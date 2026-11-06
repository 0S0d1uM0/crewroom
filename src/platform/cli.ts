import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { PlatformSession, type AdapterFactory } from './session.js';
import { createAdapter } from './adapters/index.js';
import { redact } from '../config.js';

export async function main(args = process.argv.slice(2), factory: AdapterFactory = createAdapter) {
  const option = (name: string) => { const index = args.indexOf(name); if (index < 0) return undefined; const value = args[index + 1]; if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`); return value; };
  const config = option('--config'); if (!config) throw new Error('Usage: node dist/platform/cli.js --config team.json [--message "..."]');
  const message = option('--message');
  const replies = new Map<string, { id: unknown; text: string }>();
  function flush(member?: string) {
    for (const [name, reply] of replies) if (!member || member === name) {
      process.stdout.write(reply.text + '\n'); replies.delete(name);
    }
  }
  const session = new PlatformSession(JSON.parse(readFileSync(config, 'utf8')), factory, event => {
    const member = String(event.member ?? '');
    if (event.type === 'to-user') {
      if (event.messageId) replies.set(member, { id: event.messageId, text: String(event.text) });
      else process.stdout.write(String(event.text) + '\n');
    } else {
      if (event.type === 'message-update') {
        const reply = replies.get(member);
        if (reply && reply.id === event.messageId) reply.text = event.append ? reply.text + String(event.text) : String(event.text);
      }
      if (['turn-end', 'wait-start', 'member-failed'].includes(event.type)) flush(member);
      process.stderr.write(JSON.stringify(event) + '\n');
    }
  });
  let input: ReturnType<typeof createInterface> | undefined;
  let interrupted = false;
  const shutdown = () => { interrupted = true; input?.close(); void session.stop(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  try {
    await session.start();
    if (message !== undefined) { session.sendUser(message); await session.waitForSettled(); }
    else {
      input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of input) { if (interrupted) break; if (line.trim()) session.sendUser(line); }
      await session.waitForSettled();
    }
  } finally {
    await session.stop(); flush();
    process.stderr.write(JSON.stringify({ summary: session.summary() }) + '\n');
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
    if (interrupted) process.exitCode = 130;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(redact(String(error)) + '\n'); process.exitCode = 1; });
}
