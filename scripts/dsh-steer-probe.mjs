// Does DSH accept a message into a running turn? Local Qwen only: the cloud route
// points at a closed port, so this cannot bill anything. Tools are read-only.
// Usage: node scripts/dsh-steer-probe.mjs
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseDocument, stringify } from 'yaml';
import { methods } from '@agentclientprotocol/sdk';
import { AcpWorker } from '../dist/acp.js';
import { dshLaunch } from '../dist/dsh.js';
import { stateHome, secureHome } from '../dist/config.js';
import { makeFixture, sleep } from './validation-common.mjs';

const runId = new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 6);
const root = stateHome(); secureHome(root);
const home = join(root, 'dsh-steer-probe', runId); mkdirSync(home, { recursive: true });
const inbox = join(home, 'inbox'); mkdirSync(inbox);
const fixtureRoot = join(tmpdir(), 'collab-dsh-steer', runId); mkdirSync(fixtureRoot, { recursive: true });
const fx = makeFixture(fixtureRoot, 'TOKEN-' + randomUUID().slice(0, 8));

// Read only the loopback Responses provider, with the same field allowlist as localModel().
function localProvider() {
  const entries = parseDocument(readFileSync(join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')).toJS();
  const providers = entries.find(e => e.id === 'llm-pi-ai')?.config?.providers ?? {};
  for (const [provider, c] of Object.entries(providers)) {
    const url = new URL(c.baseURL);
    if (url.hostname !== '127.0.0.1' || c.api !== 'openai-responses' || !c.models?.length) continue;
    const m = c.models[0];
    return { provider, model: m.id, selection: JSON.stringify([provider, m.id]), name: m.name,
      config: { displayName: c.displayName, apiKeyEnv: c.apiKeyEnv, api: c.api, baseURL: c.baseURL, models: [{ id: m.id, name: m.name, contextWindow: m.contextWindow, ...(m.maxTokens === undefined ? {} : { maxTokens: m.maxTokens }), reasoningEfforts: m.reasoningEfforts }] } };
  }
  throw new Error('No loopback Responses provider in the DSH desktop profile');
}
const model = localProvider();
const launch = dshLaunch(home, { baseURL: 'http://127.0.0.1:9/anthropic', maxOutputTokens: null, research: true, workspace: fx.a, local: { model, baseURL: model.config.baseURL } });

// Add the probe plugin next to the orchestrator's own guard plugin, for this isolated launch.
const install = process.env.CREWROOM_DSH_INSTALL ?? 'D:\\DSH';
const profilePatch = join(home, 'dsh-home', 'profiles', 'acp', 'cordis.patch.yml');
const patch = parseDocument(readFileSync(profilePatch, 'utf8')).toJS();
patch[0].insert.push({ id: 'collab-steer-probe', name: fileURLToPath(new URL('../dist/platform/dsh-steer-plugin.js', import.meta.url)),
  config: { inbox, llmModule: join(install, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js') } });
writeFileSync(profilePatch, stringify(patch));

let t = null;
const collector = () => ({ text: '', chunks: 0, tools: [], lastChunkAt: 0, chunksAfterSteer: 0, charsAfterSteer: 0, steerAt: 0, firstToolAfterSteer: null });
const worker = new AcpWorker(launch, {
  update: p => {
    const u = p.update; if (!t) return;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      t.text += u.content.text; t.chunks++; t.lastChunkAt = Date.now();
      t.segments = [...(t.segments ?? []), { at: Date.now(), chars: u.content.text.length, head: u.content.text.slice(0, 24), tail: u.content.text.slice(-40) }];
      if (t.steerAt) { t.chunksAfterSteer++; t.charsAfterSteer += u.content.text.length; }
    } else if (u.sessionUpdate === 'tool_call') {
      t.tools.push({ title: u.title, at: Date.now() });
      if (t.steerAt && t.firstToolAfterSteer === null) t.firstToolAfterSteer = Date.now() - t.steerAt;
    }
  },
  permission: p => { const o = p.options.find(x => x.kind === 'reject_once'); return Promise.resolve(o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : { outcome: { outcome: 'cancelled' } }); },
});
const within = (promise, ms, label) => Promise.race([promise, sleep(ms).then(() => { throw new Error(`Timeout: ${label}`); })]);
async function steer(sessionId, text) {
  const id = randomUUID(), file = join(inbox, id + '.json');
  writeFileSync(file + '.tmp', JSON.stringify({ sessionId, text }));
  renameSync(file + '.tmp', file);
  t.steerAt = Date.now();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (existsSync(file + '.taken.ok')) return { accepted: true };
    if (existsSync(file + '.taken.err')) return { accepted: false, error: readFileSync(file + '.taken.err', 'utf8').slice(0, 500) };
    await sleep(20);
  }
  return { accepted: false, error: 'Plugin did not respond within 5s' };
}
async function freshSession() {
  const id = await worker.session(fx.a, null);
  await worker.selectModel(id, model.selection);
  return id;
}

const report = { runId, model: { provider: model.provider, id: model.model, name: model.name }, results: [] };
const LONG = 'Without using any tools, write every integer from 1 to 1500 in ascending order, one per line, and nothing else.';
try {
  report.initialize = { capabilities: Object.keys((await worker.initialize()).agentCapabilities ?? {}) };

  { // S1: a second session/prompt during a running turn.
    const id = await freshSession(); t = collector();
    // Text arrives in large batches rather than token by token, so waiting for a chunk
    // would mean waiting for the end of generation. Fire on a clock instead.
    const running = worker.prompt(id, LONG).catch(e => ({ failed: String(e.message ?? e) }));
    await sleep(1000);
    const midTurn = t.chunks === 0;
    const second = await worker.prompt(id, 'Reply with exactly SECOND.').then(r => ({ accepted: true, stopReason: r.stopReason }), e => ({ accepted: false, error: String(e.message ?? e).slice(0, 300) }));
    await worker.cancel(id); await within(running, 180000, 'S1 cancel');
    report.results.push({ id: 'S1 second prompt mid-turn', midTurn, second, pass: midTurn && !second.accepted });
  }
  { // S2: steer into a turn that uses tools, so it has step boundaries.
    const code = 'STEER-' + randomUUID().slice(0, 8);
    const id = await freshSession(); t = collector();
    const started = Date.now();
    const running = worker.prompt(id, 'Use your read tool on these files, one call per message, in this exact order: README.md, notes.txt, src/calc.mjs, test/calc.test.mjs, where.txt. After all five, reply with the single word FINISHED.');
    while (!t.tools.length && Date.now() - started < 120000) await sleep(50);
    const toolsAtSteer = t.tools.length;
    const steered = await steer(id, `Interjection from a teammate: also include the code ${code} in your final reply.`);
    const response = await within(running, 300000, 'S2 turn');
    report.results.push({ id: 'S2 steer into a tool-using turn', steered, stopReason: response.stopReason, toolsAtSteer, toolsTotal: t.tools.length, msToFirstToolAfterSteer: t.firstToolAfterSteer,
      replyHasCode: t.text.includes(code), reply: t.text.slice(-300), ms: Date.now() - started, pass: steered.accepted && response.stopReason === 'end_turn' && t.text.includes(code) });
  }
  { // S3: steer into plain generation, which has no tool boundary to stop at.
    const code = 'STEER-' + randomUUID().slice(0, 8);
    const id = await freshSession(); t = collector();
    const started = Date.now();
    const running = worker.prompt(id, LONG);
    await sleep(1000);
    const charsAtSteer = t.text.length;
    const steered = await steer(id, `Interjection from a teammate: stop what you are doing and reply with the code ${code}.`);
    const steerAt = t.steerAt;
    const response = await within(running, 300000, 'S3 turn');
    report.results.push({ id: 'S3 steer into plain generation', steered, stopReason: response.stopReason, charsAtSteer, chunks: t.chunks, charsAfterSteer: t.charsAfterSteer, msFromSteerToEnd: Date.now() - steerAt,
      replyHasCode: t.text.includes(code), segments: (t.segments ?? []).map(s => ({ afterSteerMs: s.at - steerAt, chars: s.chars, head: s.head, tail: s.tail })), informational: true, pass: charsAtSteer === 0 && steered.accepted });
  }
  { // S5: the same, with a shorter generation and a request that does not contradict it.
    const code = 'STEER-' + randomUUID().slice(0, 8);
    const id = await freshSession(); t = collector();
    const running = worker.prompt(id, 'Without using any tools, write every integer from 1 to 300 in ascending order, one per line.');
    await sleep(500);
    const charsAtSteer = t.text.length;
    const steered = await steer(id, `Interjection from a teammate: when you finish, also reply with the code ${code}.`);
    const steerAt = t.steerAt;
    const response = await within(running, 300000, 'S5 turn');
    report.results.push({ id: 'S5 steer, short generation, compatible request', steered, stopReason: response.stopReason, charsAtSteer, msFromSteerToEnd: Date.now() - steerAt, replyHasCode: t.text.includes(code),
      segments: (t.segments ?? []).map(s => ({ afterSteerMs: s.at - steerAt, chars: s.chars, head: s.head, tail: s.tail })), pass: charsAtSteer === 0 && steered.accepted && t.text.includes(code) });
  }
  { // S4: steer a session with no running turn. Does it wake without a prompt?
    const code = 'STEER-' + randomUUID().slice(0, 8);
    const id = await freshSession(); t = collector();
    await within(worker.prompt(id, 'Without using any tools, reply with exactly OK.'), 120000, 'S4 setup');
    t = collector();
    const steered = await steer(id, `Interjection from a teammate: reply with the code ${code}.`);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !t.text.includes(code)) await sleep(100);
    const quietText = t.text;
    // A normal prompt afterwards must still work, and shows whether the steer was kept.
    const after = await within(worker.prompt(id, 'Without using any tools: did a teammate give you a code? Reply with the code, or NONE.').then(r => ({ stopReason: r.stopReason }), e => ({ error: String(e.message ?? e).slice(0, 300) })), 120000, 'S4 follow-up');
    report.results.push({ id: 'S4 steer an idle session', steered, wokeWithoutPrompt: quietText.includes(code), textWithoutPrompt: quietText.slice(0, 200), after, replyAfter: t.text.slice(quietText.length).slice(-200), codeKept: t.text.includes(code), pass: true, informational: true });
  }
  report.success = report.results.every(r => r.pass);
} catch (e) { report.error = String(e.message ?? e).slice(0, 800); report.stderr = worker.stderr?.slice(-800); report.success = false; }
finally {
  await worker.stop(3000).catch(() => {});
  writeFileSync(join(home, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.success ? 0 : 1);
}
