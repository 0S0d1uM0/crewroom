// Isolated DSH plugin, loaded only by this orchestrator. Uses the official
// monotonic pre-dispatch guard; editing the model-facing schema is not security.
import { shellDenial, shellGrantSchema } from './shell-policy.js';
import { writeFileSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
export const name = 'crewroom-shell-policy';
export const inject = ['tools', 'sandboxPolicy'];
export function apply(ctx: any, config: { workspace: string; allowWrite: boolean; exam?: boolean; shell?: unknown; readyPath?: string }) {
  if (typeof ctx.tools.guard !== 'function') throw new Error('SHELL_POLICY_UNAVAILABLE: monotonic DSH guard is required');
  const grant = config.shell === undefined ? undefined : shellGrantSchema.parse(config.shell);
  const mode = grant?.mode ?? (config.allowWrite ? 'workspace-write' : 'read-only');
  const initialized = new WeakSet<object>();
  ctx.tools.guard((exec: any) => {
    if (!exec.agent?.session) return 'No owned task session for tool execution';
    // A resumed session can retain an old, broader sandbox/mode. Reset through
    // the official durable event before any tool dispatch in this worker.
    if (!initialized.has(exec.agent)) {
      exec.agent.session.append('sandbox/mode', { mode });
      initialized.add(exec.agent);
    }
    const web = /^(?:tool:)?web_(?:search|fetch)$/.test(exec.name);
    const denial = config.exam && web ? 'Web tools are disabled for this exam task' : shellDenial(config.workspace, grant, exec.name, exec.arguments);
    if (config.exam && config.readyPath) appendFileSync(join(dirname(config.readyPath), 'exam-tools.audit.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), pid: process.pid, callId: exec.callId, name: exec.name, arguments: exec.arguments, denied: !!denial, reason: denial ?? null }) + '\n');
    if (config.readyPath && ['pwsh','bash'].includes(exec.name)) appendFileSync(join(dirname(config.readyPath), 'shell-policy.audit.jsonl'), JSON.stringify({ pid: process.pid, callId: exec.callId, name: exec.name, mode, denied: !!denial, reason: denial ?? null }) + '\n');
    return denial;
  });
  if (config.readyPath) writeFileSync(config.readyPath, 'ready', { flag: 'wx' });
}
