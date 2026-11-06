export function initialState(config = { members: [] }) { return { config, networkAccess: config.networkAccess ?? true, members: Object.fromEntries(config.members.map(m => [m.name, { ...m, state: '空闲', turns: 0, tokens: null, action: '', records: [] }])), messages: [], activities: [], board: [], dms: [], pending: [], status: '未加载', alerts: [] }; }
export function reduce(state, event) {
  apply(state, event);
  while (state.buffer?.has(state.sequence + 1)) {
    const next = state.buffer.get(state.sequence + 1); state.buffer.delete(state.sequence + 1); apply(state, next);
  }
  return state;
}
function apply(state, event) {
  const s = state, e = event;
  if (Number.isSafeInteger(e.sequence)) {
    s.sequence ??= 0; s.buffer ??= new Map();
    if (e.sequence <= s.sequence) return s;
    if (e.sequence > s.sequence + 1) { s.buffer.set(e.sequence, e); return s; }
    s.sequence = e.sequence;
  }
  if (e.type === 'session-start' && !Object.keys(s.members).length && e.config) { const fresh = initialState(e.config); s.config = fresh.config; s.members = fresh.members; }
  const m = s.members[e.member];
  trackMemberRuntime(s, e, m);
  if (e.type === 'tool' && WAIT_TOOL.test(toolName(e))) return s;


  if (e.type === 'message-update') {
    const target = s.messageById?.get(e.messageId);
    if (target) { target.event.text = e.append ? target.event.text + e.text : e.text; if (target.message) target.message.text = target.event.text; }
    else { const row = { ...e, type: m?.role === 'lead' ? 'to-user' : 'member-text' }; s.activities.push(row); s.messageById ??= new Map(); s.messageById.set(e.messageId, { event: row }); }
    return s;
  }
  // Legacy journals have no message IDs; only join fragments within the same turn.
  if (['from-user','session-start'].includes(e.type)) s.legacyMessages = new Map();
  if (['turn-start','wait-resume','turn-end'].includes(e.type)) { s.legacyMessages?.delete('to-user:'+e.member); s.legacyMessages?.delete('member-text:'+e.member); }
  if (['to-user','member-text'].includes(e.type) && !e.messageId) {
    s.legacyMessages ??= new Map(); const key=e.type+':'+e.member, previous=s.legacyMessages.get(key);
    if(previous) { previous.text += '\n\n'+e.text; const msg=s.messages.at(-1);if(e.type==='to-user' && msg?.role==='lead')msg.text=previous.text;return s; }
  }
  const activity = { ...e }; s.activities.push(activity);
  if (['to-user','member-text'].includes(e.type) && !e.messageId) s.legacyMessages.set(e.type+':'+e.member,activity);
  if (e.messageId) { s.messageById ??= new Map(); s.messageById.set(e.messageId, { event: activity }); }
  switch (e.type) {
    case 'permission-changed': if(m)m.permission=e.level; break;
    case 'network-changed': s.networkAccess=e.enabled; break;
    case 'permission-request': s.approvals ??= []; s.approvals.push(e); break;
    case 'permission-result': s.approvals=(s.approvals??[]).filter(p=>p.id!==e.id); break;
    case 'from-user': s.answeredAt = s.activities.length; s.messages.push({ role: 'user', text: e.text, at: e.at }); break;
    case 'to-user': s.messages.push({ role: 'lead', text: e.text, at: e.at }); break;
    case 'session-start': s.status = '空闲'; break;
    case 'member-start': if (m) { m.state = '空闲'; m.error = ''; } break;
    case 'turn-start': if (m) { m.state = '工作中'; m.turns++; m.action = ''; m.error = ''; m.turnUsage = null; if(m.role==='lead')s.leadTurnAt=s.activities.length; } s.status = '运行中'; break;
    case 'wait-start': if (m) { m.state = '等待消息'; m.action = ''; } break;
    case 'wait-resume': if (m) { m.state = '工作中'; m.turns++; m.action = ''; m.error = ''; m.turnUsage = null; if(m.role==='lead')s.leadTurnAt=s.activities.length; } s.status = '运行中'; break;
    case 'wait-cancelled': if (m && m.state === '等待消息') m.state = '工作中'; break;
    case 'usage': if (m) { const total = tokenTotal(e.usage); if (total !== null) m.observedTokens = total; if (typeof e.used === 'number') m.contextTokens = e.used; if (typeof e.size === 'number') m.contextSize = e.size; } break;
    case 'turn-end': if (m) { m.state = e.parked ? '等待消息' : e.status === 'quota' ? '暂停' : e.status === 'failed' ? '失败' : '空闲'; const total = tokenTotal(e.usage); if (total !== null) m.tokens = (m.tokens ?? 0) + total; if (e.error) m.error = e.error; } break;
    case 'tool': break;
    case 'board': s.board.push(e); break;
    case 'dm': s.dms.push(e); break;
    case 'reply-pending': s.pending.push(e); break;
    case 'reply-cleared': case 'reply-forwarded': s.pending = s.pending.filter(p => !(p.id === e.id && p.recipient === e.recipient)); break;
    case 'settled': s.status = '空闲'; break;
    case 'paused': s.status = '已暂停'; break;
    case 'resumed': s.status = '运行中'; break;
    case 'stopped': s.status = '已停止'; break;
    case 'quota': case 'lead-paused': case 'member-failed': case 'session-error': s.alerts.push(e); if (e.type === 'member-failed' && m) { m.state = '失败'; m.error = e.error ?? '原因未提供'; } if (e.type === 'session-error') s.status = '错误'; break;
    case 'member-interrupted': if (m) m.state = '空闲'; break;
    default: break;
  }

  if (e.messageId && ['from-user','to-user'].includes(e.type)) s.messageById.get(e.messageId).message = s.messages.at(-1);
  return s;
}
// Model choices. Pure, so the form's logic can be tested without a DOM.
export function findModel(entries, id) {
  if (!id) return undefined;
  const exact = entries.find(m => m.id === id); if (exact) return exact;
  // A team saved earlier may hold a full ID like claude-haiku-5-5, which the catalog lists as Haiku 5.5.
  const full = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  return full ? entries.find(m => String(m.label).toLowerCase() === `${full[1]} ${full[2]}.${full[3]}`) : undefined;
}
export function effortsFor(entries, id) {
  const known = findModel(entries, id);
  return known ? known.efforts : [...new Set(entries.flatMap(m => m.efforts))];
}
// What the effort box starts on: the model's own default if it has one. A route with no default of its
// own gets an empty choice, shown as 默认, meaning leave it to the provider.
export function effortChoices(entries, id, harness) {
  const known = findModel(entries, id), levels = effortsFor(entries, id);
  const providerDefault = harness === 'dsh' && !known?.defaultEffort && levels.length > 0;
  return { levels: providerDefault ? ['', ...levels] : levels, initial: known?.defaultEffort ?? (providerDefault ? '' : levels[0] ?? '') };
}
export function modelSelection(entries, current) {
  const known = findModel(entries, current);
  if (known?.available) return { selected: known.id, custom: '' };
  if (current && !known) return { selected: '', custom: current };
  return { selected: entries.find(m => m.available)?.id ?? '', custom: '' };
}
export function scanStatus(catalog) {
  const times = Object.values(catalog ?? {}).map(c => c.scannedAt).filter(Boolean).sort();
  const errors = Object.entries(catalog ?? {}).filter(([, c]) => c.error).map(([h, c]) => `${h}：${c.error}`);
  return { scanned: times.length ? times.at(-1) : null, errors };
}
const INTERNAL = new Set(['wake','inbox','checkpoint','codex-archive','codex-unarchive','permission-request','permission-result','permission-changed','permission-grant','permission-revoked','permission-denied','permission-explanation','network-changed','queued', 'adapter', 'usage', 'rate-limits', 'quota', 'snapshot', 'settled', 'tool-call', 'message-created', 'member-start', 'session-start', 'reply-cleared', 'demo-steer', 'project-context', 'message-update']);
const COLLABORATION_TOOL = /post_board|message_teammate|read_board|wait_for_messages|interrupt_teammate/;
const TOOL_KINDS = { commandExecution: '运行命令', fileChange: '修改文件', mcpToolCall: '调用工具', dynamicToolCall: '调用工具' };
export function toolName(e) { return String(e.title ?? TOOL_KINDS[e.kind] ?? e.kind ?? '工具').replace(/^mcp__agents__/, ''); }
const WAIT_TOOL = /(?:^|[_.:/])wait_for_messages$/;
const FINISHED_TOOL = new Set(['completed', 'failed', 'cancelled', 'canceled', 'interrupted']);
function startWaiting(m, at) {
  m.waitSince ??= at;
  m.state = '等待消息';
}
function clearRuntime(m) { m.activeTools = new Map(); m.waitSince = undefined; m.action = ''; }
function mentionedMembers(text, names) {
  const result=new Set(), longest=[...names].sort((a,b)=>b.length-a.length);
  let fence='';
  for(const line of String(text ?? '').split('\n')) {
    const marker=/^\s*(`{3,}|~{3,})/.exec(line);
    if(marker) { if(!fence) fence=marker[1][0];else if(fence===marker[1][0]) fence='';continue; }
    if(fence || /^\s*>/.test(line)) continue;
    const clean=line.replace(/(`+)[\s\S]*?\1/g,'');
    for(const match of clean.matchAll(/(?<![\p{Script=Latin}\p{N}_@.-])@/gu)) {
      const rest=clean.slice(match.index+1), name=longest.find(n=>rest.startsWith(n));
      if(!name) continue;
      const tail=rest.slice(name.length);
      if(/[\p{Script=Latin}\p{N}_-]$/u.test(name) && /^(?:[\p{Script=Latin}\p{N}_-]|\.[\p{Script=Latin}\p{N}_-])/u.test(tail)) continue;
      result.add(name);
    }
  }
  return result;
}
function trackMemberRuntime(s, e, m) {
  // Directed requests only: a member speaking somewhere else is not an answer.
  s.waitingRequests ??= new Map();
  const request = (author, target, id, mention = false) => {
    if (author !== target && s.members[author] && s.members[target]) s.waitingRequests.set(`${id}:${author}:${target}`, {author, target, id, mention});
  };
  const answer = (author, target) => { for (const [key, r] of s.waitingRequests) if (r.author === target && r.target === author) s.waitingRequests.delete(key); };
  if (e.type === 'reply-pending') request(e.requester, e.recipient, e.id);
  if (['reply-cleared','reply-forwarded'].includes(e.type)) for (const [key,r] of s.waitingRequests) if (r.id === e.id && r.target === e.recipient) s.waitingRequests.delete(key);
  if (['board','dm'].includes(e.type)) {
    const direct = new Set([...(Array.isArray(e.ask) ? e.ask : []), ...(e.type === 'dm' ? [e.recipient] : [])]);
    const targets = new Set([...direct, ...mentionedMembers(e.text, Object.keys(s.members))]);
    for (const target of targets) {
      answer(e.author, target);
      if (e.type === 'board' || e.reply || e.reply_requested) request(e.author, target, e.id, !direct.has(target));
    }
  }
  if (e.type === 'session-start' || e.type === 'stopped') for (const member of Object.values(s.members)) clearRuntime(member);
  if (!m) return;
  // A mention only asks for a reply if the platform said so; once that member's turn is over, nobody is still waiting on it.
  if (e.type === 'turn-end' && !e.parked) for (const [key, r] of s.waitingRequests) if (r.mention && r.target === m.name) s.waitingRequests.delete(key);
  if (['member-start','turn-start','wait-resume','turn-end','member-failed','member-interrupted'].includes(e.type)) {
    const since = m.waitSince; clearRuntime(m);
    if (e.type === 'turn-end' && e.parked) m.waitSince = since ?? e.at;
  }
  if (e.type === 'wait-cancelled') m.waitSince = undefined;
  if (e.type === 'wait-start') startWaiting(m, e.at);
  if (e.type === 'tool-call' && WAIT_TOOL.test(String(e.tool))) startWaiting(m, e.at);
  if (e.type !== 'tool') return;
  if (WAIT_TOOL.test(toolName(e))) {
    if (!FINISHED_TOOL.has(e.status)) startWaiting(m, e.at);
    return;
  }
  m.activeTools ??= new Map();
  const key = e.id ?? '__anonymous';
  if (FINISHED_TOOL.has(e.status)) { m.activeTools.delete(key); return; }
  if (m.state !== '工作中') return; // Late updates must not resurrect a finished turn.
  const old = m.activeTools.get(key);
  m.activeTools.set(key, { ...old, ...e, at: old?.at ?? e.at });
}
// Strip shell plumbing for the card; the original command remains its tooltip.
export function commandSummary(command) {
  // Codex reports the whole shell invocation: "C:\Program Files\PowerShell\7\pwsh.exe" -Command "...".
  const unwrapped = String(command).trim().replace(/^(?:"[^"]*?(?:pwsh|powershell|cmd|bash)(?:\.exe)?"|\S*?(?:pwsh|powershell|cmd|bash)(?:\.exe)?)(?:\s+-(?!Command\b|c\b|lc\b)\S+)*\s+(?:-Command|-c|-lc|\/c)\s+['"]?/i, '');
  const cleaned = unwrapped.replace(/\[Console\]::(?:OutputEncoding|InputEncoding)\s*=\s*[^;\n]+[;\n]?/gi, '').replace(/\$env:\w+\s*=\s*[^;\n]*[;\n]/gi, '').trim();
  // A script piped in through a here-string says nothing in its first line; the record has it all.
  if (/^@['"]\s/.test(cleaned)) return `内联脚本（${cleaned.split('\n').length - 2} 行）`;
  const head = cleaned.split(/\|(?!\|)/)[0].trim();
  const script = head.match(/(?:^|[\s"'\\/])([^\s"'\\/]+\.(?:py|mjs|cjs|js|ps1|sh|bat|cmd))(?=[\s"']|$)/i);
  const result = script?.[1] ?? head ?? cleaned;
  return (result || String(command)).replace(/\s+/g,' ').replace(/^(.*?)["']$/, (all, rest) => (all.match(/["']/g).length % 2 ? rest : all)).slice(0, 100);
}
// What a tool call did, in one line: a person cannot tell one "run command" from the next.
export function toolLine(e) {
  if (typeof e.command === 'string' && e.command) return `运行 ${commandSummary(e.command)}`;
  if (e.paths?.length) return `修改 ${String(e.paths[0]).split(/[\\/]/).pop()}${e.paths.length > 1 ? ` 等 ${e.paths.length} 个文件` : ''}`;
  return toolName(e);
}
const LEVELS = { 'read-only': '只读', 'safe-write': '安全读写', 'full-write': '全面读写' };
const DECISIONS = { once: '已允许这一次', session: '已允许（本会话相同命令）', reject: '已拒绝' };
export function operationSummary(op) { return op?.command ? commandSummary(op.command) : op?.paths?.length ? op.paths.join(', ') : op?.name ?? op?.reason ?? '权限申请'; }
function decisionLabel(e) { return DECISIONS[e.decision] ?? e.reason ?? (e.allowed ? '已允许' : '未允许'); }
// One row per request, newest first, with the outcome on it; identical rows collapse into a count.
export function permissionHistory(events) {
  const rows = [], requests = new Map();
  for (const e of events) {
    if (e.type === 'permission-request') { const row = { at: e.at, member: e.member, operation: e.operation, outcome: '等你批准', label: `${e.member} · ${operationSummary(e.operation)}` }; requests.set(e.id, row); rows.push(row); }
    else if (e.type === 'permission-result') { const row = requests.get(e.id); if (row) { row.outcome = decisionLabel(e); row.reason = e.reason; } else rows.push({ at: e.at, member: e.member, outcome: decisionLabel(e), reason: e.reason, label: `${e.member} 的申请` }); }
    else if (e.type === 'permission-denied') rows.push({ at: e.at, member: e.member, operation: e.operation, outcome: '平台规则拒绝', reason: e.reason, label: `${e.member} · ${operationSummary(e.operation)}` });
    else if (e.type === 'permission-changed') rows.push({ at: e.at, member: e.member, outcome: e.byUser ? '你改的' : '负责人改的', label: `${e.member} 权限改为 ${LEVELS[e.level] ?? e.level}` });
    else if (e.type === 'permission-revoked') rows.push({ at: e.at, outcome: '已撤销', label: '撤销了一条本会话授权' });
  }
  const merged = [];
  for (const row of rows) {
    const last = merged.at(-1), same = last && last.label === row.label && last.outcome === row.outcome && last.operation?.command === row.operation?.command;
    if (same) { last.count = (last.count ?? 1) + 1; last.at = row.at; } else merged.push(row);
  }
  return merged.reverse();
}
export function memberActivity(s, m, now = Date.now(), runtimeAvailable = true) {
  if(s.approvals?.some(p=>p.member===m.name))return {text:'等用户批准权限',title:'只有用户能批准，负责人不能代批'};
  if (m.error) return {text:m.error, title:m.error};
  if (!runtimeAvailable) return {text:'历史会话，当前未运行', title:''};
  const elapsed = (at, verb) => { const start = Date.parse(at); return Number.isFinite(start) ? ` · ${verb} ${Math.max(0,Math.floor((now-start)/60000))} 分钟` : ''; };
  const tools = m.state === '工作中' ? [...(m.activeTools?.values() ?? [])].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)) : [];
  if (tools.length) {
    const first=tools[0], command=typeof first.command === 'string' ? first.command : '';
    return {text:`正在运行 ${command ? commandSummary(command) : toolName(first)}${elapsed(first.at,'已运行')}${tools.length>1?` · 还有 ${tools.length-1} 个工具`:''}`, title:command || toolName(first)};
  }
  if (m.state === '等待消息') {
    const targets=[...new Set([...(s.waitingRequests?.values() ?? [])].filter(r=>r.author===m.name).map(r=>r.target))];
    return {text:`${targets.length?'在等'+targets.join('、'):'等待消息'}${elapsed(m.waitSince,'已等')}`, title:''};
  }
  return {text:m.action || (m.state === '工作中' ? '思考中' : '待命'), title:''};
}
// What the conversation shows: one line per tool call, none for collaboration tools (their
// board and message lines say the same), and none for the platform's own bookkeeping.
export function visibleActivities(activities) {
  const result = [], tools = new Map();
  for (const e of activities) {
    if (INTERNAL.has(e.type) && !(e.type === 'snapshot' && (e.error || e.limited))) continue;
    if (e.type !== 'tool') { result.push(e); continue; }
    if (COLLABORATION_TOOL.test(toolName(e))) continue;
    const key = e.member + ':' + e.id;
    if (e.id && tools.has(key)) { const i = tools.get(key); result[i] = { ...result[i], ...e }; }
    else { if (e.id) tools.set(key, result.length); result.push(e); }
  }
  return result;
}
export function activityLabel(e) { return ({ board: `${e.author} 发到白板`, dm: `→ 已派给 ${e.recipient}`, 'reply-forwarded': `${e.recipient} 的回复已转给负责人`, 'reply-pending': `${e.recipient} 需要回复`, 'turn-start': `${e.member} 开始工作`, 'turn-end': `${e.member} 完成一轮`, inbox: `${e.member} 收到通知（下次醒来时看到）`, snapshot: `${e.member ?? '平台'} 的快照${e.error ? '失败' : '不完整'}`, tool: `${e.member} · ${toolLine(e)}`, 'permission-request': `${e.member} 申请：${operationSummary(e.operation)}`, 'permission-result': `${e.member} 的申请：${decisionLabel(e)}`, 'permission-grant': `${e.member} 本会话允许：${e.command ? commandSummary(e.command) : ''}`, 'permission-denied': `${e.member} 被规则拒绝：${operationSummary(e.operation)}`, 'permission-changed': `${e.member} 权限改为 ${LEVELS[e.level] ?? e.level}`, 'permission-revoked': '撤销了一条本会话授权', 'permission-explanation': `${e.member ?? '平台'} 的操作未获允许`, 'wait-parked': `${e.member} 继续等待（已结束 turn，不占用额度）`, 'wait-cancelled': `${e.member} 不再等待`, 'steer-redelivered': `已把可能错过的插话重新交给 ${e.member}`, 'member-failed': `${e.member} 失败`, 'member-interrupted': `${e.member} 被打断`, guard: '已达到轮数上限', paused: '已暂停', resumed: '已继续', stopped: '已停止', 'board-tampered': '有人直接改了白板文件，已恢复', 'protocol-warning': `${e.member ?? '平台'} 的消息格式有误`, 'wait-start': `${e.member} 开始等待消息`, 'wait-resume': `${e.member} 收到消息，继续工作`, 'spin-warning': `${e.member} 试图空等，已提醒`, queued: `消息已排队给 ${e.member}`, 'demo-steer': '已收到插话' })[e.type] ?? `${e.member ?? '平台'} · ${e.type}`; }

// Member histories use the same logical-message semantics as the conversation.
const RECORD_NOISE = new Set(['usage', 'rate-limits', 'tool-call', 'message-created', 'adapter', 'project-context', 'codex-archive', 'codex-unarchive', 'wake', 'member-start']);
export function coalesceRecords(events) {
  const rows = [], messages = new Map(), tools = new Map(); let legacy = new Map();
  for (const e of events) {
    // Meters and bookkeeping are not a member's history, and they outnumber everything else in it.
    if (RECORD_NOISE.has(e.type) || (e.type === 'snapshot' && !e.error && !e.limited)) continue;
    if (e.type === 'tool') {
      // Each status change of a call arrives as its own event; a blocking wait even repeats on a timer.
      if (WAIT_TOOL.test(toolName(e))) continue;
      const known = e.id && tools.get(e.member + ':' + e.id);
      if (known) { Object.assign(known, e); continue; }
      const row = { ...e }; rows.push(row); if (e.id) tools.set(e.member + ':' + e.id, row); continue;
    }
    if (['from-user','session-start'].includes(e.type)) legacy = new Map();
    if (['turn-start','wait-resume','turn-end'].includes(e.type)) { legacy.delete('to-user:'+e.member);legacy.delete('member-text:'+e.member); }
    const key=e.type+':'+e.member;
    if (!e.messageId && ['to-user','member-text'].includes(e.type) && legacy.has(key)) { legacy.get(key).text += '\n\n'+e.text; continue; }
    if (e.type === 'message-update') {
      const row = messages.get(e.messageId); if (row) row.text = e.append ? row.text + e.text : e.text; else { const first = { ...e, type: 'member-text' }; rows.push(first); messages.set(e.messageId, first); }
    } else {
      const row = { ...e }; rows.push(row); if (e.messageId) messages.set(e.messageId, row); else if (['to-user','member-text'].includes(e.type)) legacy.set(key,row);
    }
  }
  return rows;
}

// Explicit totals avoid counting cached/reasoning subsets twice.
export function tokenTotal(usage) {
  if (!usage) return null;
  const value = usage.totalTokens ?? usage.total_tokens;
  if (Number.isFinite(value)) return value;
  const input = usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens;
  const output = usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens;
  return Number.isFinite(input) || Number.isFinite(output) ? (input ?? 0) + (output ?? 0) : null;
}
export function attention(s) {
  if(s.approvals?.length)return {waiting:true,text:s.approvals.map(p=>p.member+' · '+(p.operation.command || p.operation.paths?.join(', ') || p.operation.reason || '权限申请')).join('\n'),label:'等你批准权限'};
  const lead = Object.values(s.members).find(m => m.role === 'lead');
  const last = [...s.activities].reverse().find(e => e.type === 'to-user');
  const unanswered = last && s.activities.indexOf(last) >= Math.max(s.answeredAt ?? 0,s.leadTurnAt ?? 0);
  const busy = Object.values(s.members).some(m => m.state === '工作中');
  const question = asksUser(last?.text ?? '');
  const waiting = !!unanswered && lead?.state !== '工作中' && lead?.state !== '失败' && (question || (!busy && !s.pending.length));
  return { waiting, text: waiting ? last.text : '', label: waiting ? (question ? '等你回答（根据负责人发言）' : '等你回复') : busy ? '团队工作中' : s.pending.length ? '等待队友回复' : '等待消息，等待对象未确认' };
}

export function asksUser(text) {
  const prose=String(text).replace(/```[\s\S]*?(?:```|$)/g,'').replace(/`[^`]*`/g,'').split('\n').filter(line=>!/^\s*>|^ {4}/.test(line)).join('\n');
  return /[?？]\s*$|请(?:你|您)?(?:确认|选择|回复)|需要(?:你|您)(?:确认|选择|回复)/m.test(prose);
}
// A new window's stream replays the whole log. Old failures are history, shown in the record, and must
// not pop a desktop notification each time the app opens.
export function shouldAlert(e, openedAt) {
  const alerting = e.type === 'permission-request' || (e.type === 'permission-changed' && e.byUser === false && e.raised) || (e.type === 'quota-notice' && e.user) || ['quota', 'lead-paused', 'member-failed', 'session-error'].includes(e.type) || (e.type === 'snapshot' && (e.error || e.limited));
  return Boolean(alerting) && Date.parse(e.at) >= openedAt;
}
