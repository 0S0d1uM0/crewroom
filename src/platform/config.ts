import { z } from 'zod';
import { resolve } from 'node:path';

// Names become file names and Git branch names as well as @mentions, so letters of any script are
// fine but separators are not, and Windows reserves a few names outright.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// How DSH names a route: ["provider","model"]. Only DeepSeek's own providers are accepted.
export const DSH_CLOUD_ROUTE = /^\["deepseek-[a-z0-9-]+","[a-z0-9._-]+"\]$/;
export const memberName = z.string().max(32).regex(/^[\p{L}\p{N}][\p{L}\p{M}\p{N}_-]*$/u).refine(name => !WINDOWS_RESERVED.test(name) && name === name.normalize('NFC'));
export const configSchema = z.object({
  networkAccess: z.boolean().default(true), workspace: z.string().min(1), mode: z.enum(['shared', 'worktree']).default('shared'),
  sessionRoot: z.string().min(1).optional(), maxTurns: z.number().int().positive().optional(),
  turnTimeoutMs: z.number().int().positive().optional(),
  members: z.array(z.object({ name: memberName.optional(),
    harness: z.enum(['claude', 'codex', 'dsh']), model: z.string().min(1), effort: z.string().optional(),
    permission: z.enum(['read-only', 'safe-write', 'full-write']).default('safe-write'), role: z.enum(['lead', 'worker']) }).strict()).min(1),
}).strict().superRefine((c, ctx) => {
  if (c.members.filter(m => m.role === 'lead').length !== 1) ctx.addIssue({ code: 'custom', message: 'Exactly one lead is required' });
  // The local model serves one request at a time; the cloud routes have no such limit.
  if (c.members.filter(m => m.harness === 'dsh' && m.model === 'local').length > 1) ctx.addIssue({ code: 'custom', message: 'At most one local Qwen member is supported' });
  for (const m of c.members) if (m.harness === 'dsh' && m.model !== 'local' && !DSH_CLOUD_ROUTE.test(m.model)) ctx.addIssue({ code: 'custom', message: 'DSH takes local or a DeepSeek route from the model list' });
});
export function parseConfig(input: unknown) {
  const c = configSchema.parse(input), counts: Record<string, number> = {};
  const used = new Set(c.members.flatMap(m => m.name ? [m.name] : []));
  const members = c.members.map(m => {
    let name = m.name;
    if (!name && m.role === 'lead') name = 'lead';
    while (!name) {
      const candidate = `${m.harness}-${counts[m.harness] = (counts[m.harness] ?? 0) + 1}`;
      if (!used.has(candidate)) name = candidate;
    }
    used.add(name); return { ...m, name };
  });
  const rank = ['read-only', 'safe-write', 'full-write'];
  const lead = members.find(m => m.role === 'lead')!;
  for (const m of members) if (rank.indexOf(m.permission) > rank.indexOf(lead.permission)) m.permission = lead.permission;
  const names = members.map(m => m.name);
  // Compared without case: Windows file names treat Bob and bob as the same board file.
  const folded = names.map(name => name.toLowerCase());
  if (new Set(folded).size !== folded.length || folded.includes('all')) throw new Error('Member names must be unique and cannot be all');
  return { ...c, workspace: resolve(c.workspace), members };
}
export type PlatformConfig = ReturnType<typeof parseConfig>;
export type MemberConfig = PlatformConfig['members'][number];
