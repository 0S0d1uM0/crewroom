import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformSession } from '../dist/platform/session.js';
import { ToolServer } from '../dist/platform/tool-server.js';
import { collaborationTools } from '../dist/platform/tools.js';
import { projectContext, notesInstruction } from '../dist/platform/project-context.js';
import { isWaitingCommand, toolDenial, WAITING_DENIAL } from '../dist/platform/permissions.js';

const tick = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(resolve => setImmediate(resolve)); };
const completed = { status: 'completed', usage: { totalTokens: 5 } };
const never = () => new Promise(() => {});
const later = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
class Fake {
  onMessage = () => {}; onEvent = () => {}; prompts = []; steers = []; interrupts = 0;
  constructor(script = async () => completed) { this.script = script; }
  async start(instructions) { this.instructions = instructions; }
  async resume(id, instructions) { this.instructions = instructions; this.resumed = id; }
  getSessionId() { return 'harness-id'; }
  async prompt(text) { this.prompts.push(text); return await this.script(this, text, this.prompts.length); }
  async steer(text) { this.steers.push(text); return 'steered'; }
  async interrupt() { this.interrupts++; this.cancel?.(); }
  async stop() {}
  call(name, args = {}) { return this.tools.call(name, args); }
}
const MEMBERS = [
  { name: 'lead', harness: 'codex', model: 'fake', role: 'lead' },
  { name: 'qwen', harness: 'dsh', model: 'local', role: 'worker' },
  { name: 'sol', harness: 'codex', model: 'fake', role: 'worker' },
];
async function team(t, scripts = {}, config = {}) {
  const root = mkdtempSync(join(tmpdir(), 'platform-tools-')), workspace = join(root, 'workspace'); mkdirSync(workspace);
  const adapters = {}, events = [];
  const { recovery, ...rest } = config;
  const session = new PlatformSession({ workspace, members: MEMBERS, sessionRoot: join(root, 'sessions'), maxTurns: 30, ...rest }, m => adapters[m.name] = new Fake(scripts[m.name]), e => events.push(e), recovery);
  t.after(async () => { await session.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start(); return { session, adapters, events, root };
}
const receipt = result => JSON.parse(result.text);

test('tools: the lead alone gets interrupt, and names are limited to teammates', () => {
  const lead = collaborationTools('lead', ['lead', 'qwen'], true), worker = collaborationTools('qwen', ['lead', 'qwen'], false);
  assert.ok(lead.some(t => t.name === 'interrupt_teammate')); assert.ok(!worker.some(t => t.name === 'interrupt_teammate'));
  const send = worker.find(t => t.name === 'message_teammate');
  assert.deepEqual(send.inputSchema.properties.to.enum, ['lead']);
  assert.deepEqual(lead.find(t => t.name === 'message_teammate').inputSchema.properties.to.enum, ['qwen', 'all']);
  assert.deepEqual(collaborationTools('solo', ['solo'], true).find(t => t.name === 'post_board').inputSchema.properties.notify.items, { type: 'string' });
});

test('tools: instructions describe tools and the waiting rule, not the text blocks', async t => {
  const { adapters } = await team(t);
  assert.match(adapters.qwen.instructions, /wait_for_messages/);
  assert.match(adapters.qwen.instructions, /Never sleep, poll/);
  assert.doesNotMatch(adapters.qwen.instructions, /<<<board/);
  assert.doesNotMatch(adapters.qwen.instructions, /board[\\/]all\.md/);
});

test('tools: a harness without tools is still told about the text blocks', async t => {
  const root = mkdtempSync(join(tmpdir(), 'platform-tools-')), adapters = {};
  const session = new PlatformSession({ workspace: root, members: MEMBERS, sessionRoot: join(root, 'sessions') }, m => { const a = new Fake(); a.supportsTools = false; return adapters[m.name] = a; });
  t.after(async () => { await session.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  assert.match(adapters.qwen.instructions, /<<<board/);
  assert.match(adapters.lead.instructions, /post one work order/); assert.match(adapters.qwen.instructions, /at most two rounds of blocking review/);
});

test('post_board: labels author, steers busy recipients and stores idle mentions', async t => {
  let finish; const held = new Promise(resolve => { finish = resolve; });
  const { session, adapters } = await team(t, { qwen: async (a, _, n) => { if (n === 1) await held; return completed; } });
  session.sendUser('hi'); await tick();
  const started = adapters.qwen.call('message_teammate', { to: 'qwen', text: 'self' });
  assert.equal((await started).isError, true);
  await adapters.lead.call('post_board', { text: 'first', ask: ['qwen'] }); await tick();
  assert.equal(adapters.qwen.prompts.length, 1);
  const r = receipt(await adapters.lead.call('post_board', { text: 'second @sol', notify: ['qwen'], ask: ['qwen'] })); await tick();
  assert.deepEqual(r.notified, ['sol']); assert.deepEqual(r.reply_requested_from, ['qwen']);
  // Working recipients are steered; the lead's mention wakes, a teammate's stays in the inbox.
  assert.match(adapters.qwen.steers[0], /second @sol/);
  assert.match(adapters.sol.prompts[0], /second @sol/);
  await later(); await adapters.qwen.call('post_board', { text: 'third @sol' }); await tick();
  assert.equal(adapters.sol.prompts.length, 1);
  assert.match(session.members.get('sol').inbox[0].text, /third @sol/);
  finish(); await session.waitForSettled();
  assert.equal(adapters.qwen.prompts.length, 1);
  const board = readFileSync(join(session.dir, 'board', 'all.md'), 'utf8');
  assert.match(board, /\[b1\].*lead/);
});

test('post_board and message_teammate reject bad input without posting', async t => {
  const { adapters, events } = await team(t);
  for (const [tool, args] of [['post_board', { text: '' }], ['post_board', { text: 'x', notify: ['nobody'] }], ['post_board', { text: 'x', ask: ['lead'] }], ['message_teammate', { to: 'nobody', text: 'x' }], ['message_teammate', { to: 'sol', text: ' ' }], ['nonsense', {}]]) {
    assert.equal((await adapters.lead.call(tool, args)).isError, true, tool);
  }
  assert.equal(events.filter(e => e.type === 'board').length, 0);
});

test('message_teammate: interjects into a working teammate and reports it', async t => {
  const { session, adapters } = await team(t, { qwen: never });
  session.sendUser('go'); await tick();
  await adapters.lead.call('post_board', { text: 'work', ask: ['qwen'] }); await tick();
  const r = receipt(await adapters.lead.call('message_teammate', { to: 'qwen', text: 'psst' }));
  assert.equal(r.delivery, 'interjected');
  assert.ok(adapters.qwen.steers[0].includes('psst'));
});

test('wait_for_messages: blocks with no new turn, and a message returns from the same turn', async t => {
  let result; const seen = [];
  const { session, adapters, events } = await team(t, { qwen: async a => { result = await a.call('wait_for_messages'); seen.push(result.text); return completed; } });
  session.sendUser('go'); await tick();
  await adapters.lead.call('post_board', { text: 'start', ask: ['qwen'] }); await tick();
  assert.equal(adapters.qwen.prompts.length, 1);
  await tick(20); assert.equal(seen.length, 0);
  assert.equal(session.summary().members.find(m => m.name === 'qwen').state, 'waiting');
  const r = receipt(await adapters.lead.call('message_teammate', { to: 'qwen', text: 'hello', reply_requested: true })); await tick();
  assert.equal(r.delivery, 'delivered');
  assert.equal(seen.length, 1); assert.ok(seen[0].includes('hello'));
  assert.deepEqual(adapters.qwen.steers, [], 'a waiting member is not steered');
  assert.equal(adapters.qwen.prompts.length, 1, 'no new turn was started');
  assert.ok(events.some(e => e.type === 'wait-start')); assert.ok(events.some(e => e.type === 'wait-resume'));
});

test('wait_for_messages: returns at once if messages are already waiting', async t => {
  let finish; const held = new Promise(resolve => { finish = resolve; }); let got;
  const { session, adapters } = await team(t, { qwen: async (a, _, n) => { if (n === 1) { await held; got = await a.call('wait_for_messages'); } return completed; } });
  session.sendUser('go'); await tick();
  await adapters.lead.call('post_board', { text: 'one', ask: ['qwen'] }); await tick();
  await adapters.lead.call('post_board', { text: 'two', ask: ['qwen'] }); await tick();
  finish(); await tick(20);
  assert.ok(got.text.includes('two'));
});

test('wait_for_messages: a steer the member may not have seen is handed over instead of blocking', async t => {
  let got, go;
  const gate = new Promise(resolve => { go = resolve; });
  const { session, adapters, events } = await team(t, { qwen: async a => { await gate; got = await a.call('wait_for_messages'); return completed; } });
  session.sendUser('hi'); await tick();
  await adapters.lead.call('post_board', { text: 'work', ask: ['qwen'] }); await tick();
  assert.equal(receipt(await adapters.lead.call('message_teammate', { to: 'qwen', text: 'urgent', reply_requested: true })).delivery, 'interjected');
  go(); await tick(20);
  assert.ok(got.text.includes('urgent')); assert.match(got.text, /may repeat/);
  assert.ok(events.some(e => e.type === 'steer-redelivered'));
});

test('wait_for_messages: a steer followed by another tool call counts as seen', async t => {
  let got, go, step;
  const gate = new Promise(resolve => { go = resolve; }), stepped = new Promise(resolve => { step = resolve; });
  const { session, adapters } = await team(t, { qwen: async a => { await gate; await later(); await a.call('read_board'); step(); got = await a.call('wait_for_messages'); return completed; } });
  session.sendUser('hi'); await tick();
  await adapters.lead.call('post_board', { text: 'work', ask: ['qwen'] }); await tick();
  await adapters.lead.call('message_teammate', { to: 'qwen', text: 'urgent', reply_requested: true });
  go(); await stepped; await tick(20);
  assert.equal(got, undefined, 'still blocked');
  assert.equal(session.summary().members.find(m => m.name === 'qwen').state, 'waiting');
});

test('wait_for_messages: a second concurrent call is refused', async t => {
  let second;
  const { session, adapters } = await team(t, { qwen: async a => { void a.call('wait_for_messages'); await tick(); second = await a.call('wait_for_messages'); return never(); } });
  session.sendUser('go'); await tick();
  await adapters.lead.call('post_board', { text: 'x', ask: ['qwen'] }); await tick(20);
  assert.equal(second.isError, true);
});

test('wait_for_messages: an ended turn releases the wait, and the next message starts a new turn', async t => {
  let released; const hold = {};
  const { session, adapters } = await team(t, { qwen: async (a, _, n) => { if (n === 1) { void a.call('wait_for_messages').then(r => { released = r.text; }); await new Promise(resolve => { hold.end = resolve; }); return { status: 'cancelled' }; } return completed; } });
  session.sendUser('go'); await tick();
  await adapters.lead.call('post_board', { text: 'x', ask: ['qwen'] }); await tick();
  hold.end(); await tick(20);
  assert.equal(released, 'The turn ended.');
  await adapters.lead.call('message_teammate', { to: 'qwen', text: 'again', reply_requested: true }); await tick(20);
  assert.equal(adapters.qwen.prompts.length, 2);
});

test('wait_for_messages: an abort from the harness cancels the wait', async t => {
  const abort = new AbortController(); let got;
  const { session, adapters, events } = await team(t, { qwen: async a => { got = await a.tools.call('wait_for_messages', {}, abort.signal); return completed; } });
  session.sendUser('go'); await tick();
  await adapters.lead.call('post_board', { text: 'x', ask: ['qwen'] }); await tick();
  abort.abort(); await tick(20);
  assert.equal(got.isError, true); assert.ok(events.some(e => e.type === 'wait-cancelled'));
});

test('quiet team: a waiting lead is told twice at most, then blocks until someone sends something', async t => {
  const results = [];
  const { session, events } = await team(t, { lead: async a => { for (;;) { const r = await a.call('wait_for_messages'); results.push(r.text); if (results.length === 4) return completed; } } });
  session.sendUser('go'); await tick(30);
  // The first waits return only because the platform said nothing is happening.
  assert.match(results[0], /Nobody is working/); assert.match(results[0], /lead: waiting/);
  assert.match(results[1], /report in plain text/);
  await tick(60);
  assert.equal(results.length, 2, 'waiting after that must block: no spinning on the notice');
  assert.ok(events.some(e => e.type === 'settled'));
  session.sendUser('more'); await tick(30);
  assert.match(results[2], /more/);
  assert.match(results[3], /Nobody is working/, 'something happened, so the notice applies again');
});

test('quiet team: workers waiting and an idle lead wake the lead once, and workers stay parked', async t => {
  const seen = [];
  const { session, adapters } = await team(t, { qwen: async a => { const r = await a.call('wait_for_messages'); seen.push(r.text); return completed; } });
  session.sendUser('go'); await tick();
  await adapters.lead.call('post_board', { text: 'task', ask: ['qwen'] });
  await session.waitForSettled();
  assert.equal(adapters.lead.prompts.length, 2, 'lead was told nobody is working');
  assert.match(adapters.lead.prompts[1], /Nobody is working/); assert.match(adapters.lead.prompts[1], /qwen: waiting/);
  assert.equal(seen.length, 0);
  assert.equal(adapters.qwen.prompts.length, 1);
  await adapters.lead.call('message_teammate', { to: 'qwen', text: 'answer', reply_requested: true }); await tick(20);
  assert.ok(seen[0].includes('answer'));
});

test('waiting for a reply: the answer reaches a requester blocked in wait_for_messages', async t => {
  let answer;
  const { session, adapters } = await team(t, {
    lead: async (a, _, n) => { if (n === 1) { await a.call('message_teammate', { to: 'qwen', text: 'question', reply_requested: true }); answer = await a.call('wait_for_messages'); } return completed; },
    qwen: async a => { await later(); await a.call('message_teammate', { to: 'lead', text: 'the answer' }); return completed; },
  });
  session.sendUser('go'); await session.waitForSettled();
  assert.ok(answer.text.includes('the answer'));
  assert.equal(session.pending.length, 0);
});

test('waiting for a reply: plain text from a worker that then waits is still forwarded', async t => {
  let answer;
  const { session } = await team(t, {
    lead: async (a, _, n) => { if (n === 1) { await a.call('message_teammate', { to: 'qwen', text: 'question', reply_requested: true }); answer = await a.call('wait_for_messages'); } return completed; },
    qwen: async a => { await later(); a.onMessage('plain answer'); await a.call('wait_for_messages'); return completed; },
  });
  session.sendUser('go'); await new Promise(resolve => setTimeout(resolve, 200));
  assert.ok(answer?.text.includes('plain answer'));
});

test('interrupt_teammate: the lead alone may, and a waiting member is woken without a harness interrupt', async t => {
  let got;
  const { session, adapters } = await team(t, { qwen: async a => { got = await a.call('wait_for_messages'); return completed; }, sol: never });
  session.sendUser('go'); await tick();
  await adapters.lead.call('post_board', { text: 'x', ask: ['qwen', 'sol'] }); await tick();
  assert.equal((await adapters.sol.call('interrupt_teammate', { to: 'qwen', text: 'stop' })).isError, true);
  assert.equal((await adapters.sol.call('message_teammate', { to: 'all', text: 'hey' })).isError, true);
  assert.deepEqual(receipt(await adapters.lead.call('interrupt_teammate', { to: 'qwen', text: 'new plan' })).interrupted, ['qwen']); await tick(20);
  assert.equal(adapters.qwen.interrupts, 0); assert.ok(got.text.includes('new plan'));
  await adapters.lead.call('interrupt_teammate', { to: 'sol', text: 'stop' }); await tick(20);
  assert.equal(adapters.sol.interrupts, 1);
});

test('read_board: returns new entries, then says not to poll', async t => {
  const { adapters } = await team(t);
  await adapters.lead.call('post_board', { text: 'one' }); await adapters.sol.call('post_board', { text: 'two' });
  const first = receipt(await adapters.qwen.call('read_board'));
  assert.deepEqual(first.entries.map(e => [e.id, e.author, e.text]), [['b1', 'lead', 'one'], ['b2', 'sol', 'two']]);
  const second = receipt(await adapters.qwen.call('read_board'));
  assert.deepEqual(second.entries, []); assert.match(second.note, /wait_for_messages/);
  assert.equal(receipt(await adapters.qwen.call('read_board', { from_start: true })).entries.length, 2);
  assert.equal(receipt(await adapters.lead.call('read_board')).entries.length, 2, 'each member has its own cursor');
});

test('quiet team: the lead sees board posts that named nobody, without repeating ones it was given', async t => {
  let got;
  const { session, adapters } = await team(t, { lead: async (a, _, n) => { if (n === 1) { await a.call('post_board', { text: 'task', ask: ['qwen'] }); got = await a.call('wait_for_messages'); got = got.text.includes('Nobody') ? got : await a.call('wait_for_messages'); } return completed; }, qwen: async a => {
    const silent = receipt(await a.call('post_board', { text: 'silent result' }));
    assert.match(silent.note, /Nobody was told/);
    await a.call('post_board', { text: 'told result', notify: ['lead'] });
    return completed;
  } });
  session.sendUser('go'); await session.waitForSettled();
  assert.match(got.text, /Nobody is working/); assert.match(got.text, /silent result/); assert.doesNotMatch(got.text, /told result/); assert.doesNotMatch(got.text, /\[b1 /);
});

test('receipts mention messages waiting without delivering them', async t => {
  const { session, adapters } = await team(t, { qwen: never });
  session.sendUser('go'); await tick();
  await adapters.lead.call('post_board', { text: 'a', ask: ['qwen'] }); await tick();
  adapters.qwen.steer = async () => 'idle';
  await adapters.lead.call('post_board', { text: 'b', ask: ['qwen'] }); await tick();
  const r = receipt(await adapters.qwen.call('post_board', { text: 'c' }));
  assert.equal(r.messages_waiting_for_you, 1);
  assert.equal(session.members.get('qwen').queue.length, 1);
});

test('spinning: a sleep command is called out, and the third one interrupts the turn', async t => {
  const { session, adapters, events } = await team(t, { qwen: never });
  session.sendUser('go'); await tick();
  await adapters.lead.call('post_board', { text: 'x', ask: ['qwen'] }); await tick();
  const q = adapters.qwen;
  q.onEvent({ type: 'tool', id: 'c1', command: 'npm test' }); await tick();
  assert.deepEqual(q.steers, []);
  q.onEvent({ type: 'tool', id: 'c2', command: 'Start-Sleep -Seconds 30' }); q.onEvent({ type: 'tool', id: 'c2', command: 'Start-Sleep -Seconds 30' }); await tick();
  assert.equal(q.steers.length, 1, 'the same call counts once'); assert.ok(q.steers[0].includes('wait_for_messages'));
  q.onEvent({ type: 'tool', id: 'c3', command: 'sleep 30' }); await tick();
  q.onEvent({ type: 'tool', id: 'c4', command: 'sleep 30' }); await tick();
  assert.equal(q.interrupts, 1);
  assert.equal(events.filter(e => e.type === 'spin-warning').length, 3);
  assert.ok(session.members.get('qwen').queue.join('').includes('wait_for_messages'));
});

test('isWaitingCommand: a loop waiting for what the same command started is work, any other loop is not', () => {
  // The shape of a real test run: an unrelated foreach first, then the server, then a wait for its log.
  const real = `foreach ($f in @($raw,$err)) { Remove-Item $f }; $p = Start-Process -FilePath 'mod\\gradlew.bat' -PassThru; $deadline=(Get-Date).AddSeconds(300); while ((Get-Date) -lt $deadline) { Start-Sleep -Seconds 8; if (Select-String $raw 'Done') { break } }`;
  for (const c of [real, 'Start-Job { npm start }; while (!(Test-Path x)) { Start-Sleep 2 }', 'node server.js & while ! curl -s localhost; do sleep 1; done', 'node server.js &\nuntil curl -s localhost; do sleep 1; done']) {
    assert.ok(!isWaitingCommand(c), c);
    assert.equal(toolDenial('pwsh', { command: c }, process.cwd(), process.cwd()), undefined, c);
  }
  for (const c of [
    'while (!(Test-Path done.txt)) { Start-Sleep 5 }',
    '& gradlew.bat build; while (!(Test-Path done.txt)) { Start-Sleep 5 }',
    'npm test && while true; do sleep 5; done',
    'while true; do sleep 5; done; Start-Process notepad',
    'Start-Sleep 75; Start-Process notepad',
  ]) assert.ok(isWaitingCommand(c), c);
});

test('isWaitingCommand: catches sleeping and polling loops, not ordinary work', () => {
  for (const c of ['sleep 30', 'Start-Sleep -Seconds 30', 'start-sleep 5; Get-Content x', 'timeout /t 30', 'timeout.exe 5', 'while true; do cat x; sleep 5; done', 'foreach ($i in 1..9) { Start-Sleep 5 }', 'for i in 1 2 3; do sleep 1; done']) assert.ok(isWaitingCommand(c), c);
  for (const c of ['npm test', 'git status', 'node server.js & sleep 2; curl localhost', 'grep sleep src/a.ts', 'echo while we work', 'npm run sleepy']) assert.ok(!isWaitingCommand(c), c);
});

test('toolDenial: a DSH sleep is refused before it runs', () => {
  assert.equal(toolDenial('pwsh', { command: 'Start-Sleep 30' }, process.cwd(), process.cwd()), WAITING_DENIAL);
  assert.equal(toolDenial('tool:bash', { command: 'sleep 30' }, process.cwd(), process.cwd()), WAITING_DENIAL);
  assert.equal(toolDenial('pwsh', { command: 'npm test' }, process.cwd(), process.cwd()), undefined);
});

test('turn timeout: time blocked in a wait does not count', async t => {
  const { session, adapters, events } = await team(t, { qwen: async a => { await a.call('wait_for_messages'); return completed; } }, { turnTimeoutMs: 40 });
  session.sendUser('go'); await tick();
  await adapters.lead.call('post_board', { text: 'x', ask: ['qwen'] }); await tick();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(!events.some(e => e.type === 'member-failed'));
  await adapters.lead.call('message_teammate', { to: 'qwen', text: 'done', reply_requested: true }); await tick(30);
  assert.ok(events.some(e => e.type === 'turn-end' && e.member === 'qwen' && e.status === 'completed'));
});

test('recovery: the board log returns, and a member that was only waiting is not reported interrupted', async t => {
  const first = await team(t, { qwen: async a => { await a.call('wait_for_messages'); return completed; }, sol: never });
  first.session.sendUser('go'); await tick();
  await first.adapters.lead.call('post_board', { text: 'keep me', ask: ['qwen', 'sol'] }); await tick(30);
  const events = readFileSync(join(first.session.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const harnessIds = { lead: 'h', qwen: 'h', sol: 'h' };
  const { adapters } = await team(t, {}, { recovery: { id: first.session.id + '-r', events, harnessIds } });
  assert.equal(adapters.qwen.resumed, 'h');
  assert.deepEqual(receipt(await adapters.qwen.call('read_board')).entries.map(e => e.text), ['keep me']);
  await tick(20);
  const notices = adapters.lead.prompts.join('\n');
  assert.match(notices, /member sol was interrupted/); assert.doesNotMatch(notices, /member qwen was interrupted/);
});

test('tool server: requires its token, lists tools, and streams a blocking call', async t => {
  const server = new ToolServer(); await server.start(); t.after(() => server.stop());
  let release, aborted = false;
  const host = { definitions: [{ name: 'hold', description: 'd', inputSchema: { type: 'object', properties: {} } }], call: (name, args, signal) => new Promise(resolve => { signal.addEventListener('abort', () => { aborted = true; resolve({ text: 'gone' }); }); release = () => resolve({ text: 'held:' + args.x }); }) };
  const { url, token } = server.register('lead', host);
  const post = (body, auth = `Bearer ${token}`, signal) => fetch(url, { method: 'POST', signal, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, '')).status, 401);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'Bearer ' + 'x'.repeat(64))).status, 401);
  assert.equal((await fetch(url + 'x', { method: 'POST' })).status, 404);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).status, 405);
  assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://example.com' } })).status, 403);
  const init = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })).json();
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json()).result.tools[0].name, 'hold');
  assert.equal((await (await post({ jsonrpc: '2.0', id: 3, method: 'nope' })).json()).error.code, -32601);
  const response = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'hold', arguments: { x: 1 } } });
  assert.match(response.headers.get('content-type'), /event-stream/);
  release();
  assert.match(await response.text(), /held:1/);
  const abort = new AbortController();
  const held = await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'hold' } }, undefined, abort.signal);
  abort.abort(); await held.text().catch(() => {});
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(aborted, true);
});

test('tool server: a member token works only for that member', async t => {
  const server = new ToolServer(); await server.start(); t.after(() => server.stop());
  const host = { definitions: [], call: async () => ({ text: '' }) };
  const a = server.register('a', host), b = server.register('b', host);
  assert.notEqual(a.token, b.token);
  const response = await fetch(a.url, { method: 'POST', headers: { Authorization: `Bearer ${b.token}` }, body: '{}' });
  assert.equal(response.status, 401);
});

test('recovery: a member that never ran starts fresh instead of resuming nothing', async t => {
  const first = await team(t);
  first.session.sendUser('go'); await first.session.waitForSettled();
  const events = readFileSync(join(first.session.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const { adapters } = await team(t, {}, { recovery: { id: first.session.id + '-r', events, harnessIds: { lead: 'h', qwen: 'h', sol: 'h' } } });
  assert.equal(adapters.lead.resumed, 'h');
  assert.equal(adapters.qwen.resumed, undefined); assert.ok(adapters.qwen.instructions);
});

class ParkingFake extends Fake {
  maxBlockMs = 10;
  async interrupt() { this.interrupts++; this.endTurn?.({ status: 'cancelled' }); }
}
async function parkingTeam(t, scripts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'platform-tools-')), adapters = {}, events = [];
  const session = new PlatformSession({ workspace: root, members: MEMBERS, sessionRoot: join(root, 'sessions'), maxTurns: 30 }, m => adapters[m.name] = m.name === 'qwen' ? new Fake(scripts[m.name]) : new ParkingFake(scripts[m.name]), e => events.push(e));
  t.after(async () => { await session.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start(); return { session, adapters, events };
}
const parkScript = (seen = []) => async (a, text, n) => { seen.push(text); if (n === 1) { await a.call('post_board', { text: 'x', ask: ['sol'] }); const ended = new Promise(resolve => { a.endTurn = resolve; }); void a.call('wait_for_messages'); return ended; } return completed; };

test('parking: a wait past the harness limit ends the turn with no model call, and a message starts a new turn', async t => {
  const seen = [];
  const { session, adapters, events } = await parkingTeam(t, { lead: parkScript(seen), sol: async () => never() });
  session.sendUser('go'); await later(200); await tick(10);
  assert.equal(adapters.lead.interrupts, 1);
  assert.equal(adapters.lead.prompts.length, 1);
  assert.ok(events.some(e => e.type === 'wait-parked'));
  assert.ok(events.some(e => e.type === 'turn-end' && e.parked === true));
  assert.equal(session.summary().members.find(m => m.name === 'lead').state, 'waiting');
  await adapters.sol.call('message_teammate', { to: 'lead', text: 'the answer' }); await tick(10);
  assert.equal(adapters.lead.prompts.length, 2);
  assert.match(seen[1], /Your wait_for_messages call has ended/); assert.match(seen[1], /the answer/);
});

test('parking: a message within the limit returns in the same turn', async t => {
  let got;
  const { session, adapters } = await parkingTeam(t, { lead: async a => { a.maxBlockMs = 500; await a.call('post_board', { text: 'x', ask: ['sol'] }); got = await a.call('wait_for_messages'); return completed; }, sol: async () => never() });
  session.sendUser('go'); await tick(10);
  await adapters.sol.call('message_teammate', { to: 'lead', text: 'quick' }); await tick(10);
  assert.ok(got.text.includes('quick')); assert.equal(adapters.lead.interrupts, 0); assert.equal(adapters.lead.prompts.length, 1);
});

test('parking: a parked lead with a quiet team is told, so the user is not left in silence', async t => {
  const { session, adapters } = await parkingTeam(t, { lead: async (a, _, n) => { if (n === 1) { a.maxBlockMs = 10; const ended = new Promise(resolve => { a.endTurn = resolve; }); await later(); void a.call('wait_for_messages'); return ended; } return completed; }, sol: async () => { await later(300); return completed; } });
  session.sendUser('go'); await tick();
  await adapters.lead.call('post_board', { text: 'x', ask: ['sol'] });
  await later(450); await session.waitForSettled();
  assert.ok(adapters.lead.prompts.some(p => /Nobody is working/.test(p)));
});

test('parking: a worker message while the interrupt is in flight waits for the turn to end', async t => {
  let finish; const held = new Promise(resolve => { finish = resolve; });
  const { session, adapters } = await parkingTeam(t, { lead: async (a, _, n) => { if (n === 1) { a.interrupt = async () => { a.interrupts++; }; await a.call('post_board', { text: 'x', ask: ['sol'] }); void a.call('wait_for_messages'); await held; return { status: 'cancelled' }; } return completed; }, sol: async () => never() });
  session.sendUser('go'); await later(200); await tick(10);
  assert.equal(adapters.lead.interrupts, 1);
  await adapters.sol.call('message_teammate', { to: 'lead', text: 'late' }); await tick(10);
  assert.equal(adapters.lead.prompts.length, 1, 'no second prompt while the first turn is open');
  finish(); await tick(20);
  assert.equal(adapters.lead.prompts.length, 2); assert.match(adapters.lead.prompts[1], /late/);
});

test('quiet team: a worker whose last act was telling the lead does not wake it again', async t => {
  const { session, adapters } = await team(t, { qwen: async a => { await a.call('message_teammate', { to: 'lead', text: 'done' }); return completed; } });
  session.sendUser('go'); await tick();
  await adapters.lead.call('post_board', { text: 'task', ask: ['qwen'] });
  await session.waitForSettled();
  assert.equal(adapters.lead.prompts.length, 2);
  assert.match(adapters.lead.prompts[1], /done/);
  assert.ok(!adapters.lead.prompts.some(p => /Nobody is working/.test(p)));
});

test('quiet team: a worker that told the lead and then kept working still wakes it at the end', async t => {
  const { session, adapters } = await team(t, { qwen: async a => { await a.call('message_teammate', { to: 'lead', text: 'starting' }); a.onEvent({ type: 'tool', id: 't1', title: 'Edit file' }); return completed; } });
  session.sendUser('go'); await tick();
  await adapters.lead.call('post_board', { text: 'task', ask: ['qwen'] });
  await session.waitForSettled();
  assert.ok(adapters.lead.prompts.some(p => /Nobody is working/.test(p)));
});

test('quiet team: a message steered into the lead does not count as telling it, since the turn may be ending', async t => {
  let finish; const held = new Promise(resolve => { finish = resolve; });
  const { session, adapters } = await team(t, { lead: async (a, _, n) => { if (n === 1) { await a.call('post_board', { text: 'task', ask: ['qwen'] }); await held; } return completed; }, qwen: async a => { assert.equal(receipt(await a.call('message_teammate', { to: 'lead', text: 'done' })).delivery, 'interjected'); return completed; } });
  session.sendUser('go'); await later(50);
  finish(); await session.waitForSettled();
  assert.ok(adapters.lead.prompts.some(p => /Nobody is working/.test(p)));
});

test('tool server: Chinese survives a call, including across a chunk boundary and a non-BMP character', async t => {
  const server = new ToolServer(); await server.start(); t.after(() => server.stop());
  const text = '验收：龘靐齉爩-🚀-𠮷'.repeat(4000);
  const host = { definitions: [], call: async (name, args) => ({ text: args.text }) };
  const { url, token } = server.register('组长', host);
  assert.match(decodeURI(url), /组长/);
  const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'x', arguments: { text } } }) });
  const data = JSON.parse((await response.text()).split('\n').find(line => line.startsWith('data: ')).slice(6));
  assert.equal(data.result.content[0].text, text);
});

test('a team with Chinese names talks through the tools and the board stays intact', async t => {
  const root = mkdtempSync(join(tmpdir(), 'platform-中文-')), adapters = {}, events = [];
  const session = new PlatformSession({ workspace: root, sessionRoot: join(root, '会话'), members: [{ name: '组长', harness: 'codex', model: 'f', role: 'lead' }, { name: '小千', harness: 'dsh', model: 'local', role: 'worker' }] }, m => adapters[m.name] = new Fake(m.name === '小千' ? async a => { await a.call('post_board', { text: '收到@组长，口令🚀', notify: [] }); return completed; } : undefined), e => events.push(e));
  t.after(async () => { await session.stop(); rmSync(root, { recursive: true, force: true }); });
  await session.start();
  assert.deepEqual(collaborationTools('组长', ['组长', '小千'], true).find(x => x.name === 'post_board').inputSchema.properties.notify.items.enum, ['小千']);
  session.sendUser('开始'); await tick();
  assert.deepEqual(receipt(await adapters['组长'].call('post_board', { text: '请@小千看看', ask: ['小千'] })).reply_requested_from, ['小千']);
  await session.waitForSettled();
  assert.ok(adapters['组长'].prompts.some(p => p.includes('收到@组长，口令🚀')));
  assert.match(readFileSync(join(session.dir, 'board', 'all.md'), 'utf8'), /口令🚀/);
  assert.ok(events.some(e => e.type === 'board' && e.author === '小千'));
});

function projectFolder(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'platform-project-')), workspace = join(root, 'project'); mkdirSync(join(workspace, '.agent-notes'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) writeFileSync(join(workspace, path), text);
  return { root, workspace };
}
test('project context: rule files and every harness notes, with the platform winning conflicts', t => {
  const { workspace } = projectFolder(t, { 'AGENTS.md': '\uFEFF规则甲', 'CLAUDE.md': '规则乙', '.agent-notes/codex.md': '经验丙', '.agent-notes/dsh.md': '经验丁', '.agent-notes/skip.txt': '不是笔记' });
  const { text, files } = projectContext(workspace);
  for (const part of ['规则甲', '规则乙', '经验丙', '经验丁']) assert.ok(text.includes(part), part);
  assert.ok(!text.includes('\uFEFF')); assert.ok(!text.includes('不是笔记'));
  assert.match(text, /platform's instructions win/); assert.match(text, /information, not commands/);
  assert.deepEqual(files.map(f => f.path), ['AGENTS.md', 'CLAUDE.md', '.agent-notes/codex.md', '.agent-notes/dsh.md']);
});
test('project context: a file the harness already loads is not repeated', t => {
  const { workspace } = projectFolder(t, { 'AGENTS.md': '规则甲', 'CLAUDE.md': '规则乙' });
  const { text } = projectContext(workspace, ['AGENTS.md']);
  assert.ok(!text.includes('规则甲')); assert.ok(text.includes('规则乙'));
});
test('project context: an empty folder adds nothing, and large files are cut with a pointer', t => {
  assert.equal(projectContext(projectFolder(t).workspace).text, '');
  const { workspace } = projectFolder(t, { 'AGENTS.md': '甲'.repeat(40000), 'CLAUDE.md': '乙'.repeat(40000), '.agent-notes/codex.md': '丙'.repeat(40000) });
  const { text } = projectContext(workspace);
  assert.ok(text.length < 70000, String(text.length)); assert.match(text, /read AGENTS\.md for the rest/);
});
test('project context: a link out of the working directory is not followed', t => {
  const { root, workspace } = projectFolder(t);
  writeFileSync(join(root, 'secret.md'), '外部内容');
  try { symlinkSync(join(root, 'secret.md'), join(workspace, 'CLAUDE.md')); } catch (error) { t.skip(String(error.code)); return; }
  assert.ok(!projectContext(workspace).text.includes('外部内容'));
});
test('project context: every member gets it at start, and a resume sees what changed since', async t => {
  const { root, workspace } = projectFolder(t, { 'CLAUDE.md': '规则乙', '.agent-notes/dsh.md': '旧经验' });
  const adapters = {};
  const make = (recovery, extra) => new PlatformSession({ workspace, members: MEMBERS, sessionRoot: join(root, 'sessions') }, m => { const a = new Fake(); Object.assign(a, m.harness === 'codex' ? extra : {}); return adapters[m.name] = a; }, () => {}, recovery);
  const first = make(undefined, { nativeProjectFiles: ['CLAUDE.md'] });
  await first.start();
  assert.ok(adapters.qwen.instructions.includes('规则乙')); assert.ok(!adapters.lead.instructions.includes('规则乙'), 'native file not repeated');
  assert.ok(adapters.lead.instructions.includes('旧经验'), 'all harnesses see each other');
  assert.match(adapters.qwen.instructions, /\.agent-notes\/dsh\.md/); assert.match(adapters.lead.instructions, /\.agent-notes\/codex\.md/);
  first.sendUser('go'); await first.waitForSettled();
  await first.stop();
  writeFileSync(join(workspace, '.agent-notes', 'dsh.md'), '新经验');
  const events = readFileSync(join(first.dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const second = make({ id: first.id, events, harnessIds: { lead: 'h', qwen: 'h', sol: 'h' } }, {});
  await second.start();
  await second.stop();
  assert.equal(adapters.lead.resumed, 'h');
  assert.ok(adapters.lead.instructions.includes('新经验')); assert.ok(!adapters.lead.instructions.includes('旧经验'));
});
test('notes instruction names the harness file and protects the rule files', () => {
  const text = notesInstruction('claude');
  assert.match(text, /\.agent-notes\/claude\.md/); assert.match(text, /do not edit AGENTS\.md or CLAUDE\.md unless asked/); assert.match(text, /no credentials/);
});

test('web search goes to DSH members first, while everyone keeps access', async t => {
  const { adapters } = await team(t);
  assert.match(adapters.lead.instructions, /give searches to qwen first/); assert.match(adapters.lead.instructions, /truly necessary/);
  assert.match(adapters.qwen.instructions, /you have web_search and web_fetch/);
});

test('wake rules: idle inbox is ordered, durable across pause/restart, and consumed once', async t => {
  const first = await team(t); first.session.pause();
  for (const text of ['first note', 'second note']) {
    const r = receipt(await first.adapters.sol.call('message_teammate', { to: 'qwen', text }));
    assert.match(r.delivery, /已入收件箱/);
  }
  assert.equal(first.adapters.qwen.prompts.length, 0);
  const history = [...first.events]; await first.session.stop();
  const second = await team(t, {}, { recovery: { id: first.session.id, events: history, harnessIds: {} } });
  assert.equal(second.session.members.get('qwen').inbox.length, 2);
  second.session.resume(); await tick();
  assert.equal(second.adapters.qwen.prompts.length, 0);
  await second.adapters.lead.call('message_teammate', { to: 'qwen', text: 'respond now', reply_requested: true });
  await second.session.waitForSettled();
  assert.match(second.adapters.qwen.prompts[0], /first note[\s\S]*second note[\s\S]*respond now/);
  assert.equal(second.session.members.get('qwen').inbox.length, 0);
  assert.ok(second.events.some(e => e.type === 'wake' && e.member === 'qwen' && e.reason === 'ask' && e.inboxCount === 2));
  const third = await team(t, {}, { recovery: { id: second.session.id, events: [...history, ...second.events], harnessIds: { qwen: 'harness-id', lead: 'harness-id' } } });
  assert.equal(third.session.members.get('qwen').inbox.length, 0);
});

test('wake rules: waiting worker ignores notifications, then gets them before a lead interrupt', async t => {
  let got;
  const { session, adapters, events } = await team(t, { qwen: async a => { got = await a.call('wait_for_messages'); return completed; }, sol: never });
  await adapters.lead.call('interrupt_teammate', { to: 'all', text: 'start' }); await tick();
  await adapters.sol.call('message_teammate', { to: 'qwen', text: 'one' });
  await adapters.sol.call('post_board', { text: 'two @qwen', notify: ['qwen'] }); await tick();
  assert.equal(got, undefined); assert.equal(adapters.qwen.prompts.length, 1);
  assert.equal(events.filter(e => e.type === 'wait-resume' && e.member === 'qwen').length, 0);
  await adapters.lead.call('interrupt_teammate', { to: 'qwen', text: 'decision' }); await tick();
  assert.match(got.text, /one[\s\S]*two @qwen[\s\S]*decision/);
  assert.equal(events.filter(e => e.type === 'wake' && e.member === 'qwen' && e.reason === 'lead' && e.inboxCount === 2).length, 1);
});

test('scope: the lead is told to own a work order, workers to report new work and stop reviewing after two rounds', async t => {
  const tooled = await team(t);
  for (const pattern of [/post one work order/, /what counts as done/, /outside the order, ask the user/, /stop the work and report/]) assert.match(tooled.adapters.lead.instructions, pattern);
  for (const pattern of [/do not start it/, /blocks only if it breaks/, /at most two rounds of blocking review/]) assert.match(tooled.adapters.sol.instructions, pattern);
  assert.doesNotMatch(tooled.adapters.sol.instructions, /post one work order/);
  assert.doesNotMatch(tooled.adapters.lead.instructions, /at most two rounds/);
});

const pairTalk = async (adapters, from, n) => { for (let i = from; i < from + n; i++) await (i % 2 ? adapters.qwen : adapters.sol).call('message_teammate', { to: i % 2 ? 'sol' : 'qwen', text: `talk-${i}\nsecond line stays out` }); };

test('checkpoint: twelve teammate messages wake a sleeping lead once, with a digest and not the whole text', async t => {
  let finish; const held = new Promise(resolve => { finish = resolve; });
  const { session, adapters, events } = await team(t, { qwen: async () => held, sol: async () => held });
  await adapters.lead.call('interrupt_teammate', { to: 'all', text: 'work' }); await tick();
  await pairTalk(adapters, 0, 11); await tick();
  assert.equal(adapters.lead.prompts.length, 0);
  await pairTalk(adapters, 11, 1); await tick();
  assert.equal(adapters.lead.prompts.length, 1);
  const prompt = adapters.lead.prompts[0];
  assert.match(prompt, /Checkpoint: teammates exchanged 12 messages/); assert.match(prompt, /talk-0/); assert.match(prompt, /talk-11/);
  assert.doesNotMatch(prompt, /second line stays out/); assert.match(prompt, /sol -> qwen/);
  assert.equal(events.filter(e => e.type === 'wake' && e.member === 'lead' && e.reason === 'checkpoint').length, 1);
  await pairTalk(adapters, 12, 11); await tick();
  assert.equal(adapters.lead.prompts.length, 1, 'the count starts again');
  await pairTalk(adapters, 23, 1); await tick();
  assert.equal(adapters.lead.prompts.length, 2);
  finish(completed); await session.waitForSettled();
});

test('checkpoint: what the lead says or is told directly does not count, and a waiting lead is released', async t => {
  let got, finish; const held = new Promise(resolve => { finish = resolve; });
  const { session, adapters } = await team(t, { lead: async a => { got = await a.call('wait_for_messages'); return completed; }, qwen: async () => held, sol: async () => held });
  await adapters.lead.call('interrupt_teammate', { to: 'all', text: 'work' });
  session.sendUser('go'); await tick();
  for (let i = 0; i < 12; i++) await adapters.lead.call('message_teammate', { to: 'qwen', text: 'from lead ' + i });
  for (let i = 0; i < 12; i++) await adapters.sol.call('message_teammate', { to: 'lead', text: 'to lead ' + i });
  await tick(); assert.equal(got, undefined);
  await pairTalk(adapters, 0, 12); await tick();
  assert.match(got.text, /Checkpoint: teammates exchanged 12 messages/);
  finish(completed); await session.waitForSettled();
});

test('checkpoint: the count survives a restart, and a failed lead gets it once it can act', async t => {
  let finish; const held = new Promise(resolve => { finish = resolve; });
  const first = await team(t, { qwen: async () => held, sol: async () => held });
  await first.adapters.lead.call('interrupt_teammate', { to: 'all', text: 'work' }); await tick();
  await pairTalk(first.adapters, 0, 11); await tick();
  const history = [...first.events]; finish(completed); await first.session.stop();
  const second = await team(t, {}, { recovery: { id: first.session.id, events: history, harnessIds: { lead: 'harness-id', qwen: 'harness-id', sol: 'harness-id' } } });
  await tick(); second.adapters.lead.prompts.length = 0;
  const lead = second.session.members.get('lead'); lead.failed = true;
  await pairTalk(second.adapters, 11, 3); await tick();
  assert.equal(second.adapters.lead.prompts.length, 0);
  lead.failed = false;
  await pairTalk(second.adapters, 14, 1); await tick();
  assert.equal(second.adapters.lead.prompts.length, 1);
  assert.match(second.adapters.lead.prompts[0], /exchanged 15 messages/); assert.match(second.adapters.lead.prompts[0], /talk-14/); assert.doesNotMatch(second.adapters.lead.prompts[0], /talk-2\b/);
});

test('wake rules: a permission request does not wake the lead, and reaches it with the next wake', async t => {
  let got, finish; const held = new Promise(resolve => { finish = resolve; });
  const { session, adapters, events, root } = await team(t, { lead: async a => { got = await a.call('wait_for_messages'); return completed; }, sol: async () => held });
  await adapters.lead.call('message_teammate', { to: 'sol', text: 'work' }); await tick();
  session.sendUser('start'); await tick();
  const asked = adapters.sol.permission.request({ command: 'git push', cwd: join(root, 'workspace') }); await tick();
  assert.equal(events.filter(e => e.type === 'permission-request').length, 1);
  assert.equal(got, undefined, 'a waiting lead stays waiting');
  assert.ok(!events.some(e => e.type === 'wake' && e.member === 'lead' && e.reason === 'platform'));
  assert.equal(session.members.get('lead').inbox.length, 1);
  session.sendUser('what is happening'); await tick();
  assert.match(got.text, /sol 申请了权限[\s\S]*不用转告用户[\s\S]*what is happening/);
  assert.equal(session.members.get('lead').inbox.length, 0);
  session.permissions.cancel('sol'); await asked; finish(completed);
});

test('wake rules: the lead is told who is held up by a permission when the team status comes round', async t => {
  let finish; const held = new Promise(resolve => { finish = resolve; });
  const { adapters, root } = await team(t, { qwen: async () => held, sol: async () => held });
  await adapters.lead.call('interrupt_teammate', { to: 'all', text: 'work' }); await tick();
  const asked = adapters.sol.permission.request({ command: 'git push', cwd: join(root, 'workspace') }); await tick();
  await pairTalk(adapters, 0, 12); await tick();
  assert.match(adapters.lead.prompts[0], /sol: waiting for the user to approve a permission/);
  assert.match(adapters.lead.prompts[0], /qwen: working/);
  finish(completed); adapters.sol.interrupt(); void asked;
});

test('wake rules: six correction notifications cost no lead turn until quiet flush', async t => {
  let finish; const held = new Promise(resolve => { finish = resolve; });
  const { session, adapters, events } = await team(t, { qwen: async () => held, sol: async () => held });
  await adapters.lead.call('interrupt_teammate', { to: 'all', text: 'work' }); await tick();
  for (let i = 0; i < 6; i++) {
    const author = i % 2 ? adapters.qwen : adapters.sol;
    await author.call('post_board', { text: `correction-${i}`, notify: ['lead', i % 2 ? 'sol' : 'qwen'] });
  }
  await tick(); assert.equal(adapters.lead.prompts.length, 0);
  finish(completed); await session.waitForSettled();
  assert.equal(adapters.lead.prompts.length, 1);
  for (let i = 0; i < 6; i++) assert.match(adapters.lead.prompts[0], new RegExp(`correction-${i}`));
  const wake = events.find(e => e.type === 'wake' && e.member === 'lead');
  assert.equal(wake.reason, 'quiet'); assert.equal(wake.inboxCount, 6);
  assert.ok(events.findIndex(e => e === wake) < events.findIndex(e => e.type === 'settled'));
});

test('wake rules: failed notification steer stores inbox; failure wakes lead with earlier report', async t => {
  let finish; const held = new Promise(resolve => { finish = resolve; });
  const { session, adapters, events } = await team(t, { qwen: async () => held });
  await adapters.lead.call('interrupt_teammate', { to: 'qwen', text: 'work' }); await tick();
  adapters.qwen.steer = async () => { throw Error('steer failed'); };
  const stored = receipt(await adapters.sol.call('message_teammate', { to: 'qwen', text: 'retain me' }));
  assert.match(stored.delivery, /已入收件箱/);
  await adapters.qwen.call('message_teammate', { to: 'lead', text: 'report before failure' });
  assert.equal(session.members.get('qwen').queue.length, 0);
  assert.equal(session.members.get('qwen').inbox.length, 1);
  finish({ status: 'failed', error: 'fixture failure' }); await session.waitForSettled();
  assert.equal(adapters.lead.prompts.length, 1);
  assert.match(adapters.lead.prompts[0], /report before failure[\s\S]*fixture failure/);
  assert.ok(events.some(e => e.type === 'wake' && e.member === 'lead' && e.reason === 'platform' && e.inboxCount === 1));
  session.retry('qwen'); await session.waitForSettled();
  assert.match(adapters.qwen.prompts[0], /retain me[\s\S]*用户请求重试/);
});

test('wake rules: user wake drains lead inbox and platform wake drains worker inbox', async t => {
  const { session, adapters, events } = await team(t, { sol: never });
  await adapters.lead.call('interrupt_teammate', { to: 'sol', text: 'hold' }); await tick();
  await adapters.sol.call('message_teammate', { to: 'lead', text: 'report' });
  session.sendUser('user response'); await tick();
  assert.match(adapters.lead.prompts[0], /report[\s\S]*user response/);
  assert.ok(events.some(e => e.type === 'wake' && e.member === 'lead' && e.reason === 'user' && e.inboxCount === 1));
  await adapters.sol.call('message_teammate', { to: 'qwen', text: 'background' });
  session.enqueue(session.members.get('qwen'), '[platform] respond'); await tick();
  assert.match(adapters.qwen.prompts[0], /background[\s\S]*respond/);
});

test('wake rules: a plain assignment from the lead wakes an idle worker, by board or message', async t => {
  const { adapters, events } = await team(t, { sol: never });
  await adapters.lead.call('post_board', { text: 'please do the research', notify: ['qwen'] }); await tick();
  assert.match(adapters.qwen.prompts[0] ?? '', /please do the research/);
  assert.ok(events.some(e => e.type === 'wake' && e.member === 'qwen' && e.reason === 'lead'));
  await adapters.lead.call('message_teammate', { to: 'sol', text: 'and you check it' }); await tick();
  assert.match(adapters.sol.prompts[0] ?? '', /and you check it/);
});

test('wake rules: with a teammate failed, a report to the lead still reaches it when the team is quiet', async t => {
  let finish; const held = new Promise(resolve => { finish = resolve; });
  const { session, adapters } = await team(t, { qwen: async () => ({ status: 'failed', error: 'fixture failure' }), sol: async () => held });
  await adapters.lead.call('interrupt_teammate', { to: 'all', text: 'work' });
  await later();
  assert.equal(session.members.get('qwen').failed, true);
  const seen = adapters.lead.prompts.length;
  await adapters.sol.call('message_teammate', { to: 'lead', text: 'final report' });
  finish(completed); await tick(); await later(); await session.waitForSettled();
  assert.equal(adapters.lead.prompts.length, seen + 1);
  assert.match(adapters.lead.prompts.at(-1), /final report/);
  assert.equal(session.members.get('lead').inbox.length, 0);
});

test('wake rules: at quiet the lead is told who holds an unread handoff, and the worker stays asleep', async t => {
  let finish; const held = new Promise(resolve => { finish = resolve; });
  const { session, adapters } = await team(t, { sol: async () => held });
  await adapters.lead.call('message_teammate', { to: 'sol', text: 'work' }); await tick();
  await adapters.sol.call('message_teammate', { to: 'qwen', text: 'your turn with the file' });
  assert.equal(adapters.qwen.prompts.length, 0);
  finish(completed); await later(); await session.waitForSettled();
  assert.equal(adapters.qwen.prompts.length, 0);
  assert.match(adapters.lead.prompts.at(-1), /Unread, not woken: qwen has 1 from sol/);
});

test('wake rules: parked worker retains notifications until explicit ask', async t => {
  let endTurn;
  const { session, adapters } = await team(t, { qwen: async (a, _, n) => {
    if (n === 1) { a.maxBlockMs = 1; a.cancel = () => endTurn(completed); const ended = new Promise(resolve => { endTurn = resolve; }); void a.call('wait_for_messages'); return ended; }
    return completed;
  }, sol: never });
  await adapters.lead.call('interrupt_teammate', { to: 'all', text: 'start' }); await later(); await tick();
  assert.equal(session.members.get('qwen').parked, true);
  await adapters.sol.call('post_board', { text: 'parked note', notify: ['qwen'] }); await tick();
  assert.equal(adapters.qwen.prompts.length, 1);
  assert.equal(session.members.get('qwen').inbox.length, 1);
  await adapters.sol.call('post_board', { text: 'question @qwen?' }); await tick();
  assert.equal(adapters.qwen.prompts.length, 2);
  assert.match(adapters.qwen.prompts[1], /parked note[\s\S]*question/);
});

test('wake rules: failed concurrent steers retain creation order and do not resume wait', async t => {
  const { session, adapters } = await team(t, { qwen: never });
  await adapters.lead.call('interrupt_teammate', { to: 'qwen', text: 'work' }); await tick();
  const gates = [];
  adapters.qwen.steer = () => new Promise(resolve => gates.push(resolve));
  const one = adapters.sol.call('message_teammate', { to: 'qwen', text: 'first' });
  const two = adapters.sol.call('message_teammate', { to: 'qwen', text: 'second' });
  gates[1]('idle'); await two; gates[0]('idle'); await one;
  const inbox = session.members.get('qwen').inbox;
  assert.match(inbox[0].text, /first/); assert.match(inbox[1].text, /second/);
  assert.equal(session.members.get('qwen').queue.length, 0);
});

test('Codex archive result remains observable after session stop begins', async t => {
  const { session, adapters, events } = await team(t);
  adapters.lead.stop = async () => adapters.lead.onEvent({ type: 'codex-archive', success: true, threadId: 'fixture' });
  await session.stop();
  assert.ok(events.some(e => e.type === 'codex-archive' && e.member === 'lead' && e.success));
});
