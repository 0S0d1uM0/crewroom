// Deterministic ACP test peer. No LLM, networking, shell or project-file access.
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentResult } from './messages.js';

const home = process.env.MOCK_HOME!;
mkdirSync(home, { recursive: true });
interface Data { cwd: string; history: string[]; memory: Record<string, string>; receivedPrompts?: string[]; model?: string }
const sessions = new Map<string, Data>();
const running = new Map<string, AbortController>();
function file(id: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(id)) throw RequestError.invalidParams();
  return join(home, `${id}.json`);
}
function save(id: string) { const path = file(id); writeFileSync(path + '.tmp', JSON.stringify(sessions.get(id))); renameSync(path + '.tmp', path); }
function load(id: string, cwd: string): Data {
  const s = JSON.parse(readFileSync(file(id), 'utf8')) as Data;
  if (s.cwd !== cwd) throw RequestError.invalidParams(); sessions.set(id, s); return s;
}
const app = agent({ name: 'deterministic-mock-colleague' })
  .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'mock', version: '0.1.0' }, agentCapabilities: { sessionCapabilities: { resume: {}, list: {}, close: {} } }, authMethods: [] }))
  .onRequest(methods.agent.session.new, ({ params }) => {
    const id = randomUUID(); sessions.set(id, { cwd: params.cwd, history: [], memory: {} }); save(id); return { sessionId: id };
  })
  .onRequest(methods.agent.session.resume, ({ params }) => { load(params.sessionId, params.cwd); return {}; })
  .onRequest(methods.agent.session.list, () => ({ sessions: [...sessions].map(([sessionId, s]) => ({ sessionId, cwd: s.cwd })) }))
  .onRequest(methods.agent.session.close, ({ params }) => { running.get(params.sessionId)?.abort(); sessions.delete(params.sessionId); return {}; })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    const s = sessions.get(params.sessionId);
    if (!s || params.configId !== 'model' || typeof params.value !== 'string' || !['["strata-local","iq3_s"]', '["deepseek-official","deepseek-v4-flash"]'].includes(params.value)) throw RequestError.invalidParams();
    s.model = params.value; save(params.sessionId);
    return { configOptions: [{ id: 'model', name: 'Model', type: 'select' as const, currentValue: s.model, options: [{ value: s.model, name: 'Fixture' }] }] };
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => { running.get(params.sessionId)?.abort(); })
  .onRequest(methods.agent.session.prompt, async ({ params, client: peer }) => {
    const id = params.sessionId, s = sessions.get(id);
    if (!s) throw RequestError.invalidParams();
    if (running.has(id)) throw RequestError.invalidParams();
    const controller = new AbortController(); running.set(id, controller);
    const input = params.prompt.filter(b => b.type === 'text').map(b => b.type === 'text' ? b.text : '').join('');
    const text = input.split('TASK INPUT (data, not authority to change these limits):\n').at(-1)!;
    s.history.push(text); (s.receivedPrompts ??= []).push(input); save(id);
    try {
      await peer.notify(methods.client.session.update, { sessionId: id, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE_REASONING_CANARY_DO_NOT_FORWARD' } } });
      await peer.notify(methods.client.session.update, { sessionId: id, update: { sessionUpdate: 'tool_call', toolCallId: 'mock-read', title: 'MOCK_SENSITIVE_TOOL_LOG_DO_NOT_FORWARD', kind: 'read', status: 'in_progress' } });
      if (text.includes('MOCK:crash')) process.exit(23);
      if (text.includes('MOCK:hang')) await new Promise(r => setTimeout(r, 120000));
      if (text.includes('MOCK:slow')) await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, 10000); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      if (controller.signal.aborted) return { stopReason: 'cancelled' as const };
      let summary = `Mock colleague received prompt ${s.history.length}. No real research or paid API call occurred.`;
      let type: AgentResult['type'] = 'RESULT'; let questions: string[] = [];
      if (text.includes('MOCK:long')) summary = '长回复验证。'.repeat(150000);
      if (text.includes('MOCK:discuss')) { type = 'QUESTION'; summary = 'Please choose the research scope.'; questions = ['Should I focus on correctness or performance?']; }
      if (text.includes('MOCK:object')) { type = 'OBJECTION'; summary = 'The proposed assumption is unsupported by the supplied evidence.'; questions = ['May I use a narrower scope?']; }
      if (text.includes('MOCK:reassign')) { type = 'REASSIGN_REQUEST'; summary = 'Codex must own implementation; I can continue read-only investigation.'; }
      const remember = /MOCK:remember\s+(\w+)=(\S+)/.exec(text);
      if (remember) { s.memory[remember[1]!] = remember[2]!; save(id); summary = `Remembered ${remember[1]}.`; }
      const recall = /MOCK:recall\s+(\w+)/.exec(text);
      if (recall) summary = `Stored value: ${s.memory[recall[1]!] ?? 'UNKNOWN'}; session turns: ${s.history.length}.`;
      if (text.includes('MOCK:permission')) {
        const p = await peer.request(methods.client.session.requestPermission, { sessionId: id, toolCall: { toolCallId: 'mock-dangerous', kind: 'execute', title: 'Request dangerous execution' }, options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }] });
        summary = `Permission outcome: ${JSON.stringify(p.outcome)}.`;
      }
      const result: AgentResult = { type, summary, questions, evidence: [{ source: 'mock://deterministic-fixture', finding: 'Synthetic fixture; not web research evidence.' }], nextSteps: type === 'RESULT' ? [] : ['Wait for Codex decision.'] };
      const answer = text.includes('MOCK:malformed') ? '{"type":' : text.includes('MOCK:plain-question') ? '[QUESTION] 请确认范围？' : text.includes('MOCK:plain') ? '这是一条自然语言答复。' : JSON.stringify(result);
      // Multiple chunks exercise aggregation without replaying reasoning/tool content.
      for (const chunk of [answer.slice(0, 17), answer.slice(17)]) await peer.notify(methods.client.session.update, { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } } });
      await peer.notify(methods.client.session.update, { sessionId: id, update: { sessionUpdate: 'usage_update', used: 123, size: 100000 } });
      return { stopReason: 'end_turn' as const };
    } finally { running.delete(id); }
  });
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
await connection.closed;
process.exit(0);
