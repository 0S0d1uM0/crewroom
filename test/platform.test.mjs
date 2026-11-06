import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtocolParser, mentions } from '../dist/platform/protocol.js';
import { parseConfig } from '../dist/platform/config.js';
import { PlatformSession } from '../dist/platform/session.js';
import { shellAllowed } from '../dist/platform/permissions.js';
import { scrubbedEnv } from '../dist/platform/env.js';
import { git, snapshot } from '../dist/platform/storage.js';
import { main } from '../dist/platform/cli.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
const base = members => ({ workspace: '.', members: members ?? [{ harness: 'codex', model: 'fake', role: 'lead' }] });
class Fake {
  onMessage = () => {}; onEvent = () => {}; prompts = []; steers = []; interrupts = 0; stops = 0;
  constructor(script = async () => ({ status: 'completed', usage: { totalTokens: 3 } })) { this.script = script; }
  async start(instructions) { this.instructions = instructions; }
  async prompt(text) { this.prompts.push(text); return await this.script(this, text, this.prompts.length); }
  async steer(text) { this.steers.push(text); return this.steerResult ?? 'steered'; }
  async interrupt() { this.interrupts++; }
  async stop() { this.stops++; }
}
async function team(t, scripts = {}, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'platform-unit-')), workspace = join(root, 'workspace'); mkdirSync(workspace);
  const adapters = {}, events = [];
  const session = new PlatformSession({ ...base([
    { name: 'lead', harness: 'codex', model: 'fake', role: 'lead' },
    { name: 'qwen', harness: 'dsh', model: 'local', role: 'worker' },
    { name: 'sol', harness: 'codex', model: 'fake', role: 'worker' },
  ]), workspace, sessionRoot: join(root, 'sessions'), maxTurns: 30, ...config }, m => adapters[m.name] = new Fake(scripts[m.name]), e => events.push(e));
  t.after(async () => { await session.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start(); return { session, adapters, events, root, workspace };
}
const completed = { status: 'completed', usage: { totalTokens: 5 } };

test('platform parser: multiple blocks, plain text, unknown targets and unclosed blocks', () => {
  const p = new ProtocolParser(['lead', 'qwen']);
  const a = p.message('Hello\n<<<board\n@qwen? work\n>>>\n<<<dm qwen\nprivate\n>>>\n<<<dm stranger\nunknown\n>>>\n<<<alien\nx\n>>>');
  assert.equal(a.filter(x => x.type === 'board').length, 1);
  assert.deepEqual(a.find(x => x.type === 'dm'), { type: 'dm', target: 'qwen', reply: false, text: 'private' });
  assert.equal(a.filter(x => x.type === 'warning').length, 2);
  assert.ok(a.some(x => x.type === 'text' && x.text.includes('<<<dm stranger')));
  assert.deepEqual(p.message('<<<dm? qwen\npart one'), []);
  assert.deepEqual(p.message('part two\n>>>'), [{ type: 'dm', target: 'qwen', reply: true, text: 'part one\npart two' }]);
  p.message('<<<board\nlast'); assert.deepEqual(p.end().map(x => x.type), ['warning', 'board']);
});
test('platform mentions ignore fences, inline code, quotes, emails and unknown names', () => {
  const text = '@qwen @lead? @qwen?\n```ts\n@sol\n```\n> @sol?\n`@sol` a@sol.com @nobody @sol.com\n~~~\n@sol\n~~~';
  assert.deepEqual(mentions(text, ['qwen', 'lead', 'sol']), [{ name: 'qwen', reply: true }, { name: 'lead', reply: true }]);
  assert.deepEqual(mentions('a@qwen 7@lead @sol?', ['lead', 'qwen', 'sol']), [{ name: 'sol', reply: true }]);
  assert.deepEqual(mentions('@sol?. @qwen.com @lead,', ['lead', 'qwen', 'sol']), [{ name: 'sol', reply: true }, { name: 'lead', reply: false }]);
  assert.deepEqual(mentions('Please review this, @qwen.\nDone @sol.', ['qwen', 'sol']), [{ name: 'qwen', reply: false }, { name: 'sol', reply: false }]);
  const p = new ProtocolParser(['lead']);
  assert.ok(p.message('```\n<<<board\nx\n>>>\n```').every(x => x.type === 'text'));
  assert.deepEqual(p.end(), []);
});
test('platform config validates roles, names, local concurrency and cloud rejection', () => {
  const c = parseConfig(base([{ harness: 'claude', model: 'haiku', role: 'lead' }, { harness: 'codex', model: 'x', role: 'worker' }, { harness: 'codex', model: 'x', role: 'worker' }]));
  assert.deepEqual(c.members.map(m => m.name), ['lead', 'codex-1', 'codex-2']); assert.equal(c.mode, 'shared'); assert.equal(c.maxTurns, undefined);
  assert.throws(() => parseConfig(base([])), /lead|small/i);
  assert.throws(() => parseConfig(base([{ harness: 'dsh', model: 'deepseek', role: 'lead' }])), /model list/);
  assert.throws(() => parseConfig(base([{ harness: 'dsh', model: 'local', role: 'lead' }, { harness: 'dsh', model: 'local', role: 'worker' }])), /At most one/);
  for (const name of ['../bad', 'all']) assert.throws(() => parseConfig(base([{ name, harness: 'codex', model: 'x', role: 'lead' }])));
  assert.throws(() => parseConfig(base([{ name: 'lead', harness: 'codex', model: 'x', role: 'lead' }, { name: 'lead', harness: 'codex', model: 'x', role: 'worker' }])), /unique/);
});
test('platform environment removes inherited host endpoints and tokens', () => {
  const env = scrubbedEnv({ ANTHROPIC_API_KEY: 'fake', ANTHROPIC_BASE_URL: 'fake', CLAUDECODE: '1', CLAUDE_CODE_SESSION: 'x', CLAUDE_CONFIG_DIR: '/test', CODEX_THREAD_ID: 'x', CODEX_SESSION_ID: 'x', PATH: 'keep' });
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: '/test', PATH: 'keep', CREWROOM_PLATFORM_WORKER: '1' });
});
test('platform shell check rejects escapes, external absolute paths, pushes and collab', () => {
  const workspace = 'C:\\project', session = 'C:\\sessions\\one';
  for (const cmd of ['git push origin main', 'git -C . push', 'COLLAB.cmd send hi', 'cat ../outside', 'cd ..', 'cat sub/../../outside', 'type C:\\outside\\x', 'type "C:\\other dir\\x"', 'cat /etc/passwd', 'cat ~\\x']) {
    assert.equal(shellAllowed(cmd, workspace, session), false, cmd);
  }
  for (const cmd of ['git status', 'node --test', 'type C:\\project\\x', 'type "C:\\sessions\\one\\board\\all.md"', 'type .\\src\\x']) assert.equal(shellAllowed(cmd, workspace, session), true, cmd);
  for (const cmd of ['cat ./src/calc.mjs', 'cat src/calc.mjs', 'cat /tmp/project/src/calc.mjs', 'cat /tmp/session/board.md']) assert.equal(shellAllowed(cmd, '/tmp/project', '/tmp/session'), true, cmd);
  assert.equal(shellAllowed('node -e "read(\'C:\\outside\\x\')"', workspace, session), false);
});
test('platform sends the roster and records worker text without forwarding it', async t => {
  const { session, adapters, events } = await team(t, { lead: async a => { a.onMessage('<<<steer qwen\nwork\n>>>\nUser response'); return completed; }, qwen: async a => { a.onMessage('internal reply'); return completed; } }, { maxTurns: 3 });
  session.sendUser('start'); await session.waitForSettled();
  assert.ok(adapters.lead.instructions.includes('qwen: dsh, local, worker'));
  assert.ok(adapters.lead.prompts[0].startsWith('[from user]'));
  assert.ok(events.some(e => e.type === 'member-text' && e.text === 'internal reply'));
  assert.ok(!events.some(e => e.type === 'to-user' && e.text === 'internal reply'));
});
test('platform routes intermediate messages immediately and batches busy board deliveries', async t => {
  const hold = deferred(), woke = deferred();
  const { session, adapters } = await team(t, {
    lead: async (a, _, n) => { if (n === 1) { a.onMessage('<<<board\n@qwen? first\n>>>'); await hold.promise; } return completed; },
    qwen: async (a, _, n) => { if (n === 1) { woke.resolve(); await hold.promise; } return completed; },
  });
  session.sendUser('start'); await woke.promise;
  assert.equal(adapters.lead.prompts.length, 1); assert.equal(session.members.get('lead').state, 'busy');
  adapters.qwen.steerResult = 'unsupported';
  adapters.lead.onMessage('<<<board\n@qwen? second\n>>>\n<<<board\n@qwen? third\n>>>');
  await tick(); assert.equal(adapters.qwen.prompts.length, 1); assert.equal(adapters.qwen.steers.length, 2);
  hold.resolve(); await session.waitForSettled();
  assert.equal(adapters.qwen.prompts.length, 2); assert.match(adapters.qwen.prompts[1], /second[\s\S]*third/);
});
test('platform busy DMs steer, and a steer the worker cannot take waits for its turn to end', async t => {
  const hold = deferred();
  const { session, adapters, events } = await team(t, {
    lead: async (a, _, n) => { if (n === 1) { a.onMessage('<<<board\n@qwen? begin\n>>>'); await hold.promise; } return completed; },
    qwen: async (a, _, n) => { if (n === 1) await hold.promise; return completed; },
  });
  session.sendUser('start'); await tick();
  adapters.lead.onMessage('<<<dm qwen\nsteer-one\n>>>'); await tick();
  assert.equal(adapters.qwen.steers.length, 1); assert.ok(events.some(e => e.type === 'dm' && e.steered));
  adapters.qwen.steerResult = 'unsupported';
  adapters.lead.onMessage('<<<dm qwen\nfallback-one\n>>>\n<<<dm qwen\nfallback-two\n>>>'); await tick();
  hold.resolve(); await session.waitForSettled();
  // From the lead, so a steer that fails still wakes the worker afterwards, once, with both.
  assert.equal(adapters.qwen.prompts.length, 2);
  assert.match(adapters.qwen.prompts[1], /fallback-one[\s\S]*fallback-two/);
  assert.equal(events.filter(e => e.type === 'dm').length, 3);
});
test('platform reply requests clear on a later DM or board mention and unresolved ones remain', async t => {
  const { session, events } = await team(t, {
    lead: async (a, _, n) => { if (n === 1) a.onMessage('<<<board\n@qwen? do it\n>>>\n<<<dm? sol\nplease reply\n>>>'); return completed; },
    qwen: async a => { a.onMessage('<<<dm lead\nDone\n>>>'); return completed; },
  });
  session.sendUser('start'); await session.waitForSettled();
  assert.equal(session.pending.length, 1); assert.equal(session.pending[0].recipient, 'sol');
  assert.ok(events.some(e => e.type === 'reply-cleared' && e.recipient === 'qwen'));
  const { session: s2 } = await team(t, {
    lead: async (a, _, n) => { if (n === 1) a.onMessage('<<<dm? qwen\nRequest\n>>>'); return completed; },
    qwen: async a => { a.onMessage('<<<board\n@lead Done\n>>>'); return completed; },
  });
  s2.sendUser('start'); await s2.waitForSettled(); assert.equal(s2.pending.length, 0);
});
test('platform workers cannot interrupt or steer and unknown targets notify the sender', async t => {
  const { session, adapters, events } = await team(t, {
    lead: async (a, _, n) => { if (n === 1) a.onMessage('<<<dm? qwen\nwork\n>>>'); return completed; },
    qwen: async (a, _, n) => { if (n === 1) a.onMessage('<<<interrupt all\nno\n>>>\n<<<steer lead\nno\n>>>\n<<<dm absent\nno\n>>>'); return completed; },
  });
  session.sendUser('start'); await session.waitForSettled();
  assert.equal(adapters.lead.interrupts, 0); assert.equal(adapters.sol.prompts.length, 0);
  assert.equal(events.filter(e => e.type === 'protocol-warning').length, 3);
  assert.match(adapters.qwen.prompts[1], /Only the lead may interrupt[\s\S]*Unknown block/);
});
test('platform all-idle wakes the lead once, then settles without a loop', async t => {
  const { session, adapters, events } = await team(t, {
    lead: async (a, _, n) => { if (n === 1) a.onMessage('<<<board\n@qwen? task\n>>>'); return completed; },
  });
  session.sendUser('start'); await session.waitForSettled();
  assert.equal(adapters.lead.prompts.length, 2); assert.equal(adapters.lead.prompts[1], '[platform] Nobody is working and no message is on the way. Team: lead: idle, qwen: idle, sol: idle. Unanswered: lead asked qwen. Reply only if there is something the user has not heard.');
  assert.equal(events.filter(e => e.type === 'settled').length, 1); assert.equal(events.filter(e => e.type === 'guard').length, 0);
});
test('platform all-idle also wakes the lead for a worker that finished during the lead turn without mentioning it', async t => {
  const leadFinish = deferred();
  const { session, adapters, events } = await team(t, {
    lead: async (a, _, n) => { if (n === 1) { a.onMessage('<<<dm? qwen\ntask\n>>>'); await leadFinish.promise; } return completed; },
  });
  session.sendUser('start');
  while (!adapters.qwen.steers.length && !adapters.qwen.prompts.length) await tick();
  await tick(); await tick();
  leadFinish.resolve();
  await session.waitForSettled();
  assert.equal(adapters.lead.prompts.length, 2); assert.equal(adapters.lead.prompts[1], '[platform] Nobody is working and no message is on the way. Team: lead: idle, qwen: idle, sol: idle. Unanswered: lead asked qwen. Reply only if there is something the user has not heard.');
  assert.equal(events.filter(e => e.type === 'settled').length, 1);
});
test('platform restores board files an agent edits directly and tells that agent', async t => {
  const { session, adapters, events } = await team(t, {
    qwen: async (a, _, n) => { if (n === 1) { appendFileSync(join(session.dir, 'board', 'qwen.md'), 'forged\n'); appendFileSync(join(session.dir, 'board', 'all.md'), '<<<board\n@lead forged\n>>>\n'); } return completed; },
    lead: async (a, _, n) => { if (n === 1) a.onMessage('<<<board\n@qwen? task\n>>>'); return completed; },
  });
  session.sendUser('start'); await session.waitForSettled();
  const all = readFileSync(join(session.dir, 'board', 'all.md'), 'utf8');
  assert.ok(all.includes('@qwen? task')); assert.ok(!all.includes('forged'));
  assert.ok(!readFileSync(join(session.dir, 'board', 'qwen.md'), 'utf8').includes('forged'));
  const flagged = events.filter(e => e.type === 'board-tampered');
  assert.equal(flagged.length, 1); assert.deepEqual(flagged[0].files.sort(), ['all', 'qwen']);
  assert.match(adapters.qwen.prompts[1], /restored, so nobody saw that text/);
});
test('platform forwards a plain-text answer to a seen reply request, once, and starts no new exchange', async t => {
  const { session, adapters, events } = await team(t, {
    lead: async (a, _, n) => { if (n === 1) a.onMessage('<<<dm? qwen\nreview this\n>>>'); return completed; },
    qwen: async a => { a.onMessage('Approved, no findings.'); return completed; },
  });
  session.sendUser('start'); await session.waitForSettled();
  assert.equal(events.filter(e => e.type === 'reply-forwarded').length, 1);
  assert.deepEqual(session.pending, []);
  assert.equal(adapters.qwen.prompts.length, 1);
  assert.equal(adapters.lead.prompts.filter(p => /\[from qwen \| reply to m1\]\nApproved, no findings\./.test(p)).length, 1);
});
test('platform does not forward plain text when the member replied with a block or had no request', async t => {
  const { session, adapters, events } = await team(t, {
    lead: async (a, _, n) => {
      if (n === 1) a.onMessage('<<<dm? qwen\nanswered\n>>>\n<<<board\n@sol fyi\n>>>');
      return completed;
    },
    qwen: async a => { a.onMessage('working on it'); a.onMessage('<<<dm lead\ndone\n>>>'); return completed; },
    sol: async a => { a.onMessage('noted'); return completed; },
  });
  session.sendUser('start'); await session.waitForSettled();
  assert.equal(events.filter(e => e.type === 'reply-forwarded').length, 0);
  assert.ok(!adapters.lead.prompts.join().includes('working on it')); assert.ok(!adapters.lead.prompts.join().includes('noted'));
});
test('platform does not answer a request that arrived during the turn with text written before it', async t => {
  const started = deferred(), finish = deferred();
  const { session, adapters, events } = await team(t, {
    qwen: async (a, _, n) => { if (n === 1) { a.onMessage('earlier unrelated text'); started.resolve(); await finish.promise; } return completed; },
    lead: async (a, _, n) => {
      if (n === 1) a.onMessage('<<<steer qwen\nstart\n>>>');
      if (n === 2) a.onMessage('<<<board\n@qwen? late question\n>>>');
      return completed;
    },
  });
  adapters.qwen.steerResult = 'unsupported';
  session.sendUser('one'); await started.promise;
  while (session.members.get('lead').state !== 'idle') await tick();
  session.sendUser('two'); while (adapters.lead.prompts.length < 2) await tick();
  await tick(); await tick();
  finish.resolve(); await session.waitForSettled();
  assert.equal(events.filter(e => e.type === 'reply-forwarded').length, 0);
  assert.ok(!adapters.lead.prompts.join().includes('earlier unrelated text'));
  assert.equal(session.pending.length, 1); assert.equal(adapters.qwen.prompts.length, 2);
});
test('platform steers answers and ordinary notifications to working recipients', async t => {
  const waiting = deferred();
  const { session, adapters, events } = await team(t, {
    lead: async (a, _, n) => { if (n === 1) { a.onMessage('<<<dm? qwen\nforwarded answer please\n>>>\n<<<dm? sol\nboard answer please\n>>>'); await waiting.promise; } return completed; },
    qwen: async a => { a.onMessage('plain answer'); return completed; },
    sol: async a => { a.onMessage('<<<board\n@lead here is my answer\n>>>\n<<<board\n@qwen unrelated note\n>>>'); return completed; },
  });
  session.sendUser('start');
  while (adapters.lead.steers.length < 2) await tick();
  assert.ok(adapters.lead.steers.some(x => x.includes('reply to m1') && x.includes('plain answer')));
  assert.ok(adapters.lead.steers.some(x => x.includes('here is my answer')));
  assert.deepEqual(session.pending, []);
  assert.ok(adapters.qwen.steers.every(x => x.includes('unrelated note')), 'notifications steer a working member');
  waiting.resolve(); await session.waitForSettled();
  assert.equal(events.filter(e => e.type === 'reply-forwarded').length, 1);
});
test('platform maxTurns guards ping-pong and preserves undispatched messages', async t => {
  const { session, events } = await team(t, {
    lead: async a => { a.onMessage('<<<dm? qwen\nping\n>>>'); return completed; },
    qwen: async a => { a.onMessage('<<<dm? lead\npong\n>>>'); return completed; },
  }, { maxTurns: 4 });
  session.sendUser('start'); await session.waitForSettled();
  assert.equal(events.filter(e => e.type === 'turn-start').length, 4); assert.equal(events.filter(e => e.type === 'guard').length, 1);
  assert.ok(session.summary().members.some(m => m.queued));
});
test('platform failures notify the lead without retrying and lead failure only emits events', async t => {
  const { session, adapters, events } = await team(t, {
    lead: async (a, _, n) => { if (n === 1) a.onMessage('<<<dm? qwen\nwork\n>>>'); return completed; },
    qwen: async () => { throw new Error('fixture crash'); },
  });
  session.sendUser('start'); await session.waitForSettled();
  assert.equal(adapters.qwen.prompts.length, 1); assert.match(adapters.lead.prompts[1], /member qwen failed/);
  assert.equal(events.filter(e => e.type === 'member-failed').length, 1);
  const { session: s2, events: e2 } = await team(t, { lead: async () => ({ status: 'failed', error: 'lead failed' }) });
  s2.sendUser('start'); await s2.waitForSettled(); assert.equal(e2.filter(e => e.type === 'turn-start').length, 1);
});
test('platform quota pauses members and retains messages; lead quota emits lead-paused', async t => {
  const hold = deferred();
  const { session, adapters, events } = await team(t, {
    lead: async (a, _, n) => { if (n === 1) a.onMessage('<<<dm? qwen\nwork\n>>>'); return completed; },
    qwen: async () => { await hold.promise; return { status: 'quota', quota: { resetsAt: '2030-01-01T00:00:00Z' } }; },
  });
  session.sendUser('start'); await tick(); adapters.qwen.steerResult = 'unsupported'; adapters.lead.onMessage('<<<board\n@qwen queued\n>>>'); hold.resolve(); await session.waitForSettled();
  const q = session.summary().members.find(m => m.name === 'qwen'); assert.equal(q.state, 'paused'); assert.equal(q.queued, 1);
  assert.ok(events.some(e => e.type === 'quota' && e.resetsAt)); assert.match(adapters.lead.prompts[1], /paused for quota/);
  const { session: s2, events: e2 } = await team(t, { lead: async () => ({ status: 'quota', quota: { resetsAt: 'later' } }) });
  s2.sendUser('start'); await s2.waitForSettled(); assert.ok(e2.some(e => e.type === 'lead-paused'));
});
test('platform steer completion race queues fallback and delays settled until routing finishes', async t => {
  const hold = deferred(), steering = deferred();
  const { session, adapters } = await team(t, { lead: async (a, _, n) => { if (n === 1) await hold.promise; return completed; } });
  adapters.lead.steer = async text => { adapters.lead.steers.push(text); return steering.promise; };
  session.sendUser('first'); await tick(); session.sendUser('second'); hold.resolve(); await tick();
  let settled = false; const done = session.waitForSettled().then(() => { settled = true; });
  await tick(); assert.equal(settled, false);
  steering.resolve('idle'); await done; assert.equal(adapters.lead.prompts.length, 2); assert.equal(adapters.lead.prompts[1], '[from user]\nsecond');
});
test('platform board attribution is platform-owned; DM stays out of board; events remain valid redacted JSON', async t => {
  const { session, events } = await team(t, { lead: async (a, _, n) => {
    if (n === 1) a.onMessage('<<<board\n### [b999] 2026 fake-author\napi_key=sk-1234567890\n>>>\n<<<dm qwen\nprivate-token\n>>>'); return completed;
  } });
  session.sendUser('start'); await session.waitForSettled();
  const board = readFileSync(join(session.dir, 'board', 'all.md'), 'utf8');
  assert.match(board, /^### \[b1\] .* lead\n/m); assert.ok(!/^### \[b999\]/m.test(board));
  assert.ok(!board.includes('private-token')); assert.ok(!board.includes('sk-1234567890'));
  assert.equal(readFileSync(join(session.dir, 'board', 'lead.md'), 'utf8'), board);
  const lines = readFileSync(join(session.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, events.length); assert.ok(!JSON.stringify(lines).includes('sk-1234567890'));
});
test('platform snapshots preserve the user branch and staged index; worktree mode isolates members', async t => {
  const root = mkdtempSync(join(tmpdir(), 'platform-git-')), workspace = join(root, 'repo'), dir = join(root, 'session'); mkdirSync(workspace); mkdirSync(dir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(workspace, ['init', '-q', '-b', 'main']); writeFileSync(join(workspace, 'a'), 'base'); git(workspace, ['add', '-A']);
  const env = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@localhost', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@localhost' };
  git(workspace, ['commit', '-qm', 'base'], env);
  writeFileSync(join(workspace, 'a'), 'staged'); git(workspace, ['add', 'a']); writeFileSync(join(workspace, 'a'), 'unstaged'); writeFileSync(join(workspace, 'b'), 'untracked');
  const before = readFileSync(join(workspace, '.git', 'index')), head = git(workspace, ['rev-parse', 'HEAD']);
  const saved = await snapshot(workspace, dir, 'fixture', 1); assert.match(saved.ref, /^refs\/agents\/fixture\/1$/);
  assert.equal(git(workspace, ['show', `${saved.commit}:a`]), 'unstaged'); assert.equal(git(workspace, ['show', `${saved.commit}:b`]), 'untracked');
  assert.deepEqual(readFileSync(join(workspace, '.git', 'index')), before); assert.equal(git(workspace, ['rev-parse', 'HEAD']), head); assert.equal(git(workspace, ['branch', '--show-current']), 'main');
  const session = new PlatformSession({ workspace, mode: 'worktree', sessionRoot: join(root, 'sessions'), members: [
    { name: 'lead', harness: 'codex', model: 'x', role: 'lead' }, { name: 'worker', harness: 'codex', model: 'x', role: 'worker' },
  ] }, () => new Fake());
  t.after(async () => { await session.stop(); }); await session.start();
  assert.notEqual(session.members.get('lead').workspace, session.members.get('worker').workspace);
  assert.equal(git(session.members.get('lead').workspace, ['branch', '--show-current']), `agents/${session.id}/lead`);
  assert.ok(existsSync(join(session.members.get('lead').workspace, 'a')));
  session.sendUser('work'); await session.waitForSettled(); await session.stop();
  assert.equal(git(workspace, ['rev-parse', 'HEAD']), head); assert.deepEqual(readFileSync(join(workspace, '.git', 'index')), before);
});
test('platform worktree rejects non-Git directories and cleans up adapters on startup failure', async t => {
  const root = mkdtempSync(join(tmpdir(), 'platform-start-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const s = new PlatformSession({ ...base(), workspace: root, sessionRoot: join(root, 'sessions'), mode: 'worktree' }, () => new Fake());
  await assert.rejects(s.start(), /requires a Git/);
  const adapters = [];
  const failing = new PlatformSession({ ...base(), workspace: root, sessionRoot: join(root, 'sessions') }, () => { const a = new Fake(); a.start = async () => { throw new Error('startup failed'); }; adapters.push(a); return a; });
  await assert.rejects(failing.start(), /startup failed/); assert.equal(adapters[0].stops, 1);
});
test('platform lead broadcast excludes itself and interruption precedes the follow-up prompt', async t => {
  const hold = deferred(), ready = deferred();
  const { session, adapters, events } = await team(t, {
    lead: async (a, _, n) => { if (n === 1) { a.onMessage('<<<dm? qwen\nbegin\n>>>'); await hold.promise; } return completed; },
    qwen: async (a, _, n) => { if (n === 1) { ready.resolve(); await hold.promise; } return completed; },
  });
  session.sendUser('start'); await ready.promise;
  adapters.lead.onMessage('<<<steer all\nupdate\n>>>'); await tick();
  assert.equal(adapters.lead.steers.length, 0); assert.equal(adapters.qwen.steers.length, 1); assert.equal(adapters.sol.prompts.length, 1);
  adapters.qwen.interrupt = async () => { adapters.qwen.interrupts++; hold.resolve(); };
  adapters.lead.onMessage('<<<interrupt qwen\nreplacement\n>>>'); await session.waitForSettled();
  assert.equal(adapters.qwen.interrupts, 1); assert.match(adapters.qwen.prompts[1], /replacement/);
  assert.ok(events.some(e => e.type === 'interrupt' && e.recipient === 'qwen'));
});
test('platform unclosed blocks execute at turn end with a warning and no extra sender prompt', async t => {
  const { session, adapters, events } = await team(t, { lead: async a => { a.onMessage('<<<board\nno recipients'); return completed; } });
  session.sendUser('start'); await session.waitForSettled();
  assert.equal(events.filter(e => e.type === 'board').length, 1); assert.equal(events.filter(e => e.type === 'protocol-warning').length, 1); assert.equal(adapters.lead.prompts.length, 1);
});
test('platform timeout stops the worker without retry; stop joins cleanup and preserves unknown token usage', async t => {
  const { session, adapters, events } = await team(t, { lead: async () => new Promise(() => {}) }, { turnTimeoutMs: 15 });
  session.sendUser('timeout'); await session.waitForSettled();
  assert.equal(adapters.lead.prompts.length, 1); assert.equal(adapters.lead.stops, 1); assert.ok(events.some(e => e.type === 'member-failed' && /timed out/.test(e.error)));
  assert.equal(session.summary().members[0].unmeasuredTurns, 1);
  const stopped = deferred(); adapters.lead.stop = () => stopped.promise;
  const first = session.stop(), second = session.stop(); assert.equal(first, second); stopped.resolve(); await second;
});
test('platform empty session settles and naming avoids explicit-name collisions', async t => {
  const { session } = await team(t); await session.waitForSettled();
  assert.ok(session.summary().members.every(m => m.turns === 0));
  const c = parseConfig(base([{ harness: 'codex', model: 'x', role: 'lead' }, { name: 'codex-1', harness: 'codex', model: 'x', role: 'worker' }, { harness: 'codex', model: 'x', role: 'worker' }]));
  assert.deepEqual(c.members.map(m => m.name), ['lead', 'codex-1', 'codex-2']);
});
test('platform CLI prints lead text to stdout, events and token summary to stderr, then cleans up', async t => {
  const root = mkdtempSync(join(tmpdir(), 'platform-cli-')), file = join(root, 'team.json');
  writeFileSync(file, JSON.stringify({ ...base(), workspace: root, sessionRoot: join(root, 'sessions') }));
  let stdout = '', stderr = '', adapter;
  const out = process.stdout.write, err = process.stderr.write;
  // The test runner's own reporter writes Buffers to stdout whenever the event loop turns.
  process.stdout.write = chunk => { if (typeof chunk === 'string') stdout += chunk; return true; }; process.stderr.write = chunk => { if (typeof chunk === 'string') stderr += chunk; return true; };
  try {
    await main(['--config', file, '--message', 'hello'], () => adapter = new Fake(async a => { a.onMessage('User-visible answer'); return completed; }));
  } finally { process.stdout.write = out; process.stderr.write = err; rmSync(root, { recursive: true, force: true }); }
  assert.equal(stdout, 'User-visible answer\n');
  const summary = stderr.trim().split('\n').map(JSON.parse).find(e => e.summary).summary;
  assert.equal(summary.members[0].turns, 1); assert.equal(summary.members[0].usage.totalTokens, 5); assert.equal(adapter.stops, 1);
  await assert.rejects(main([]), /Usage:/);
});
test('platform snapshot failure records an event without failing the turn or settlement', async t => {
  const { session, workspace, events } = await team(t);
  git(workspace, ['init', '-q']); writeFileSync(join(workspace, 'file.txt'), 'work');
  mkdirSync(join(session.dir, 'snapshot-index'));
  session.sendUser('start'); await session.waitForSettled();
  await session.waitForSnapshots();
  assert.ok(events.some(e => e.type === 'snapshot' && e.error));
  assert.ok(events.some(e => e.type === 'turn-end' && e.status === 'completed'));
  assert.ok(!events.some(e => e.type === 'member-failed'));
});

test('platform mentions work in Chinese text, which has no spaces around them', () => {
  const m = (text, names = ['qwen', 'lead', '小千', '小千二']) => mentions(text, names);
  assert.deepEqual(m('请@qwen看一下'), [{ name: 'qwen', reply: false }]);
  assert.deepEqual(m('中国@lead'), [{ name: 'lead', reply: false }]);
  assert.deepEqual(m('@小千请看一下'), [{ name: '小千', reply: false }]);
  assert.deepEqual(m('请@小千二看看'), [{ name: '小千二', reply: false }], 'the longest known name wins');
  assert.deepEqual(m('你怎么看，@小千？'), [{ name: '小千', reply: true }], 'a full-width question mark asks too');
  assert.deepEqual(m('@qwen？'), [{ name: 'qwen', reply: true }]);
  assert.deepEqual(m('@小千。然后@qwen，'), [{ name: '小千', reply: false }, { name: 'qwen', reply: false }]);
  assert.deepEqual(m('@qwenx @qwen-2 @qwen.com a@小千 @别人'), [], 'Latin around a mention still means something else');
  assert.deepEqual(m('`@小千`\n> @小千'), [], 'code and quotes still do not notify');
});
test('platform member names may be Chinese, but not a file system trap', () => {
  const team = names => parseConfig({ workspace: '.', members: names.map((name, i) => ({ name, harness: 'codex', model: 'x', role: i ? 'worker' : 'lead' })) });
  assert.deepEqual(team(['组长', '小千', 'Bob-2', 'é']).members.map(m => m.name), ['组长', '小千', 'Bob-2', 'é']);
  for (const bad of ['a/b', 'a\\b', '..', 'a b', 'a.b', 'con', 'NUL', 'com1', '-x', '', 'x'.repeat(33), 'e\u0301']) assert.throws(() => team([bad]), undefined, bad);
  assert.throws(() => team(['Bob', 'bob']), /unique/);
  assert.throws(() => team(['组长', 'ALL']), /cannot be all/);
});
test('platform text blocks accept a Chinese member name', () => {
  const p = new ProtocolParser(['组长', '小千']);
  assert.deepEqual(p.message('<<<dm 小千\n你好\n>>>').map(a => [a.type, a.target]), [['dm', '小千']]);
  assert.ok(p.message('<<<dm 别人\n你好\n>>>').some(a => a.type === 'warning'));
});
test('platform CLI prints the full logical reply across tool-separated text items',async()=>{
 const root=mkdtempSync(join(tmpdir(),'platform-cli-reply-')),file=join(root,'team.json');
 writeFileSync(file,JSON.stringify({...base(),workspace:root,sessionRoot:join(root,'sessions')}));
 let stdout='';const out=process.stdout.write,err=process.stderr.write;
 process.stdout.write=chunk=>{if(typeof chunk==='string')stdout+=chunk;return true;};
 process.stderr.write=()=>true;
 try{await main(['--config',file,'--message','hello'],()=>new Fake(async a=>{
 a.onMessage('第一段，说到一半');a.onEvent({type:'tool',id:'t',title:'Read'});a.onMessage('——工具之后继续说完。');return completed;
 }));}finally{process.stdout.write=out;process.stderr.write=err;rmSync(root,{recursive:true,force:true});}
 assert.equal(stdout,'第一段，说到一半——工具之后继续说完。\n');
});
