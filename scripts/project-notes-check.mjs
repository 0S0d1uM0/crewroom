// Do project rules and notes really reach every harness, and does what one round writes reach the next?
// Each harness gets its own one-member session, told directly, so a lead's incomplete relay cannot
// decide the result. Round two starts fresh: only the files can carry anything over.
// Makes real model calls, so it needs --authorized-this-run. Never part of npm test.
// Usage: node scripts/project-notes-check.mjs --authorized-this-run
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlatformSession } from '../dist/platform/session.js';
import { createAdapter } from '../dist/platform/adapters/index.js';

if (!process.argv.includes('--authorized-this-run')) throw new Error('--authorized-this-run is required; this script makes real model calls');
const root = mkdtempSync(join(tmpdir(), 'agents-notes-')), folder = join(root, '多轮项目');
mkdirSync(folder);
const RULE_A = '规则甲-7316', RULE_C = '规则乙-4829';
writeFileSync(join(folder, 'AGENTS.md'), `# 项目规则\n\n构建前先看标记：${RULE_A}。\n`);
writeFileSync(join(folder, 'CLAUDE.md'), `# 项目规则\n\n提交前先看标记：${RULE_C}。\n`);
const TEAM = {
  claude: { harness: 'claude', model: 'claude-haiku-5-5', effort: 'low', lesson: '经验-claude-5501' },
  dsh: { harness: 'dsh', model: 'local', lesson: '经验-dsh-6602' },
  codex: { harness: 'codex', model: 'gpt-6-luna', effort: 'low', lesson: '经验-codex-7703' },
};
const noteFile = harness => join(folder, '.agent-notes', `${harness}.md`);
async function solo(key, ...messages) {
  const { lesson, ...member } = TEAM[key], events = [];
  const session = new PlatformSession({ workspace: folder, sessionRoot: join(root, 'sessions'), turnTimeoutMs: 300000, members: [{ name: '成员', ...member, role: 'lead' }] }, createAdapter, event => events.push(event));
  try { await session.start(); for (const message of messages) { session.sendUser(message); await session.waitForSettled(); } } finally { await session.stop().catch(() => {}); }
  return { events, said: events.filter(e => e.type === 'to-user').map(e => String(e.text)).join('\n') };
}
// A model can answer carelessly, so for Codex read what it was actually given from its rollout.
function codexGiven(events) {
  const id = events.find(e => e.type === 'member-start')?.harnessId;
  const dir = join(homedir(), '.codex', 'sessions', ...new Date().toISOString().slice(0, 10).split('-'));
  const file = existsSync(dir) && readdirSync(dir).find(name => name.includes(id));
  return file ? readFileSync(join(dir, file), 'utf8') : '';
}
const loaded = events => events.find(e => e.type === 'project-context')?.files.map(f => f.path) ?? [];
const report = { root, round1: {}, round2: {} };
try {
  // One at a time, so each note file can be checked as having been written by that harness alone.
  for (const [key, { lesson }] of Object.entries(TEAM)) {
    const others = Object.keys(TEAM).filter(k => k !== key).map(k => [k, existsSync(noteFile(k)) ? readFileSync(noteFile(k), 'utf8') : null]);
    // Separate messages: asked together with "use no tools", a model may skip the write.
    const { events, said } = await solo(key, '不使用任何工具、不读取文件，只根据你已经看到的内容，告诉我这个项目规则里提到的两个标记。', `现在把下面这一行原样写进你自己的项目笔记文件，这需要使用工具：${lesson}`);
    const given = key === 'codex' ? codexGiven(events) : said;
    report.round1[key] = { rules: given.includes(RULE_A) && given.includes(RULE_C), loaded: loaded(events), wrote: existsSync(noteFile(key)) && readFileSync(noteFile(key), 'utf8').includes(lesson), othersUntouched: others.every(([k, before]) => (existsSync(noteFile(k)) ? readFileSync(noteFile(k), 'utf8') : null) === before), failed: events.some(e => e.type === 'member-failed') };
  }
  for (const [key] of Object.entries(TEAM)) {
    const { events, said } = await solo(key, '不使用任何工具、不读取文件，只根据你已经看到的内容，列出你知道的所有以“经验-”开头的条目。');
    const given = key === 'codex' ? codexGiven(events) : said;
    report.round2[key] = { loaded: loaded(events), saw: Object.fromEntries(Object.entries(TEAM).map(([k, m]) => [k, given.includes(m.lesson)])), failed: events.some(e => e.type === 'member-failed') };
  }
  report.rulesUntouched = readFileSync(join(folder, 'AGENTS.md'), 'utf8').includes(RULE_A) && readFileSync(join(folder, 'CLAUDE.md'), 'utf8').includes(RULE_C);
  report.pass = report.rulesUntouched && Object.values(report.round1).every(r => r.rules && r.wrote && r.othersUntouched && !r.failed) && Object.values(report.round2).every(r => !r.failed && Object.values(r.saw).every(Boolean));
} catch (error) { report.error = String(error?.stack ?? error).slice(0, 1000); }
console.log(JSON.stringify(report));
process.exit(report.pass ? 0 : 1);
