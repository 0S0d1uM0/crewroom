import { existsSync, realpathSync } from 'node:fs';
import { dirname, resolve, win32, posix } from 'node:path';

export function inside(path: string, root: string): boolean {
  const api = /^[a-z]:[\\/]|^\\\\/i.test(root) ? win32 : posix;
  const r = api.relative(api.resolve(root), api.resolve(root, path));
  return !r || (!r.startsWith('..' + api.sep) && r !== '..' && !api.isAbsolute(r));
}
export function containedFile(path: string, root: string): boolean {
  try {
    const absolute = resolve(root, path);
    let ancestor = absolute;
    while (!existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) return false; ancestor = parent; }
    return inside(absolute, root) && inside(realpathSync(ancestor), realpathSync(root));
  } catch { return false; }
}

// This is a conservative command check, not a shell sandbox.
export function shellAllowed(command: string, workspace: string, sessionDir: string): boolean {
  if (!command.trim() || /\bcollab(?:\.cmd)?\b/i.test(command) || /\bgit\b[^\r\n;|&]*\bpush\b/i.test(command)) return false;
  if (/(?:^|[\\/\s'"=;|&(])\.\.(?=$|[\\/\s'";|&)])/.test(command)) return false;
  command = command.replace(/https?:\/\/[^\s'"]+/gi, 'URL').replace(/(?:^|(?<=[\s'">]))\/dev\/null(?=$|[\s'";|&])/g, 'NUL');
  const paths = command.match(/"[^"\r\n]+"|'[^'\r\n]+'|[^\s;|&()<>]+/g) ?? [];
  for (let token of paths) {
    token = token.replace(/^['"]|['"]$/g, '').replace(/^\w+=/, '');
    if (/^[a-z]:[\\/]|^\\\\|^\//i.test(token) && !inside(token, workspace) && !inside(token, sessionDir)) return false;
  }
  for (const path of command.match(/[a-z]:[\\/][^\s'";|&()<>]+|\\\\[^\s'";|&()<>]+|(?<![-\w:/.\\])\/[a-z0-9_.-]+(?:\/[^\s'";|&()<>]*)?/gi) ?? []) {
    if (!inside(path, workspace) && !inside(path, sessionDir)) return false;
  }
  if (/~[\\/]|\$(?:env:)?(?:HOME|USERPROFILE)|%USERPROFILE%/i.test(command)) return false;
  return true;
}

// Starts something in the background: PowerShell's process and job commands, or a shell's trailing
// `&`. PowerShell's `&` call operator also appears here, but only ever at the start of a statement.
const STARTS_OWN_WORK = /\bstart-(?:process|job|threadjob)\b|[^\s;|&(]\s+&(?:\s|$)/i;
// A command whose purpose is to pass time: starting with a sleep, or looping over one. A sleep or
// loop after starting a server is not caught, since that waits for the command's own work.
export function isWaitingCommand(command: string): boolean {
  if (/^\s*(?:sleep\b|start-sleep\b|timeout(?:\.exe)?\s+(?:\/t\s+)?\d)/i.test(command)) return true;
  if (!/\b(?:while|until|for|foreach|do)\b[\s\S]*\b(?:sleep|start-sleep)\b/i.test(command)) return false;
  return !STARTS_OWN_WORK.test(command.slice(0, command.search(/\b(?:start-sleep|sleep)\b/i)));
}
export const WAITING_DENIAL = 'Do not sleep or poll to wait. To wait for a teammate or the user, call wait_for_messages, which blocks at no cost until a message arrives. If there is nothing to wait for, finish your reply.';

// One DSH tool call, before dispatch. A denial is shown to the model as the reason.
export function toolDenial(name: string, input: any, workspace: string, sessionDir: string): string | undefined {
  const tool = String(name).replace(/^tool:/, '');
  if (tool === 'pwsh' || tool === 'bash') {
    if (typeof input?.command !== 'string' || !input.command.trim()) return 'Invalid shell command';
    if (input.run_in_background) return 'Background shell jobs are disabled';
    if (isWaitingCommand(input.command)) return WAITING_DENIAL;
    if (input.workdir && !containedFile(input.workdir, workspace)) return 'Shell workdir must be inside the working directory';
    if (!shellAllowed(input.command, workspace, sessionDir)) return 'Command rejected: it refers to a path outside the working directory, or runs git push or collab';
  } else if (tool === 'write' || tool === 'edit') {
    const file = input?.file_path ?? input?.path;
    if (typeof file !== 'string' || !containedFile(file, workspace)) return 'Writes are only allowed inside the working directory';
  }
  return undefined;
}
