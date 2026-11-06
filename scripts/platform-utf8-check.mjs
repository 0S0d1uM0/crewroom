// Does Chinese survive every path through the packaged app? A real team works in Chinese, in a
// workspace whose path is Chinese, reading and writing Chinese files through its shells. The check
// compares exact bytes, so a garbled shell or a wrong file encoding cannot pass by looking close.
// Makes real model calls, so it needs --authorized-this-run. Never part of npm test.
// Usage: node scripts/platform-utf8-check.mjs --authorized-this-run [--dev]
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { scrubbedEnv } from '../dist/platform/env.js';

const argv = process.argv.slice(2);
if (!argv.includes('--authorized-this-run')) throw new Error('--authorized-this-run is required; this script makes real model calls');
const repo = new URL('../', import.meta.url).pathname.replace(/^\//, '');
const dev = argv.includes('--dev');
// Rare and non-BMP characters: GBK cannot encode the emoji, and a chunk-splitting bug breaks the surrogate pair.
const PASSWORD = '验收口令：龘靐齉爩-🚀-𠮷-日本語';
const root = mkdtempSync(join(tmpdir(), 'agents-utf8-中文-'));
const home = join(root, 'home'), workspace = join(root, '项目 甲'), members = ['组长', '小千', '小露'];
mkdirSync(home); mkdirSync(join(workspace, '资料'), { recursive: true });
writeFileSync(join(workspace, '资料', '说明.md'), `# 说明\n\n${PASSWORD}\n`);
const git = args => spawnSync('git', args, { cwd: workspace, env: scrubbedEnv(), windowsHide: true });
git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-qm', '初始']);

const server = dev ? [process.execPath, [join(repo, 'dist/app/server.js')]] : [join(repo, 'release/Crewroom/Crewroom.exe'), [join(repo, 'release/Crewroom/resources/app/dist/app/server.js')]];
const service = spawn(server[0], server[1], { env: { ...scrubbedEnv(), CREWROOM_HOME: home, ...(dev ? {} : { ELECTRON_RUN_AS_NODE: '1' }) }, stdio: 'ignore', windowsHide: true, detached: true });
service.unref();
const lock = join(home, 'service.lock', 'info.json');
const later = ms => new Promise(resolve => setTimeout(resolve, ms));
for (let i = 0; i < 100 && !existsSync(lock); i++) await later(100);
const { pid, port, token } = JSON.parse(readFileSync(lock, 'utf8'));
const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json', Origin: `http://127.0.0.1:${port}` };
const api = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
};
const report = { root, packaged: !dev, password: PASSWORD };
try {
  const project = await api('projects', { path: workspace });
  const session = await api('sessions', { projectId: project.id ?? project.project?.id, title: '中文验收', mode: 'shared', members: [
    { name: '组长', harness: 'claude', model: 'claude-haiku-5-5', effort: 'low', role: 'lead' },
    { name: '小千', harness: 'dsh', model: 'local', role: 'worker' },
    { name: '小露', harness: 'codex', model: 'gpt-6-luna', effort: 'low', role: 'worker' },
  ] });
  await api(`sessions/${session.id}/messages`, { text: `这是一次中文编码验收，请全程用中文交流。工作目录里有 资料/说明.md，其中有一行验收口令。
组长请把下面的任务交给 小千 和 小露，并等两人都回复：
1. 用 shell 命令（不是文件读取工具）读取 资料/说明.md，把口令那一行原样用 post_board 发出来，并在 notify 里写上 组长。shell 显示成什么就发什么，不要自行修正。
2. 新建文件 产出/<自己的名字>.md，内容只有那一行口令。
组长自己也用 shell 读一次，新建 产出/组长.md。全部完成后，把三个人读到的口令原样告诉我。` });
  const deadline = Date.now() + 8 * 60 * 1000;
  let events = [];
  for (;;) {
    await later(3000);
    const data = await api(`sessions/${session.id}/events?after=0`); events = data.events ?? data;
    const s = (await api('state')).sessions.find(x => x.id === session.id);
    if (s.status !== '运行中' && events.some(e => e.type === 'settled')) break;
    if (Date.now() > deadline) { report.timedOut = true; break; }
  }
  // Exact bytes on disk: a tool that wrote GBK, or a BOM, shows up here.
  const expected = Buffer.from(PASSWORD, 'utf8');
  report.files = Object.fromEntries(members.map(name => {
    const file = join(workspace, '产出', `${name}.md`);
    if (!existsSync(file)) return [name, 'missing'];
    const bytes = readFileSync(file);
    return [name, { exact: bytes.includes(expected), bom: bytes[0] === 0xef && bytes[1] === 0xbb, text: bytes.toString('utf8').slice(0, 80), hex: bytes.includes(expected) ? undefined : bytes.toString('hex').slice(0, 120) }];
  }));
  report.posted = Object.fromEntries(members.slice(1).map(name => {
    const posts = events.filter(e => e.type === 'board' && e.author === name).map(e => String(e.text));
    return [name, { exact: posts.some(t => t.includes(PASSWORD)), sample: posts.at(-1)?.slice(0, 160) }];
  }));
  const told = events.filter(e => e.type === 'to-user').map(e => String(e.text));
  report.toUser = { exact: told.some(t => t.includes(PASSWORD)), text: told.at(-1)?.slice(0, 500) };
  report.boardFile = readFileSync(join(home, 'sessions', session.id, 'board', 'all.md'), 'utf8').includes(PASSWORD);
  report.journal = readFileSync(join(home, 'sessions', session.id, 'events.jsonl'), 'utf8').includes(PASSWORD);
  report.garbled = events.filter(e => /�/.test(JSON.stringify(e.text ?? ''))).map(e => ({ type: e.type, member: e.member ?? e.author }));
  report.shellCommands = events.filter(e => e.type === 'tool' && typeof e.command === 'string').map(e => `${e.member}: ${e.command.replace(/\s+/g, ' ').slice(0, 130)}`).filter((v, i, a) => a.indexOf(v) === i).slice(0, 12);
  report.failed = events.filter(e => e.type === 'member-failed').map(e => ({ member: e.member, error: String(e.error).slice(0, 300) }));
  report.turns = (await api('state')).sessions.find(x => x.id === session.id)?.status;
  report.pass = !report.timedOut && !report.failed.length && !report.garbled.length && report.boardFile && report.journal && report.toUser.exact && members.every(name => report.files[name]?.exact) && members.slice(1).every(name => report.posted[name].exact);
} catch (error) { report.error = String(error?.stack ?? error).slice(0, 1200); }
// Also the real graceful exit, with real harnesses attached.
try {
  const r = await fetch(`http://127.0.0.1:${port}/api/shutdown`, { method: 'POST', headers });
  report.shutdown = { status: r.status };
  const end = Date.now() + 15000;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  while (alive() && Date.now() < end) await later(200);
  report.shutdown.serviceExited = !alive(); report.shutdown.lockReleased = !existsSync(lock);
  if (alive()) process.kill(pid);
} catch (error) { report.shutdown = { error: String(error) }; }
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
