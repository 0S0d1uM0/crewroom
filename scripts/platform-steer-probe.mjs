// Live subscription-quota probe. Write-only deliverable; run only with explicit authorization.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeAdapter } from '../dist/platform/adapters/claude.js';
import { CodexAdapter } from '../dist/platform/adapters/codex.js';
import { makeFixture } from './validation-common.mjs';
import { sanitize } from '../dist/platform/storage.js';

if (!process.argv.includes('--authorized-this-run')) throw new Error('Explicit approval and --authorized-this-run are required; this script uses real subscription quota');
const root = mkdtempSync(join(tmpdir(), 'crewroom-steer-'));
const fx = makeFixture(root, randomUUID());
const report = { root, results: [] };
let active;
let interrupted = false;
const shutdown = () => { interrupted = true; void active?.stop(); process.exitCode = 130; };
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
const instructions = 'Follow the task. Do not spawn agents or run collab. Work only in your working directory.';
for (const harness of ['claude', 'codex']) {
  if (interrupted) break;
  const config = { name: harness, harness, role: 'worker', model: harness === 'claude' ? 'claude-haiku-5-5' : 'gpt-6-luna', effort: 'low' };
  const adapter = harness === 'claude' ? new ClaudeAdapter(config, fx.a, root) : new CodexAdapter(config, fx.a);
  active = adapter;
  const code = 'STEER-' + randomUUID().slice(0, 8);
  let text = '', lastMessage = '', tools = 0, steerPromise;
  let timeout;
  adapter.onMessage = message => { text += message + '\n'; lastMessage = message; };
  adapter.onEvent = event => {
    if (event.type === 'tool' && ++tools === 1) steerPromise = adapter.steer(`Teammate interjection: include ${code} in your final reply.`);
  };
  try {
    await adapter.start(instructions);
    const result = await Promise.race([
      adapter.prompt('Read these five files in order with five separate tool calls: README.md, notes.txt, src/calc.mjs, test/calc.test.mjs, where.txt. Then give a final reply.'),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Turn timed out after ten minutes')), 600000); }),
    ]);
    const steering = steerPromise ? await steerPromise : 'no-tool-call';
    report.results.push({ harness, result, tools, steering, replyHasCode: lastMessage.includes(code), pass: steering === 'steered' && lastMessage.includes(code), finalReply: lastMessage, transcript: text });
  } catch (error) { report.results.push({ harness, pass: false, error: String(error) }); }
  finally { clearTimeout(timeout); await adapter.stop(); active = undefined; }
}
process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
console.log(JSON.stringify(sanitize(report), null, 2));
if (interrupted) process.exitCode = 130;
else if (report.results.some(r => !r.pass)) process.exitCode = 1;
