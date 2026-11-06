import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { JsonRpcProcess } from './rpc.js';
import { scrubbedEnv } from '../env.js';
import type { MemberConfig } from '../config.js';
import type { AdapterEvent, HarnessAdapter, ToolHost, TurnResult, Usage } from '../types.js';
import type { Launch } from '../../acp.js';

// sleep_tool: Codex's own clock.sleep is how it spun in a turn, so waiting must go through the platform.
const DISABLED = ['sleep_tool', 'memories', 'apps', 'plugins', 'remote_plugin', 'tool_suggest', 'browser_use', 'browser_use_external', 'computer_use', 'in_app_browser', 'multi_agent'];
export function locateCodex() {
  if (process.env.CREWROOM_CODEX) return process.env.CREWROOM_CODEX;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-AppxPackage OpenAI.Codex).InstallLocation'], { env: scrubbedEnv(), encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const path = join(result.stdout?.trim() ?? '', 'app', 'resources', 'codex.exe');
  if (!existsSync(path)) throw new Error('Codex executable not found; set CREWROOM_CODEX'); return path;
}
// What this account can run, with each model's own effort levels. No thread, no inference.
export async function codexModels(cwd: string) {
  const rpc = new JsonRpcProcess({ command: locateCodex(), args: ['app-server', '--listen', 'stdio://'], cwd, env: scrubbedEnv() });
  try {
    await rpc.request('initialize', { clientInfo: { name: 'crewroom', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }); rpc.notify('initialized');
    const result = []; let cursor: string | undefined;
    do {
      const page = await rpc.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
      for (const m of page.data ?? []) if (!m.hidden) result.push({ id: String(m.model ?? m.id), label: String(m.displayName ?? m.model ?? m.id), description: m.description, available: true, efforts: (m.supportedReasoningEfforts ?? []).map((e: any) => String(e.reasoningEffort ?? e.effort ?? e)) });
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return result;
  } finally { await rpc.stop(); }
}
interface TurnState { completed?: any; error?: any; wake?: () => void }
export class CodexAdapter implements HarnessAdapter {
  onMessage: (text: string) => void = () => {};
  onEvent: (event: AdapterEvent) => void = () => {};
  tools?: ToolHost;
  permission?: HarnessAdapter['permission'];
  // Codex lists client tools only inside exec, and adds a sub-agent system that reads as if it were this team.
  readonly toolHint = 'These tools are inside your exec tool, for example: await tools.post_board({ text: "...", notify: ["name"] }). Your teammates are separate running agents, reachable only this way: the collaboration namespace, /root and sub-agents have nothing to do with them. Your own wait tool only resumes a yielded exec cell; to wait for a teammate or the user, use tools.wait_for_messages.';
  // Client tools run inside exec, which yields after 30 seconds and leaves the model polling
  // wait: a turn cost 650k tokens that way before the model gave up. So the platform ends the turn first.
  readonly maxBlockMs = 20_000;
  readonly nativeProjectFiles = ['AGENTS.md'];
  private rpc?: JsonRpcProcess;
  private threadId?: string;
  private threadParams: Record<string, unknown> = {};
  private appliedOnline = true;
  private hasRollout = false;
  private active?: string;
  private running = false;
  private stopped = false;
  private turns = new Map<string, TurnState>();
  private totals: Usage = {};
  private explanations: string[] = [];
  constructor(private member: MemberConfig, private workspace: string, private launchFactory?: (args: string[]) => Launch) {}
  private launch(args: string[]) { return this.launchFactory?.(args) ?? { command: locateCodex(), args: ['app-server', '--listen', 'stdio://', ...args], cwd: this.workspace, env: scrubbedEnv() }; }
  private async initialize(rpc: JsonRpcProcess) {
    await rpc.request('initialize', { clientInfo: { name: 'crewroom', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }); rpc.notify('initialized');
  }
  getSessionId() { return this.threadId; }
  async resume(id: string, instructions: string) { await this.open(instructions, id); }
  async start(instructions: string) { await this.open(instructions); }
  private async open(instructions: string, id?: string) {
    const probe = this.rpc = new JsonRpcProcess(this.launch([]));
    let args: string[];
    try {
      await this.initialize(probe);
      const config = await probe.request('config/read', { includeLayers: false, cwd: this.workspace });
      const features = await probe.request('experimentalFeature/list', {});
      args = [...Object.keys(config.config?.mcp_servers ?? {}).flatMap(n => ['-c', `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(n) ? n : JSON.stringify(n)}.enabled=false`]), '-c', 'include_apps_instructions=false',
        ...DISABLED.filter(n => features.data?.some((f: any) => f.name === n)).flatMap(n => ['--disable', n])];
    } finally { await probe.stop(); }
    if (this.stopped) throw new Error('Codex adapter stopped during startup');
    const rpc = this.rpc = new JsonRpcProcess(this.launch(args));
    rpc.onRequest = async (method, p) => {
      if (method === 'item/tool/call') {
        if (!this.tools) return { contentItems: [{ type: 'inputText', text: 'No platform tools in this session' }], success: false };
        try { const result = await this.tools.call(p.tool, p.arguments ?? {}); return { contentItems: [{ type: 'inputText', text: result.text }], success: result.isError !== true }; }
        catch (error) { return { contentItems: [{ type: 'inputText', text: String(error) }], success: false }; }
      }
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'].includes(method)) {
        const profile = p.permissions ?? p.additionalPermissions;
        const profilePaths = profile ? JSON.stringify(profile).split('\"').filter((v: string) => /[\\/]/.test(v)) : [];
        const result = await this.permission?.request({ name: profile?.network?.enabled ? 'network https' : undefined, cwd: p.cwd ?? this.workspace, command: p.command, paths: [...(p.grantRoot ? [p.grantRoot] : []), ...profilePaths], reason: method === 'item/permissions/requestApproval' ? 'Codex 此申请按整个回合授权，无法限制为单条命令。'+(p.reason ?? '') : p.reason, forceApproval: true, remember: method === 'item/commandExecution/requestApproval' });
        if (!result?.allowed) {
          const reason = result?.reason ?? '平台未连接审批处理器，用户没有拒绝此请求';
          this.explanations.push(reason); this.onEvent({ type: 'permission-explanation', text: reason });
          void this.steer('[platform] '+reason).catch(() => {});
        }
        if (method === 'item/permissions/requestApproval') return { permissions: result?.allowed ? p.permissions ?? {} : {}, scope: 'turn' };
        return { decision: result?.allowed ? 'accept' : 'decline' };
      }
      throw new Error(`Unsupported server request: ${method}`);
    };
    rpc.onNotification = (method, p) => this.observe(method, p);
    await this.initialize(rpc);
    this.threadParams = { model: this.member.model, cwd: this.workspace, developerInstructions: instructions, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: this.permission?.level() === 'full-write' ? 'danger-full-access' : this.permission?.level() === 'read-only' ? 'read-only' : 'workspace-write', ...(this.tools ? { dynamicTools: this.tools.definitions.map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema })) } : {}) };
    this.appliedOnline = this.permission?.online() !== false; this.hasRollout = Boolean(id);
    if (id) {
      try { await rpc.request('thread/unarchive', { threadId: id }, 5000); }
      catch (error) { this.onEvent({ type: 'codex-unarchive', threadId: id, success: false, error: String(error) }); }
    }
    let result;
    try { result = await rpc.request(id ? 'thread/resume' : 'thread/start', { ...(id ? { threadId: id } : {}), ...this.threadParams, config: this.webConfig(this.appliedOnline) }); }
    catch (error) {
      if (/active writer/i.test(String(error))) throw new Error('这个线程正被 Codex 桌面版打开，请完全退出 Codex 桌面版后重试。' + String(error));
      throw error;
    }
    this.threadId = result.thread.id;
  }
  private webConfig(online: boolean) { return { web_search: online ? 'live' : 'disabled' }; }
  // The search tool is fixed on the thread. A thread that has never run has nothing to resume, so it
  // is started again; only a change of the switch touches the thread at all.
  private async applyNetwork() {
    const online = this.permission?.online() !== false;
    if (online === this.appliedOnline) return;
    const config = this.webConfig(online);
    if (this.hasRollout) await this.rpc!.request('thread/resume', { threadId: this.threadId, config });
    else this.threadId = (await this.rpc!.request('thread/start', { ...this.threadParams, config })).thread.id;
    this.appliedOnline = online;
  }
  private sandboxPolicy() {
    const level = this.permission?.level() ?? 'safe-write';
    if (level === 'full-write') return { type: 'dangerFullAccess' };
    if (level === 'read-only') return { type: 'readOnly', networkAccess: this.permission?.online() ?? true };
    return { type: 'workspaceWrite', writableRoots: [this.workspace], networkAccess: this.permission?.online() ?? true, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
  }
  private state(id: string) { let state = this.turns.get(id); if (!state) { state = {}; this.turns.set(id, state); } return state; }
  private observe(method: string, p: any) {
    if (method === 'thread/tokenUsage/updated') { this.totals = { ...(p.tokenUsage?.total ?? {}) }; this.onEvent({ type: 'usage', usage: this.totals }); return; }
    if (method === 'account/rateLimits/updated') { this.onEvent({ type: 'rate-limits', ...p }); return; }
    const id = p.turnId ?? p.turn?.id;
    if (id && method === 'turn/started' && this.running) this.active = id;
    if (method === 'item/completed' && p.item?.type === 'agentMessage') this.onMessage(p.item.text ?? '');
    else if (['item/started', 'item/completed'].includes(method) && ['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall'].includes(p.item?.type)) this.onEvent({ type: 'tool', id: p.item.id, kind: p.item.type, status: method === 'item/completed' ? 'completed' : 'in_progress', ...(typeof p.item.tool === 'string' ? { title: p.item.tool } : {}), ...(typeof p.item.command === 'string' ? { command: p.item.command } : {}), ...(Array.isArray(p.item.changes) && p.item.changes.length ? { paths: p.item.changes.map((c: any) => String(c.path)) } : {}) });
    if (!id) return;
    const state = this.state(id);
    if (method === 'error' && !p.willRetry) state.error = p.error;
    if (method === 'turn/completed') { state.completed = p.turn; if (this.active === id) this.active = undefined; state.wake?.(); }
  }
  async readQuota(): Promise<any> { return this.rpc ? this.rpc.request('account/rateLimits/read', {}, 3000) : undefined; }
  async prompt(text: string): Promise<TurnResult> {
    if (this.stopped || !this.threadId) throw new Error('Adapter is not ready; no inference submitted');
    if (this.running) throw new Error('A prompt is already in flight'); this.running = true;
    const before = { ...this.totals };
    if(this.explanations.length) text = this.explanations.splice(0).map(reason=>'[platform] '+reason).join('\n')+'\n'+text;
    try {
      await this.applyNetwork();
      const result = await this.rpc!.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text, text_elements: [] }], model: this.member.model, effort: this.member.effort ?? 'low', cwd: this.workspace,
        approvalPolicy: 'on-request', approvalsReviewer: 'user', sandboxPolicy: this.sandboxPolicy() });
      this.hasRollout = true;
      const id = result.turn.id, state = this.state(id);
      if (!state.completed) {
        this.active = id;
        await Promise.race([new Promise<void>(resolve => { state.wake = resolve; }), this.rpc!.closed.then(() => { throw new Error('HARNESS_EXITED during turn'); })]);
      }
      this.active = undefined;
      const usage = Object.fromEntries(Object.entries(this.totals).map(([key, value]) => [key, Math.max(0, value - (before[key] ?? 0))]));
      const error = state.completed?.error ?? state.error;
      const info = error?.codexErrorInfo, code = typeof info === 'string' ? info : Object.keys(info ?? {})[0];
      this.turns.delete(id);
      if (code && ['usageLimitExceeded', 'rateLimitExceeded'].includes(code)) return { status: 'quota', usage, error: error?.message, quota: { code } };
      return { status: error || state.completed?.status === 'failed' ? 'failed' : state.completed?.status === 'interrupted' ? 'cancelled' : 'completed', usage, error: error?.message };
    } catch (error) {
      // A server may reject turn/start directly rather than emit turn/completed.
      let details: any; try { details = JSON.parse(error instanceof Error ? error.message : String(error)); } catch {}
      const info = details?.data?.codexErrorInfo ?? details?.codexErrorInfo;
      const code = typeof info === 'string' ? info : Object.keys(info ?? {})[0];
      if (code && ['usageLimitExceeded','rateLimitExceeded'].includes(code)) return {status:'quota',error:details.message,quota:{code}};
      throw error;
    } finally { this.active = undefined; this.running = false; }
  }
  async steer(text: string): Promise<'steered' | 'idle'> {
    const id = this.active; if (!id) return 'idle';
    try { await this.rpc!.request('turn/steer', { threadId: this.threadId, expectedTurnId: id, input: [{ type: 'text', text, text_elements: [] }] }); return 'steered'; }
    catch { return 'idle'; }
  }
  async interrupt() { if (this.active) await this.rpc!.request('turn/interrupt', { threadId: this.threadId, turnId: this.active }); }
  private stopTask?: Promise<void>;
  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    return this.stopTask = (async () => {
      if (this.rpc && this.threadId && this.hasRollout) {
        try { await this.rpc.request('thread/archive', { threadId: this.threadId }, 5000); this.onEvent({ type: 'codex-archive', threadId: this.threadId, success: true }); }
        catch (error) { this.onEvent({ type: 'codex-archive', threadId: this.threadId, success: false, error: String(error) }); }
      }
      await this.rpc?.stop();
    })();
  }
}
