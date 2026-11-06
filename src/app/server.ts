import { PermissionManager } from '../platform/permission-manager.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, appendFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PlatformSession, type AdapterFactory } from '../platform/session.js';
import { createAdapter } from '../platform/adapters/index.js';
import { parseConfig, memberName } from '../platform/config.js';
import { SessionStorage, git, gitAsync, isGit, initRepository, directoryStats } from '../platform/storage.js';
import { atomic, atomicText, readJson, events, prepare } from './persistence.js';
import { acquireLock, publishLock, serviceInfo } from './lock.js';
import { allowedEfforts, type Catalog, type HarnessName } from './models.js';
import { loadCatalog, realScanners, saveCatalog, scanCatalog, type Scanners } from './model-catalog.js';
import { containedFile } from '../platform/permissions.js';
import { normalizeQuota } from './quota.js';
import { QuotaMonitor, QUOTA_POLL_MS, quotaNotices } from './quota-monitor.js';
import { demoFactory } from './demo.js';
import { generateTitle, requestTitle, type TitleRequest } from './title.js';
export function appHome() { return process.env.CREWROOM_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Crewroom'); }
const projectSchema = z.object({ path: z.string().min(1).max(32768) }).strict();
const messageSchema = z.object({ text: z.string().trim().min(1).max(200000) }).strict();
const sessionSchema = z.object({ projectId: z.string(), title: z.string().max(200).optional(), mode: z.enum(['shared', 'worktree']).default('shared'), networkAccess: z.boolean().default(true), members: z.array(z.object({ name: memberName.optional(), harness: z.enum(['claude','codex','dsh']), model: z.string().min(1).max(200), effort: z.string().optional(), permission: z.enum(['read-only','safe-write','full-write']).default('safe-write'), role: z.enum(['lead','worker']) }).strict()).min(1).max(16) }).strict();
export async function startApp(options: { home?: string; factory?: AdapterFactory; lock?: boolean; onShutdown?: () => void; scanners?: Scanners; titleRequest?: TitleRequest; titleTimeoutMs?: number } = {}) {
  const home = resolve(options.home ?? appHome()); prepare(home);
  const release = options.lock === false ? () => {} : acquireLock(home);
  const token = randomBytes(32).toString('hex');
  const factory = options.factory ?? createAdapter;
  // A fake team never implicitly launches real inference (tests and preview included).
  const titleTransports = new Set<Promise<string>>();
  const titleRequest = options.titleRequest ?? (options.factory ? async () => { throw new Error('OFFLINE'); } : ((model, text, signal) => {
    const task = requestTitle(model, text, signal); titleTransports.add(task);
    void task.finally(() => titleTransports.delete(task)).catch(() => {}); return task;
  }) satisfies TitleRequest);
  const titleRequests = new Map<string, AbortController>();
  function cancelTitle(id: string) { titleRequests.get(id)?.abort(); titleRequests.delete(id); }
  function startTitle(id: string, text: string) {
    const controller = new AbortController(); titleRequests.set(id, controller);
    void generateTitle(text, controller.signal, titleRequest, options.titleTimeoutMs).then(title => {
      const meta = records.get(id);
      if (controller.signal.aborted || closed || meta?.titleState !== 'attempted') return;
      if (title) {
        meta.title = title; atomic(join(home, 'sessions', id, 'session.json'), meta);
        broadcast(id, { type: 'session-renamed' });
      } else appendFileSync(join(home, 'title.log'), JSON.stringify({ at: new Date().toISOString(), sessionId: id, reason: 'title-generation-failed' }) + '\n');
    }).catch(() => { /* Persistence failure must not affect member turns or exit. */ }).finally(() => {
      if (titleRequests.get(id) === controller) titleRequests.delete(id);
    });
  }
  let projects: any[] = readJson(join(home, 'projects.json'), []); if (!Array.isArray(projects)) projects = [];
  projects = projects.filter(p => p && typeof p.id === 'string' && typeof p.path === 'string');
  for (const p of projects) p.git = isGit(p.path);
  const records = new Map<string, any>(), live = new Map<string, PlatformSession>(), loading = new Map<string, Promise<PlatformSession>>();
  for (const id of readdirSync(join(home, 'sessions'))) {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) continue;
    const meta = readJson(join(home, 'sessions', id, 'session.json'), undefined);
    if (meta?.id === id) { try { meta.config = parseConfig(meta.config); records.set(id, meta); } catch {} }
  }
  const monitor = new QuotaMonitor();
  function seedQuota(s: PlatformSession) { for(const h of ['codex','claude']) { const q=readJson(join(home,'quota',h+'.json'),undefined); if(q)s.knownQuota.set(h,q); } }
  const quotaTimer=setInterval(()=>{void monitor.poll([...live].filter(([id])=>status(id)!=='已停止').map(([,s])=>s));},QUOTA_POLL_MS);
  quotaTimer.unref();
  const replayLimit = 2048;
  let stream = events(home).filter(e => e.type === 'stream').slice(-replayLimit);
  atomicText(join(home, 'events.jsonl'), stream.map(e => JSON.stringify(e) + '\n').join(''));
  let sequence = stream.reduce((n, e) => Math.max(n, Number(e.seq) || 0), 0);
  const initializing = new Map<string, Promise<Awaited<ReturnType<typeof initRepository>>>>();
  const clients = new Set<ServerResponse>();
  function broadcast(sessionId: string, event: any) {
    const frame = { type: 'stream', at: new Date().toISOString(), seq: ++sequence, sessionId, event };
    appendFileSync(join(home, 'events.jsonl'), JSON.stringify(frame) + '\n'); stream.push(frame);
    if (stream.length > replayLimit) { stream = stream.slice(-replayLimit); if (sequence % 128 === 0) atomicText(join(home, 'events.jsonl'), stream.map(e => JSON.stringify(e) + '\n').join('')); }
    for (const client of clients) client.write(`id: ${frame.seq}\ndata: ${JSON.stringify(frame)}\n\n`);
  }
  function callback(id: string, e: any) {
    const list = histories.get(id) ?? []; histories.set(id, list); list.push({ ...e, sequence: list.length + 1 }); observe(id, e);
    e = list.at(-1);
    const meta = records.get(id);
    if (e.type === 'member-start' && e.harnessId && meta) { meta.harnessIds[e.member] = e.harnessId; atomic(join(home, 'sessions', id, 'session.json'), meta); }
    if (e.type === 'rate-limits' && meta) {
      const harness = meta.config.members.find((m: any) => m.name === e.member)?.harness;
      if (harness && harness !== 'dsh') {
        const q=normalizeQuota(harness,e); atomic(join(home,'quota',harness+'.json'),q);
        for(const [sid,s] of live) {
          s.knownQuota.set(harness,q);
          if(status(sid)==='已停止' || !s.config.members.some(m=>m.harness===harness)) continue;
          const lead=[...s.members.values()].find(m=>m.config.role==='lead')!;
          for(const notice of quotaNotices(harness,e,history(sid)).events) {
            s.storage.event(notice.type,{...notice,user:lead.config.harness===harness});
            if(notice.type==='quota-notice') s.notifyLead(notice.text);
          }
        }
      }
    }
    broadcast(id, e);
  }
  // Parse each journal once; a future byte-offset/LRU cache can bound cold-session history memory.
  const histories = new Map<string, any[]>(), summaries = new Map<string, { lastActivity?: string; paused: boolean; stopped: boolean; busy: Set<string>; leadText: string; messageId?: string; waiting: boolean; pending: Set<string> }>();
  function history(id: string) { return histories.get(id) ?? []; }
  function observe(id: string, e: any) {
    let summary = summaries.get(id);
    if (!summary) { summary = { paused: false, stopped: false, busy: new Set(), leadText: '', waiting: false, pending: new Set() }; summaries.set(id, summary); }
    if (!(e.type === 'tool' && /(?:^|[_.:/])wait_for_messages$/.test(String(e.title ?? '')))) summary.lastActivity = e.at;
    const lead = records.get(id)?.config.members.find((m: any) => m.role === 'lead')?.name;
    if(e.type === 'from-user') { summary.leadText = ''; summary.waiting = false; }
    if(e.member === lead && ['turn-start','wait-resume'].includes(e.type)) { summary.leadText = ''; summary.messageId = undefined; }
    if(e.type === 'to-user') { summary.leadText = !e.messageId && !summary.messageId && summary.leadText ? summary.leadText + '\n\n' + e.text : e.text; summary.messageId = e.messageId; }
    if(e.type === 'message-update' && e.member === lead && e.messageId === summary.messageId) summary.leadText = e.append ? summary.leadText + e.text : e.text;
    if(e.type === 'reply-pending') summary.pending.add(e.id + ':' + e.recipient);
    if(['reply-cleared','reply-forwarded'].includes(e.type)) summary.pending.delete(e.id + ':' + e.recipient);
    if(e.member === lead && ['turn-start','wait-resume','member-failed'].includes(e.type)) summary.waiting = false;
    if(e.member === lead && (e.type === 'wait-start' || (e.type === 'turn-end' && e.status === 'completed'))) summary.waiting = true;
    if (e.type === 'paused' || e.type === 'lead-paused') summary.paused = true;
    if (e.type === 'resumed') summary.paused = false;
    if (e.type === 'stopped') summary.stopped = true;
    if (['turn-start', 'wait-resume'].includes(e.type)) summary.busy.add(e.member);
    if (['turn-end', 'member-interrupted', 'wait-start'].includes(e.type)) summary.busy.delete(e.member);
  }
  for (const id of records.keys()) { const list = events(join(home, 'sessions', id)).map((e, i) => ({ ...e, sequence: i + 1 })); histories.set(id, list); for (const e of list) observe(id, e);
    const dangling = new Map<string, any>();
    for (const e of list) { if(e.type==='permission-request')dangling.set(String(e.id),e); if(e.type==='permission-result')dangling.delete(String(e.id)); }
    const storage = new SessionStorage(join(home,'sessions',id), e => callback(id,e));
    for(const e of dangling.values()) storage.event('permission-result',{id:e.id,member:e.member,decision:'cancel',allowed:false,reason:'服务已重启，旧申请取消，请重新发起'});
  }
  function status(id: string) {
    const summary = summaries.get(id);
    if (summary?.stopped) return '已停止';
    if (records.get(id).error) return '错误';
    if (summary?.paused || live.get(id)?.paused) return '已暂停';
    if (!live.has(id)) return '未加载';
    return summary?.busy.size ? '运行中' : '空闲';
  }
  function sessionAttention(id: string) {
    const requests = live.get(id)?.permissions.pending;
    if (requests?.size) return { waiting: true, kind: 'permission', text: `${requests.size} 个权限申请等你批准` };
    const s = summaries.get(id);
    const prose=String(s?.leadText ?? '').replace(/```[\s\S]*?(?:```|$)/g,'').replace(/`[^`]*`/g,'').split('\n').filter(line=>!/^\s*>|^ {4}/.test(line)).join('\n');
    const question = /[?？]\s*$|请(?:你|您)?(?:确认|选择|回复)|需要(?:你|您)(?:确认|选择|回复)/m.test(prose);
    const waiting = !!s?.waiting && !!s.leadText && !s.stopped && (question || (!s.busy.size && !s.pending.size));
    return { waiting, text: waiting ? s!.leadText.slice(0,300) : '' };
  }
  async function load(id: string) {
    if (loading.has(id)) return loading.get(id)!;
    if (live.has(id)) return live.get(id)!;
    if (status(id) === '已停止') throw new Error('会话已停止');
    const meta = records.get(id);
    const task = (async () => {
      const session = new PlatformSession({ ...meta.config, sessionRoot: join(home, 'sessions') }, factory, e => callback(id, e), { id, events: history(id), harnessIds: meta.harnessIds });
      seedQuota(session);
      try { await session.start(); live.set(id, session); seedQuota(session); delete meta.error; atomic(join(home, 'sessions', id, 'session.json'), meta); return session; }
      catch (error) { meta.error = `恢复失败：${String(error)}`; atomic(join(home, 'sessions', id, 'session.json'), meta); session.storage.event('session-error', { text: meta.error }); throw new Error(meta.error); }
      finally { loading.delete(id); }
    })(); loading.set(id, task); return task;
  }
  async function body(req: IncomingMessage) { let size = 0; const chunks: Buffer[] = []; for await (const chunk of req) { size += chunk.length; if (size > 262144) throw new Error('请求体过大'); chunks.push(chunk); } try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('请求必须为 JSON'); } }
  function json(res: ServerResponse, value: unknown, code = 200) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
  let origin = '';
  const pending = new Set<Promise<void>>();
  let catalog: Catalog = loadCatalog(home), scanning: Promise<Catalog> | undefined;
  function scanModels() {
    return scanning ??= scanCatalog(catalog, options.scanners).then(next => { catalog = next; saveCatalog(home, next); broadcast('', { type: 'models-changed' }); return next; }).finally(() => { scanning = undefined; });
  }
  const server = createServer((req, res) => { const task = (async () => {
    if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin)) return json(res, { error: '来源不允许' }, 403);
    const url = new URL(req.url ?? '/', origin);
    if (url.pathname.startsWith('/api/')) {
      if (req.headers.authorization !== `Bearer ${token}` && !(url.pathname === '/api/stream' && url.searchParams.get('token') === token)) return json(res, { error: '令牌无效' }, 401);
      const method = req.method;
      if (method === 'POST' && url.pathname === '/api/shutdown') {
        if (req.headers.origin !== origin) return json(res, { error: '来源不允许' }, 403);
        res.once('finish', () => { void close().then(() => options.onShutdown?.()); });
        return json(res, { ok: true });
      }
      if (closed) return json(res, { error: '服务正在退出' }, 503);
      if (method === 'GET' && url.pathname === '/api/state') return json(res, { projects: projects.map(p => ({ ...p })), sessions: [...records.values()].map(m => ({ ...m, status: status(m.id), lastActivity: summaries.get(m.id)?.lastActivity ?? m.createdAt, attention: sessionAttention(m.id) })), models: catalog, quota: ['claude','codex','dsh'].flatMap(h => { const q = readJson(join(home, 'quota', h + '.json'), undefined); return q ? [q] : []; }) });
      if (method === 'POST' && url.pathname === '/api/models/scan') {
        if (req.headers.origin !== origin) return json(res, { error: '来源不允许' }, 403);
        return json(res, await scanModels());
      }
      const statsMatch = /^\/api\/projects\/([^/]+)\/git-stats$/.exec(url.pathname);
      if (method === 'GET' && statsMatch) {
        const project = projects.find(p => p.id === statsMatch[1]); if (!project) throw new Error('未知项目');
        return json(res, await directoryStats(project.path));
      }
      const gitInit = /^\/api\/projects\/([^/]+)\/git-init$/.exec(url.pathname);
      if (method === 'POST' && gitInit) {
        if (req.headers.origin !== origin) return json(res, { error: '来源不允许' }, 403);
        const project = projects.find(p => p.id === gitInit[1]);
        if (!project) return json(res, { error: '未知项目' }, 404);
        let task = initializing.get(project.id);
        if (!task) { task = initRepository(project.path); initializing.set(project.id, task); }
        let created;
        try { created = await task; project.git = true; } finally { initializing.delete(project.id); }
        broadcast('', { type: 'projects-changed' });
        return json(res, created);
      }
      if (url.pathname === '/api/projects') {
        if (method === 'POST') { const input = projectSchema.parse(await body(req)); const path = resolve(input.path); if (!statSync(path).isDirectory()) throw new Error('项目路径必须是已存在的目录'); let p = projects.find(p => p.path === path); if (!p) { p = { id: randomUUID(), path, git: isGit(path) }; projects.push(p); } atomic(join(home, 'projects.json'), projects); broadcast('', { type: 'projects-changed' }); return json(res, p); }
        if (method === 'DELETE') { const input = z.object({ id: z.string() }).strict().parse(await body(req)); if (!projects.some(p => p.id === input.id)) return json(res, { error: '未知项目' }, 404); projects = projects.filter(p => p.id !== input.id); atomic(join(home, 'projects.json'), projects); broadcast('', { type: 'projects-changed' }); return json(res, { ok: true }); }
      }
      if (method === 'POST' && url.pathname === '/api/sessions') {
        const input = sessionSchema.parse(await body(req)), project = projects.find(p => p.id === input.projectId);
        if (!project) throw new Error('请选择已存在的项目');
        if (input.mode === 'worktree' && !isGit(project.path)) throw new Error('此项目不是 Git 仓库，不能使用 worktree');
        if (input.members.filter(m => m.harness === 'dsh' && m.model === 'local').length > 1) throw new Error('一个会话最多一个本地 Qwen');
        for (const m of input.members) if (m.effort && !allowedEfforts(catalog, m.harness as HarnessName, m.model).includes(m.effort)) throw new Error(`${m.model} 不支持推理强度 ${m.effort}`);
        let config; try { config = parseConfig({ workspace: project.path, mode: input.mode, members: input.members, networkAccess: input.networkAccess, sessionRoot: join(home, 'sessions') }); } catch { throw new Error('团队配置无效：必须恰有一名负责人，成员名唯一，DSH 只能选列表里的模型'); }
        const s = new PlatformSession(config, factory, e => callback(s.id, e));
        const meta = { id: s.id, projectId: project.id, title: input.title ?? '', titleState: input.title ? 'manual' : 'eligible', config, createdAt: new Date().toISOString(), harnessIds: {} as Record<string,string> };
        records.set(s.id, meta); atomic(join(s.dir, 'session.json'), meta);
        seedQuota(s);
        try { await s.start(); live.set(s.id, s); seedQuota(s); } catch (error) { (meta as any).error = `启动失败：${String(error)}`; atomic(join(s.dir, 'session.json'), meta); s.storage.event('session-error', { text: (meta as any).error }); }
        broadcast(s.id, { type: 'session-created' }); return json(res, { ...meta, status: status(s.id) });
      }
      if (method === 'GET' && url.pathname === '/api/stream') {
        const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) throw new Error('事件序号无效');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        clients.add(res); if (stream.length && after < stream[0].seq - 1) res.write(`event: gap\ndata: ${JSON.stringify({ oldest: stream[0].seq, latest: sequence })}\n\n`); for (const f of stream) if (f.seq > after) res.write(`id: ${f.seq}\ndata: ${JSON.stringify(f)}\n\n`);
        const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000); req.on('close', () => { clearInterval(heartbeat); clients.delete(res); }); return;
      }
      const permissionMatch = /^\/api\/sessions\/([^/]+)\/permissions$/.exec(url.pathname);
      if (permissionMatch && records.has(permissionMatch[1]!)) {
        const id = permissionMatch[1]!, meta = records.get(id);
        if (method === 'GET') {
          const manager = live.get(id)?.permissions ?? new PermissionManager(parseConfig(meta.config), () => {}, history(id));
          return json(res, { ...manager.snapshot(), recent: history(id).filter(e => e.type.startsWith('permission-')).slice(-50) });
        }
        if (method === 'POST') {
          if (req.headers.origin !== origin) return json(res, { error: '来源不允许' }, 403);
          const input = z.discriminatedUnion('action', [
            z.object({ action: z.literal('level'), member: z.string(), level: z.enum(['read-only','safe-write','full-write']) }).strict(),
            z.object({ action: z.literal('network'), enabled: z.boolean() }).strict(),
            z.object({ action: z.literal('answer'), id: z.string(), decision: z.enum(['once','session','reject']) }).strict(),
            z.object({ action: z.literal('revoke'), id: z.string() }).strict(),
          ]).parse(await body(req));
          const session = await load(id), manager = session.permissions;
          if (input.action === 'level') manager.set(input.member, input.level);
          if (input.action === 'network') manager.setNetwork(input.enabled);
          if (input.action === 'answer') manager.answer(input.id, input.decision);
          if (input.action === 'revoke') manager.revoke(input.id);
          return json(res, { ok: true });
        }
      }
      const match = /^\/api\/sessions\/([^/]+)\/(events|messages|rename|pause|resume|stop|board|changes|context|members\/([^/]+)\/(?:interrupt|retry))$/.exec(url.pathname);
      if (!match || !records.has(match[1]!)) return json(res, { error: '未知会话' }, 404);
      // The path arrives percent-encoded, which a Chinese member name always is.
      const id = match[1]!, action = match[2]!, meta = records.get(id), memberPath = match[3] && decodeURIComponent(match[3]);
      if (method === 'GET' && action === 'events') { const after = Number(url.searchParams.get('after') ?? 0); if (!Number.isSafeInteger(after) || after < 0) throw new Error('事件序号无效'); const member = url.searchParams.get('member'); return json(res, history(id).slice(after).filter(e => !member || [e.member, e.author, e.recipient].includes(member)).map((e, i) => ({ ...e, sequence: e.sequence ?? history(id).indexOf(e) + 1 }))); }
      if (method === 'GET' && action === 'board') return json(res, { text: existsSync(join(home, 'sessions', id, 'board', 'all.md')) ? readFileSync(join(home, 'sessions', id, 'board', 'all.md'), 'utf8') : '' });
      if (action === 'context') {
        const root = meta.config.workspace;
        const names = ['AGENTS.md','CLAUDE.md', ...(() => { const dir = join(root,'.agent-notes'); try { return containedFile(dir,root) ? readdirSync(dir).filter(f=>f.endsWith('.md')).slice(0,16).map(f=>'.agent-notes/'+f) : []; } catch { return []; } })()];
        if(method === 'GET') return json(res,{files:names.filter(name=>containedFile(join(root,name),root)).map(name=>{ const file=join(root,name), large=existsSync(file) && statSync(file).size>64000; return {path:name,editable:!large && ['AGENTS.md','CLAUDE.md'].includes(name),text:large ? '文件超过64KB，请在编辑器中查看，避免截断保存。' : existsSync(file) ? readFileSync(file,'utf8') : ''}; })});
        if(method === 'POST') {
          const input = z.object({path:z.enum(['AGENTS.md','CLAUDE.md']),text:z.string().max(64000)}).strict().parse(await body(req));
          if(!containedFile(join(root,input.path),root)) throw new Error('规则路径不安全');
          atomicText(join(root,input.path),input.text);return json(res,{ok:true});
        }
      }
      if (method === 'GET' && action === 'changes') {
        const unique: string[] = [meta.config.workspace];
        if(meta.config.mode === 'worktree') for(const member of meta.config.members) {
          const path=join(home,'sessions',id,'worktrees',member.name);
          if(existsSync(path)) unique.push(path);
        }
        const index = Number(url.searchParams.get('workspace') ?? 0), file = url.searchParams.get('file');
        if(!Number.isSafeInteger(index) || !unique[index]) throw new Error('未知工作目录');
        if(file !== null) {
          const cwd=unique[index]!;
          if(!file || file.includes('\0') || !containedFile(join(cwd,file),cwd)) throw new Error('文件路径不安全');
          const tracked = await gitAsync(cwd,['--literal-pathspecs','ls-files','--',file]);
          if(!tracked) { const others=await gitAsync(cwd,['--literal-pathspecs','ls-files','--others','--exclude-standard','-z','--',file]); if(!others.split('\0').includes(file)) throw new Error('该文件不在可查看的改动中'); }
          if(!tracked) { if(!existsSync(join(cwd,file))) return json(res,{message:'文件已删除'}); if(statSync(join(cwd,file)).size>256000)return json(res,{message:'文件过大，请在编辑器查看'}); const text=readFileSync(join(cwd,file),'utf8'); return json(res,{diff:text.includes('\0')?'二进制文件':text}); }
          const [unstaged,staged]=await Promise.all([gitAsync(cwd,['--literal-pathspecs','diff','--no-ext-diff','--no-textconv','--',file]),gitAsync(cwd,['--literal-pathspecs','diff','--cached','--no-ext-diff','--no-textconv','--',file])]);
          return json(res,{diff:('未暂存改动\n'+unstaged+'\n已暂存改动\n'+staged).slice(0,256000)});
        }
        const workspaces=[];
        for(const [i,cwd] of unique.entries()) {
          try { const raw=await gitAsync(cwd,['status','--porcelain=v1','-z','--untracked-files=all']); const parts=raw.split('\0').filter(Boolean), files=[];
            for(let n=0;n<parts.length;n++){const row=parts[n]!;files.push({status:row.slice(0,2),path:row.slice(3)});if(/[RC]/.test(row.slice(0,2)))n++;}
            workspaces.push({index:i,path:cwd,label:i===0?'项目目录':'成员工作树',files});
          } catch { workspaces.push({index:i,path:cwd,label:'Git 状态读取失败或目录不是仓库',files:[]}); }
        }
        // Preserve the original summary fields for existing clients.
        const cwd = meta.config.workspace;
        try {
          const [status,diff] = await Promise.all([gitAsync(cwd, ['status', '--short']),gitAsync(cwd, ['diff', '--stat'])]);
          return json(res,{status,diff,workspaces});
        } catch { return json(res,{message:'此目录不是 Git 仓库',workspaces}); }

      }
      if (method === 'POST') {
        if (memberPath && !meta.config.members.some((m: any) => m.name === memberPath)) return json(res, { error: '未知成员' }, 404);
        if (action === 'stop') { cancelTitle(id); if (loading.has(id)) await loading.get(id); if (live.has(id)) await live.get(id)!.stop(); else { new SessionStorage(join(home, 'sessions', id), e => callback(id, e)).event('stopped'); } return json(res, { ok: true }); }
        if(action === 'rename') { const {text}=messageSchema.parse(await body(req)); cancelTitle(id); meta.titleState='manual'; meta.title=[...text.replace(/\s+/g,' ').trim()].slice(0,60).join(''); atomic(join(home,'sessions',id,'session.json'),meta); broadcast(id,{type:'session-renamed'}); return json(res,{ok:true}); }
        if (action === 'messages') {
          const { text } = messageSchema.parse(await body(req)); const s = await load(id);
          if (!meta.title) meta.title = [...text.replace(/\s+/g,' ').trim()].slice(0,36).join('');
          const generate = meta.titleState === 'eligible';
          if (generate) meta.titleState = 'attempted';
          atomic(join(s.dir, 'session.json'), meta);
          s.sendUser(text);
          if (generate && !closed && status(id) !== '已停止') startTitle(id, text);
        }
        else if (action === 'pause') (await load(id)).pause();
        else if (action === 'resume') (await load(id)).resume();
        else if (memberPath) { const session = await load(id); if(action.endsWith('/retry')) session.retry(memberPath); else await session.interrupt(memberPath); }
        else return json(res, { error: '未知操作' }, 404);
        return json(res, { ok: true });
      }
      return json(res, { error: '请求方法不允许' }, 405);
    }
    if (req.method !== 'GET') return json(res, { error: '请求方法不允许' }, 405);
    const files: Record<string, string> = { '/': 'index.html', '/app.js': 'app.js', '/state.js': 'state.js', '/markdown.js': 'markdown.js', '/style.css': 'style.css' };
    const file = files[url.pathname]; if (!file) return json(res, { error: '未找到' }, 404);
    res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    res.end(readFileSync(fileURLToPath(new URL('../../ui/' + file, import.meta.url))));
  })().catch(error => { if (!res.headersSent) json(res, { error: error instanceof z.ZodError ? '配置校验失败：请检查输入字段、成员名和团队配置' : String(error.message ?? error) }, 400); else res.end(); }); pending.add(task); void task.finally(() => pending.delete(task)); });
  try { await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); }); } catch (error) { release(); throw error; }
  const port = (server.address() as any).port; origin = `http://127.0.0.1:${port}`;
  if (options.lock !== false) publishLock(home, { pid: process.pid, port, token });
  let closed = false, closing: Promise<void> | undefined;
  function close() { return closing ??= (async () => { closed = true; for (const id of titleRequests.keys()) cancelTitle(id); clearInterval(quotaTimer); await Promise.allSettled([...titleTransports]); for (const s of live.values()) s.permissions.cancel(); await Promise.allSettled([...pending]); await Promise.allSettled([...loading.values()]); await Promise.allSettled([...live.values()].map(s => s.stop(false))); for (const c of clients) c.end(); await new Promise<void>(r => server.close(() => r())); release(); })(); }
  return { home, token, origin, url: `${origin}/?token=${token}`, close, server, live };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.CREWROOM_SMOKE && !process.env.CREWROOM_HOME) throw new Error('冒烟模式必须设置 CREWROOM_HOME');
  const demo = process.argv.includes('--demo');
  const home = demo ? mkdtempSync(join(tmpdir(), 'agents-app-demo-')) : appHome();
  const existing = serviceInfo(home);
  if (existing) { try { process.kill(existing.pid, 0); console.log(`http://127.0.0.1:${existing.port}/?token=${existing.token}`); process.exit(0); } catch {} }
  const app = await startApp({ home, factory: demo ? demoFactory : undefined, onShutdown: () => process.exit(0), scanners: demo ? { claude: async () => [], codex: async () => [], dsh: async () => [] } : realScanners });
  // Keeps the model lists current without holding up startup. Only opens sessions, so it costs no inference.
  if (!demo && !process.env.CREWROOM_SMOKE) void fetch(app.origin + '/api/models/scan', { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, Origin: app.origin } }).catch(() => {});
  if (demo) {
    const headers = { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' };
    const request = async (path: string, value: unknown) => (await (await fetch(app.origin + '/api/' + path, { method: 'POST', headers, body: JSON.stringify(value) })).json()) as any;
    const project = await request('projects', { path: home });
    const session = await request('sessions', { projectId: project.id, title: '团队协作演示', members: [ { name: 'lead', role: 'lead', harness: 'claude', model: 'claude-opus-5-5', effort: 'high' }, { name: 'qwen', role: 'worker', harness: 'dsh', model: 'local' }, { name: 'sol', role: 'worker', harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' } ] });
    await request(`sessions/${session.id}/messages`, { text: '请安排团队检查项目，展示白板、私信和额度。' });
    setTimeout(() => { void request(`sessions/${session.id}/messages`, { text: '补充：请同时检查测试。' }); }, 50);
  }
  console.log(app.url);
  for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => process.exit()); });
}
