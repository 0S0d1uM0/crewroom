import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { z } from 'zod';

export const shellGrantSchema = z.object({
  mode: z.enum(['read-only', 'workspace-write']),
  commands: z.array(z.string().trim().min(1).max(16000)).min(1).optional(),
}).strict();
export type ShellGrant = z.infer<typeof shellGrantSchema>;

export function shellDenial(workspace: string, grant: ShellGrant | undefined, name: string, input: any): string | undefined {
  if (!['pwsh', 'bash', 'tool:pwsh', 'tool:bash'].includes(name)) return;
  if (!grant || !['pwsh', 'tool:pwsh'].includes(name)) return 'Shell is disabled for this task';
  if (!input || typeof input.command !== 'string' || !input.command.trim()) return 'Invalid Shell command';
  if (grant.commands && !grant.commands.includes(input.command.trim())) return 'Command is not in the task exact-command grant';
  if (input.run_in_background) return 'Background Shell jobs are disabled';
  if (input.sandbox_permissions && input.sandbox_permissions !== grant.mode) return 'Requested Shell mode exceeds the task grant';
  try {
    const root = realpathSync(workspace), cwd = realpathSync(resolve(workspace, input.workdir ?? workspace));
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
    if (normalize(cwd) !== normalize(root) && !normalize(cwd).startsWith(normalize(root.endsWith(sep) ? root : root + sep))) return 'Shell workdir must be inside the task workspace';
  } catch { return 'Shell workdir cannot be verified'; }
}
