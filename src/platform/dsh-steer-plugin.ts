import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toolDenial } from './permissions.js';
import type { ToolDefinition, ToolEndpoint } from './types.js';
export const name = 'crewroom-platform-steer';
export const inject = ['agents', 'tools'];
// DSH's own MCP client gives a call 60 seconds with no option over ACP, too short for a blocking
// tool. A plugin tool has no such limit, so it forwards to the same endpoint the others use.
async function callEndpoint(endpoint: ToolEndpoint, name: string, args: unknown, signal?: AbortSignal) {
  const response = await fetch(endpoint.url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${endpoint.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  if (!response.ok) throw new Error(`Platform tool endpoint answered ${response.status}`);
  const body = await response.text();
  const data = body.split('\n').find(line => line.startsWith('data: '));
  if (!data) throw new Error('Platform tool endpoint closed without a result');
  const result = JSON.parse(data.slice(6)).result;
  return { text: String(result.content?.[0]?.text ?? ''), isError: result.isError === true };
}
async function authorizeTool(endpoint: ToolEndpoint, exec: any, workspace: string): Promise<string | undefined> {
  const input = exec.arguments ?? {}, name = String(exec.name).replace(/^tool:/, '');
  const response = await fetch(endpoint.url, { method: 'POST', signal: exec.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'permissions/check', params: { name, cwd: workspace, command: input.command, paths: [input.file_path, input.path, input.workdir].filter(v => typeof v === 'string'), read: /^(read|glob|grep|list)$/i.test(name) } }) });
  if (!response.ok) return '平台权限服务不可用，操作取消';
  const body = await response.text();
  const data = body.split('\n').find(line => line.startsWith('data: '));
  const frame = data ? JSON.parse(data.slice(6)) : undefined;
  const result = JSON.parse(frame?.result?.content?.[0]?.text ?? '{}');
  return result.allowed ? undefined : result.reason ?? '平台权限检查失败';
}
function parameters(definition: ToolDefinition) {
  const required = new Set(definition.inputSchema.required ?? []);
  return Object.fromEntries(Object.entries(definition.inputSchema.properties).map(([key, value]) => [key, { ...value, ...(required.has(key) ? { required: true } : {}) }]));
}
export function apply(ctx: any, config: { llmModule: string; inbox: string; readyPath?: string; workspace?: string; sessionDir?: string; toolsModule?: string; tools?: ToolDefinition[]; toolEndpoint?: ToolEndpoint }) {
  if (config.workspace) {
    // Without DSH's sandbox ordinary calls no longer ask for approval, so this pre-dispatch
    // guard is the only place left to apply the working-directory rule.
    if (typeof ctx.tools?.guard !== 'function') throw new Error('PLATFORM_GUARD_UNAVAILABLE: DSH tool guard is required');
    if (config.toolEndpoint) {
      if (typeof ctx.on !== 'function') throw new Error('PLATFORM_GUARD_UNAVAILABLE: asynchronous pre-execute hook required');
      const checked = new WeakMap<object, string | undefined>();
      ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
        let reason: string | undefined;
        try { reason = await authorizeTool(config.toolEndpoint!, exec, config.workspace!); }
        catch { reason = '平台权限检查失败，操作取消'; }
        checked.set(exec, reason);
        return reason ? { kind: 'deny', reason } : next();
      });
      ctx.tools.guard((exec: any) => checked.has(exec) ? checked.get(exec) : '平台权限检查未执行，操作取消');
    } else ctx.tools.guard((exec: any) => toolDenial(exec.name, exec.arguments, config.workspace!, config.sessionDir ?? config.workspace!));
  }
  const llm = import(pathToFileURL(config.llmModule).href);
  const timer = setInterval(() => {
    for (const file of readdirSync(config.inbox).filter(f => f.endsWith('.json'))) {
      const path = join(config.inbox, file), claimed = path + '.taken';
      try { renameSync(path, claimed); } catch { continue; }
      void llm.then(({ createUserMessage }) => {
        const { sessionId, text } = JSON.parse(readFileSync(claimed, 'utf8'));
        const agent = ctx.agents.get(sessionId);
        if (!agent) throw new Error(`No agent for session ${sessionId}`);
        agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
        writeFileSync(claimed + '.ok', String(Date.now()));
      }).catch(error => writeFileSync(claimed + '.err', String(error)));
    }
  }, 50);
  timer.unref();
  ctx.on?.('dispose', () => clearInterval(timer));
  const ready = () => { if (config.readyPath) writeFileSync(config.readyPath, 'ready'); };
  if (!config.tools?.length) { ready(); return undefined; }
  // Readiness comes last: if the tools fail to register, the adapter refuses to start.
  return import(pathToFileURL(config.toolsModule!).href).then(({ defineTool }) => {
    for (const definition of config.tools!) ctx.tools.register(defineTool({
      name: definition.name, description: definition.description, parameters: parameters(definition),
      output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
      async execute(args: unknown, exec: any) {
        const result = await callEndpoint(config.toolEndpoint!, definition.name, args, exec.signal);
        if (result.isError) throw new Error(result.text);
        return result.text;
      },
      presentCall: (args: unknown) => ({ card: 'generic', title: definition.name, rawInput: args }),
    }));
    ready();
  });
}
