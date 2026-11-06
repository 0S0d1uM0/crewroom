// Can a platform tool hold a harness turn open for a long time, cost no model calls meanwhile,
// and still be interrupted? Spends a few cheap model calls, so it needs --authorized-this-run.
// Luna is left out by default: Codex cannot hold a call open without polling, which is why the
// platform ends its turn instead (see scripts/platform-park-check.mjs). Including it shows the polling.
// Usage: node scripts/tool-block-probe.mjs --authorized-this-run [--block-ms 660000] [--members haiku,qwen]
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeAdapter } from '../dist/platform/adapters/claude.js';
import { CodexAdapter } from '../dist/platform/adapters/codex.js';
import { DshAdapter } from '../dist/platform/adapters/dsh.js';
import { ToolServer } from '../dist/platform/tool-server.js';
import { makeFixture } from './validation-common.mjs';

const argv = process.argv.slice(2);
if (!argv.includes('--authorized-this-run')) { console.error('Refusing without --authorized-this-run'); process.exit(2); }
const option = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const blockMs = Number(option('--block-ms', 660000)), names = option('--members', 'haiku,qwen').split(',');
const root = mkdtempSync(join(tmpdir(), 'agents-tool-block-'));
const definitions = [
  { name: 'wait_for_messages', description: 'Block until a teammate message arrives, then return it. May take a long time; that is normal. Takes no arguments.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'post_board', description: 'Post text to the team board. Returns a receipt.', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'What to post' } }, required: ['text'], additionalProperties: false } },
];
const server = new ToolServer(); await server.start();
const log = (who, what) => console.log(`${new Date().toISOString().slice(11, 19)} ${who} ${what}`);

async function scenario(name) {
  const sessionDir = join(root, name, 'session'); mkdirSync(sessionDir, { recursive: true });
  const fx = makeFixture(join(root, name), randomUUID());
  const calls = []; let release, phase = 'long';
  const token = `TOKEN-${randomUUID().slice(0, 8)}`;
  const host = { definitions, call: async (tool, args, signal) => {
    const call = { tool, args, at: Date.now() }; calls.push(call); log(name, `tool ${tool} ${JSON.stringify(args)} phase=${phase}`);
    if (tool === 'post_board') return { text: JSON.stringify({ id: 'b1', notified: [] }) };
    if (tool !== 'wait_for_messages') return { text: `Unknown tool ${tool}`, isError: true };
    const text = await new Promise(resolve => {
      const timer = phase === 'long' ? setTimeout(() => resolve(token), blockMs) : undefined;
      release = () => { clearTimeout(timer); resolve('released'); };
      signal?.addEventListener('abort', () => { call.aborted = Date.now(); clearTimeout(timer); resolve('aborted'); });
    });
    call.heldMs = Date.now() - call.at; log(name, `tool ${tool} returned after ${call.heldMs} ms: ${text}`);
    return { text };
  } };
  const member = name === 'haiku' ? { name, harness: 'claude', model: 'claude-haiku-5-5', role: 'worker', effort: 'low' }
    : name === 'luna' ? { name, harness: 'codex', model: 'gpt-6-luna', role: 'worker', effort: 'low' } : { name, harness: 'dsh', model: 'local', role: 'worker' };
  const adapter = member.harness === 'claude' ? new ClaudeAdapter(member, fx.a, sessionDir) : member.harness === 'codex' ? new CodexAdapter(member, fx.a) : new DshAdapter(member, fx.a, sessionDir);
  adapter.tools = { ...host, endpoint: server.register(name, host) };
  let reply = ''; const tools = [];
  adapter.onMessage = text => { reply += text; };
  adapter.onEvent = event => { if (event.type === 'tool') tools.push(`${event.title ?? event.kind}:${event.status ?? ''}`); };
  const out = { name, steps: [] };
  try {
    await adapter.start('You are a test worker. Do exactly what each message asks. Use the provided tools, not the shell.');
    log(name, 'started');
    let started = Date.now(); reply = '';
    let r = await adapter.prompt('Call the wait_for_messages tool now, exactly once, with no arguments. It will block for a long time; that is expected. When it returns, reply with the exact text it returned and nothing else.');
    const waits = calls.filter(c => c.tool === 'wait_for_messages');
    out.steps.push({ id: 'long block', status: r.status, ms: Date.now() - started, waitCalls: waits.length, heldMs: waits[0]?.heldMs, usage: r.usage, reply: reply.slice(0, 200), pass: r.status === 'completed' && reply.includes(token) && waits.length === 1 && waits[0].heldMs >= blockMs - 1000 });
    log(name, 'long block ' + JSON.stringify(out.steps.at(-1)));
    phase = 'interrupt'; started = Date.now(); reply = '';
    const prompt = adapter.prompt('Call post_board with the text "hello", then call wait_for_messages once. When it returns, reply with what it returned.');
    const seen = calls.length;
    while (!(calls.length >= seen + 2 && calls.at(-1).tool === 'wait_for_messages') && Date.now() - started < 180000) await new Promise(res => setTimeout(res, 200));
    await new Promise(res => setTimeout(res, 15000));
    const interruptAt = Date.now(); await adapter.interrupt();
    r = await Promise.race([prompt, new Promise(res => setTimeout(() => res({ status: 'stuck after interrupt' }), 60000))]);
    const stuck = r.status === 'stuck after interrupt';
    const aborted = calls.at(-1).aborted;
    release?.();  // The session releases a member's wait at turn end; the probe does the same.
    if (stuck) r = await Promise.race([prompt, new Promise(res => setTimeout(() => res({ status: 'stuck after release' }), 60000))]);
    out.steps.push({ id: 'interrupt while blocked', status: r.status, stuckBeforeRelease: stuck, turnEndMs: Date.now() - interruptAt, abortSeenMs: aborted ? aborted - interruptAt : null, post: calls.some(c => c.tool === 'post_board' && c.args?.text === 'hello'), pass: r.status === 'cancelled' && !stuck });
    log(name, 'interrupt ' + JSON.stringify(out.steps.at(-1)));
    phase = 'after'; reply = ''; started = Date.now();
    r = await adapter.prompt('Without calling any tool: what exact text did the first wait_for_messages call return? Reply with only that text.');
    out.steps.push({ id: 'alive and remembers', status: r.status, reply: reply.slice(0, 200), pass: r.status === 'completed' && reply.includes(token) });
    log(name, 'after ' + JSON.stringify(out.steps.at(-1)));
    out.tools = tools.slice(0, 20);
  } catch (error) { out.steps.push({ id: 'run', error: String(error?.stack ?? error).slice(0, 1200), calls: calls.length, pass: false }); log(name, 'error ' + out.steps.at(-1).error); }
  finally { release?.(); await adapter.stop().catch(() => {}); }
  return out;
}
const results = await Promise.all(names.map(scenario));
await server.stop();
const success = results.every(r => r.steps.length && r.steps.every(s => s.pass));
const report = { root, blockMs, success, results };
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(success ? 0 : 1);
