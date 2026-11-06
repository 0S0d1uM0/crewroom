import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { shellGrantSchema } from './shell-policy.js';

export const limitsSchema = z.object({
  allowWrite: z.boolean().default(false),
  exam: z.boolean().default(false),
  noTimeout: z.boolean().default(false),
  shell: shellGrantSchema.optional(),
  maxPrompts: z.number().int().min(1).max(20).default(6),
  promptTimeoutMs: z.number().int().min(100).max(1_800_000).default(1_800_000),
  taskTimeoutMs: z.number().int().min(100).max(1_800_000).default(1_800_000),
  permissionTimeoutMs: z.number().int().min(100).max(60_000).default(15_000),
  cancelGraceMs: z.number().int().min(100).max(10_000).default(3_000),
  maxLlmCalls: z.number().int().min(1).max(100).default(20),
  maxCostUsd: z.number().min(0).max(100).default(0),
}).strict();
export const configSchema = z.object({
  backend: z.enum(['mock', 'dsh']).default('mock'),
  permission: z.enum(['reject', 'review']).default('reject'),
  maxQueue: z.number().int().min(1).max(100).default(32),
  maxSessions: z.number().int().min(1).max(20).default(8),
  limits: limitsSchema.default(() => limitsSchema.parse({})),
}).strict();
export type Config = z.infer<typeof configSchema>;
export type Limits = Config['limits'];

export function stateHome(): string {
  return resolve(process.env.CREWROOM_STATE_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), '.local', 'state'), 'Crewroom\\legacy-state'));
}
export function secureHome(home: string): void {
  // Only a dedicated, unmistakably system-owned directory may be re-ACL'd.
  const marker = join(home, '.crewroom-owned');
  if (existsSync(marker) && existsSync(join(home, 'token'))) return;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, '.crewroom-init');
  try { mkdirSync(lock); }
  catch {
    if (Date.now() - statSync(lock).mtimeMs < 30000) throw new Error('STATE_INITIALIZING');
    rmSync(lock, { recursive: true });
    throw new Error('STATE_INITIALIZING');
  }
  try {
  if (!existsSync(marker) && readdirSync(home).some(x => x !== '.crewroom-init')) throw new Error('CREWROOM_STATE_HOME must be empty or already owned by collab');
  if (process.platform === 'win32' && !existsSync(marker)) {
    const who = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { encoding: 'utf8', windowsHide: true });
    const sid = who.stdout?.trim();
    if (who.status !== 0 || !/^S-1-\d+(?:-\d+)+$/.test(sid)) throw new Error('Cannot determine state-directory owner SID');
    const acl = spawnSync('icacls.exe', [home, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, encoding: 'utf8' });
    if (acl.status !== 0) throw new Error('Cannot protect collaboration state directory');
  }
  if (!existsSync(join(home, 'token'))) writeFileSync(join(home, 'token'), randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  if (!existsSync(marker)) writeFileSync(marker, 'collab-state-v1\n', { mode: 0o600, flag: 'wx' });
  } finally { rmSync(lock, { recursive: true }); }
}
export function loadConfig(home: string): Config {
  const path = join(home, 'config.json');
  return configSchema.parse(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {});
}
export function endpoint(home: string): string {
  const id = createHash('sha256').update(resolve(home).toLowerCase()).digest('hex').slice(0, 24);
  return process.platform === 'win32' ? `\\\\.\\pipe\\codex-dsh-${id}` : join(home, 'daemon.sock');
}
export function canonicalWorkspace(path: string): string {
  if (!isAbsolute(path)) throw new Error('Workspace must be an absolute path');
  return realpathSync(path);
}
export function sessionKey(workspace: string, role: string, scope = ''): string {
  return createHash('sha256').update(`${process.platform === 'win32' ? workspace.toLowerCase() : workspace}\0${role}${scope ? `\0${scope}` : ''}`).digest('hex');
}
export function conversationScope(explicit?: string): string {
  const id = explicit ?? process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
  if (!id?.trim()) throw new Error('No Codex conversation identity; pass --conversation NAME once per calling environment. A shared workspace is not a safe conversation identity.');
  if (!/^[a-zA-Z0-9_.:-]{1,160}$/.test(id)) throw new Error('Invalid conversation identity');
  return id;
}
export function redact(value: string): string {
  return value.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)/gi, '[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization)\s*[=:]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}
