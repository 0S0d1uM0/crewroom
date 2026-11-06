import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { methods } from '@agentclientprotocol/sdk';
import { AcpAdapter } from './acp.js';
import { scrubbedEnv } from '../env.js';
import type { Launch } from '../../acp.js';
import type { MemberConfig } from '../config.js';

const optionChoices = (options: any[] | undefined, id: string): any[] => (options?.find((o: any) => o.id === id)?.options ?? []).flatMap((o: any) => o.options ?? [o]);
export function expectedModelName(model: string) { const m = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(model); return m ? `${m[1]} ${m[2]}.${m[3]}` : model.toLowerCase(); }
// Every tool call re-reads the whole context, so long runs near 1M are what spend the quota. The
// harness compacts at this size instead, and caps it at the model's own window.
export const CLAUDE_CONTEXT_WINDOW = 400_000;
export function claudeEnv(executable: string, contextWindow = CLAUDE_CONTEXT_WINDOW): NodeJS.ProcessEnv {
  return { ...scrubbedEnv(), ELECTRON_RUN_AS_NODE: '1', ENABLE_TOOL_SEARCH: 'false', MCP_TOOL_TIMEOUT: '2147483647', CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '0', CLAUDE_CODE_EXECUTABLE: executable, CLAUDE_AGENT_ACP_PROTOCOL: 'v1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow) };
}
export const claudeAcpEntry = () => fileURLToPath(new URL('../../../node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js', import.meta.url));
export class ClaudeAdapter extends AcpAdapter {
  protected contextLimit = CLAUDE_CONTEXT_WINDOW;
  constructor(private member: MemberConfig, workspace: string, sessionDir: string, private testLaunch?: Launch) { super(workspace, sessionDir); }
  getSessionId() { return this.sessionId; }
  async resume(id: string, instructions: string) { await this.open(instructions, id); }
  async start(instructions: string) { await this.open(instructions); }
  private async open(instructions: string, id?: string) {
    const executable = process.env.CREWROOM_CLAUDE ?? join(homedir(), '.local', 'bin', 'claude.exe');
    if (!this.testLaunch) {
      const auth = spawnSync(executable, ['auth', 'status'], { env: scrubbedEnv(), encoding: 'utf8', windowsHide: true, timeout: 30000 });
      let loggedIn = false; try { loggedIn = JSON.parse(auth.stdout).loggedIn === true; } catch {}
      if (auth.status !== 0 || !loggedIn) throw new Error('Claude Code is not logged in; run claude auth login before starting the platform');
    }
    await this.connect(this.testLaunch ?? { command: process.execPath, args: [claudeAcpEntry()], cwd: this.workspace, env: claudeEnv(executable) });
    const response = await this.request(id ? methods.agent.session.resume : methods.agent.session.new, { ...(id ? { sessionId: id } : {}), cwd: this.workspace, mcpServers: this.tools?.endpoint ? [{ type: 'http', name: 'agents', url: this.tools.endpoint.url, headers: [{ name: 'Authorization', value: `Bearer ${this.tools.endpoint.token}` }] }] : [], _meta: { claudeCode: { options: {
      settings: { permissions: { ask: ['Read','Glob','Grep','Bash','Write','Edit','MultiEdit','NotebookEdit','WebSearch','WebFetch'] } },
      settingSources: [], strictMcpConfig: true, plugins: [], promptSuggestions: false, additionalDirectories: [this.sessionDir],
      disallowedTools: ['Agent', 'Task', 'AskUserQuestion'],
      systemPrompt: { type: 'preset', preset: 'claude_code', append: instructions },
    } } } });
    this.sessionId = id ?? response.sessionId;
    let applied: any;
    for (const [configId, value] of [['model', this.member.model], ['mode', 'default']]) {
      applied = await this.request(methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId, value });
    }
    // Not every model has effort levels, and asking for one it lacks would fail the whole start.
    if (optionChoices(applied.configOptions, 'effort').length) applied = await this.request(methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId: 'effort', value: this.member.effort ?? 'low' });
    const options = applied.configOptions ?? [], model = options.find((o: any) => o.id === 'model');
    const choices = (model?.options ?? []).flatMap((o: any) => o.options ?? [o]);
    const display = choices.find((o: any) => o.value === model?.currentValue)?.name;
    // A scanned ID is confirmed directly; a full ID like claude-haiku-5-5 comes back as an alias.
    if (model?.currentValue !== this.member.model && String(display).toLowerCase() !== expectedModelName(this.member.model)) throw new Error(`MODEL_NOT_APPLIED: requested ${this.member.model}, received ${display}; no inference submitted`);
    if (options.find((o: any) => o.id === 'mode')?.currentValue !== 'default') throw new Error('MODE_NOT_DEFAULT; no inference submitted');
    this.ready = true;
  }
  // What this harness can run, with each model's own effort levels. Sends no prompt.
  async modelCatalog() {
    const set = (configId: string, value: string) => this.request(methods.agent.session.setConfigOption, { sessionId: this.sessionId, configId, value });
    const start = await set('mode', 'default'), result = [];
    // "default" is a pointer to one of the others, and which one can change.
    for (const m of optionChoices(start.configOptions, 'model').filter((o: any) => o.value !== 'default')) {
      const applied = await set('model', m.value);
      result.push({ id: String(m.value), label: String(m.name ?? m.value), description: m.description, available: true, efforts: optionChoices(applied.configOptions, 'effort').map((o: any) => String(o.value)).filter((v: string) => v !== 'default') });
    }
    return result;
  }
  async steer(text: string): Promise<'steered' | 'idle' | 'unsupported'> {
    if (!this.busy) return 'idle';
    try {
      const result = await this.request('_session/steering', { sessionId: this.sessionId, prompt: [{ type: 'text', text }], _meta: { steering: { idleBehavior: 'promptRequired' } } }, 10000);
      return result.outcome === 'promptRequired' ? 'idle' : 'steered';
    } catch { return 'unsupported'; }
  }
}
