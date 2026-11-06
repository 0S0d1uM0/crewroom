import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { client, methods, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, type InitializeResponse, type SessionNotification, type RequestPermissionRequest, type RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { redact } from './config.js';
import { existsSync, unlinkSync } from 'node:fs';

export interface Launch { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; policyReady?: string }
export interface Handlers {
  update: (params: SessionNotification) => void;
  permission: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}
export class AcpWorker {
  child: ChildProcessWithoutNullStreams;
  connection: ClientConnection;
  initialized?: InitializeResponse;
  stderr = '';
  loaded = new Set<string>();
  private stopped = false;
  constructor(private launch: Launch, handlers: Handlers) {
    this.child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, windowsHide: true, stdio: 'pipe', shell: false });
    // Handle spawn errors even if they occur before the first request starts.
    this.child.on('error', () => {});
    this.child.stderr.on('data', b => { this.stderr = redact((this.stderr + b.toString()).slice(-4096)); });
    this.child.stdin.on('error', () => {});
    const stream = ndJsonStream(Writable.toWeb(this.child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>);
    this.connection = client({ name: 'codex-dsh-orchestrator' })
      .onNotification(methods.client.session.update, ({ params }) => handlers.update(params))
      .onRequest(methods.client.session.requestPermission, ({ params }) => handlers.permission(params))
      .connect(stream);
  }
  async initialize(timeout = 30_000) {
    this.initialized = await this.bounded(this.connection.agent.request(methods.agent.initialize, {
      protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'codex-dsh-orchestrator', version: '0.1.0' }, clientCapabilities: {},
    }), timeout);
    const caps = this.initialized.agentCapabilities?.sessionCapabilities;
    if (!caps?.resume || !caps?.list || !caps?.close) throw new Error('ACP server lacks required resume/list/close capabilities');
    if (this.launch.policyReady) {
      const deadline = Date.now() + 5000;
      while (!existsSync(this.launch.policyReady) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
      if (!existsSync(this.launch.policyReady)) throw new Error('SHELL_POLICY_UNAVAILABLE: execution guard did not load; no inference submitted. ' + this.stderr);
    }
    return this.initialized;
  }
  async bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('ACP_TIMEOUT')), ms); }), this.connection.closed.then(() => { throw new Error('ACP_DISCONNECTED'); })]); }
    finally { if (timer) clearTimeout(timer); }
  }
  async session(cwd: string, id: string | null) {
    if (id && this.loaded.has(id)) return id;
    const result = id
      ? await this.bounded(this.connection.agent.request(methods.agent.session.resume, { sessionId: id, cwd, mcpServers: [] }), 30_000)
      : await this.bounded(this.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] }), 30_000);
    const sessionId = id ?? ('sessionId' in result ? result.sessionId : undefined);
    if (typeof sessionId !== 'string') throw new Error('ACP server did not return session ID');
    this.loaded.add(sessionId); return sessionId;
  }
  prompt(id: string, text: string) { return this.connection.agent.request(methods.agent.session.prompt, { sessionId: id, prompt: [{ type: 'text', text }] }); }
  async selectModel(id: string, selection: string) {
    const result = await this.bounded(this.connection.agent.request(methods.agent.session.setConfigOption, { sessionId: id, configId: 'model', value: selection }), 10000);
    const model = result.configOptions.find(option => option.id === 'model');
    if (model?.type !== 'select' || model.currentValue !== selection) throw new Error('MODEL_SELECTION_FAILED: ACP did not confirm the requested model; no inference was submitted');
  }
  async cancel(id: string) { await this.connection.agent.notify(methods.agent.session.cancel, { sessionId: id }); }
  async stop(graceMs = 3000) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      // EOF invokes the official profile's quiescent teardown. Never kill unrelated dsh instances.
      this.child.stdin.end();
      await this.waitForExit(graceMs);
      if (this.child.exitCode === null && this.child.signalCode === null) await this.kill();
    }
    this.connection.close();
    if (this.launch.policyReady && existsSync(this.launch.policyReady)) unlinkSync(this.launch.policyReady);
  }
  private async waitForExit(ms: number) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.child.off('exit', finish); this.child.off('error', finish); resolve(); };
      const timer = setTimeout(finish, ms);
      this.child.once('exit', finish); this.child.once('error', finish);
    });
  }
  async kill() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (process.platform === 'win32' && this.child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await new Promise<void>(resolve => { killer.once('exit', () => resolve()); killer.once('error', () => resolve()); });
    } else this.child.kill('SIGKILL');
    this.connection.close(new Error('Worker terminated'));
  }
}
