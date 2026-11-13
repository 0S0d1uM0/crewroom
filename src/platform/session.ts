import { PermissionManager } from './permission-manager.js';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { parseConfig, type MemberConfig, type PlatformConfig } from './config.js';
import { ProtocolParser, mentions, type Action } from './protocol.js';
import { SessionStorage, git, isGit, snapshot, releaseSnapshots } from './storage.js';
import { ToolServer } from './tool-server.js';
import { collaborationTools } from './tools.js';
import { notesInstruction, projectContext } from './project-context.js';
import type { HarnessAdapter, PlatformEvent, ToolResult, TurnResult, Usage } from './types.js';

// A member inside wait_for_messages has a waiter: its turn is open, but its output has ended.
type WakeReason = 'user' | 'ask' | 'reply' | 'lead' | 'platform' | 'quiet' | 'checkpoint';
interface Member { config: MemberConfig; workspace: string; adapter: HarnessAdapter; parser: ProtocolParser; state: 'idle' | 'busy' | 'paused'; queue: string[]; wakeReasons: WakeReason[]; inbox: { id: string; text: string; order: number }[]; turns: number; usage: Usage; measuredTurns: number; failed: boolean; lastText: string; outputId?: string; waiter?: (text: string) => void; boardCursor: number; lastToolAt: number; steered: { at: number; text: string; reason?: WakeReason | null; source: string; order: number }[]; deliveredBoard: Set<string>; parkTimer?: NodeJS.Timeout; parked: boolean; toldLead: boolean }
interface BoardEntry { id: string; author: string; text: string; at: string }
const MAX_BOARD_READ = 100_000;
const INBOX_RECEIPT = '已入收件箱，对方下次被唤醒时看到；需要对方立刻响应请设 reply_requested（白板用 ask）';
const QUIET = 'Nobody is working and no message is on the way.';
// Workers can talk for an hour without the lead, because their messages wake only each other. Counting
// messages rather than time means an idle team costs nothing.
const CHECKPOINT_MESSAGES = 12;
const LEAD_RULES = '\nSCOPE: you decide what gets done, how far, and by whom. Before work starts, post one work order on the board: the goal, what counts as done, what this round leaves out, who does what, and which milestones get reviewed. A small single question needs only one line. Give the bulk of the work to the cheapest suitable members, and have reviewers check milestones rather than every step. When anyone proposes new work or a new requirement, check it against the work order first, including when it arrives as a technical question. If it is outside the order, ask the user when it changes what the user gets or adds substantial work; otherwise record it as a known limitation. Tell the user when scope changes. When the done line is reached, stop the work and report, even if improvements remain. The platform sends you a checkpoint when teammates have exchanged many messages: use it to check they are still inside the order.';
const WORKER_RULES = '\nSCOPE: work from the lead\'s work order. If you find new work or a new requirement, report it to the lead with a reply request and do not start it. A review finding blocks only if it breaks what the work order counts as done; record any other finding as a known limitation and do not ask for a fix. One delivery gets at most two rounds of blocking review; after that, send the lead a summary of what remains and let the lead decide.';
const COLLABORATION_TOOL = /post_board|message_teammate|read_board|wait_for_messages|interrupt_teammate/;
export interface PendingReply { id: string; requester: string; recipient: string }
export type AdapterFactory = (member: MemberConfig, workspace: string, sessionDir: string) => HarnessAdapter;

// A normalized quota reading says no more turns can run before a window resets.
export function quotaExhausted(known: any): boolean {
  const pending = (w: any) => !w.resetsAt || Date.parse(w.resetsAt) > Date.now();
  return Boolean((known?.ordinaryUsageAllowed === false && (!known.windows?.length || known.windows.some(pending)))
    || known?.windows?.some((w: any) => (w.usedPercent >= 100 || w.status === 'rejected') && pending(w)));
}


export class PlatformSession {
  readonly permissions: PermissionManager;
  knownQuota = new Map<string, any>();
  // Called after a new reading. Members paused for quota on that harness go back to work once the
  // reading allows it; nothing else would wake them, since quota polling never reaches them otherwise.
  quotaChanged(harness: string) {
    if (this.stopped || quotaExhausted(this.knownQuota.get(harness))) return;
    for (const m of this.members.values()) {
      if (m.config.harness !== harness || m.state !== 'paused') continue;
      m.state = 'idle'; this.storage.event('quota-resumed', { member: m.config.name });
    }
    this.schedule();
  }
  notifyLead(text: string) {
    const lead = this.members.get(this.lead)!;
    if (this.stopped || lead.state === 'paused' || this.knownQuota.get(lead.config.harness)?.exhausted) return;
    this.enqueue(lead, '[platform] ' + text);
  }
  readonly config: PlatformConfig;
  readonly id: string;
  paused = false;
  readonly dir: string;
  readonly storage: SessionStorage;
  readonly members = new Map<string, Member>();
  readonly pending: PendingReply[] = [];
  private lead: string;
  private started = false;
  private ready = false;
  private stopped = false;
  private stopTask?: Promise<void>;
  private scheduled = false;
  private routing = 0;
  private totalTurns = 0;
  private boardId = 0;
  private messageId = 0;
  private deliveryOrder = 0;
  private workerFinished = false;
  private guarded = false;
  private settled = false;
  private waiters: (() => void)[] = [];
  private tasks = new Set<Promise<unknown>>();
  private snapshotTasks = new Set<Promise<unknown>>();
  // Reply requests the recipient has actually received, and so could have answered.
  private seenRequests = new Set<string>();
  private toolServer = new ToolServer();
  private boardLog: BoardEntry[] = [];
  // How often the lead has been told that nothing is happening. It is told twice at most, and then
  // waiting blocks, so a lead that keeps calling wait_for_messages cannot spin on the notice.
  private quietNotices = 0;
  // One line per teammate message since the last checkpoint.
  private teamTalk: string[] = [];

  constructor(input: unknown, private factory: AdapterFactory, onEvent: (event: PlatformEvent) => void = () => {}, private recovery?: { id: string; events: PlatformEvent[]; harnessIds: Record<string, string> }) {
    this.id = recovery?.id ?? randomUUID();
    this.config = parseConfig(input);
    this.lead = this.config.members.find(m => m.role === 'lead')!.name;
    this.dir = join(this.config.sessionRoot ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Crewroom', 'sessions'), this.id);
    this.storage = new SessionStorage(this.dir, onEvent);
    this.permissions = new PermissionManager(this.config, (type, data) => {
      this.storage.event(type, data);
      // The user is told directly by the app. Waking the lead for this only made it repeat the request.
      if (type === 'permission-request' && data.member !== this.lead && this.members.size) this.storeInbox(this.members.get(this.lead)!, `[platform] ${data.member} 申请了权限，用户已直接收到提示。负责人不能代批，也不用转告用户。`, `permission-${data.id}`);
    }, recovery?.events);
  }
  async start() {
    if (this.started || this.stopped) throw new Error('Session already started or stopped');
    this.started = true;
    const names = this.config.members.map(m => m.name);
    try {
      await this.toolServer.start();
      if (this.config.mode === 'worktree' && !isGit(this.config.workspace)) throw new Error('worktree mode requires a Git repository');
      for (const config of this.config.members) {
        let workspace = this.config.workspace;
        if (this.config.mode === 'worktree') {
          workspace = join(this.dir, 'worktrees', config.name); mkdirSync(join(this.dir, 'worktrees'), { recursive: true });
          if (this.recovery) { if (!existsSync(workspace) || !isGit(workspace)) throw new Error(`Worktree is missing: ${workspace}`); }
          else git(this.config.workspace, ['worktree', 'add', '-b', `agents/${this.id}/${config.name}`, workspace]);
        }
        const adapter = this.factory(config, workspace, this.dir);
        const member: Member = { config, workspace, adapter, parser: new ProtocolParser(names), state: 'idle', queue: [], wakeReasons: [], inbox: [], turns: 0, usage: {}, measuredTurns: 0, failed: false, lastText: '', boardCursor: 0, lastToolAt: 0, steered: [], deliveredBoard: new Set(), parked: false, toldLead: false };
        this.members.set(config.name, member);
        const host = { definitions: collaborationTools(config.name, names, config.role === 'lead'), call: async (name: string, args: unknown, signal?: AbortSignal) => this.toolCall(member, name, args, signal) };
        adapter.permission = { level: () => this.permissions.level(config.name), online: () => this.config.networkAccess,
          request: (operation, signal) => this.paused || this.stopped ? Promise.resolve({ allowed: false, reason: '会话暂停或停止，请恢复后重新申请' }) : this.permissions.request(config.name, operation, signal) };
        adapter.tools = { ...host, authorize: adapter.permission.request, endpoint: this.toolServer.register(config.name, { ...host, authorize: adapter.permission.request }) };
        this.storage.seedBoard(config.name);
        adapter.onMessage = text => { if (!this.stopped) this.actions(member, member.parser.message(text)); };
        adapter.onEvent = event => {
          if ((this.stopped && event.type !== 'codex-archive') || /thought|reason/i.test(event.type)) return;
          if (event.type === 'tool' && !/wait_for_messages/.test(String(event.title))) member.lastToolAt = Date.now();
          if (event.type === 'tool' && !COLLABORATION_TOOL.test(String(event.title))) member.toldLead = false;
          this.storage.event(['quota', 'tool', 'usage', 'rate-limits', 'protocol-warning', 'demo-steer', 'codex-archive', 'codex-unarchive', 'harness-id'].includes(event.type) ? event.type : 'adapter', { member: config.name, ...event });
        };
      }
      this.storage.seedBoard('all');
      if (this.recovery) this.rebuild(this.recovery.events);
      this.storage.event('session-start', { id: this.id, config: this.config });
      for (const member of this.members.values()) {
        if (this.stopped) throw new Error('Session stopped during startup');
        // A harness keeps nothing until its first turn, so a member that never ran has nothing to resume.
        const ran = this.recovery?.events.some(e => e.member === member.config.name && e.type === 'turn-start');
        const savedId = ran ? this.recovery!.harnessIds[member.config.name] : undefined;
        if (ran && !savedId) throw new Error(`Missing Harness session ID: ${member.config.name}`);
        if (savedId) {
          if (!member.adapter.resume) throw new Error('Harness does not support resume');
          await member.adapter.resume(savedId, this.instructions(member));
        } else await member.adapter.start(this.instructions(member));
        if (this.stopped) { await member.adapter.stop(); throw new Error('Session stopped during startup'); }
        // Recovery queued work for a member that failed before the restart, and this adapter can now
        // take it. A failed member with nothing queued stays failed, so the user can still retry it.
        if (member.queue.length) member.failed = false;
        this.storage.event('member-start', { member: member.config.name, workspace: member.workspace, harnessId: member.adapter.getSessionId?.() });
      }
      this.ready = true; if (this.recovery && !this.paused) this.schedule();
    } catch (error) { await this.stop(false); throw error; }
  }
  // Read at every start and resume, so a later session sees what the earlier ones left.
  private instructions(member: Member) {
    const context = projectContext(member.workspace, member.adapter.nativeProjectFiles);
    this.storage.event('project-context', { member: member.config.name, files: context.files });
    return '\n常驻权限分只读、安全读写、全面读写。只读仅允许读取，安全读写允许目录内普通操作，外部写入、GUI、结束进程、git push、历史改写和批量删除需用户审批。只读及安全读写禁止读取 .env、pem/key、id_rsa、credentials、.ssh 和 Harness 认证文件。全面读写全部允许（含 git push），联网仍由用户控制。权限由用户设置，负责人可用 set_member_permission 修改其他成员且不能超过自己。需要超出权限时直接发起操作，平台询问用户。负责人不能代批，不要绕过规则，被拒后不要换方式重试。Codex 权限下回合生效，Claude/DSH 下次工具调用生效，运行中命令不撤回。\n' + this.teamInstructions(member) + this.searchInstruction(member) + notesInstruction(member.config.harness) + context.text;
  }
  // Everyone keeps web access. Searches go to members on DSH first because its search service is cheap.
  private searchInstruction(member: Member) {
    const searchers = [...this.members.values()].filter(m => m.config.harness === 'dsh' && m !== member).map(m => m.config.name);
    if (member.config.harness === 'dsh') return '\n\nWeb search: you have web_search and web_fetch, and teammates will send searches to you. Do broad searches when useful.';
    return searchers.length ? `\n\nWeb search: you have web access, but give searches to ${searchers.join(' or ')} first. Go online yourself only when it is truly necessary.` : '';
  }
  private teamInstructions(member: Member) {
    const table = [...this.members.values()].map(m => `${m.config.name}: ${m.config.harness}, ${m.config.model}, ${m.config.role}, cwd=${m.workspace}`).join('\n');
    if (member.adapter.tools && member.adapter.supportsTools !== false) return `You are ${member.config.name}, the ${member.config.role}. Team:\n${table}\n` +
      'These teammates are real and running now. Your team works like a meeting around a shared board. You talk to them only through the tools post_board, message_teammate, read_board and wait_for_messages' + (member.config.role === 'lead' ? ', and interrupt_teammate' : '') + '. Tool names may carry a prefix such as mcp__agents__. ' + (member.adapter.toolHint ? member.adapter.toolHint + ' ' : '') + 'Reports should not request replies. When blocked, needing a decision, raising an objection, or handing work to a teammate, use reply_requested or ask. Do not request replies merely to make someone see a report sooner. ' + (member.config.role === 'lead' ? 'Every message you send a teammate wakes them, so send only what they must act on. Ordinary notifications between teammates and to you go to an inbox without waking anyone idle or waiting.' : 'Ordinary notifications go to an inbox without waking idle or waiting teammates.') + ' Default to telling people without asking for a reply. Never message teammates merely to thank or acknowledge. If a message requires no action and contains no new information for the user, end your reply silently; do not report that there is no progress. Use the language the user writes in, with teammates too.\n' +
      'WAITING: to wait for a teammate or the user, call wait_for_messages. It blocks at no cost and returns only when you need to respond; inbox notifications are included then, however long that takes. This is the only way to wait. Never sleep, poll, loop, or re-read the board to pass time. Waiting for a command you started is fine.\n' +
      `${member.config.role === 'lead' ? 'Plain reply text goes to the user' : 'Plain reply text reaches nobody, so report your results and questions with post_board or send_message'}. When all your work is done and nothing is outstanding, end your reply: the platform wakes you when someone needs you.\n` +
      (this.config.mode === 'shared' ? 'Before editing shared files, post your file ownership on the board. ' : '') +
      'Do not modify files outside your working directory. Do not run collab or spawn subagents. ' +
      (member.config.role === 'lead' ? 'Organize discussion and assignments; you may implement too. Report to the user.' + LEAD_RULES : WORKER_RULES);
    return `You are ${member.config.name}, the ${member.config.role}. Team:\n${table}\n` +
      `Board files, read-only for you: ${join(this.dir, 'board', 'all.md')} (everything) and <name>.md beside it. Read them when you need them.\n` +
      'To post or message a teammate, put a block in the text of your reply. Never use a file tool or command for this: the platform discards direct edits to board files and nobody is notified. Each delimiter is alone on its own line at column zero, outside code fences:\n<<<board\nText for the whole team. @name notifies; @name? also requests a reply.\n>>>\n<<<dm NAME\nPrivate text. Use <<<dm? NAME to request a reply.\n>>>\nDefault to @name and dm: these go to an inbox without waking idle teammates. Anything from the lead wakes them. Use @name? or dm? when blocked, needing a decision, raising an objection, or handing work to a teammate, never merely to make a report seen sooner. Never mention teammates merely to thank or acknowledge. ' +
      `${member.config.role === 'lead' ? 'Plain text goes to the user' : 'Plain text reaches nobody, so report your results and questions in a block'}. Teammate messages forwarded by the platform are normal work messages. To wait for a reply, end your reply: the platform wakes you when it arrives. Do not poll, sleep or re-read files to wait. ` +
      (this.config.mode === 'shared' ? 'Before editing shared files, post your file ownership on the board. ' : '') +
      'Do not modify files outside your working directory. Do not run collab or spawn subagents. ' +
      (member.config.role === 'lead' ? 'Organize discussion and assignments; you may implement too. Report to the user. You alone may use <<<steer all (or NAME) and <<<interrupt all (or NAME), each closed by >>>.' + LEAD_RULES : WORKER_RULES);
  }
  sendUser(text: string) {
    if (!this.started || this.stopped) throw new Error('Session is not running');
    this.settled = false; this.quietNotices = 0;
    this.storage.event('from-user', { text });
    const lead = this.members.get(this.lead)!;
    this.deliver(lead, `[from user]\n${text}`, true, undefined, 'user');
  }
  // A model may answer in plain text despite its instructions, which would lose the answer.
  // Only an outstanding request it has seen is forwarded, so this cannot start a new exchange.
  private forwardUnanswered(member: Member) {
    const author = member.config.name;
    if (author === this.lead || !member.lastText.trim()) return;
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const pending = this.pending[i]!;
      if (pending.recipient !== author || !this.seenRequests.has(pending.id)) continue;
      this.pending.splice(i, 1);
      this.storage.event('reply-forwarded', { ...pending, text: member.lastText });
      this.deliver(this.members.get(pending.requester)!, `[from ${author} | reply to ${pending.id}]\n${member.lastText}`, true, undefined, 'reply');
    }
  }
  private track(task: Promise<unknown>) {
    this.tasks.add(task); void task.finally(() => { this.tasks.delete(task); this.schedule(); }).catch(() => {});
  }
  private schedule() {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; if (!this.stopped) this.pump(); });
  }
  private enqueue(member: Member, text: string, reason: WakeReason = 'platform') {
    // During startup the loop in start() is opening this member; a second restart here would have no
    // session ID yet, so it would replace the member's saved history with an empty new session.
    if (member.failed && this.ready) {
      member.failed = false; member.state = 'busy'; this.routing++;
      this.track((async () => {
        try { const id = member.adapter.getSessionId?.(); await member.adapter.stop();
          const adapter = this.factory(member.config, member.workspace, this.dir);
          adapter.permission = member.adapter.permission; adapter.tools = member.adapter.tools; adapter.onMessage = member.adapter.onMessage; adapter.onEvent = member.adapter.onEvent;
          member.adapter = adapter;
          if (id && adapter.resume) await adapter.resume(id, this.instructions(member)); else await adapter.start(this.instructions(member));
          member.state = 'idle'; this.storage.event('member-start', { member: member.config.name, harnessId: adapter.getSessionId?.() });
        } catch (error) { member.failed = true; member.state = 'idle'; this.storage.event('member-failed', { member: member.config.name, error: String(error) }); if (member.config.name !== this.lead) this.notifyLead(`member ${member.config.name} failed: ${String(error)}`); }
        finally { this.routing--; this.schedule(); }
      })());
    }
    member.queue.push(text); member.wakeReasons.push(reason); this.storage.event('queued', { member: member.config.name, text, reason }); this.settled = false; this.schedule(); }
  private storeInbox(member: Member, text: string, id: string, order = ++this.deliveryOrder) {
    member.inbox.push({ id, text, order }); member.inbox.sort((a, b) => a.order - b.order);
    this.storage.event('inbox', { member: member.config.name, id, text, order }); this.settled = false; this.schedule();
  }
  private deliver(member: Member, text: string, steer: boolean, report?: (steered: boolean) => void, reason: WakeReason | null = 'platform', source = 'platform') {
    const order = ++this.deliveryOrder;
    if (!this.paused && steer && member.state === 'busy' && !member.waiter && !member.parked) {
      this.routing++;
      this.track((async () => {
        let accepted = false;
        try { accepted = await member.adapter.steer(text) === 'steered'; } catch {}
        if (this.stopped) { report?.(false); return; }
        if (accepted) {
          // Harnesses show a steer at the next step boundary, and a blocking call has none. If the
          // member began waiting while this was in flight, it would sit unseen until the wait ended.
          if (member.waiter || member.state !== 'busy') {
            if (reason) this.enqueue(member, text, reason); else this.storeInbox(member, text, source, order);
          } else {
            member.steered.push({ at: Date.now(), text, reason, source, order });
            if (reason) this.storage.event('wake', { member: member.config.name, reason, inboxCount: 0 });
          }
        } else if (reason) this.enqueue(member, text, reason); else this.storeInbox(member, text, source, order);
        report?.(accepted);
      })().finally(() => { this.routing--; }));
    } else { if (reason) this.enqueue(member, text, reason); else this.storeInbox(member, text, source, order); report?.(false); }
  }
  private talkLine(author: string, to: string, id: string, text: string) {
    return `${author} -> ${to} ${id}: ${text.trim().split('\n')[0]!.slice(0, 100)}`;
  }
  private noteTeamTalk(author: string, to: string, id: string, text: string) {
    if (author === this.lead || to === this.lead) return;
    this.teamTalk.push(this.talkLine(author, to, id, text));
    const lead = this.members.get(this.lead)!;
    // A lead that cannot act now gets the checkpoint on the first message after it can.
    if (this.teamTalk.length < CHECKPOINT_MESSAGES || lead.failed || lead.state === 'paused') return;
    const count = this.teamTalk.length, lines = this.teamTalk.slice(-CHECKPOINT_MESSAGES); this.teamTalk = [];
    this.storage.event('checkpoint', { count });
    this.enqueue(lead, `[platform] Checkpoint: teammates exchanged ${count} messages since the last one. ${this.teamStatus()}\n${lines.join('\n')}\nCheck this against your work order. If it is still inside the order and heading for the done line, write nothing and end your reply or keep waiting. If it has drifted, narrow or stop the work. Read the board only if a line needs it.`, 'checkpoint');
  }
  private reply(requester: string, recipient: string) {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const pending = this.pending[i]!;
      if (pending.requester === recipient && pending.recipient === requester) { this.pending.splice(i, 1); this.storage.event('reply-cleared', pending as unknown as Record<string, unknown>); }
    }
  }
  private request(id: string, requester: string, recipient: string) {
    if (requester === recipient) return;
    const pending = { id, requester, recipient }; this.pending.push(pending); this.storage.event('reply-pending', pending);
  }
  private postBoard(member: Member, text: string, notify: string[] = [], ask: string[] = []) {
    const author = member.config.name, id = `b${++this.boardId}`;
    this.storage.board(id, author, text); this.storage.event('board', { id, author, text });
    this.boardLog.push({ id, author, text, at: new Date().toISOString() });
    this.noteTeamTalk(author, 'board', id, text);
    const deliveries: Record<string, string> = {};
    const deliveryTasks: Promise<void>[] = [];
    const targets = new Map<string, boolean>();
    for (const mention of mentions(text, this.members.keys())) targets.set(mention.name, mention.reply || (targets.get(mention.name) ?? false));
    for (const name of notify) targets.set(name, targets.get(name) ?? false);
    for (const name of ask) targets.set(name, true);
    targets.delete(author);
    for (const [name, reply] of targets) {
      // A reply to an outstanding request wakes even without a new reply flag.
      const answers = this.pending.some(p => p.requester === name && p.recipient === author);
      this.reply(author, name);
      if (reply) this.request(id, author, name);
      this.members.get(name)!.deliveredBoard.add(id);
      const target = this.members.get(name)!;
      const wake = this.wakeFor(author, reply, answers);
      deliveries[name] = wake ? 'queued for response' : this.inboxReceipt(target);
      deliveryTasks.push(new Promise<void>(resolve => { this.deliver(target, `[from ${author} | board ${id}${reply ? ' | reply requested' : ''}]\n${text}`, true, steered => { this.noteToldLead(member, name, steered); if (steered && reply) this.seenRequests.add(id); deliveries[name] = steered ? 'interjected' : wake ? 'queued for response' : INBOX_RECEIPT; resolve(); }, wake, id); }));
    }
    return { id, deliveries, completion: Promise.all(deliveryTasks), notified: [...targets].filter(([, reply]) => !reply).map(([name]) => name), reply_requested_from: [...targets].filter(([, reply]) => reply).map(([name]) => name) };
  }
  private sendMessage(member: Member, recipient: string, text: string, reply: boolean, report?: (steered: boolean) => void) {
    const author = member.config.name, id = `m${++this.messageId}`;
    this.storage.event('message-created', { id, author, recipient });
    this.noteTeamTalk(author, recipient, id, text);
    const answers = this.pending.some(p => p.requester === recipient && p.recipient === author);
    this.reply(author, recipient);
    if (reply) this.request(id, author, recipient);
    this.deliver(this.members.get(recipient)!, `[from ${author} | dm ${id}${reply ? ' | reply requested' : ''}]\n${text}`, true,
      steered => { this.noteToldLead(member, recipient, steered); if (steered) this.seenRequests.add(id); this.storage.event('dm', { id, author, recipient, text, reply, steered }); report?.(steered); }, this.wakeFor(author, reply, answers), id);
    return id;
  }
  // The lead assigns work by plain notification, and real runs show workers doing most of their work
  // from those, so anything from the lead wakes. Only reports and chatter between others wait.
  private wakeFor(author: string, reply: boolean, answers: boolean): WakeReason | null {
    return reply ? 'ask' : answers ? 'reply' : author === this.lead ? 'lead' : null;
  }
  private leadAction(member: Member, type: 'steer' | 'interrupt', target: string, text: string) {
    const author = member.config.name;
    const targets = target === 'all' ? [...this.members.values()].filter(m => m !== member) : [this.members.get(target)!];
    for (const recipient of targets) {
      this.storage.event(type, { author, recipient: recipient.config.name, text });
      const message = `[from ${author} | ${type}]\n${text}`;
      if (type === 'interrupt' && recipient.state === 'busy' && !recipient.waiter) {
        this.routing++;
        this.track(recipient.adapter.interrupt().catch(error => this.storage.event('protocol-warning', { member: author, text: String(error) })).then(() => { this.enqueue(recipient, message, 'lead'); }).finally(() => { this.routing--; }));
      } else this.deliver(recipient, message, true, undefined, 'lead');
    }
    return targets.map(m => m.config.name);
  }
  private inboxReceipt(member: Member) {
    return !this.paused && member.state === 'busy' && !member.waiter && !member.parked ? 'steer attempted; if it fails, stored in inbox' : INBOX_RECEIPT;
  }
  private toolCall(member: Member, name: string, args: any, signal?: AbortSignal): Promise<ToolResult> | ToolResult {
    const fail = (text: string): ToolResult => ({ text, isError: true });
    if (this.stopped) return fail('The session has stopped.');
    this.storage.event('tool-call', { member: member.config.name, tool: name, args });
    if (name !== 'wait_for_messages') member.lastToolAt = Date.now();
    const self = member.config.name, isLead = self === this.lead;
    const known = (list: unknown): string | undefined => {
      if (list === undefined) return undefined;
      if (!Array.isArray(list)) return 'Expected a list of member names';
      const bad = list.filter(n => typeof n !== 'string' || n === self || !this.members.has(n));
      return bad.length ? `Not teammates: ${bad.join(', ')}. Teammates: ${[...this.members.keys()].filter(n => n !== self).join(', ')}` : undefined;
    };
    const hint = () => member.queue.length ? { messages_waiting_for_you: member.queue.length, note: 'You get them when you call wait_for_messages or end your reply.' } : {};
    this.settled = false;
    try {
      if (name === 'set_member_permission') { this.permissions.set(args.member, args.level, self); return { text: '权限已更新' }; }
      if (name === 'post_board') {
        if (typeof args?.text !== 'string' || !args.text.trim()) return fail('text is required');
        const problem = known(args.notify) ?? known(args.ask); if (problem) return fail(problem);
        const { completion, ...posted } = this.postBoard(member, args.text, args.notify, args.ask);
        const nobody = !posted.notified.length && !posted.reply_requested_from.length;
        return completion.then(() => ({ text: JSON.stringify({ ...posted, ...(nobody ? { note: 'Nobody was told about this post. Name people in notify or ask if someone is waiting for it.' } : {}), ...hint() }) }));
      }
      if (name === 'message_teammate') {
        if (typeof args?.text !== 'string' || !args.text.trim()) return fail('text is required');
        if (args.to === 'all') {
          if (!isLead) return fail('Only the lead may message everyone');
          return { text: JSON.stringify({ sent_to: this.leadAction(member, 'steer', 'all', args.text), ...hint() }) };
        }
        const problem = known([args.to]); if (problem) return fail(problem);
        const target = this.members.get(args.to)!;
        // The report can fire before sendMessage returns, when no steering is involved.
        let report!: (steered: boolean) => void;
        const outcome = new Promise<boolean>(resolve => { report = resolve; });
        const needsResponse = this.wakeFor(self, args.reply_requested === true, this.pending.some(p => p.requester === args.to && p.recipient === self)) !== null;
        const id = this.sendMessage(member, args.to, args.text, args.reply_requested === true, report);
        return outcome.then(steered => ({ text: JSON.stringify({ id, delivery: steered ? 'interjected' : !needsResponse ? INBOX_RECEIPT : target.waiter || target.state === 'idle' || target.queue.length === 0 ? 'delivered' : 'queued until their current step ends', ...hint() }) }));
      }
      if (name === 'read_board') {
        const start = args?.from_start === true ? 0 : member.boardCursor;
        const entries = this.boardLog.slice(start); member.boardCursor = this.boardLog.length;
        if (!entries.length) return { text: JSON.stringify({ entries: [], note: 'No new entries. Do not poll: to wait, call wait_for_messages.', ...hint() }) };
        let size = 0, first = entries.length;
        while (first > 0 && size + entries[first - 1]!.text.length <= MAX_BOARD_READ) { first--; size += entries[first]!.text.length; }
        return { text: JSON.stringify({ entries: entries.slice(first), ...(first ? { omitted_older_entries: first } : {}), ...hint() }) };
      }
      if (name === 'interrupt_teammate') {
        if (!isLead) return fail('Only the lead may interrupt');
        if (typeof args?.text !== 'string' || !args.text.trim()) return fail('text is required');
        if (args.to !== 'all') { const problem = known([args.to]); if (problem) return fail(problem); }
        return { text: JSON.stringify({ interrupted: this.leadAction(member, 'interrupt', args.to, args.text), ...hint() }) };
      }
      if (name === 'wait_for_messages') return this.startWait(member, signal);
      return fail(`Unknown tool: ${name}`);
    } finally { this.schedule(); }
  }
  private startWait(member: Member, signal?: AbortSignal): Promise<ToolResult> | ToolResult {
    if (member.waiter) return { text: 'You are already waiting in another call.', isError: true };
    // A steer newer than the member's last tool call may only reach the model after this call
    // returns, which could be never. Hand it over now; at worst the model reads it twice.
    const unseen = member.steered.filter(s => s.at >= member.lastToolAt); member.steered = [];
    this.endOutput(member);
    if (unseen.length) { this.storage.event('steer-redelivered', { member: member.config.name, count: unseen.length }); for (const s of unseen) { if (s.reason) this.enqueue(member, `[may repeat a message you already saw]\n${s.text}`, s.reason); else this.storeInbox(member, s.text, s.source, s.order); } }
    this.noteWorkerFinished(member);
    this.storage.event('wait-start', { member: member.config.name });
    return new Promise<ToolResult>(resolve => {
      member.waiter = text => resolve({ text });
      signal?.addEventListener('abort', () => {
        if (!member.waiter) return;
        this.clearWaiter(member); this.storage.event('wait-cancelled', { member: member.config.name }); resolve({ text: 'Cancelled', isError: true }); this.schedule();
      });
      if (member.adapter.maxBlockMs !== undefined) member.parkTimer = setTimeout(() => this.park(member), member.adapter.maxBlockMs);
      this.schedule();
    });
  }
  // A steer may land as the lead's turn ends, so only a queued message is sure to reach it.
  private noteToldLead(member: Member, recipient: string, steered: boolean) {
    if (recipient === this.lead && !steered) member.toldLead = true;
  }
  // The lead is woken when workers go quiet, unless a worker's last act was to tell it something:
  // its queued message or the lead inbox quiet flush guarantees delivery.
  private noteWorkerFinished(member: Member) {
    if (member.config.name !== this.lead && !member.toldLead) this.workerFinished = true;
  }
  private clearWaiter(member: Member) { clearTimeout(member.parkTimer); member.parkTimer = undefined; member.waiter = undefined; }
  private releaseWait(member: Member, text: string) {
    const waiter = member.waiter!; this.clearWaiter(member);
    waiter(text);
  }
  // The wait goes on, without an open turn: the member is idle, and the next message starts a turn.
  private park(member: Member) {
    if (!member.waiter || this.stopped || member.queue.length) return;
    member.parked = true;
    this.storage.event('wait-parked', { member: member.config.name });
    this.routing++;
    this.track(member.adapter.interrupt().catch(error => this.storage.event('protocol-warning', { member: member.config.name, text: String(error) })).finally(() => { this.routing--; }));
  }
  // What happens whenever a member's output ends, whether it ended its turn or is now waiting.
  private endOutput(member: Member, status: TurnResult['status'] = 'completed') {
    if (status === 'completed') this.forwardUnanswered(member);
    const snapshotTask = snapshot(member.workspace, this.dir, this.id, this.totalSnapshot++).then(saved => {
      if (saved) this.storage.event('snapshot', { member: member.config.name, ...saved,
        ...(saved.limited ? { text: '未跟踪文件超过数量或大小限制，或文件状态读取失败；本次仅快照索引中已有的文件' } : {}) });
    }).catch(error => { this.storage.event('snapshot', { member: member.config.name, error: String(error) }); });
    this.snapshotTasks.add(snapshotTask); void snapshotTask.finally(() => this.snapshotTasks.delete(snapshotTask));
    const tampered = this.storage.restoreBoard();
    if (!tampered.length) return;
    // Agents run concurrently, so the turn that ended is not necessarily the one that edited.
    // A member's own file names it; an edit only to all.md could be anyone still running.
    const owners = tampered.filter(name => this.members.has(name));
    const targets = owners.length ? owners : [...this.members.values()].filter(m => m === member || (m.state === 'busy' && !m.waiter)).map(m => m.config.name);
    this.storage.event('board-tampered', { members: targets, files: tampered });
    for (const name of targets) {
      const target = this.members.get(name)!;
      if (!target.failed && !(target === member && status === 'failed')) this.enqueue(target, '[platform] Board files changed directly were restored, so nobody saw that text. If you edited one, send it again with the post_board tool.');
    }
  }
  private teamStatus() {
    const states = [...this.members.values()].map(m => `${m.config.name}: ${m.failed ? 'failed' : m.state === 'paused' ? 'paused for quota' : [...this.permissions.pending.values()].some(p => p.member === m.config.name) ? 'waiting for the user to approve a permission' : m.waiter || m.parked ? 'waiting' : m.state === 'busy' ? 'working' : 'idle'}`).join(', ');
    const asked = this.pending.map(p => `${p.requester} asked ${p.recipient}`).join(', ');
    // A handoff sent as a plain notification sleeps in the recipient's inbox; only the lead can notice.
    const unread = [...this.members.values()].filter(m => m.config.name !== this.lead && m.inbox.length).map(m => `${m.config.name} has ${m.inbox.length} from ${[...new Set(m.inbox.map(e => /^\[from ([^\s|\]]+)/.exec(e.text)?.[1] ?? 'unknown'))].join(', ')}`).join('; ');
    return `Team: ${states}.${asked ? ` Unanswered: ${asked}.` : ''}${unread ? ` Unread, not woken: ${unread}; message them if they should act.` : ''}`;
  }
  // Board posts the member has not seen, since nobody named it. A quiet team may be waiting on one.
  private unreadBoard(member: Member) {
    const entries = this.boardLog.slice(member.boardCursor).filter(e => e.author !== member.config.name && !member.deliveredBoard.has(e.id));
    member.boardCursor = this.boardLog.length;
    return entries.map(e => `\n[${e.id} from ${e.author}]\n${e.text}`).join('').slice(-MAX_BOARD_READ);
  }
  private actions(member: Member, actions: Action[]) {
    const author = member.config.name;
    for (const action of actions) {
      if (action.type === 'text') {
        if (action.text.trim()) {
          const first = !member.outputId; member.outputId ??= author + ':' + member.turns;
          member.lastText += action.text;
          this.storage.event(first ? (author === this.lead ? 'to-user' : 'member-text') : 'message-update',
            { member: author, messageId: member.outputId, text: action.text, ...(!first ? { append: true } : {}) });
        }
      } else if (action.type === 'warning') {
        this.storage.event('protocol-warning', { member: author, text: action.text });
        if (action.notify) this.enqueue(member, `[platform] ${action.text}`);
      } else if (action.type === 'board') this.postBoard(member, action.text);
      else if (action.type === 'dm') this.sendMessage(member, action.target!, action.text, action.reply === true);
      else {
        if (author !== this.lead) {
          this.storage.event('protocol-warning', { member: author, text: `Only the lead may ${action.type}` });
          this.enqueue(member, `[platform] Only the lead may ${action.type}.`); continue;
        }
        this.leadAction(member, action.type, action.target!, action.text);
      }
    }
    this.schedule();
  }
  private pump() {
    if (this.stopped || this.paused || !this.ready) return;
    for (const member of this.members.values()) {
      const waiting = member.state === 'busy' && member.waiter !== undefined;
      if ((member.state !== 'idle' && !waiting) || !member.queue.length || member.failed || this.guarded) continue;
      // Interrupted to park but not yet ended: the new turn starts once it has.
      if (waiting && member.parked) continue;
      if (this.config.maxTurns !== undefined && this.totalTurns >= this.config.maxTurns) {
        this.guarded = true; this.storage.event('guard', { maxTurns: this.config.maxTurns }); break;
      }
      const wasParked = member.parked; member.parked = false;
      const inbox = member.inbox.splice(0);
      const reason = member.wakeReasons[0] ?? 'platform'; member.wakeReasons = [];
      this.storage.event('wake', { member: member.config.name, reason, inboxCount: inbox.length });
      const text = (wasParked ? '[platform] Your wait_for_messages call has ended. The platform closed that turn to save budget; nothing was lost. This arrived:\n' : '') + [...inbox.map(e => e.text), ...member.queue.splice(0)].join('\n\n'); member.state = 'busy'; member.turns++; this.totalTurns++; member.lastText = ''; member.outputId = undefined; member.steered = []; member.lastToolAt = Date.now(); member.toldLead = false;
      for (const p of this.pending) if (p.recipient === member.config.name) this.seenRequests.add(p.id);
      // Cleared when the lead starts, not when it ends: a worker that finishes during the lead's
      // turn without mentioning it must still trigger the idle notice.
      if (member.config.name === this.lead) this.workerFinished = false;
      else this.quietNotices = 0;
      if (waiting) { this.storage.event('wait-resume', { member: member.config.name, turn: this.totalTurns, text }); this.releaseWait(member, text); }
      else { this.storage.event('turn-start', { member: member.config.name, turn: this.totalTurns, text }); this.track(this.run(member, text)); }
    }
    if ([...this.members.values()].some(m => m.state === 'busy' && (!m.waiter || m.parked)) || this.routing) return;
    const queued = [...this.members.values()].some(m => m.queue.length);
    const blocked = this.guarded || [...this.members.values()].some(m => m.state === 'paused' || m.failed);
    if (queued && !blocked) return;
    const lead = this.members.get(this.lead)!;
    // A failed or quota-paused teammate must not strand what the others told the lead, and its queue
    // cannot drain, so only work that can still run or a lead that cannot wake holds this back.
    const runnable = [...this.members.values()].some(m => m.queue.length && !m.failed && m.state !== 'paused');
    if (!runnable && !this.guarded && !lead.failed && lead.state !== 'paused' && lead.inbox.length) {
      // This flush is the quiet notice: a subsequent wait must not wake it again.
      this.quietNotices = 2;
      this.enqueue(lead, `[platform] ${QUIET} ${this.teamStatus()} Read the collected notifications and respond only if needed.${this.unreadBoard(lead)}`, 'quiet'); return;
    }
    if (!queued && !blocked && this.workerFinished && lead.state === 'idle') {
      this.workerFinished = false; this.enqueue(lead, `[platform] ${QUIET} ${this.teamStatus()} Reply only if there is something the user has not heard.${this.unreadBoard(lead)}`, 'quiet'); return;
    }
    if (!queued && !blocked && (lead.waiter || lead.parked) && this.quietNotices < 2) {
      this.quietNotices++;
      this.enqueue(lead, this.quietNotices === 1
        ? `[platform] ${QUIET} ${this.teamStatus()} Give new assignments, or report to the user and end your reply.${this.unreadBoard(lead)}`
        : '[platform] Nothing has changed and nothing will until you act. The user has not heard from you: report in plain text and end your reply. The next message starts a new turn.', 'quiet'); return;
    }
    if (!this.settled) {
      this.settled = true; this.storage.event('settled', { blocked, pending: this.pending });
      for (const resolve of this.waiters.splice(0)) resolve();
    }
  }
  private async run(member: Member, text: string) {
    let result: TurnResult, timer: NodeJS.Timeout | undefined;
    try {
      let exhausted = quotaExhausted(this.knownQuota.get(member.config.harness));
      // The saved reading can be stale: the user may have reset the limit or changed plan since.
      // Ask the harness again before turning the member away; the reading updates knownQuota.
      if (exhausted && member.adapter.readQuota) {
        try {
          const data = await member.adapter.readQuota();
          if (data) { this.storage.event('rate-limits', { member: member.config.name, ...data }); exhausted = quotaExhausted(this.knownQuota.get(member.config.harness)); }
        } catch (error) { this.storage.event('protocol-warning', { text: '额度查询失败，按上次读数处理：' + String(error) }); }
      }
      const known = this.knownQuota.get(member.config.harness);
      const prompt = exhausted ? Promise.resolve<TurnResult>({status:'quota',quota:known}) : member.adapter.prompt(text);
      // Time spent blocked in wait_for_messages is not work, so it does not count against the limit.
      result = this.config.turnTimeoutMs === undefined ? await prompt : await Promise.race([prompt, new Promise<never>((_, reject) => {
        const arm = () => { timer = setTimeout(() => { if (member.waiter || [...this.permissions.pending.values()].some(p => p.member === member.config.name)) arm(); else reject(new Error('Turn timed out')); }, this.config.turnTimeoutMs); };
        arm();
      })]);
    } catch (error) {
      result = { status: 'failed', error: String(error) };
      await this.stopMember(member);
    } finally { clearTimeout(timer); this.permissions.cancel(member.config.name); }
    if (member.waiter) { if (!member.parked) this.storage.event('wait-cancelled', { member: member.config.name }); this.releaseWait(member, 'The turn ended.'); }
    if (this.stopped) return;
    this.actions(member, member.parser.end());
    const usage = Object.entries(result.usage ?? {}).filter(([, value]) => typeof value === 'number' && Number.isFinite(value));
    if (usage.length) member.measuredTurns++;
    for (const [key, value] of usage) member.usage[key] = (member.usage[key] ?? 0) + value;
    this.storage.event('turn-end', { member: member.config.name, ...result, ...(member.parked ? { parked: true } : {}) });
    member.state = result.status === 'quota' ? 'paused' : 'idle';
    this.noteWorkerFinished(member);
    this.endOutput(member, result.status);
    if (result.status === 'quota') {
      this.storage.event('quota', { member: member.config.name, ...result.quota });
      if (member.config.name === this.lead) this.storage.event('lead-paused', { member: this.lead, ...result.quota });
      else this.enqueue(this.members.get(this.lead)!, `[platform] member ${member.config.name} paused for quota: ${JSON.stringify(result.quota ?? {})}`);
    } else if (result.status === 'failed') {
      member.failed = true;
      this.storage.event('member-failed', { member: member.config.name, error: result.error });
      if (member.config.name !== this.lead) this.enqueue(this.members.get(this.lead)!, `[platform] member ${member.config.name} failed: ${result.error ?? 'unknown error'}`);
    }
  }
  private rebuild(events: PlatformEvent[]) {
    const busy = new Set<string>(), waiting = new Set<string>();
    for (const e of events) {
      if (/^m[0-9]+$/.test(String(e.id))) this.messageId = Math.max(this.messageId, Number(String(e.id).slice(1)));
      if (/^b[0-9]+$/.test(String(e.id))) this.boardId = Math.max(this.boardId, Number(String(e.id).slice(1)));
      const m = this.members.get(String(e.member));
      if (e.type === 'board') { this.storage.board(String(e.id), String(e.author), String(e.text), e.at); this.boardLog.push({ id: String(e.id), author: String(e.author), text: String(e.text), at: e.at }); this.boardId = Math.max(this.boardId, Number(String(e.id).slice(1))); }
      if (e.type === 'dm') this.messageId = Math.max(this.messageId, Number(String(e.id).slice(1)));
      if (e.type === 'checkpoint') this.teamTalk = [];
      if ((e.type === 'board' || e.type === 'dm') && e.author !== this.lead && e.recipient !== this.lead) this.teamTalk.push(this.talkLine(String(e.author), e.type === 'dm' ? String(e.recipient) : 'board', String(e.id), String(e.text)));
      if (e.type === 'reply-pending') this.pending.push({ id: String(e.id), requester: String(e.requester), recipient: String(e.recipient) });
      if (e.type === 'reply-cleared' || e.type === 'reply-forwarded') { const i = this.pending.findIndex(p => p.id === e.id && p.recipient === e.recipient); if (i >= 0) this.pending.splice(i, 1); }
      if (e.type === 'paused') this.paused = true;
      if (e.type === 'resumed') this.paused = false;
      if (!m) continue;
      if (e.type === 'inbox') { const order = Number(e.order) || ++this.deliveryOrder; this.deliveryOrder = Math.max(this.deliveryOrder, order); m.inbox.push({ id: String(e.id), text: String(e.text), order }); m.inbox.sort((a, b) => a.order - b.order); m.deliveredBoard.add(String(e.id)); }
      if (e.type === 'queued') { m.queue.push(String(e.text)); m.wakeReasons.push((e.reason as WakeReason) ?? 'platform'); }
      if (e.type === 'wait-start') waiting.add(m.config.name);
      if (e.type === 'wait-cancelled') waiting.delete(m.config.name);
      if (e.type === 'wait-resume') { waiting.delete(m.config.name); m.queue = []; m.wakeReasons = []; m.inbox = []; m.turns++; this.totalTurns++; for (const p of this.pending) if (p.recipient === m.config.name) this.seenRequests.add(p.id); }
      if (e.type === 'turn-start') { m.queue = []; m.wakeReasons = []; m.inbox = []; m.turns++; this.totalTurns++; busy.add(m.config.name); for (const p of this.pending) if (p.recipient === m.config.name) this.seenRequests.add(p.id); }
      if (e.type === 'member-interrupted') busy.delete(String(e.member));
      if (e.type === 'turn-end') { busy.delete(m.config.name); waiting.delete(m.config.name); if (e.usage && Object.keys(e.usage as object).length) { m.measuredTurns++; for (const [k,v] of Object.entries(e.usage as Usage)) m.usage[k] = (m.usage[k] ?? 0) + v; } m.state = e.status === 'quota' ? 'paused' : 'idle'; m.failed = e.status === 'failed'; }
    }
    this.totalSnapshot = events.filter(e => e.type === 'snapshot').length + 1;
    // A member that was waiting had finished its output: nothing was lost, its next message starts a new turn.
    for (const name of waiting) busy.delete(name);
    for (const name of busy) { this.storage.event('member-interrupted', { member: name }); this.enqueue(this.members.get(this.lead)!, `[platform] member ${name} was interrupted by a restart`); }
  }
  pause() { this.paused = true; this.permissions.cancel(); this.storage.event('paused'); }
  resume() { this.paused = false; for (const m of this.members.values()) if (m.state === 'paused') m.state = 'idle'; this.storage.event('resumed'); this.schedule(); }
  retry(name: string) { const m = this.members.get(name); if (!m) throw new Error('未知成员'); if (!m.failed) throw new Error('只能重试失败成员'); this.enqueue(m, '[platform] 用户请求重试：请继续上次失败的任务，先检查已有进度。'); }
  async interrupt(name: string) { const m = this.members.get(name); if (!m) throw new Error('Unknown member'); this.permissions.cancel(name); await m.adapter.interrupt(); this.storage.event('member-interrupted', { member: name }); }
  private totalSnapshot = 1;
  async waitForSnapshots() { await Promise.allSettled([...this.snapshotTasks]); }
  waitForSettled(): Promise<void> { if (this.settled || this.stopped) return Promise.resolve(); this.schedule(); return new Promise(resolve => this.waiters.push(resolve)); }
  summary() { return { members: [...this.members.values()].map(m => ({ name: m.config.name, turns: m.turns, usage: m.usage, unmeasuredTurns: m.turns - m.measuredTurns, state: m.waiter || m.parked ? 'waiting' : m.state, failed: m.failed, queued: m.queue.length + m.inbox.length })), pending: [...this.pending], sessionDir: this.dir }; }
  private async stopMember(member: Member) {
    let timer: NodeJS.Timeout | undefined;
    try { await Promise.race([member.adapter.interrupt().catch(() => {}), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); }
    finally { clearTimeout(timer); await member.adapter.stop().catch(() => {}); }
  }
  stop(persist = true): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    this.permissions.cancel();
    if (persist) this.storage.event('stopped');
    this.stopTask = (async () => {
      for (const m of this.members.values()) if (m.waiter) this.releaseWait(m, 'The session has stopped.');
      await Promise.allSettled([...this.members.values()].map(m => this.stopMember(m)));
      await Promise.allSettled([...this.snapshotTasks]); releaseSnapshots(this.dir);
      await this.toolServer.stop().catch(() => {});
      for (const resolve of this.waiters.splice(0)) resolve();
    })();
    return this.stopTask;
  }
}
