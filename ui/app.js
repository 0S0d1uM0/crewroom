import { initialState, reduce, activityLabel, shouldAlert, visibleActivities, effortChoices, modelSelection, scanStatus, coalesceRecords, attention, memberActivity, toolName, permissionHistory, operationSummary } from './state.js';
import { markdown } from './markdown.js';
const $ = id => document.getElementById(id);
const statusLabel = value => ({completed:'已完成',failed:'失败',cancelled:'已中断',quota:'额度暂停',in_progress:'执行中',pending:'等待中'}[value] ?? value ?? '执行中');
const token = new URL(location.href).searchParams.get('token');
if (token) { sessionStorage.setItem('agents-token', token); history.replaceState(null, '', '/'); }
const auth = sessionStorage.getItem('agents-token') ?? '';
const notifiedWaiting = new Set();
const notifiedPermissions = new Set();
let readingTab = null;
let state = { projects: [], sessions: [], quota: [], models: {} }, selected = null, view, tab = '白板', newProject, source;
const permissionLabels = {'read-only':'只读','safe-write':'安全读写','full-write':'全面读写 · 全部允许（含 git push）'};
const defaults = [{ harness:'claude',model:'opus',effort:'high',role:'lead' },{ harness:'dsh',model:'local',role:'worker' },{ harness:'codex',model:'gpt-6.1-sol',effort:'high',role:'worker' }];
function node(tag, text, cls) { const e = document.createElement(tag); if (text != null) e.textContent = String(text); if (cls) e.className = cls; return e; }
function button(text, action) { const b = node('button', text); b.type = 'button'; b.onclick = () => Promise.resolve().then(action).catch(showError); return b; }
function showError(error) { $('banner').textContent = error.message ?? String(error); }
async function api(path, method = 'GET', data) { const r = await fetch('/api/' + path, { method, headers: { Authorization: `Bearer ${auth}`, ...(data ? {'Content-Type':'application/json'} : {}) }, body: data ? JSON.stringify(data) : undefined }); const value = await r.json(); if (!r.ok) throw new Error(value.error); return value; }
function rich(text) { const root = node('div'); function render(d) { const e = d.tag === 'text' ? document.createTextNode(d.text) : node(d.tag, d.text); for (const child of d.children ?? []) e.append(render(child)); return e; } root.append(...markdown(text).map(render)); return root; }
function record(e) {
  const d = node('details', null, 'activity');
  const heading = e.type === 'queued' ? `消息已排队给 ${e.member}` : e.type === 'turn-start' || e.type === 'wait-resume' ? `第 ${e.turn ?? '?'} 轮 · 收到消息` : e.type === 'member-text' || e.type === 'to-user' ? `${e.member} 的文本` : e.type === 'dm' ? `${e.author} → ${e.recipient} · ${e.id}` : activityLabel(e);
  d.append(node('summary', heading));
  if (e.text) d.append(rich(e.text));
  else if (e.type === 'tool') { d.append(node('p', `${toolName(e)} · ${statusLabel(e.status)}${e.at ? ' · ' + new Date(e.at).toLocaleTimeString() : ''}`)); if (e.command) d.append(node('pre', e.command)); if (e.paths?.length) d.append(node('pre', e.paths.join('\n'))); }
  else if (e.operation || e.command) { d.append(node('pre', e.operation?.command ?? e.command ?? e.operation?.paths?.join('\n') ?? e.operation?.name ?? '')); if (e.reason ?? e.operation?.reason) d.append(node('p', e.reason ?? e.operation.reason)); }
  else if (e.type === 'turn-end') d.append(node('p', `结果：${statusLabel(e.status)} · ${e.error ?? ''}`));
  else d.append(node('p', e.at ? new Date(e.at).toLocaleString() : ''));
  if (e.error) d.append(node('p',e.error,'warning'));
  return d;
}
function notify(title, body) { window.desktop?.notify(title, body); }
// A pending request is on the waiting strip and the member's card for exactly as long as it lasts; the banner has no way to know it was answered.
function showAlert(e) {
  const text=e.type==='permission-request'?`${e.member} 等你批准：${operationSummary(e.operation)}`:e.type==='permission-changed'?`${e.member} 权限已由负责人上调`:e.text ?? e.error ?? activityLabel(e);
  if(e.type!=='permission-request')$('banner').textContent=text;
  notify('团队提醒',text);
}
async function refresh() {
  if (refreshTask) { refreshAgain = true; return refreshTask; }
  refreshTask = (async () => { state = await api('state'); for(const s of state.sessions) { if(s.attention?.waiting && s.attention.kind!=='permission') { if(!notifiedWaiting.has(s.id))notify('等你回答',s.title || '负责人有消息等待你回复');notifiedWaiting.add(s.id); } else notifiedWaiting.delete(s.id); } renderLeft(); renderHead(); })();
  try { await refreshTask; } finally { refreshTask = null; if (refreshAgain) { refreshAgain = false; scheduleRender(); } }
}
function nearBottom() { const c = $('chat'); return c.scrollHeight - c.scrollTop - c.clientHeight <= 1; }
let openingConversation = false, followingBottom = true;
function pinBottom() { $('chat').scrollTop = $('chat').scrollHeight; }
function renderHead() {
  const pinned = nearBottom();
  const a = view ? attention(view) : { waiting:false, label:'' };
  const current = state.sessions.find(s => s.id === selected);
  const frozen = ['已暂停','已停止','错误'].includes(current?.status);
  $('waiting').hidden = !a.waiting;
  $('waiting').replaceChildren();
  if(view?.approvals?.length)$('waiting').append(button('处理权限申请',()=>{showRight();const name=view.approvals[0]?.member;[...$('members').children].find(c=>c.dataset.member===name)?.scrollIntoView?.({block:'nearest'});}));
  if (a.waiting) { $('waiting').append(node('strong',`${frozen ? current.status+' · ' : ''}${a.label}`),node('span',a.text.replace(/\s+/g,' ').slice(0,70),'question-summary'),button('查看全文',()=>{const d=node('dialog');d.append(rich(a.text),button('关闭',()=>{d.close();d.remove();}));document.body.append(d);d.showModal();})); if(current?.status==='已暂停')$('waiting').title='回复将排队，继续会话后送达'; if(current?.status!=='已停止')$('waiting').append(button('回答负责人',()=>{ document.body.classList.remove('show-right'); $('message').focus(); })); }
 const s = state.sessions.find(s => s.id === selected); $('title').textContent = s?.title || (s ? '新会话' : '选择项目，开始协作'); $('status').textContent = s ? frozen ? s.status : `${s.status==='未加载'?'历史会话':s.status} · ${a.label}` : '只需与负责人对话'; $('pause').textContent = s?.status === '已暂停' ? '继续' : '暂停'; for (const id of ['pause','interrupt','stop','message']) $(id).disabled = !s || s.status === '已停止'; $('composer').querySelector('button').disabled = !s || loadingView || s.status === '已停止';
  if (loadingView) { $('status').textContent = '加载中…'; for (const id of ['pause','interrupt','stop','message']) $(id).disabled = true; }
  $('interrupt').hidden = !view || !Object.values(view.members).some(m=>m.role==='lead' && m.state==='工作中') || frozen;
  const online=view?.networkAccess ?? s?.config.networkAccess ?? true; $('network-toggle').textContent=online?'联网开':'联网关闭';$('network-toggle').className=online?'':'warning';$('network-toggle').disabled=!s;
  const lead=s?.config.members.find(m=>m.role==='lead');
  const low=state.quota.filter(q=>q.harness===lead?.harness).flatMap(q=>q.windows.filter(w=>w.usedPercent>85 && (!w.resetsAt || Date.parse(w.resetsAt)>Date.now())).map(w=>q.harness+' '+(w.label==='5h'?'5 小时':'每周')+'剩余 '+Math.max(0,100-w.usedPercent)+'%，重置 '+(w.resetsAt?new Date(w.resetsAt).toLocaleString():'未知')));
  $('quota-warning').textContent=low.join('；') || (state.quota.some(q=>q.harness===lead?.harness && q.exhausted)?`${lead.harness} 额度已耗尽，请等待重置或切换会话。`:'');
  if (pinned) pinBottom();
}
function unreadCounts(id) {
  const seen=JSON.parse(sessionStorage.getItem('unread:'+id)||'{}');
  const events=id===selected ? view?.activities ?? [] : [];
  return Object.fromEntries([['白板','board'],['私信','dm']].map(([name,type])=>[name,events.filter(e=>e.type===type && (e.sequence??0)>(seen[name]??0)).length]));
}
function readTab() {
  if(!selected || !view || !['白板','私信'].includes(tab))return;
  const key='unread:'+selected, seen=JSON.parse(sessionStorage.getItem(key)||'{}');seen[tab]=view.sequence??0;sessionStorage.setItem(key,JSON.stringify(seen));
}
function renderTabs() { const counts=unreadCounts(selected);for(const b of $('tabs').children){const name=b.dataset.tab;if(!name)continue;b.textContent=name==='记录'?`${recordMember ?? ''} 的记录`:name+(counts[name]?' ('+counts[name]+')':'');b.hidden=name==='记录' && !recordMember;b.className=name===tab && !panelCollapsed?'active':'';} }
const quotaOpen = new Map();
function relativeTime(value) {
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '时间未知';
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
function sessionRow(s) {
  const b = button(null, () => select(s.id));
  b.className = 'session' + (selected === s.id ? ' active' : '') + (s.attention?.waiting ? ' waiting-session' : '');
  b.setAttribute('aria-current', selected === s.id ? 'true' : 'false');
  const title = node('span', `● ${s.title || '新会话'}`, 'session-title'); title.title = s.title || '新会话';
  const detail = node('span', `${s.attention?.waiting ? '等你回答' : s.status === '未加载' ? '历史会话' : s.status} · ${relativeTime(s.lastActivity)}`, 'session-meta');
  b.append(title, detail); return b;
}
function renderLeft() {
  for(const card of $('quota').children) if(card.dataset.harness)quotaOpen.set(card.dataset.harness,card.open);
  $('projects').replaceChildren();
  for (const p of state.projects) {
    const section = node('section',null,'project'), path = node('p',p.path,'hint project-path'); path.title = p.path; section.append(node('strong', p.path.split(/[\\/]/).pop()), path);
    if (!p.git) section.append(button('初始化 Git', async () => { try { await initGit(p); } catch (e) { showError(e); } }));
    const more=node('details',null,'more');more.append(node('summary','更多'),button('移除项目', async () => { if (confirm('只从列表移除此项目？项目文件和会话记录会保留。')) { await api('projects','DELETE',{id:p.id}); await refresh(); } }));
    section.append(button('＋ 新会话',()=>openNew(p)),more);
    for (const s of state.sessions.filter(s => s.projectId === p.id)) section.append(sessionRow(s));
    $('projects').append(section);
  }
  const orphans = state.sessions.filter(s => !state.projects.some(p => p.id === s.projectId)); if (orphans.length) { $('projects').append(node('h3','已移除项目的历史')); for (const s of orphans) $('projects').append(sessionRow(s)); }
  $('quota').replaceChildren(node('strong','额度观察'));
  for (const q of state.quota.filter(q=>q.harness!=='dsh')) { const card = node('details',null,'quota-detail'); card.dataset.harness=q.harness;card.open=quotaOpen.get(q.harness)??false; card.append(node('summary',`${q.harness} · ${q.windows.filter(w=>w.label==='5h').map(w=>'5小时 '+(w.usedPercent==null?'未知':Math.round(100-w.usedPercent)+'% 剩余')).join('') || '额度详情'}`),node('b',q.harness),node('p',`更新于 ${relativeTime(q.observedAt)} · ${q.harness==='claude'?'仅工作时更新':'定期观察'}`)); for (const w of q.windows) card.append(node('p',`${w.label === 'weekly' ? '每周' : w.label === '5h' ? '5 小时' : w.label}：${w.usedPercent == null ? '未知' : Math.round(100-w.usedPercent)}% 剩余 · 重置 ${w.resetsAt ? new Date(w.resetsAt).toLocaleString() : '未知'}`,w.usedPercent >= 85 ? 'warning' : '')); if (q.exhausted) { card.append(node('b','额度已耗尽','warning')); } card.children[2].dataset.observedAt=q.observedAt;card.children[2].dataset.harness=q.harness;$('quota').append(card); }
}
let generation = 0, loadingView = false, pendingEvents = [], renderTimer, refreshTask, refreshAgain = false;
let historyBoundary = 0, panelDirty = true, panelGeneration = 0;
let consumed = 0, groups = [], groupNodes = new Map(), visibleCount = 200;
async function syncEvents() {
  if (!selected || loadingView) return;
  const id = selected, gen = generation, local = view;
  const list = await api(`sessions/${id}/events?after=${local.sequence ?? 0}`);
  if (generation !== gen) return;
  for (const e of list) reduce(local, e);
  scheduleRender();
}
async function select(id) {
  if (id === selected && view) return;
  if (selected) sessionStorage.setItem('draft:'+selected, $('message').value || '');
  $('message').value = sessionStorage.getItem('draft:'+id) ?? '';
  panelDirty = true; panelGeneration++;
  readingTab=null; selected = id; const gen = ++generation;
  loadingView = true; openingConversation = true; followingBottom = true; pendingEvents = []; visibleCount = 200;
  consumed = 0; groups = []; groupNodes.clear(); $('chat').replaceChildren(); $('panel').replaceChildren(); $('members').replaceChildren();
  const local = initialState(state.sessions.find(s => s.id === id)?.config);
  view = local;
  $('banner').textContent = ''; renderLeft(); renderHead();
  $('chat').append(node('p','加载中…','loading'));
  try {
    const list = await api(`sessions/${id}/events`);
    if (generation !== gen) return;
    for (const e of list) reduce(local, e);
    if (state.sessions.find(s=>s.id===id)?.status === '未加载') {
      for (const m of Object.values(local.members)) {
        m.activeTools?.clear();
        if (m.state === '工作中') m.state='空闲';
      }
    }
    historyBoundary = local.sequence ?? list.length;
    for (const e of pendingEvents) reduce(local, e);
    loadingView = false; pendingEvents = []; $('chat').replaceChildren(); scheduleRender();
  } catch (error) {
    if (generation === gen) { $('chat').replaceChildren(node('p','加载失败，请重新选择会话')); view = null; showError(error); }
  } finally { if (generation === gen) { loadingView = false; renderHead(); } }
}
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    if (view && !loadingView) { renderConversation(); void renderPanel().catch(showError); }
    renderHead();
    void refresh().catch(showError);
  }, 250);
}
function renderConversation(prepending = false) {
  const chat = $('chat'), atBottom = openingConversation || nearBottom();
  openingConversation = false;
  const oldHeight = chat.scrollHeight, oldTop = chat.scrollTop, oldGroups = groups.length;
  for (; consumed < view.activities.length; consumed++) {
    const e = view.activities[consumed], dialogue = ['from-user','to-user'].includes(e.type);
    if (dialogue) groups.push({ dialogue: true, events: [e] });
    else {
      let group = groups.at(-1);
      if (!group || group.dialogue) { group = { events: [] }; groups.push(group); }
      group.events.push(e);
    }
  }
  if (!atBottom && !prepending) visibleCount += groups.length - oldGroups;
  const start = Math.max(0, groups.length - visibleCount), active = new Set();
  for (let i = start; i < groups.length; i++) {
    active.add(i); const g = groups[i]; let el = groupNodes.get(i);
    if (!el) {
      if (g.dialogue) { const e = g.events[0]; el = node('article', null, `bubble ${e.type === 'from-user' ? 'user' : 'lead'}`); el.append(node('small', e.type === 'from-user' ? '你' : '负责人'), rich(e.text)); }
      else { el = node('details', null, 'activity'); el.append(node('summary'), node('div')); el.ontoggle = () => fillActivity(el, g); }
      groupNodes.set(i, el);
    }
    if (g.dialogue && el.dataset.text !== g.events[0].text) {
      const content = rich(g.events[0].text); if (el.children[1]) el.children[1].replaceWith(content); el.dataset.text = g.events[0].text;
    }
    if (!g.dialogue) {
      if (g.visibleCount !== g.events.length) {
        g.visible = visibleActivities(g.events); g.visibleCount = g.events.length;
        g.failures = g.events.filter(mustExpand).length;
      }
      el.hidden = !g.visible.length;
      const last = g.visible.at(-1), toolFailures = g.visible.filter(e => e.type === 'tool' && e.status === 'failed').length;
      el.firstChild.textContent = `团队活动 · ${g.visible.length} 步${toolFailures ? ` · ${toolFailures} 个工具失败` : ''}${last ? ' · ' + activityLabel(last) : ''}`;
      if (g.failures && g.failureCount !== g.failures) { el.open = true; g.failureCount = g.failures; }
      fillActivity(el, g);
    }
    const previous = i === start ? null : groupNodes.get(i - 1);
    if (previous ? previous.nextSibling !== el : chat.firstChild !== el) chat.insertBefore(el, previous ? previous.nextSibling : chat.firstChild);
  }
  for (const [key, el] of groupNodes) if (!active.has(key)) { el.remove(); groupNodes.delete(key); }
  followingBottom = atBottom;
  if (atBottom) pinBottom();
  else chat.scrollTop = oldTop + (prepending ? Math.max(0, chat.scrollHeight - oldHeight) : 0);
}
// A member that stopped needs the user. A failed command is routine: the member usually tries something else.
function mustExpand(e) { return (e.sequence ?? 0) > historyBoundary && ['member-failed','session-error'].includes(e.type); }
function fillActivity(el, group) {
  if (!el.open) return;
  const root = el.lastChild;
  // Only mount a bounded page even when one activity group spans a very long turn.
  const all = group.visible ?? visibleActivities(group.events), items = all.slice(-(group.limit ?? 200));
  // Keep streaming text fresh even when the number of logical rows stays constant.
  const existing = new Map([...root.children].filter(d => d.dataset.key).map(d => [d.dataset.key, d]));
  const active = new Set();
  for (let i = 0; i < items.length; i++) {
    const e = items[i], key = e.type === 'tool' && e.id ? `tool:${e.member}:${e.id}` : String(e.sequence ?? i); active.add(key);
    let d = existing.get(key);
    if (d && e.type === 'tool' && d.children[1]) d.children[1].textContent = `${e.title ?? e.kind ?? '工具'} · ${statusLabel(e.status)}${e.error ? ' · ' + e.error : ''}`;
    if (d && e.text && d.dataset.text !== e.text) { if(d.children[1]) d.children[1].replaceWith(rich(e.text)); d.dataset.text=e.text; }
    if (d && mustExpand(e)) { d.open = true; }
    if (!d) { d = record(e); d.dataset.key = key; d.open = mustExpand(e); root.append(d); }
  }
  for (const [key, d] of existing) if (!active.has(key)) d.remove();
  const more = [...root.children].find(d => d.dataset.more);
  if (more) more.remove();
  if (all.length > (group.limit ?? 200)) {
    const b = button('加载更早活动', () => { group.limit = (group.limit ?? 200) + 200; delete el.dataset.count; fillActivity(el, group); });
    b.dataset.more = 'true'; root.append(b);
  }
  el.dataset.count = String(group.events.length);
}
// Track user scrolling separately so later layout changes only follow a pinned conversation.
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => { if (followingBottom) pinBottom(); }).observe($('chat'));
$('chat').onscroll = () => {
  followingBottom = nearBottom();
  if ($('chat').scrollTop < 30 && visibleCount < groups.length) { visibleCount += 200; renderConversation(true); }
};
// The lower half of the panel shows one thing at a time, and steps aside when nothing is wanted there.
let recordMember = null, panelCollapsed = false;
const shortLevels = {'read-only':'只读','safe-write':'安全读写','full-write':'全面读写'};
const tenThousands = n => n >= 10000 ? `${Math.round(n / 10000)}万` : String(n);
function openTab(name) { tab=name;panelCollapsed=false;$('right').className='';readingTab=name;readTab();renderTabs();panelDirty=true;return renderPanel(); }
function collapsePanel() { panelCollapsed=true;$('right').className='panel-collapsed';renderTabs(); }
function openRecords(name) { recordMember=name;showRight();return openTab('记录'); }
async function setPermissions(data) { await api(`sessions/${selected}/permissions`,'POST',data);if(tab==='权限')panelDirty=true;await syncEvents();return renderPanel(); }
// An approval is answered on the member's own card, so the rest of the team stays in view.
function approvalCard(p) {
  const card=node('section',null,'approval'), op=p.operation;
  card.append(node('b','申请运行：'+operationSummary(op)));
  if(op.command || op.paths?.length || op.name) card.append(node('pre',op.command || op.paths?.join('\n') || op.name));
  if(op.reason) card.append(node('p',op.reason));
  card.append(node('p',`目录 ${op.cwd ?? '未知'} · 批准后可能跑在沙箱外，它启动的子进程也不受工作目录限制`,'hint'));
  const actions=node('div',null,'approval-actions');
  const answer=decision=>setPermissions({action:'answer',id:p.id,decision});
  actions.append(button('允许这一次',()=>answer('once')));
  if(op.command && op.remember!==false) actions.append(button('本会话允许相同命令',()=>answer('session')));
  actions.append(button('拒绝',()=>answer('reject')));
  card.append(actions);return card;
}
async function renderPanel() {
  if (!selected || !view) return;
  const members = $('members');
  const attentionState = attention(view);
  const priority = m => m.state === '失败' ? 0 : view.approvals?.some(p=>p.member===m.name) || m.role === 'lead' && attentionState.waiting ? 1 : m.state === '等待消息' ? 2 : 3;
  let previous = null;
  for (const m of Object.values(view.members).sort((a,b) => priority(a) - priority(b))) {
    let c = [...members.children].find(c => c.dataset.member === m.name);
    if (!c) {
      c = node('section',null,'card'); c.dataset.member=m.name;
      const head=node('div',null,'member-head');
      const level=node('select',null,'member-level');level.setAttribute('aria-label',m.name+' 权限');
      for(const [value,label] of Object.entries(shortLevels)){const o=node('option',label);o.value=value;level.append(o);}
      level.onchange=()=>setPermissions({action:'level',member:m.name,level:level.value}).catch(error=>{level.value=view.members[m.name]?.permission ?? 'safe-write';showError(error);});
      const control=button('打断',()=>api(`sessions/${selected}/members/${encodeURIComponent(m.name)}/${c.dataset.failed==='true'?'retry':'interrupt'}`,'POST'));
      head.append(node('h3',m.name),node('span',null,'member-status'),level,control);
      const records=button('记录',()=>openRecords(m.name));records.className='member-records';
      c.append(head,node('p',null,'member-action'),node('small',null,'member-meta'),node('div',null,'member-approvals'),records); members.append(c);
    }
    const status=state.sessions.find(s=>s.id===selected)?.status;
    const approvals=view.approvals?.filter(p=>p.member===m.name) ?? [];
    const label=m.state==='失败'?'失败':approvals.length?'等你批准':status==='已暂停'?'已暂停':status==='已停止'?'已停止':m.role==='lead' && attentionState.waiting?'等你回答':m.state;
    c.firstChild.children[1].textContent=label; c.dataset.state=label; c.firstChild.firstChild.title=label;
    const level=c.firstChild.children[2], leadLevel=Object.values(view.members).find(x=>x.role==='lead')?.permission ?? 'safe-write', order=Object.keys(shortLevels);
    level.value=m.permission ?? 'safe-write'; level.disabled=['已停止','未加载'].includes(status);
    for(const o of level.options) o.disabled=m.role!=='lead' && order.indexOf(o.value)>order.indexOf(leadLevel);
    level.title=(m.harness==='codex'?'系统强制沙箱，危险命令和凭据检查存在限制':'规则检查，不能防有意绕过')+'。全面读写会全部允许，包括 git push。';
    updateMemberAction(c, m);
    c.children[1].className='member-action'+(m.state==='失败'?' warning':'');
    c.children[1].hidden=approvals.length>0;
    c.children[2].textContent=`${m.role==='lead'?'负责人 · ':''}${m.harness ?? ''} / ${m.model ?? ''}${m.contextTokens==null?'':` · 上下文 ${tenThousands(m.contextTokens)}${m.contextSize?' / '+tenThousands(m.contextSize):''}`}`;
    c.children[2].title=`${m.turns} 轮 · Token ${m.tokens ?? m.observedTokens ?? '未计量'}`;
    const box=c.children[3], boxKey=approvals.map(p=>p.id).join();
    if(box.dataset.key!==boxKey){box.dataset.key=boxKey;box.replaceChildren(...approvals.map(approvalCard));}
    c.dataset.failed=String(m.state==='失败');
    const control=c.firstChild.lastChild; control.textContent=m.state==='失败'?'重试成员':'打断'; control.disabled=status==='已停止'; control.hidden=m.state!=='失败' && (m.state!=='工作中' || ['已暂停','已停止','未加载'].includes(status));
    if (previous ? previous.nextSibling !== c : members.firstChild !== c) members.insertBefore(c,previous ? previous.nextSibling : members.firstChild);
    previous=c;
  }
  const everyone=Object.values(view.members), working=everyone.filter(m=>m.state==='工作中').length, asking=view.approvals?.length ?? 0;
  $('team-summary').textContent=`${everyone.length} 人${working?` · ${working} 人工作中`:''}${asking?` · ${asking} 个待批准`:''}`;
  if(tab==='记录' && !view.members[recordMember]) { recordMember=null;tab='白板';panelDirty=true; }
  renderTabs();
  if(!panelDirty) return; panelDirty=false;
  const panel=$('panel'), id=selected, gen=generation, request=++panelGeneration, chosen=tab;
  const valid=()=>id===selected && gen===generation && chosen===tab && request===panelGeneration;
  const content=node('div');
  if(tab==='记录') {
    const name=recordMember, list=coalesceRecords(await api(`sessions/${id}/events?member=${encodeURIComponent(name)}`));
    if(!valid()) return;
    content.append(button('刷新记录',()=>{panelDirty=true;return renderPanel();}));
    let count=200;const rows=node('div');
    const draw=()=>{rows.replaceChildren(...list.slice(-count).reverse().map(record));if(list.length>count)rows.append(button('加载更早记录',()=>{count+=200;draw();}));};draw();
    if(!list.length) rows.append(node('p','暂无记录'));
    content.append(rows);
  }
  else if(tab==='白板') { const r=await api(`sessions/${id}/board`);content.append(rich(r.text || '白板暂无内容')); }
  else if(tab==='私信') { for(const e of view.dms) { const c=node('div',null,'card');c.append(node('b',`${e.author} → ${e.recipient}`),rich(e.text));content.append(c); } if(!view.dms.length) content.append(node('p','暂无私信')); }
  else if(tab==='未回复') { for(const p of view.pending) content.append(node('p',`${p.requester} 等待 ${p.recipient} · ${p.id}`));if(!view.pending.length)content.append(node('p','没有未回复请求')); }
  else if(tab==='改动') {
    const r=await api(`sessions/${id}/changes`);
    content.append(button('刷新改动',()=>{panelDirty=true;return renderPanel();}));
    if(r.message) content.append(node('p',r.message));
    for(const area of r.workspaces ?? []) {
      content.append(node('h3',area.label),node('p',area.path,'hint'));
      if(!area.files.length)content.append(node('p','工作区无改动'));
      for(const file of area.files) {
        const d=node('details');d.append(node('summary',`${file.status} · ${file.path}`));
        d.ontoggle=async()=>{if(!d.open || d.dataset.loaded)return;try{const result=await api(`sessions/${id}/changes?workspace=${area.index}&file=${encodeURIComponent(file.path)}`);if(!valid())return;d.append(node('pre',result.diff || result.message || '无文本差异'));d.dataset.loaded='true';}catch(e){showError(e);}};content.append(d);
      }
    }
  } else if(tab==='权限') {
    const r=await api(`sessions/${id}/permissions`);
    const change=async(data)=>{await api(`sessions/${id}/permissions`,'POST',data);panelDirty=true;await syncEvents();return renderPanel();};
    content.append(node('h3',r.networkAccess?'联网开':'联网关闭'),button(r.networkAccess?'关闭联网':'开启联网',()=>change({action:'network',enabled:!r.networkAccess})));
    const rules=node('details');rules.append(node('summary','权限说明'),node('p','Claude / DSH 规则检查，不能防有意绕过。断网不保证。Codex 系统强制沙箱，但无法全面检查沙箱内危险命令或凭据读取，全面读写无法系统断网。','warning'),node('p','Claude / DSH 从下次工具调用生效，Codex 从下回合生效。运行中的命令不撤回。成员的权限和申请在上面的成员卡片里。','hint'));content.append(rules);
    content.append(node('h3','本会话允许的命令'));if(!r.grants.length)content.append(node('p','没有','hint'));
    for(const g of r.grants) {const row=node('div',null,'card');row.append(node('b',g.member),node('pre',g.command),node('p',g.cwd),button('撤销',()=>change({action:'revoke',id:g.id})));content.append(row);}
    content.append(node('h3','最近记录'),...permissionHistory(r.recent).slice(0,20).map(row=>{const d=node('details',null,'activity');d.append(node('summary',`${new Date(row.at).toLocaleTimeString()} ${row.label}${row.count>1?` ×${row.count}`:''} · ${row.outcome}`));const op=row.operation;if(op?.command||op?.paths?.length||op?.name)d.append(node('pre',op.command??op.paths?.join('\n')??op.name));if(op?.cwd)d.append(node('p','目录 '+op.cwd));if(op?.reason)d.append(node('p','申请理由：'+op.reason));d.append(node('p',`结果：${row.outcome}${row.reason&&row.reason!==row.outcome?' · '+row.reason:''}`));return d;}));
  } else if(tab==='项目') {
    const r=await api(`sessions/${id}/context`);
    for(const file of r.files) { const d=node('details');d.append(node('summary',file.path));if(file.editable){const input=node('textarea');input.value=file.text;input.rows=12;d.append(input,button('保存规则',async()=>{await api(`sessions/${id}/context`,'POST',{path:file.path,text:input.value});$('banner').textContent='规则已保存，下次成员加载项目上下文时生效';}));}else d.append(rich(file.text));content.append(d); }
  }
  if(valid()){panel.replaceChildren(content);if(readingTab===tab)readTab();renderTabs();}
}
function updateMemberAction(card, member) {
  const status=state.sessions.find(s=>s.id===selected)?.status;
  const activity=memberActivity(view,member,Date.now(),status!=='未加载' && status!=='已停止');
  if(card.children[1].textContent!==activity.text) card.children[1].textContent=activity.text;
  card.children[1].title=activity.title || activity.text;
}
// One page-wide clock: touch only existing text nodes, never render or fetch.
setInterval(() => {
  if (!view || loadingView) return;
  for (const card of $('members').children) {
    const member=view.members[card.dataset.member];
    if(member) updateMemberAction(card,member);
  }
}, 1000);
for(const name of ['白板','私信','改动','未回复','项目','权限','记录']) { const b=button(name,()=>tab===name && !panelCollapsed?collapsePanel():openTab(name));b.dataset.tab=name;$('tabs').append(b); }
function showRight() { document.body.classList.remove('hide-right');document.body.classList.add('show-right'); }
$('network-toggle').onclick=async()=>{await api(`sessions/${selected}/permissions`,'POST',{action:'network',enabled:!(view?.networkAccess ?? true)});panelDirty=true;await syncEvents();renderHead();};
$('open-changes').onclick=()=>{showRight();void openTab('改动').catch(showError);};
$('toggle-right').onclick=()=>{document.body.classList.toggle('hide-right');document.body.classList.toggle('show-right');};
$('close-right').onclick=()=>{document.body.classList.add('hide-right');document.body.classList.remove('show-right');};
$('toggle-left').onclick=()=>document.body.classList.toggle('show-left');
$('add-project').onclick = async () => { try { const path = window.desktop ? await window.desktop.chooseFolder() : prompt('输入项目的完整路径'); if (path) { await api('projects','POST',{path}); await refresh(); } } catch(e) { showError(e); } };
function teamRow(member) {
  const row = node('div',null,'member-row'); row.dataset.role = member.role;
  const role=node('select');role.dataset.field='role';role.setAttribute('aria-label','角色');for(const [value,label] of [['lead','负责人'],['worker','成员']]){const o=node('option',label);o.value=value;role.append(o);}role.value=member.role;role.onchange=()=>{row.dataset.role=role.value;};row.append(role);
  const harness = node('select'), model = node('select'), custom = node('input'), effort = node('select'), name = node('input'); name.placeholder = '成员名（可空）'; name.setAttribute('aria-label','成员名'); harness.setAttribute('aria-label','运行工具');model.setAttribute('aria-label','模型');effort.setAttribute('aria-label','推理强度'); name.value = member.name ?? ''; name.dataset.field = 'name';
  for (const h of ['claude','codex','dsh']) { const o = node('option',h); o.value=h; harness.append(o); } harness.value=member.harness; harness.dataset.field='harness'; model.dataset.field='model'; custom.dataset.field='model'; effort.dataset.field='effort'; custom.placeholder='输入模型 ID';
  const entries = () => state.models[harness.value]?.models ?? [];
  const currentModel = () => model.value || custom.value.trim();
  function strengths() { const old = effort.value, choice = effortChoices(entries(),currentModel(),harness.value); effort.replaceChildren(); for (const value of choice.levels) { const o = node('option',({low:'低',medium:'中',high:'高',xhigh:'更高',max:'最高',ultra:'极高'}[value] ?? value) || '默认'); o.value=value; effort.append(o); } effort.value = old && choice.levels.includes(old) ? old : choice.initial; effort.disabled=!effort.options.length; }
  function toggleCustom() { const typing = model.value === ''; custom.hidden=!typing; custom.disabled=!typing; custom.required=typing; }
  function fill(current) {
    model.replaceChildren();
    for (const m of entries()) { const o=node('option',m.available ? m.label : `${m.label} - ${m.note ?? '不可用'}`); o.value=m.id; o.disabled=!m.available; if (m.description) o.title=m.description; model.append(o); }
    // DSH runs only what the platform has wired in, so a typed ID could never work there.
    if (harness.value !== 'dsh') { const o=node('option','手动输入模型 ID…'); o.value=''; model.append(o); }
    const choice=modelSelection(entries(),current); model.value=choice.selected; custom.value=choice.custom; toggleCustom(); strengths();
  }
  harness.onchange=()=>fill(); model.onchange=()=>{toggleCustom();strengths();}; custom.oninput=strengths;
  fill(member.model); if(member.effort && [...effort.options].some(o => o.value===member.effort)) effort.value=member.effort;
  const permission=node('select');permission.dataset.field='permission';permission.setAttribute('aria-label','权限');for(const [value,label] of Object.entries(permissionLabels)){const o=node('option',label);o.value=value;permission.append(o);}permission.value=member.permission ?? 'safe-write';
  row.append(harness,model,custom,effort,name,permission); row.append(button('移除',()=>row.remove())); $('team').append(row);
}
function readTeam() { return [...$('team').children].map(row=>{ const m={role:row.dataset.role}; for(const e of row.querySelectorAll('[data-field]')) if(e.value && !e.disabled) m[e.dataset.field]=e.value; return m; }); }
function renderScanStatus() { const s=scanStatus(state.models); $('models-status').textContent=(s.scanned?`模型列表更新于 ${new Date(s.scanned).toLocaleString()}`:'模型列表尚未扫描，暂用内置列表')+(s.errors.length?`。扫描失败：${s.errors.join('；')}`:''); }
function renderMode() { const p=newProject; $('mode').options[1].disabled=!p.git; if(!p.git && $('mode').value==='worktree') $('mode').value='shared'; $('mode-help').textContent='共用目录共享改动；工作树隔离各成员的分支和改动，只包含已提交的文件。'+(!p.git?'此项目不是 Git 仓库，工作树和自动快照都不可用。':''); $('git-init').hidden=p.git; }
// Runs only on a click, after saying exactly what it will do.
async function initGit(project) {
  const stats = await api(`projects/${project.id}/git-stats`);
  if (!confirm(`在这个文件夹初始化 Git？
${project.path}
共 ${stats.files} 个文件，${(stats.bytes / 1024 ** 2).toFixed(1)} MB。
将当前状态提交，逐字节保存，不修改工作文件。
排除规则：${stats.excludes.join('、')}
单文件超过 100MB 以后无法推送 GitHub（当前 ${stats.largeFiles} 个）。`)) return false;
  $('banner').textContent = 'Git 初始化进行中，请稍候…';
  const result = await api(`projects/${project.id}/git-init`,'POST');
  $('banner').textContent = '初始提交已完成。排除文件：' + (`${result.excluded.length} 个：${result.excluded.slice(0, 30).join('、') || '无'}${result.excluded.length > 30 ? '…（只列前30个）' : ''}；其他既有忽略项 ${result.previouslyIgnored.length} 个`);
  await refresh(); return true;
}
function openNew(project) { newProject=project; $('project-path').textContent=project.path; $('team').replaceChildren(); let team=defaults; try { const saved=JSON.parse(localStorage.getItem('agents-team')); if(Array.isArray(saved)&&saved.length&&saved.every(m=>state.models[m.harness])) team=saved; } catch {} team.forEach(teamRow); $('mode').value='shared'; renderMode(); renderScanStatus(); $('form-error').textContent=''; $('new-session').showModal(); }
$('add-worker').onclick=()=>teamRow({harness:'codex',model:'gpt-6-luna',role:'worker',effort:'medium'});
$('cancel-new').onclick=()=>$('new-session').close();
$('models-refresh').onclick=async()=>{ const b=$('models-refresh'), team=readTeam(); b.disabled=true; $('models-status').textContent='正在扫描可用模型，大约需要半分钟…'; try { await api('models/scan','POST'); await refresh(); $('team').replaceChildren(); team.forEach(teamRow); renderScanStatus(); } catch(e) { $('form-error').textContent=e.message; } finally { b.disabled=false; } };
$('git-init').onclick=async()=>{ try { if(await initGit(newProject)) { newProject=state.projects.find(p=>p.id===newProject.id)??newProject; renderMode(); } } catch(e) { $('form-error').textContent=e.message; } };
$('team-form').onsubmit=async event=>{ event.preventDefault(); const members=readTeam(); if(members.filter(m=>m.harness==='dsh'&&m.model==='local').length>1) { $('form-error').textContent='一个会话最多一个本地 Qwen'; return; } try { const s=await api('sessions','POST',{projectId:newProject.id,mode:$('mode').value,members}); localStorage.setItem('agents-team',JSON.stringify(members)); $('new-session').close(); await refresh(); await select(s.id); } catch(e) { $('form-error').textContent=e.message; } };
$('composer').onsubmit=async e=>{ e.preventDefault(); const text=$('message').value.trim(), id=selected; if(!id||!text)return; try { await api(`sessions/${id}/messages`,'POST',{text}); if(selected===id && $('message').value.trim()===text){$('message').value='';sessionStorage.removeItem('draft:'+id);} } catch(e) { showError(e); } };
$('message').oninput=()=>{if(selected)sessionStorage.setItem('draft:'+selected,$('message').value);};
$('message').onkeydown=e=>{ if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); } };
$('pause').onclick=async()=>{try{const s=state.sessions.find(s=>s.id===selected);await api(`sessions/${selected}/${s.status==='已暂停'?'resume':'pause'}`,'POST');await refresh();}catch(e){showError(e);}};
$('interrupt').onclick=async()=>{try{const lead=Object.values(view.members).find(m=>m.role==='lead');await api(`sessions/${selected}/members/${lead.name}/interrupt`,'POST');}catch(e){showError(e);}};
$('stop').onclick=async()=>{try{if(confirm('停止后不能再继续此会话。想之后继续请用暂停。确定停止？')){await api(`sessions/${selected}/stop`,'POST');await refresh();}}catch(e){showError(e);}};
$('rename').onclick=async()=>{const text=prompt('会话新名称',state.sessions.find(s=>s.id===selected)?.title??'');if(text?.trim()){try{await api(`sessions/${selected}/rename`,'POST',{text});await refresh();}catch(e){showError(e);}}};
function invalidatePanel(sessionId,e) {
  if(sessionId===selected && ((tab==='白板' && e.type==='board') || (tab==='私信' && e.type==='dm') || (tab==='权限' && /^(permission-|network-changed)/.test(e.type)) || (tab==='未回复' && ['reply-pending','reply-cleared','reply-forwarded'].includes(e.type))))panelDirty=true;
}
async function boot() {
  const openedAt=Date.now();
  await refresh();
  let after=Number(sessionStorage.getItem('agents-stream-after')??0);
  source=new EventSource(`/api/stream?token=${encodeURIComponent(auth)}&after=${after}`);
  source.onmessage=message=>{try{
    const f=JSON.parse(message.data); sessionStorage.setItem('agents-stream-after',String(f.seq));
    if(f.sessionId===selected) { if (loadingView) pendingEvents.push(f.event); else reduce(view,f.event); }
    invalidatePanel(f.sessionId,f.event);
    scheduleRender();
    const e=f.event;
    if(shouldAlert(e,openedAt) && (!e.type.startsWith('permission-') || !notifiedPermissions.has(f.sessionId+':'+(e.id ?? e.sequence)))) {
      if(e.type.startsWith('permission-'))notifiedPermissions.add(f.sessionId+':'+(e.id ?? e.sequence));
      showAlert(e);
    }
  }catch(e){showError(e);}};
  source.addEventListener('gap', () => { void syncEvents().catch(showError); scheduleRender(); });
  source.onerror=()=>{$('status').textContent='连接中断，正在重连…';};
}
boot().catch(showError);
