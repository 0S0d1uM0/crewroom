import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, statSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { scrubbedEnv } from './env.js';
import { redact } from '../config.js';
import type { PlatformEvent } from './types.js';

export function sanitize(value: unknown): any {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
  return value;
}
export class SessionStorage {
  // What the platform itself wrote, so a direct edit by an agent can be detected and undone.
  private canonical = new Map<string, string>();
  constructor(readonly dir: string, private callback: (e: PlatformEvent) => void = () => {}) { mkdirSync(join(dir, 'board'), { recursive: true }); }
  event(type: string, data: Record<string, unknown> = {}) {
    const event: PlatformEvent = sanitize({ ...data, type, at: new Date().toISOString() });
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify(event) + '\n'); this.callback(event); return event;
  }
  seedBoard(name: string) {
    const header = '# Team board. Written by the platform; read-only for agents.\n\n';
    this.canonical.set(name, header); writeFileSync(join(this.dir, 'board', name + '.md'), header);
  }
  // Returns the board files an agent changed directly, after restoring them.
  restoreBoard(): string[] {
    const changed: string[] = [];
    for (const [name, content] of this.canonical) {
      const path = join(this.dir, 'board', name + '.md');
      let current: string | undefined; try { current = readFileSync(path, 'utf8'); } catch {}
      if (current !== content) { changed.push(name); writeFileSync(path, content); }
    }
    return changed;
  }
  board(id: string, author: string, text: string, at = new Date().toISOString()) {
    // Indenting entry content prevents a forged Markdown header from becoming an entry.
    const entry = `### [${id}] ${at} ${author}\n\n${redact(text).split('\n').map(l => '    ' + l).join('\n')}\n\n`;
    for (const name of ['all', author]) { appendFileSync(join(this.dir, 'board', name + '.md'), entry); this.canonical.set(name, (this.canonical.get(name) ?? '') + entry); }
  }
}
export function git(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...scrubbedEnv(), ...extra }, timeout: 30000 }).trim();
}
export function isGit(cwd: string) { try { return git(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true'; } catch { return false; } }

export function gitAsync(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}, timeout = 30000): Promise<string> {
  return new Promise((yes, no) => {
    execFile('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true,
      env: { ...scrubbedEnv(), ...extra }, timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => error ? no(error) : yes(stdout.replace(/\r?\n$/, '')));
  });
}
const identity = { GIT_AUTHOR_NAME: 'Crewroom', GIT_AUTHOR_EMAIL: 'crewroom@localhost', GIT_COMMITTER_NAME: 'Crewroom', GIT_COMMITTER_EMAIL: 'crewroom@localhost' };
export const SECRET_EXCLUDES = ['.env', '.env.*', '*.pem', '*.key', 'id_rsa*', '*credentials*'];
export const MAX_UNTRACKED_FILES = 50000, MAX_UNTRACKED_BYTES = 2 * 1024 ** 3;
export async function directoryStats(cwd: string) {
  const { readdir, lstat } = await import('node:fs/promises');
  let files = 0, bytes = 0, largeFiles = 0;
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) await walk(path);
      else if (e.isFile()) { const st = await lstat(path); files++; bytes += st.size; if (st.size > 100 * 1024 ** 2) largeFiles++; }
    }
  }
  await walk(cwd); return { files, bytes, largeFiles, excludes: SECRET_EXCLUDES };
}
export async function initRepository(cwd: string) {
  if (isGit(cwd)) throw new Error('这个文件夹已经在 Git 仓库里了');
  if (existsSync(join(cwd, '.git'))) throw new Error('文件夹里已有 .git，但 Git 无法识别，请先检查它');
  await gitAsync(cwd, ['init'], {}, 0);
  await gitAsync(cwd, ['config', '--local', 'core.autocrlf', 'false']);
  writeFileSync(join(cwd, '.git', 'info', 'attributes'), '* -text -filter -ident\n');
  appendFileSync(join(cwd, '.git', 'info', 'exclude'), '\n' + SECRET_EXCLUDES.join('\n') + '\n');
  try {
    await gitAsync(cwd, ['add', '-A'], {}, 0);
    await gitAsync(cwd, ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initialize repository'], identity, 0);
  } catch (error) { throw new Error('Git 仓库已创建，但初始提交失败：' + String(error)); }
  const ignored = (await gitAsync(cwd, ['-c', 'core.quotepath=false', 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  const secret = (path: string) => path.split('/').some(name => /^(?:\.env(?:\..*)?|.*\.pem|.*\.key|id_rsa.*|.*credentials.*)$/.test(name));
  return { branch: await gitAsync(cwd, ['symbolic-ref', '--short', 'HEAD']), commit: await gitAsync(cwd, ['rev-parse', '--short', 'HEAD']),
    excluded: ignored.filter(secret), previouslyIgnored: ignored.filter(path => !secret(path)) };
}
export interface SnapshotOptions { timeoutMs?: number; runGit?: typeof gitAsync }
async function takeSnapshot(cwd: string, dir: string, session: string, sequence: number, options: SnapshotOptions) {
  const runGit = options.runGit ?? gitAsync;
  let ancestor = cwd;
  while (!existsSync(join(ancestor, '.git'))) { if ((process.env.GIT_CEILING_DIRECTORIES ?? '').split(process.platform === 'win32' ? ';' : ':').includes(ancestor)) return undefined; const parent = dirname(ancestor); if (parent === ancestor) return undefined; ancestor = parent; }
  try { await runGit(cwd, ['rev-parse', '--is-inside-work-tree']); } catch { return undefined; }
  const worktree = statSync(join(ancestor, '.git')).isFile();
  const index = join(dir, worktree ? 'snapshot-index-' + createHash('sha256').update(cwd).digest('hex').slice(0, 12) : 'snapshot-index'), env = { GIT_INDEX_FILE: index, ...identity };
  const { lstat, unlink, copyFile } = await import('node:fs/promises');
  // The index is private to this session and all writers are serialized above.
  // A killed Git may leave its lock behind, including across service restarts.
  await unlink(index + '.lock').catch(() => {});
  if (!existsSync(index)) { try { await runGit(cwd, ['read-tree', 'HEAD'], env); } catch { await runGit(cwd, ['read-tree', '--empty'], env); } }
  let count = 0, bytes = 0, limited = false;
  for (const file of (await runGit(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)) {
    const st = await lstat(join(cwd, file)).catch(() => null); count++;
    if (!st) { limited = true; break; } // Cannot safely bound the size: use tracked-only mode.
    bytes += st.size;
    if (count > MAX_UNTRACKED_FILES || bytes > MAX_UNTRACKED_BYTES) { limited = true; break; }
  }
  try {
    if (limited) {
      // Copy the user's index into our private one, including newly staged files,
      // then refresh tracked content without changing the user's staged state.
      const userIndex = resolve(cwd, await runGit(cwd, ['rev-parse', '--git-path', 'index']));
      try { await copyFile(userIndex, index); }
      catch { try { await runGit(cwd, ['read-tree', 'HEAD'], env); } catch { await runGit(cwd, ['read-tree', '--empty'], env); } }
    }
    await runGit(cwd, limited ? ['add', '-u'] : ['add', '-A'], env, options.timeoutMs ?? 180000);
    const tree = await runGit(cwd, ['write-tree'], env);
    let parent: string | undefined; try { parent = await runGit(cwd, ['rev-parse', 'HEAD']); } catch {}
    const commit = await runGit(cwd, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', 'Crewroom turn ' + sequence], env);
    const ref = 'refs/agents/' + session + '/' + sequence;
    await runGit(cwd, ['update-ref', ref, commit], env); return { ref, commit, limited };
  } catch (error) { await unlink(index + '.lock').catch(() => {}); throw error; }
}
type SnapshotResult = Awaited<ReturnType<typeof takeSnapshot>>;
const snapshots = new Map<string, { running?: Promise<SnapshotResult>; next?: () => Promise<SnapshotResult>; failures: number; disabled: boolean }>();
export function snapshot(cwd: string, dir: string, session: string, sequence: number, options: SnapshotOptions = {}): Promise<SnapshotResult> {
  let state = snapshots.get(dir);
  if (!state) { state = { failures: 0, disabled: false }; snapshots.set(dir, state); }
  const current = state;
  const run = async () => {
    if (current.disabled) return undefined;
    try { const value = await takeSnapshot(cwd, dir, session, sequence, options); current.failures = 0; return value; }
    catch (error) { if (++current.failures >= 3) current.disabled = true; throw new Error(String(error) + (current.disabled ? '；连续失败，本次会话快照已关闭' : '')); }
  };
  if (current.running) { current.next = run; return current.running; }
  current.running = (async () => {
    let result: SnapshotResult, task: (() => Promise<SnapshotResult>) | undefined = run;
    try { while (task) { current.next = undefined; result = await task(); task = current.next; } return result; }
    finally { current.running = undefined; current.next = undefined; }
  })();
  return current.running;
}

export function releaseSnapshots(dir: string) { snapshots.delete(dir); }
