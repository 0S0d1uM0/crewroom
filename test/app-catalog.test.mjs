import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp } from '../dist/app/server.js';
import { scanCatalog, loadCatalog, saveCatalog } from '../dist/app/model-catalog.js';
import { builtinCatalog, allowedEfforts } from '../dist/app/models.js';
import { initRepository } from '../dist/platform/storage.js';
import { expectedModelName } from '../dist/platform/adapters/claude.js';
import { findModel, effortsFor, effortChoices, modelSelection, scanStatus } from '../ui/state.js';
import { parseConfig } from '../dist/platform/config.js';
import { DshAdapter, useDirectCloud, restoreWebServices } from '../dist/platform/adapters/dsh.js';

const temp = t => { const root = mkdtempSync(join(tmpdir(), 'agents-catalog-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
const entry = (id, efforts = ['low'], extra = {}) => ({ id, label: id, efforts, available: true, ...extra });
const scanners = over => ({ claude: async () => [entry('opus', ['low', 'max'])], codex: async () => [entry('gpt-x', ['low', 'ultra']), entry('gpt-y', ['low'])], dsh: async () => [entry('local', [])], ...over });
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
async function service(t, options = {}) {
  const root = temp(t), project = join(root, '项目'); mkdirSync(project);
  const app = await startApp({ home: join(root, 'home'), factory: () => ({ onMessage() {}, onEvent() {}, async start() {}, async prompt() { return { status: 'completed' }; }, async steer() { return 'idle'; }, async interrupt() {}, async stop() {} }), scanners: scanners(), ...options });
  t.after(() => app.close());
  const call = async (path, body, headers = { Origin: app.origin }) => { const r = await fetch(app.origin + '/api/' + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + app.token, 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
  return { app, call, project, root };
}

test('scan replaces each list, and a failing harness keeps its old list and says why', async () => {
  const next = await scanCatalog(builtinCatalog(), scanners({ dsh: async () => { throw new Error('DSH 未安装'); }, codex: async () => [] }));
  assert.deepEqual(next.claude.models.map(m => m.id), ['opus']); assert.ok(next.claude.scannedAt);
  assert.deepEqual(next.dsh.models.map(m => m.id), ['local']); assert.match(next.dsh.error, /DSH 未安装/);
  assert.ok(next.codex.models.length > 1, 'an empty answer does not wipe the list'); assert.match(next.codex.error, /没有返回/);
});
test('a saved scan survives a restart, and a damaged one falls back to the built-in list', t => {
  const home = temp(t), catalog = builtinCatalog(); catalog.claude = { models: [entry('sonnet')], scannedAt: 'x' };
  saveCatalog(home, catalog);
  assert.deepEqual(loadCatalog(home).claude.models.map(m => m.id), ['sonnet']);
  writeFileSync(join(home, 'model-catalog.json'), '{ damaged');
  assert.ok(loadCatalog(home).claude.models.length >= 4);
});
test('efforts follow the model, and a hand-typed model may use any known level', () => {
  const catalog = builtinCatalog();
  assert.ok(allowedEfforts(catalog, 'codex', 'gpt-6.1-terra').includes('ultra'));
  assert.ok(!allowedEfforts(catalog, 'codex', 'gpt-6-luna').includes('ultra'));
  assert.ok(allowedEfforts(catalog, 'codex', 'gpt-custom').includes('ultra'));
});
test('the API scans, serves the result, and validates efforts against it', async t => {
  const { call, project } = await service(t);
  assert.equal((await call('models/scan', {}, { Origin: 'https://example.com' })).status, 403);
  const scan = await call('models/scan', {}); assert.equal(scan.status, 200);
  assert.deepEqual((await call('state')).body.models.codex.models.map(m => m.id), ['gpt-x', 'gpt-y']);
  const p = (await call('projects', { path: project })).body;
  const team = (model, effort) => ({ projectId: p.id, members: [{ name: 'lead', harness: 'codex', model, effort, role: 'lead' }] });
  const bad = await call('sessions', team('gpt-y', 'ultra'));
  assert.equal(bad.status, 400); assert.match(bad.body.error, /gpt-y 不支持推理强度 ultra/);
  assert.ok((await call('sessions', team('gpt-x', 'ultra'))).status < 300);
});
test('concurrent scans share one run', async t => {
  let runs = 0;
  const { call } = await service(t, { scanners: scanners({ claude: async () => { runs++; await new Promise(r => setTimeout(r, 30)); return [entry('opus')]; } }) });
  await Promise.all([call('models/scan', {}), call('models/scan', {})]);
  assert.equal(runs, 1);
});
test('form choices: what is available, full IDs from earlier teams, and typed IDs', () => {
  const list = [{ id: 'opus', label: 'Opus 5.5', efforts: ['low', 'max'], available: true }, { id: 'haiku', label: 'Haiku 5.5', efforts: ['low'], available: true }, { id: 'cloud', label: 'DeepSeek', efforts: [], available: false, note: '尚未接入' }];
  assert.deepEqual(modelSelection(list, 'haiku'), { selected: 'haiku', custom: '' });
  assert.deepEqual(modelSelection(list, 'claude-haiku-5-5'), { selected: 'haiku', custom: '' }, 'a saved full ID finds its entry');
  assert.deepEqual(modelSelection(list, 'my-model'), { selected: '', custom: 'my-model' });
  assert.deepEqual(modelSelection(list, undefined), { selected: 'opus', custom: '' });
  assert.deepEqual(modelSelection(list, 'cloud'), { selected: 'opus', custom: '' }, 'a model that cannot run is never preselected');
  assert.deepEqual(effortsFor(list, 'opus'), ['low', 'max']); assert.deepEqual(effortsFor(list, 'my-model'), ['low', 'max']);
  assert.equal(findModel(list, 'claude-sonnet-5-5'), undefined);
  assert.equal(expectedModelName('claude-haiku-5-5'), 'haiku 5.5');
});
test('scan status reports the newest scan and any failures', () => {
  assert.deepEqual(scanStatus({ a: { scannedAt: '2026-01-01' }, b: { scannedAt: '2026-01-02' }, c: { error: '坏了' } }), { scanned: '2026-01-02', errors: ['c：坏了'] });
  assert.equal(scanStatus({ a: {} }).scanned, null);
});
test('initializing Git commits current files byte-for-byte and excludes secrets', async t => {
  const folder = join(temp(t), '项目'); mkdirSync(join(folder, '子目录'), { recursive: true });
  writeFileSync(join(folder, '说明.md'), '内容\r\n'); writeFileSync(join(folder, '子目录', '.env'), 'SECRET=1');
  const before = [statSync(join(folder, '说明.md')).mtimeMs, readFileSync(join(folder, '说明.md'))];
  const result = await initRepository(folder);
  assert.ok(result.branch); assert.ok(result.commit);
  assert.equal(statSync(join(folder, '说明.md')).mtimeMs, before[0]); assert.deepEqual(readFileSync(join(folder, '说明.md')), before[1]);
  assert.match(git(folder, '-c', 'core.quotepath=false', 'ls-tree', '-r', 'HEAD'), /说明.md/);
  assert.equal(git(folder, 'status', '--short'), '');
  assert.ok(result.excluded.some(p=>p.includes('.env')));
  assert.equal(existsSync(join(folder, '.gitignore')), false, 'no file is added');
});
test('initializing Git refuses a repository, a folder inside one, and a damaged .git', async t => {
  const root = temp(t), repo = join(root, 'repo'), inside = join(repo, 'inside'), broken = join(root, 'broken');
  mkdirSync(inside, { recursive: true }); mkdirSync(join(broken, '.git'), { recursive: true });
  await initRepository(repo);
  const head = git(repo, 'rev-parse', 'HEAD');
  await assert.rejects(() => initRepository(repo), /已经在 Git 仓库里/); await assert.rejects(() => initRepository(inside), /已经在 Git 仓库里/);
  await assert.rejects(() => initRepository(broken), /无法识别/);
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head); assert.equal(existsSync(join(inside, '.git')), false);
});
test('initializing Git works with no Git identity configured', async t => {
  const folder = join(temp(t), 'p'); mkdirSync(folder);
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };
  process.env.GIT_CONFIG_GLOBAL = join(folder, '..', 'no-such-config'); process.env.GIT_CONFIG_NOSYSTEM = '1';
  try { assert.ok((await initRepository(folder)).commit); assert.equal(git(folder, 'log', '-1', '--format=%an'), 'Crewroom'); }
  finally { for (const [key, value] of [['GIT_CONFIG_GLOBAL', saved.global], ['GIT_CONFIG_NOSYSTEM', saved.nosystem]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});
test('the API initializes Git only for a listed project and a trusted page', async t => {
  const { call, project } = await service(t);
  writeFileSync(join(project, 'keep.txt'), 'x');
  const p = (await call('projects', { path: project })).body;
  assert.equal((await call('state')).body.projects[0].git, false);
  assert.equal((await call(`projects/${p.id}/git-init`, {}, { Origin: 'https://example.com' })).status, 403);
  assert.equal(existsSync(join(project, '.git')), false);
  assert.equal((await call('projects/unknown/git-init', {})).status, 404);
  assert.equal((await call(`projects/${p.id}/git-init`, {})).status, 200);
  assert.equal((await call('state')).body.projects[0].git, true);
  assert.equal((await call(`projects/${p.id}/git-init`, {})).status, 400);
  assert.equal(readFileSync(join(project, 'keep.txt'), 'utf8'), 'x');
});

test('DSH: a team may mix local Qwen with DeepSeek, but not two local members or a route it does not know', () => {
  const route = '["deepseek-official","deepseek-flash"]', team = models => ({ workspace: '.', members: models.map((model, i) => ({ harness: 'dsh', model, role: i ? 'worker' : 'lead' })) });
  assert.equal(parseConfig(team(['local', route, '["deepseek-account","deepseek-v4-pro"]'])).members.length, 3);
  assert.throws(() => parseConfig(team(['local', 'local'])), /At most one/);
  for (const bad of ['deepseek', '["other","x"]', '["deepseek-official"]', '["deepseek-official","a b"]', '["deepseek-official","x"];rm']) assert.throws(() => parseConfig(team([bad])), /model list/, bad);
});
test('DSH: only a cloud member loses the closed port, and nothing else in the launch changes', () => {
  const patch = '- id: credentials\n  config:\n    path: "x"\n- id: llm-deepseek\n  config:\n    baseURL: "http://127.0.0.1:9/anthropic"\n- id: web-search-deepseek\n  config:\n    baseURL: "http://127.0.0.1:9/anthropic/v1"\n';
  const cloud = useDirectCloud(patch);
  assert.doesNotMatch(cloud, /llm-deepseek/); assert.match(cloud, /id: credentials/); assert.match(cloud, /web-search-deepseek/);
  assert.throws(() => useDirectCloud('- id: credentials\n'), /no DeepSeek route/);
});
test('DSH: the scan lists every route, with the local one under its short name', async () => {
  const selection = '["strata","iq3_s"]';
  const a = new DshAdapter({ name: 'x', harness: 'dsh', model: 'local', role: 'worker' }, '.', '.', { launch: {}, model: { selection } });
  a.sessionId = 's';
  a.worker = { bounded: p => p, connection: { agent: { request: async () => ({ configOptions: [{ id: 'model', options: [{ value: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V4.1-Flash' }, { value: selection, name: 'Qwen 3.8 Flash Next' }] }] }) } } };
  const list = await a.modelCatalog();
  assert.deepEqual(list.map(m => [m.id, m.label, m.available]), [['local', 'Qwen 3.8 Flash Next（本地，免费）', true], ['["deepseek-official","deepseek-flash"]', 'DeepSeek-V4.1-Flash（deepseek-official，按量计费）', true]]);
  assert.equal(modelSelection(list, undefined).selected, 'local', 'the form must never preselect a paid route');
});

test('DSH: the scan reads each route\'s own reasoning levels', async () => {
  const local = '["strata","iq3_s"]', flash = '["deepseek-official","deepseek-flash"]'; let current = local;
  const options = () => ({ configOptions: [{ id: 'model', options: [{ value: flash, name: 'Flash' }, { value: local, name: 'Qwen' }] }, current === local ? { id: 'reasoning_effort', currentValue: '', options: [{ value: '' }, { value: 'off' }, { value: 'low' }, { value: 'medium' }] } : { id: 'reasoning_effort', currentValue: 'high', options: [{ value: 'off' }, { value: 'low' }, { value: 'high' }, { value: 'max' }] }] });
  const a = new DshAdapter({ name: 'x', harness: 'dsh', model: 'local', role: 'worker' }, '.', '.', { launch: {}, model: { selection: local } });
  a.sessionId = 's'; a.worker = { bounded: p => p, connection: { agent: { request: async (_, p) => { current = p.value; return options(); } } } };
  const [qwen, deepseek] = await a.modelCatalog();
  assert.deepEqual([qwen.id, qwen.efforts, qwen.defaultEffort], ['local', ['off', 'low', 'medium'], undefined]);
  assert.deepEqual([deepseek.id, deepseek.efforts, deepseek.defaultEffort], [flash, ['off', 'low', 'high', 'max'], 'high']);
});
test('DSH: a reasoning level that does not take stops before any inference', async () => {
  const local = '["strata","iq3_s"]', calls = [];
  const a = new DshAdapter({ name: 'x', harness: 'dsh', model: '["deepseek-official","deepseek-flash"]', effort: 'off', role: 'worker' }, process.cwd(), process.cwd(), { launch: {}, model: { selection: local } });
  a.connect = async () => {};
  const worker = (current) => ({ session: async () => 's', selectModel: async (_, value) => calls.push(value), bounded: p => p, connection: { agent: { request: async (_, p) => { calls.push(p.configId + '=' + p.value); return { configOptions: [{ id: 'reasoning_effort', currentValue: current }] }; } } } });
  a.worker = worker('high');
  await assert.rejects(a.start('x'), /EFFORT_NOT_APPLIED/);
  assert.deepEqual(calls, ['["deepseek-official","deepseek-flash"]', 'reasoning_effort=off']);
  a.worker = worker('off'); await a.start('x');
  await a.worker.session; assert.equal(a.ready, true);
});
test('the form starts on a model\'s default effort, and a route without one on the provider default', () => {
  const list = [{ id: 'local', label: 'Qwen', efforts: ['off', 'low'], available: true }, { id: 'flash', label: 'Flash', efforts: ['off', 'low', 'high'], defaultEffort: 'high', available: true }];
  assert.deepEqual(effortChoices(list, 'local', 'dsh'), { levels: ['', 'off', 'low'], initial: '' });
  assert.deepEqual(effortChoices(list, 'flash', 'dsh'), { levels: ['off', 'low', 'high'], initial: 'high' });
  assert.deepEqual(effortChoices([{ id: 'opus', label: 'Opus', efforts: ['low', 'max'], available: true }], 'opus', 'claude'), { levels: ['low', 'max'], initial: 'low' });
  assert.deepEqual(effortChoices([{ id: 'none', label: 'None', efforts: [], available: true }], 'none', 'claude'), { levels: [], initial: '' });
});

test('DSH: search and fetch are restored while a local member keeps the model route closed', () => {
  const patch = '- id: llm-deepseek\n  config:\n    baseURL: "http://127.0.0.1:9/anthropic"\n- id: web-search-deepseek\n  config:\n    baseURL: "http://127.0.0.1:9/anthropic/v1"\n- id: web-deepseek-api\n  disabled: false\n  config:\n    baseURL: "http://127.0.0.1:9/v1/tools"\n    count: 5\n';
  const out = restoreWebServices(patch);
  assert.match(out, /llm-deepseek[\s\S]*127\.0\.0\.1:9\/anthropic"/, 'the model route stays closed');
  assert.doesNotMatch(out, /v1\/tools|anthropic\/v1/);
  assert.match(out, /web-deepseek-api\n  disabled: false\n  config:\n    count: 5/);
  assert.throws(() => restoreWebServices('- id: other\n'), /unexpected web configuration/);
});
