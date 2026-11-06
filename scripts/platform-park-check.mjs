// A real Codex member waits for a teammate who answers after minutes. Does it cost any model calls
// while it waits, and does the answer reach it? Needs --authorized-this-run. Never part of npm test.
// Usage: node scripts/platform-park-check.mjs --authorized-this-run [--delay-ms 120000]
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PlatformSession } from '../dist/platform/session.js';
import { createAdapter } from '../dist/platform/adapters/index.js';
import { makeFixture } from './validation-common.mjs';

const argv = process.argv.slice(2);
if (!argv.includes('--authorized-this-run')) throw new Error('--authorized-this-run is required; this script makes real model calls');
const delayMs = argv.includes('--delay-ms') ? Number(argv[argv.indexOf('--delay-ms') + 1]) : 120000;
const root = mkdtempSync(join(tmpdir(), 'agents-park-')), fx = makeFixture(root, randomUUID());
const answer = `ANSWER-${randomUUID().slice(0, 8)}`;
class Slow {
  onMessage = () => {}; onEvent = () => {};
  async start() {} async steer() { return 'unsupported'; } async interrupt() {} async stop() {}
  async prompt() { await new Promise(resolve => setTimeout(resolve, delayMs)); await this.tools.call('message_teammate', { to: 'luna', text: `The code word is ${answer}` }); return { status: 'completed' }; }
}
const events = [];
const session = new PlatformSession({ workspace: fx.a, sessionRoot: join(root, 'sessions'), members: [
  { name: 'luna', harness: 'codex', model: 'gpt-6-luna', effort: 'low', role: 'lead' },
  { name: 'slow', harness: 'codex', model: 'fake', role: 'worker' },
] }, (member, workspace, dir) => member.name === 'slow' ? new Slow() : createAdapter(member, workspace, dir), event => {
  events.push(event);
  if (['tool-call', 'wait-start', 'wait-parked', 'wait-resume', 'turn-start', 'turn-end', 'to-user', 'settled', 'spin-warning'].includes(event.type)) process.stderr.write(`${event.at.slice(11, 19)} ${event.member ?? ''} ${event.type} ${String(event.tool ?? event.status ?? event.text ?? '').replace(/\s+/g, ' ').slice(0, 100)}\n`);
});
const report = { root, delayMs };
try {
  await session.start();
  session.sendUser('Ask slow for the code word, with reply requested. Then wait for the answer. When it arrives, tell me the code word.');
  await session.waitForSettled();
  report.summary = session.summary();
  const id = events.find(e => e.type === 'member-start' && e.member === 'luna').harnessId;
  const day = new Date().toISOString().slice(0, 10).split('-');
  const dir = join(homedir(), '.codex', 'sessions', ...day), file = readdirSync(dir).find(name => name.includes(id));
  const lines = readFileSync(join(dir, file), 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  // Only the tool names and how many: what a poll would look like.
  const calls = lines.filter(l => ['function_call', 'custom_tool_call'].includes(l.payload?.type)).map(l => ({ at: String(l.timestamp).slice(11, 19), ms: Date.parse(l.timestamp), name: l.payload.name }));
  report.modelToolCalls = calls;
  // A wait call before the model starts waiting is not polling; one during the block is.
  const blocked = Date.parse(events.find(e => e.type === 'wait-start' && e.member === 'luna').at);
  report.pollsOfWait = calls.filter(c => c.name === 'wait' && c.ms >= blocked).length;
  report.callsDuringWait = calls.filter(c => c.ms >= blocked).length;
} catch (error) { report.error = String(error?.stack ?? error).slice(0, 1200); }
finally { await session.stop().catch(() => {}); }
const told = events.filter(e => e.type === 'to-user').map(e => String(e.text));
report.parked = events.filter(e => e.type === 'wait-parked').length;
report.answerReachedUser = told.some(text => text.includes(answer));
report.toUser = told.map(text => text.slice(0, 200));
report.pass = !report.error && report.answerReachedUser && report.parked >= 1 && report.pollsOfWait === 0 && report.callsDuringWait === 0;
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
