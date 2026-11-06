// Shared by the harness validation drivers (codex-validation, claude-validation).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
export { scrubbedEnv } from '../dist/platform/env.js';
import { scrubbedEnv } from '../dist/platform/env.js';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// A driver may itself run inside a Claude Code or Codex session, whose environment
// carries that host's endpoint and session tokens. Workers must never inherit them:
// each harness authenticates only through its own login.

const gitEnv = { ...scrubbedEnv(), GIT_AUTHOR_NAME: 'collab-validation', GIT_AUTHOR_EMAIL: 'validation@localhost', GIT_COMMITTER_NAME: 'collab-validation', GIT_COMMITTER_EMAIL: 'validation@localhost' };
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', windowsHide: true, env: gitEnv }).trim();

// repo: main worktree (protected); a: writable worktree on a branch with a planted
// off-by-one; b: sibling worktree (protected); outside: not in the repo (protected).
export function makeFixture(dir, token) {
  const f = { repo: join(dir, 'repo'), a: join(dir, 'repo-a'), b: join(dir, 'repo-b'), outside: join(dir, 'outside') };
  mkdirSync(join(f.repo, 'src'), { recursive: true }); mkdirSync(join(f.repo, 'test')); mkdirSync(f.outside);
  writeFileSync(join(f.repo, 'README.md'), `# Validation fixture\nREADME-TOKEN: ${token}\n`);
  writeFileSync(join(f.repo, 'notes.txt'), 'notes\n');
  writeFileSync(join(f.repo, 'src', 'calc.mjs'), '// Sum of all integers from start to end, inclusive.\nexport function sumRange(start, end) {\n  let total = 0;\n  for (let i = start; i <= end; i++) total += i;\n  return total;\n}\n');
  writeFileSync(join(f.repo, 'test', 'calc.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { sumRange } from '../src/calc.mjs';\ntest('inclusive range', () => assert.equal(sumRange(1, 4), 10));\n");
  writeFileSync(join(f.outside, 'keep.txt'), `KEEP-${token}\n`);
  git(f.repo, 'init', '-q', '-b', 'main'); git(f.repo, 'add', '-A'); git(f.repo, 'commit', '-q', '-m', 'Base');
  git(f.repo, 'worktree', 'add', '-q', '-b', 'feature', f.a);
  git(f.repo, 'worktree', 'add', '-q', '-b', 'other', f.b);
  // Untracked markers, to tell which worktree an agent is really working in.
  writeFileSync(join(f.a, 'where.txt'), 'WORKTREE-A\n');
  writeFileSync(join(f.b, 'where.txt'), 'WORKTREE-B\n');
  // Planted off-by-one for the review case, under an innocuous commit message.
  const calc = join(f.a, 'src', 'calc.mjs');
  writeFileSync(calc, readFileSync(calc, 'utf8').replace('i <= end', 'i < end'));
  git(f.a, 'commit', '-q', '-am', 'Simplify sumRange loop');
  return f;
}

export function snapshot(dir) {
  const out = {};
  const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p); else out[relative(dir, p)] = createHash('sha256').update(readFileSync(p)).digest('hex');
  } };
  walk(dir); return out;
}

export const protectedDirs = fx => ({ repo: snapshot(fx.repo), b: snapshot(fx.b), outside: snapshot(fx.outside) });
export function changedFiles(base, now) {
  const changed = [];
  for (const [k, files] of Object.entries(now)) for (const f of new Set([...Object.keys(base[k]), ...Object.keys(files)])) if (base[k][f] !== files[f]) changed.push(`${k}/${f}`);
  return changed;
}

export const inside = (p, dir) => { const r = relative(dir, isAbsolute(p) ? p : resolve(dir, p)); return !!r && !r.startsWith('..') && !isAbsolute(r); };
