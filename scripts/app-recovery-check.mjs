// The path a user comes back on, with real models through the packaged app: work with web tools, a
// member fails, pause, exit, reopen, continue, the failed member retries, and memory survives. Uses
// cheap models but real ones, so it needs --authorized-this-run. Never part of npm test.
// Usage: node scripts/app-recovery-check.mjs --authorized-this-run
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { scrubbedEnv } from '../dist/platform/env.js';

if (!process.argv.includes('--authorized-this-run')) throw new Error('--authorized-this-run is required; this script makes real model calls');
const repo = new URL('../', import.meta.url).pathname.replace(/^\//, '');
const root = mkdtempSync(join(tmpdir(), 'agents-recovery-')), home = join(root, 'home'), work = join(root, '项目');
mkdirSync(home); mkdirSync(work); writeFileSync(join(work, 'README.md'), '# 测试项目\n');
spawnSync('git', ['init', '-q'], { cwd: work }); spawnSync('git', ['add', '.'], { cwd: work }); spawnSync('git', ['-c', 'user.name=F', '-c', 'user.email=f@localhost', 'commit', '-qm', '初始'], { cwd: work });
const later = ms => new Promise(r => setTimeout(r, ms));
let info;
const FIRST = '简短验收，全程用中文，请记住暗号：青松七号。分三步：1) 组长先写一句开场白，然后自己调用一次 WebSearch 搜 "Agent Client Protocol"，再接着写一句结论；2) 请 小千 用 web_search 搜同样的内容，把第一个结果的标题发到白板并 notify 组长；3) 请 小露 用 shell 运行 node -v，把结果发到白板并 notify 组长。等他们都回复后告诉我结果。';
async function launch() {
  const lock = join(home, 'service.lock', 'info.json');
  const child = spawn(join(repo, 'release/Crewroom/Crewroom.exe'), [join(repo, 'release/Crewroom/resources/app/dist/app/server.js')], { env: { ...scrubbedEnv(), CREWROOM_HOME: home, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true, detached: true });
  child.unref();
  for (let i = 0; i < 150; i++) { await later(100); if (existsSync(lock)) { const next = JSON.parse(readFileSync(lock, 'utf8')); if (next.pid === child.pid) { info = next; break; } } }
  if (info?.pid !== child.pid) throw new Error('service did not start');
}
const api = async (path, body) => {
  const r = await fetch(`http://127.0.0.1:${info.port}/api/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${info.token}`, 'content-type': 'application/json', Origin: `http://127.0.0.1:${info.port}`, Connection: 'close' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${path}: ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
  return data;
};
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function exitService() { await api('shutdown', {}); for (let i = 0; i < 150 && alive(info.pid); i++) await later(100); return !alive(info.pid); }
const report = { root, steps: {} }; let id;
const log = () => readFileSync(join(home, 'sessions', id, 'events.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
// Takes the log length from before the message, so a team that finishes quickly is not missed.
async function settle(start, limit = 240000) {
  const end = Date.now() + limit;
  while (Date.now() < end) { await later(2000); if (settled(start)) { await later(3000); if (settled(start)) return true; } }
  return false;
}
// Bookkeeping such as a snapshot can follow 'settled', so it need not be the very last event.
const NOISE = new Set(['snapshot', 'usage', 'rate-limits', 'quota-notice', 'quota-rearmed', 'protocol-warning']);
function settled(start) { const list = log().slice(start).filter(e => !NOISE.has(e.type)); return list.at(-1)?.type === 'settled'; }
const status = async () => (await api('state')).sessions.find(s => s.id === id)?.status;
try {
  await launch();
  await api('models/scan', {});
  const project = await api('projects', { path: work });
  id = (await api('sessions', { projectId: project.id, mode: 'shared', members: [
    { name: '组长', harness: 'claude', model: 'haiku', effort: 'low', role: 'lead' },
    { name: '小千', harness: 'dsh', model: 'local', effort: 'low', role: 'worker' },
    { name: '小露', harness: 'codex', model: 'gpt-6-luna', effort: 'low', role: 'worker' },
  ] })).id;
  const sent = log().length;
  await api(`sessions/${id}/messages`, { text: FIRST });
    report.steps.work = await settle(sent);
  let list = log();
  const toolDone = (member, re) => list.some(e => e.type === 'tool' && e.member === member && re.test(String(e.title)) && e.status === 'completed');
  // Claude retitles a finished search to 'Search "..."'.
  report.web = { claudeWebSearch: toolDone('组长', /web ?search|^search /i), qwenWebSearch: toolDone('小千', /web_search/) };
  const titled = (await api('state')).sessions.find(s => s.id === id);
  report.title = { title: titled?.title, generated: Boolean(titled?.title) && !FIRST.startsWith(titled.title.replace(/…$/, '')) };
  report.claudeTools = [...new Set(list.filter(e => e.type === 'tool' && e.member === '组长').map(e => `${String(e.title).slice(0, 30)}:${e.status}`))].slice(0, 12);
  report.leadMessages = list.filter(e => e.type === 'to-user').map(e => String(e.text).slice(0, 90));
  report.updates = list.filter(e => e.type === 'message-update').length;
  report.board = list.filter(e => e.type === 'board').map(e => `${e.author}: ${String(e.text).replace(/\s+/g, ' ').slice(0, 90)}`);
  // A member fails: its harness dies between turns, and the next message to it cannot run.
  const tree = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='codex.exe' AND ParentProcessId=${info.pid}" | ForEach-Object ProcessId`], { encoding: 'utf8', windowsHide: true }).stdout.trim().split(/\s+/).filter(Boolean);
  report.codexChildren = tree.length;
  for (const pid of tree) process.kill(Number(pid));
  await later(1000);
  const sentFailure = log().length;
  await api(`sessions/${id}/messages`, { text: '请 小露 再运行一次 node -v 并把结果 notify 给组长。如果她失败了，告诉我失败了，不要自己替她做，然后结束回复。' });
  report.steps.failure = await settle(sentFailure);
  list = log();
  report.failure = { failed: list.some(e => e.type === 'member-failed' && e.member === '小露'), errors: list.filter(e => e.type === 'member-failed').map(e => String(e.error).slice(0, 120)) };
  // The user's path back: pause, exit, open the new version, continue.
  await api(`sessions/${id}/pause`, {});
  report.pausedBefore = await status();
  report.exitedCleanly = await exitService();
  await launch();
  report.pausedAfterRestart = await status();
  await api(`sessions/${id}/resume`, {});
  report.afterResume = await status();
  const mark = log().length, sentRetry = mark;
  await api(`sessions/${id}/messages`, { text: '继续。请 小露 再试一次 node -v，把结果和我一开始说的暗号一起 notify 给组长；小千 也把暗号 notify 给组长。然后组长告诉我三个人说的暗号。' });
  report.steps.retry = await settle(sentRetry);
  const after = log().slice(mark);
  report.retry = { lunaRan: after.some(e => e.type === 'turn-end' && e.member === '小露' && e.status === 'completed'), failedAgain: after.some(e => e.type === 'member-failed') };
  const said = name => after.filter(e => (e.type === 'board' || e.type === 'dm') && e.author === name).map(e => String(e.text)).join(' ');
  report.memory = { 小露: said('小露').includes('青松七号'), 小千: said('小千').includes('青松七号'), 组长: after.filter(e => e.type === 'to-user' || e.type === 'message-update').map(e => String(e.text)).join(' ').includes('青松七号') };
  report.lastToUser = after.filter(e => e.type === 'to-user').map(e => String(e.text).slice(0, 200)).at(-1);
  report.problems = log().filter(e => ['spin-warning', 'session-error', 'guard'].includes(e.type)).map(e => e.type);
  report.pass = report.title.generated && report.web.claudeWebSearch &&report.web.qwenWebSearch && report.failure.failed && report.pausedAfterRestart === '已暂停' && report.afterResume !== '已暂停' && report.retry.lunaRan && !report.retry.failedAgain && report.memory.小露 && report.memory.小千 && report.memory.组长 && !report.problems.length;
} catch (error) { report.error = String(error?.stack ?? error).slice(0, 1200); }
try { await exitService(); report.finalExit = !alive(info.pid); } catch (error) { report.finalExit = String(error); }
console.log(JSON.stringify(report, null, 1));
process.exit(report.pass ? 0 : 1);
