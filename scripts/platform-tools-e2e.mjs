// Live check of the collaboration tools: a real team works and waits through them, then a restart
// must keep them working. Makes real model calls, so it needs --authorized-this-run. Never part of npm test.
// Usage: node scripts/platform-tools-e2e.mjs --authorized-this-run [--lead luna|haiku|qwen]
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PlatformSession } from '../dist/platform/session.js';
import { createAdapter } from '../dist/platform/adapters/index.js';
import { makeFixture, protectedDirs, changedFiles, scrubbedEnv } from './validation-common.mjs';
import { sanitize } from '../dist/platform/storage.js';

const argv = process.argv.slice(2);
if (!argv.includes('--authorized-this-run')) throw new Error('--authorized-this-run is required; this script makes real model calls');
const lead = argv[argv.indexOf('--lead') + 1] && argv.includes('--lead') ? argv[argv.indexOf('--lead') + 1] : 'luna';
const root = mkdtempSync(join(tmpdir(), 'agents-tools-e2e-'));
const fx = makeFixture(root, randomUUID()), before = protectedDirs(fx);
const all = { luna: { harness: 'codex', model: 'gpt-6-luna', effort: 'low' }, haiku: { harness: 'claude', model: 'claude-haiku-5-5', effort: 'low' }, qwen: { harness: 'dsh', model: 'local' } };
const config = { workspace: fx.a, sessionRoot: join(root, 'sessions'), maxTurns: 40, turnTimeoutMs: 600000, members: Object.entries(all).map(([name, m]) => ({ name, ...m, role: name === lead ? 'lead' : 'worker' })) };
const events = [];
const onEvent = event => {
  events.push(event);
  const who = event.member ?? event.author ?? '';
  if (['tool-call', 'wait-start', 'wait-resume', 'wait-cancelled', 'turn-start', 'turn-end', 'board', 'dm', 'spin-warning', 'steer-redelivered', 'member-failed', 'settled', 'to-user', 'protocol-warning', 'reply-forwarded'].includes(event.type))
    process.stderr.write(`${event.at.slice(11, 19)} ${who} ${event.type} ${String(event.tool ?? event.status ?? event.text ?? '').replace(/\s+/g, ' ').slice(0, 110)}\n`);
};
const report = { root, lead, phases: {} };
let session = new PlatformSession(config, createAdapter, onEvent);
try {
  await session.start();
  session.sendUser('Fix the sumRange off-by-one error in src/calc.mjs, add isEven(n), and add unit tests for both. One worker implements, the other reviews and must reply with its findings. Wait for both before telling me it is done. Keep it short.');
  await session.waitForSettled();
  report.phases.first = session.summary();
  const id = session.id, harnessIds = Object.fromEntries(events.filter(e => e.type === 'member-start').map(e => [e.member, e.harnessId]));
  await session.stop(false);
  const start = events.length;
  const saved = readFileSync(join(session.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  session = new PlatformSession(config, createAdapter, onEvent, { id, events: saved, harnessIds });
  await session.start();
  session.sendUser('After a restart: ask each teammate to post the word RESUMED with post_board, wait for both, then tell me what the first task changed, in one sentence.');
  await session.waitForSettled();
  report.phases.resumed = session.summary();
  const after = events.slice(start);
  report.resumedPosts = Object.keys(all).filter(name => after.some(e => e.type === 'board' && e.author === name && /RESUMED/.test(String(e.text))));
  report.reportedAfterResume = after.filter(e => e.type === 'to-user').map(e => String(e.text).slice(0, 300));
} catch (error) { report.error = String(error?.stack ?? error).slice(0, 1500); }
finally { await session.stop().catch(() => {}); }
const tests = spawnSync(process.execPath, ['--test'], { cwd: fx.a, env: scrubbedEnv(), encoding: 'utf8', windowsHide: true, timeout: 60000 });
const functional = spawnSync(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict'; import {sumRange,isEven} from './src/calc.mjs'; assert.equal(sumRange(1,4),10); assert.equal(isEven(4),true); assert.equal(isEven(3),false);"], { cwd: fx.a, env: scrubbedEnv(), encoding: 'utf8', windowsHide: true, timeout: 60000 });
const changed = changedFiles(before, protectedDirs(fx));
const usedTools = Object.fromEntries(Object.keys(all).map(name => [name, [...new Set(events.filter(e => e.type === 'tool-call' && e.member === name).map(e => e.tool))]]));
const commands = events.filter(e => e.type === 'tool' && typeof e.command === 'string').map(e => e.command);
// A wait is only real if the member did nothing during it.
const waits = []; const open = new Map();
for (const e of events) {
  if (e.type === 'wait-start') open.set(e.member, { member: e.member, from: Date.parse(e.at), calls: 0 });
  else if (e.type === 'tool-call' && open.has(e.member)) open.get(e.member).calls++;
  else if (['wait-resume', 'wait-cancelled', 'turn-end'].includes(e.type) && open.has(e.member)) { const w = open.get(e.member); open.delete(e.member); waits.push({ member: w.member, seconds: Math.round((Date.parse(e.at) - w.from) / 1000), callsDuring: w.calls, ended: e.type }); }
}
Object.assign(report, {
  usedTools, waits, tests: { pass: tests.status === 0, stdout: tests.stdout.slice(-400) }, functional: { pass: functional.status === 0, stderr: functional.stderr.slice(-300) },
  spinWarnings: events.filter(e => e.type === 'spin-warning').map(e => ({ member: e.member, command: e.command })), sleepCommands: commands.filter(c => /\b(sleep|start-sleep)\b/i.test(c)),
  markerBlocks: events.filter(e => (e.type === 'member-text' || e.type === 'to-user') && /<<<|<tool_call>/.test(String(e.text))).length,
  emptyBoardReads: events.filter(e => e.type === 'tool-call' && e.tool === 'read_board').length,
  protectedChanges: changed, failed: events.filter(e => e.type === 'member-failed').map(e => ({ member: e.member, error: e.error })),
  boardEntries: events.filter(e => e.type === 'board').length, messages: events.filter(e => e.type === 'dm').length,
  toUser: events.filter(e => e.type === 'to-user').map(e => String(e.text).slice(0, 300)),
});
report.pass = !report.error && tests.status === 0 && functional.status === 0 && !changed.length && !report.failed.length && !report.spinWarnings.length && !report.sleepCommands.length && Object.values(usedTools).every(t => t.length > 0) && waits.every(w => w.callsDuring === 0) && report.resumedPosts?.length >= 2 && report.reportedAfterResume?.length > 0;
const clean = sanitize(report);
writeFileSync(join(root, 'report.json'), JSON.stringify(clean, null, 2));
console.log(JSON.stringify(clean, null, 2));
process.exit(report.pass ? 0 : 1);
