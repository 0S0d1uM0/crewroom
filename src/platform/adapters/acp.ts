import { AcpWorker, type Launch } from '../../acp.js';
import { methods, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { scrubbedEnv } from '../env.js';
import { containedFile, isWaitingCommand, shellAllowed } from '../permissions.js';
import { shellDenial } from '../../shell-policy.js';
import { spawn } from 'node:child_process';
import type { AdapterEvent, HarnessAdapter, ToolHost, TurnResult } from '../types.js';

class PlatformAcpWorker extends AcpWorker {
  override async kill() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (process.platform === 'win32' && this.child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { env: scrubbedEnv(), windowsHide: true, stdio: 'ignore' });
      await new Promise<void>(resolve => { killer.once('exit', () => resolve()); killer.once('error', () => resolve()); });
    } else this.child.kill('SIGKILL');
    this.connection.close(new Error('Worker terminated'));
  }
}

export abstract class AcpAdapter implements HarnessAdapter {
  onMessage: (text: string) => void = () => {};
  onEvent: (event: AdapterEvent) => void = () => {};
  tools?: ToolHost;
  permission?: HarnessAdapter['permission'];
  protected worker?: AcpWorker;
  protected sessionId?: string;
  protected busy = false;
  protected ready = false;
  protected prefix = '';
  // Where the harness compacts, when that is below the model's window: the real limit to show.
  protected contextLimit?: number;
  private text = '';
  private calls = new Map<string, any>();
  private quota?: Record<string, unknown>;
  constructor(protected workspace: string, protected sessionDir: string, private dsh = false) {}
  getSessionId() { return this.sessionId; }
  abstract start(instructions: string): Promise<void>;
  abstract steer(text: string): Promise<'steered' | 'idle' | 'unsupported'>;
  protected async connect(launch: Launch) {
    const env = scrubbedEnv(launch.env);
    if (!this.dsh) {
      for (const key of ['CLAUDE_CODE_EXECUTABLE', 'CLAUDE_AGENT_ACP_PROTOCOL', 'CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW']) if (launch.env[key]) env[key] = launch.env[key];
    }
    this.worker = new PlatformAcpWorker({ ...launch, env }, {
      update: p => this.update(p as any), permission: async p => this.permissionCallback(p),
    });
    if (this.dsh) await this.worker.initialize();
    else await this.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'crewroom', version: '0.1.0' }, clientCapabilities: {} });
  }
  protected request(method: any, params: any, timeout = 60000): Promise<any> { return this.worker!.bounded(this.worker!.connection.agent.request(method, params), timeout); }
  private flush() { if (this.text) { const text = this.text; this.text = ''; this.onMessage(text); } }
  private update(p: any) {
    if (p.sessionId !== this.sessionId || !this.busy) return;
    const u = p.update;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') this.text += u.content.text;
    else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      if (u.sessionUpdate === 'tool_call') this.flush();
      const call = { ...this.calls.get(u.toolCallId), ...u }; this.calls.set(u.toolCallId, call);
      this.onEvent({ type: 'tool', id: u.toolCallId, title: call.title, kind: call.kind, status: call.status, ...(typeof call.rawInput?.command === 'string' ? { command: call.rawInput.command } : {}) });
    } else if (u.sessionUpdate === 'usage_update') {
      this.onEvent({ type: 'usage', used: u.used, size: this.contextLimit && typeof u.size === 'number' ? Math.min(u.size, this.contextLimit) : u.size });
      const limit = u._meta?.['_claude/rateLimit'];
      if (limit) {
        const windows = Object.entries(limit.unifiedWindows ?? { [limit.rateLimitType ?? 'unknown']: limit }).map(([name, w]: [string, any]) => ({ name, status: w.status ?? limit.status,
          usedPercent: w.utilization == null ? null : w.utilization * 100, resetsAt: w.resetsAt == null ? null : new Date(w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt).toISOString() }));
        this.onEvent({ type: 'rate-limits', windows });
        if (limit.status === 'rejected' || windows.some(w => w.status === 'rejected')) this.quota = { windows };
      }
    }
  }
  private async permissionCallback(p: any): Promise<any> {
    const call = { ...this.calls.get(p.toolCall.toolCallId), ...p.toolCall };
    const cached = this.calls.get(p.toolCall.toolCallId);
    const input = { ...cached?.rawInput, ...p.toolCall.rawInput };
    const name = call._meta?.claudeCode?.toolName ?? call.title ?? '';
    if (this.permission) {
      const result = await this.permission.request({ name, command: input.command, paths: [input.file_path, input.path, input.notebook_path, input.workdir, ...(call.locations ?? []).map((l: any) => l.path)].filter((v: any) => typeof v === 'string'), cwd: this.workspace, read: call.kind === 'read' || /^(read|glob|grep|list|tool:read)$/i.test(name), reason: call.title });
      if (!result.allowed) { this.prefix += `[platform] ${result.reason}\n`; this.onEvent({ type: 'permission-explanation', text: result.reason }); }
      const option = p.options.find((o: any) => o.kind === (result.allowed ? 'allow_once' : 'reject_once'));
      return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
    }
    let allowed = false;
    if (/^(WebFetch|WebSearch)$/.test(name) || name.startsWith('mcp__agents__')) allowed = true;
    else if (typeof input.command === 'string') {
      allowed = shellAllowed(input.command, this.workspace, this.sessionDir) && !isWaitingCommand(input.command);
      if (this.dsh) allowed &&= !shellDenial(this.workspace, { mode: 'workspace-write' }, name, input);
      if (input.workdir) allowed &&= containedFile(input.workdir, this.workspace);
    } else {
      const paths = [input.file_path, input.path, input.notebook_path, input.workdir, ...(call.locations ?? []).map((l: any) => l.path)].filter((v): v is string => typeof v === 'string');
      const read = call.kind === 'read' || /^(read|glob|grep|list|tool:read)$/i.test(name);
      allowed = paths.length > 0 && paths.every(path => containedFile(path, this.workspace) || (read && containedFile(path, this.sessionDir)));
    }
    const option = p.options.find((o: any) => o.kind === (allowed ? 'allow_once' : 'reject_once'));
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
  }
  async prompt(text: string): Promise<TurnResult> {
    if (!this.ready) throw new Error('Adapter is not ready; no inference submitted');
    if (this.busy) throw new Error('A prompt is already in flight');
    this.busy = true; this.text = ''; this.calls.clear(); this.quota = undefined;
    const prefix = this.prefix; this.prefix = '';
    try {
      const result = await Promise.race([this.worker!.prompt(this.sessionId!, prefix + text), this.worker!.connection.closed.then(() => { throw new Error('ACP_DISCONNECTED'); })]);
      this.flush();
      return { status: this.quota ? 'quota' : result.stopReason === 'end_turn' ? 'completed' : result.stopReason === 'cancelled' ? 'cancelled' : 'failed', usage: (result as any).usage, quota: this.quota, error: result.stopReason === 'end_turn' ? undefined : result.stopReason };
    } catch (error) { this.flush(); if (this.quota) return { status: 'quota', quota: this.quota, error: String(error) }; throw error; }
    finally { this.busy = false; }
  }
  async interrupt() { if (this.busy && this.sessionId) await this.worker!.cancel(this.sessionId); }
  async stop() { this.ready = false; await this.worker?.stop(1000); }
}
