import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { ToolEndpoint, ToolHost } from './types.js';

const MAX_BODY = 8 * 1024 * 1024;
const PROTOCOL = '2025-06-18';
const PING_MS = 15_000;

// A minimal MCP Streamable HTTP server, loopback only. Each member gets its own path and token,
// so a call's author comes from the token and cannot be claimed by the model.
export class ToolServer {
  private server?: Server;
  private members = new Map<string, { token: Buffer; host: ToolHost }>();
  private port = 0;
  async start() {
    const server = this.server = createServer((req, res) => { void this.handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); }); });
    // A blocking call holds its request open, for as long as the wait lasts.
    server.requestTimeout = 0; server.timeout = 0;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    this.port = (server.address() as AddressInfo).port;
  }
  register(member: string, host: ToolHost): ToolEndpoint {
    if (!this.server) throw new Error('Tool server is not started');
    const token = randomBytes(32).toString('hex');
    this.members.set(member, { token: Buffer.from(token), host });
    return { url: `http://127.0.0.1:${this.port}/mcp/${encodeURIComponent(member)}`, token };
  }
  async stop() {
    const server = this.server; if (!server) return;
    this.server = undefined; server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) { res.writeHead(403).end(); return; }
    const match = /^\/mcp\/([^/?]+)$/.exec(req.url ?? '');
    const member = match ? this.members.get(decodeURIComponent(match[1]!)) : undefined;
    if (!member) { res.writeHead(404).end(); return; }
    const given = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.concat([Buffer.from('Bearer '), member.token]);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) { res.writeHead(401).end(); return; }
    // No server-initiated stream and no sessions: the client treats 405 as "not offered".
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) { res.writeHead(413).end(); return; } chunks.push(chunk as Buffer); }
    let frame: any;
    try { frame = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { res.writeHead(400).end(); return; }
    if (frame?.id === undefined || frame.id === null) { res.writeHead(202).end(); return; }
    const reply = (body: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: frame.id, ...(body as object) })); };
    if (frame.method === 'initialize') reply({ result: { protocolVersion: frame.params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'crewroom', version: '0.1.0' } } });
    else if (frame.method === 'ping') reply({ result: {} });
    else if (frame.method === 'tools/list') reply({ result: { tools: member.host.definitions.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    else if (frame.method === 'permissions/check') {
      if (!member.host.authorize) return reply({ error: { code: -32601, message: 'Permission handler unavailable' } });
      await this.call({ definitions: [], call: async (_name, args, signal) => ({ text: JSON.stringify(await member.host.authorize!(args as any, signal)) }) }, { id: frame.id, params: { arguments: frame.params } }, req, res);
    }
    else if (frame.method === 'tools/call') await this.call(member.host, frame, req, res);
    else reply({ error: { code: -32601, message: `Unknown method: ${frame.method}` } });
  }
  // Answered as an event stream so the pings keep every HTTP client's idle timer from firing.
  private async call(host: ToolHost, frame: any, req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.flushHeaders();
    const abort = new AbortController();
    res.once('close', () => abort.abort());
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    try {
      const result = await host.call(String(frame.params?.name), frame.params?.arguments ?? {}, abort.signal);
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { content: [{ type: 'text', text: result.text }], isError: result.isError === true } })}\n\n`);
    } catch (error) {
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { content: [{ type: 'text', text: String(error) }], isError: true } })}\n\n`);
    } finally { clearInterval(ping); res.end(); }
  }
}
