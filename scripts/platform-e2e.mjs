// Live team validation. Never part of npm test.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PlatformSession } from '../dist/platform/session.js';
import { createAdapter } from '../dist/platform/adapters/index.js';
import { makeFixture, protectedDirs, changedFiles, scrubbedEnv } from './validation-common.mjs';
import { sanitize } from '../dist/platform/storage.js';

if (!process.argv.includes('--authorized-this-run')) throw new Error('Explicit approval and --authorized-this-run are required; this script makes real model calls');
const root = mkdtempSync(join(tmpdir(), 'crewroom-e2e-'));
const fx = makeFixture(root, randomUUID()), before = protectedDirs(fx);
const events = [];
const session = new PlatformSession({ workspace: fx.a, maxTurns: 15, turnTimeoutMs: 600000, members: [
  { name: 'lead', harness: 'claude', model: 'claude-haiku-5-5', effort: 'low', role: 'lead' },
  { name: 'qwen', harness: 'dsh', model: 'local', role: 'worker' },
  { name: 'luna', harness: 'codex', model: 'gpt-6-luna', effort: 'low', role: 'worker' },
] }, createAdapter, event => { events.push(event); if (event.type === 'to-user') process.stderr.write(String(event.text) + '\n'); });
let interrupted = false;
const shutdown = () => { interrupted = true; void session.stop(); };
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
let error;
try {
  await session.start();
  session.sendUser('Fix the sumRange off-by-one error in src/calc.mjs, add isEven(n), and add unit tests for both. Assign implementation to one worker and have the other worker review it. Tell me when it is done.');
  await session.waitForSettled();
} catch (e) { error = String(e); }
finally { await session.stop(); process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown); }
const tests = spawnSync(process.execPath, ['--test'], { cwd: fx.a, env: scrubbedEnv(), encoding: 'utf8', windowsHide: true, timeout: 60000 });
const functional = spawnSync(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import {sumRange,isEven} from './src/calc.mjs'; assert.equal(sumRange(1,4),10); assert.equal(sumRange(2,2),2); assert.equal(isEven(4),true); assert.equal(isEven(3),false); assert.equal(isEven(-2),true);"],
  { cwd: fx.a, env: scrubbedEnv(), encoding: 'utf8', windowsHide: true, timeout: 60000 });
const changed = changedFiles(before, protectedDirs(fx));
// Plain worker text reaches nobody, so only routed messages count as speaking.
const spoken = Object.fromEntries(session.config.members.map(m => [m.name, events.some(e => (['board', 'dm'].includes(e.type) && e.author === m.name) || (e.type === 'to-user' && e.member === m.name) || (e.type === 'reply-forwarded' && e.recipient === m.name))]));
const tampered = events.filter(e => e.type === 'board-tampered').map(e => ({ members: e.members, files: e.files }));
const calc = readFileSync(join(fx.a, 'src', 'calc.mjs'), 'utf8');
const report = sanitize({ root, error, interrupted, summary: session.summary(), tests: { pass: tests.status === 0, stdout: tests.stdout, stderr: tests.stderr }, spoken,
  functionalChecks: { pass: functional.status === 0, stderr: functional.stderr },
  boardEntries: events.filter(e => e.type === 'board').length, directMessages: events.filter(e => e.type === 'dm').length,
  protectedChanges: changed, boardTampered: tampered, snapshots: events.filter(e => e.type === 'snapshot' && e.commit).length,
  guardReached: events.some(e => e.type === 'guard'), hasIsEven: /export\s+(?:function\s+isEven|const\s+isEven)/.test(calc),
  pass: !error && !interrupted && tests.status === 0 && functional.status === 0 && !changed.length && !tampered.length && Object.values(spoken).every(Boolean) &&
    events.some(e => e.type === 'board') && events.some(e => e.type === 'snapshot' && e.commit) });
console.log(JSON.stringify(report, null, 2));
if (interrupted) process.exitCode = 130;
else if (!report.pass) process.exitCode = 1;
