// Does a real DeepSeek member work through the packaged app, alongside local Qwen? A short job, with a
// time limit that ends it. Spends real DeepSeek credit, so it needs --authorized-this-run and a fresh
// user approval each time. Never part of npm test.
// Usage: node scripts/deepseek-check.mjs --authorized-this-run
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { scrubbedEnv } from '../dist/platform/env.js';

if (!process.argv.includes('--authorized-this-run')) throw new Error('--authorized-this-run is required; this script spends DeepSeek credit');
const repo = new URL('../', import.meta.url).pathname.replace(/^\//, '');
const FLASH = '["deepseek-official","deepseek-flash"]', LIMIT_MS = 4 * 60 * 1000;
const root = mkdtempSync(join(tmpdir(), 'agents-deepseek-')), home = join(root, 'home'), workspace = join(root, '项目');
mkdirSync(home); mkdirSync(join(workspace, 'src'), { recursive: true });
writeFileSync(join(workspace, 'src', 'calc.mjs'), 'export function add(a, b) {\n  return a - b;\n}\n');
const git = args => spawnSync('git', args, { cwd: workspace, env: scrubbedEnv(), windowsHide: true });
git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', '初始']);
const service = spawn(join(repo, 'release/Crewroom/Crewroom.exe'), [join(repo, 'release/Crewroom/resources/app/dist/app/server.js')], { env: { ...scrubbedEnv(), CREWROOM_HOME: home, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true, detached: true });
service.unref();
const lock = join(home, 'service.lock', 'info.json'), later = ms => new Promise(resolve => setTimeout(resolve, ms));
for (let i = 0; i < 100 && !existsSync(lock); i++) await later(100);
const { pid, port, token } = JSON.parse(readFileSync(lock, 'utf8'));
const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json', Origin: `http://127.0.0.1:${port}` };
const api = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
};
const report = { root };
try {
  const catalog = await api('models/scan', {});
  report.flashListed = catalog.dsh.models.find(m => m.id === FLASH);
  const project = await api('projects', { path: workspace });
  const session = await api('sessions', { projectId: project.id ?? project.project?.id, title: 'Flash + Qwen', mode: 'shared', members: [
    { name: '闪电', harness: 'dsh', model: FLASH, effort: 'off', role: 'lead' },
    { name: '小千', harness: 'dsh', model: 'local', role: 'worker' },
  ] });
  report.sessionStatus = session.status; report.sessionError = session.error;
  await api(`sessions/${session.id}/messages`, { text: 'src/calc.mjs 里的 add 写错了。请让 小千 修好它，并用 node 命令验证 add(2, 3) 等于 5。小千汇报后，你读一下文件确认，然后用一句话告诉我结果。保持简短，不要做别的。' });
  const deadline = Date.now() + LIMIT_MS;
  let events = [];
  for (;;) {
    await later(3000);
    const data = await api(`sessions/${session.id}/events?after=0`); events = data.events ?? data;
    const s = (await api('state')).sessions.find(x => x.id === session.id);
    if (s.status !== '运行中' && events.some(e => e.type === 'settled')) break;
    if (Date.now() > deadline) { report.timedOut = true; break; }
  }
  const check = spawnSync(process.execPath, ['--input-type=module', '-e', "import {add} from './src/calc.mjs'; if (add(2,3)!==5) process.exit(1);"], { cwd: workspace, env: scrubbedEnv(), windowsHide: true });
  report.fixed = check.status === 0;
  report.tools = Object.fromEntries(['闪电', '小千'].map(name => [name, [...new Set(events.filter(e => e.type === 'tool-call' && e.member === name).map(e => e.tool))]]));
  report.turns = events.filter(e => e.type === 'turn-end').map(e => `${e.member}:${e.status}:${JSON.stringify(e.usage ?? {})}`);
  report.lastUsage = Object.fromEntries(['闪电', '小千'].map(name => [name, events.filter(e => e.type === 'usage' && e.member === name).at(-1)?.used ?? null]));
  report.board = events.filter(e => e.type === 'board' || e.type === 'dm').map(e => `${e.author}: ${String(e.text).replace(/\s+/g, ' ').slice(0, 170)}`);
  report.toUser = events.filter(e => e.type === 'to-user').map(e => String(e.text).slice(0, 240));
  report.problems = events.filter(e => ['member-failed', 'spin-warning', 'session-error', 'protocol-warning', 'guard'].includes(e.type)).map(e => `${e.type}: ${String(e.error ?? e.text ?? e.command ?? '').slice(0, 300)}`);
  const members = join(home, 'sessions', session.id, 'members');
  // Only whether the routes appear in each member's own files, not what those files say.
  const search = (dir, word, found = []) => { if (!existsSync(dir)) return found; for (const e of readdirSync(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) search(p, word, found); else if (statSync(p).size < 5e6 && /\.(jsonl?|ya?ml|log)$/.test(e.name) && readFileSync(p, 'utf8').includes(word)) found.push(p.slice(members.length + 1)); } return found; };
  report.routeEvidence = { flashFiles: search(join(members, '闪电'), 'deepseek-flash').length, qwenFilesMentioningFlash: search(join(members, '小千'), 'deepseek-flash').length, qwenFilesMentioningLocal: search(join(members, '小千'), 'iq3_s').length };
  report.pass = !report.timedOut && !report.sessionError && report.fixed && !report.problems.length && report.toUser.length > 0 && report.tools['闪电'].length > 0 && report.tools['小千'].length > 0;
} catch (error) { report.error = String(error?.stack ?? error).slice(0, 1200); }
try {
  const r = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers });
  const end = Date.now() + 15000, alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  while (alive() && Date.now() < end) await later(200);
  report.shutdown = { status: r.status, exited: !alive() };
  if (alive()) process.kill(pid);
} catch (error) { report.shutdown = { error: String(error) }; }
console.log(JSON.stringify(report, null, 1));
process.exit(report.pass ? 0 : 1);
