import { randomUUID } from 'node:crypto';
import { inside, containedFile } from './permissions.js';
import type { PlatformConfig } from './config.js';
import type { PlatformEvent } from './types.js';
export type PermissionLevel = 'read-only' | 'safe-write' | 'full-write';
export interface Operation { command?: string; paths?: string[]; cwd: string; name?: string; read?: boolean; reason?: string; forceApproval?: boolean; remember?: boolean }
export interface PermissionResult { allowed: boolean; reason: string }
export const permissionLevels: PermissionLevel[] = ['read-only', 'safe-write', 'full-write'];
const credential = /(?:^|[\\/\s'"=])(?:\.env(?:\.[\w.-]+)?|[^\\/\s'"]*\.(?:pem|key)|id_(?:rsa|ed25519|ecdsa|dsa)[^\\/\s'"]*|[^\\/\s'"]*credentials[^\\/\s'"]*|\.ssh|\.aws|auth\.json|\.credentials\.json|authentication\.json)(?=$|[\\/\s'";|&])/i;
const network = /\b(?:curl|wget|invoke-webrequest|invoke-restmethod|webclient|httpclient|start-bitstransfer|ssh|scp|sftp|iwr|irm|web_search|web_fetch|websearch|webfetch|fetch|https?)\b|git\s+(?:fetch|pull|push|clone)|npm\s+(?:install|ci)|pip\s+install/i;
export function judgeOperation(level: PermissionLevel, online: boolean, op: Operation): 'allow' | 'ask' | 'deny' {
  const text = [op.command, op.name, ...(op.paths ?? [])].join(' ');
  if (level !== 'full-write' && credential.test(text)) return 'deny';
  if (!online && network.test(text)) return 'deny';
  if (level === 'full-write') return 'allow';
  if (/^(?:mcp__agents__|post_board|message_teammate|read_board|wait_for_messages|interrupt_teammate|set_member_permission|web_search|web_fetch|WebSearch|WebFetch)/i.test(op.name ?? '')) return 'allow';
  if (op.forceApproval) return 'ask';
  if (op.command) {
    if (/\bcollab\b/i.test(op.command)) return 'deny';
    const read = /^\s*(?:Get-Content|Get-ChildItem|Get-Item|Test-Path|Select-String|cat|ls|pwd|rg|type|git\s+(?:status|diff|log|show|ls-files|rev-parse))\b/i.test(op.command) && !/[>|;&$()`]|\b(?:--output|--exec|--pre)\b/i.test(op.command);
    if (level === 'read-only') return read ? 'allow' : 'ask';
    if (/\bgit\b[^\n;|&]*\b(?:push|reset\s+--hard|gc|clean|rebase|filter-branch)\b|(?:^|\s)(?:--force|--hard|-f)(?=\s|$)|\b(?:Remove-Item|rmdir|del|rm)\b[^\n]*(?:-r|-f|\/s|\*)|\b(?:Start-Process|start|Stop-Process|taskkill|kill|explorer|open|xdg-open)\b/i.test(op.command)) return 'ask';
    if (!read && op.paths?.some(p => !inside(p, op.cwd))) return 'ask';
    if (!read && /(?:^|[\s'"\\/])\.\.(?=$|[\s'";|&\\/])|~[\\/]|%\w+%|\$/i.test(op.command)) return 'ask';
    const paths = op.command.replace(/https?:\/\/[^\s'"]+/gi, '').match(/[a-z]:[\\/][^'";|&\r\n]*|\\\\[^\s'"]+|(?<![\w:/])\/[\w.-]+(?:\/[^\s'"]*)?/gi) ?? [];
    if (!read && paths.some(p => !inside(p.trim(), op.cwd))) return 'ask';
    return 'allow';
  }
  if (op.read) return 'allow';
  if (level === 'read-only') return 'ask';
  if (!op.paths?.length) return 'ask';
  return op.paths.every(p => containedFile(p, op.cwd)) ? 'allow' : 'ask';
}
export class PermissionManager {
  readonly pending = new Map<string, { id: string; member: string; operation: Operation; resolve: (r: PermissionResult) => void }>();
  readonly grants = new Map<string, { id: string; member: string; command: string; cwd: string }>();
  constructor(readonly config: PlatformConfig, private emit: (type: string, data: any) => void, history: PlatformEvent[] = []) {
    for (const e of history) {
      if (e.type === 'permission-changed') { const m = config.members.find(m => m.name === e.member); if (m && permissionLevels.includes(e.level as PermissionLevel)) m.permission = e.level as PermissionLevel; }
      if (e.type === 'network-changed') config.networkAccess = e.enabled === true;
      if (e.type === 'permission-grant' && typeof e.id === 'string') this.grants.set(e.id, { id: e.id, member: String(e.member), command: String(e.command), cwd: String(e.cwd) });
      if (e.type === 'permission-revoked') this.grants.delete(String(e.id));
    }
  }
  level(member: string) { const m = this.config.members.find(m => m.name === member); if (!m) throw Error('未知成员'); return m.permission; }
  set(member: string, level: PermissionLevel, actor?: string) {
    if (!permissionLevels.includes(level)) throw Error('未知权限档位');
    const lead = this.config.members.find(m => m.role === 'lead')!;
    if (actor !== undefined && (actor !== lead.name || member === lead.name)) throw Error('仅负责人可以修改其他成员权限，不能修改自己');
    if (member !== lead.name && permissionLevels.indexOf(level) > permissionLevels.indexOf(lead.permission)) throw Error('成员权限不能超过负责人');
    const old = this.level(member), target = this.config.members.find(m => m.name === member)!;
    target.permission = level;
    this.emit('permission-changed', { member, level, actor: actor ?? 'user', byUser: actor === undefined, raised: permissionLevels.indexOf(level) > permissionLevels.indexOf(old) });
    if (member === lead.name) for (const m of this.config.members) if (permissionLevels.indexOf(m.permission) > permissionLevels.indexOf(level)) this.set(m.name, level);
  }
  setNetwork(enabled: boolean) { this.config.networkAccess = enabled; this.emit('network-changed', { enabled }); }
  async request(member: string, operation: Operation, signal?: AbortSignal): Promise<PermissionResult> {
    const verdict = judgeOperation(this.level(member), this.config.networkAccess, operation);
    if (verdict === 'deny') { const result = { allowed: false, reason: '平台规则拒绝，凭据保护、断网或命令规则生效，用户没有拒绝此请求' }; this.emit('permission-denied', { member, operation, ...result }); return result; }
    if (verdict === 'allow') return { allowed: true, reason: '常驻权限允许' };
    if (operation.command && operation.remember !== false && [...this.grants.values()].some(g => g.member === member && g.command === operation.command && g.cwd === operation.cwd)) return { allowed: true, reason: '用户已批准本会话完全相同的命令' };
    if (signal?.aborted) return { allowed: false, reason: '请求已取消' };
    const id = randomUUID();
    return new Promise(resolve => {
      const finish = (result: PermissionResult) => { signal?.removeEventListener('abort', abort); resolve(result); };
      const abort = () => this.answer(id, 'cancel');
      this.pending.set(id, { id, member, operation, resolve: finish });
      signal?.addEventListener('abort', abort, { once: true });
      this.emit('permission-request', { id, member, operation });
    });
  }
  answer(id: string, decision: 'once' | 'session' | 'reject' | 'cancel') {
    const p = this.pending.get(id); if (!p) throw Error('申请已结束，请重新发起');
    if (!['once','session','reject','cancel'].includes(decision)) throw Error('无效审批');
    if (decision === 'session' && (!p.operation.command || p.operation.remember === false)) throw Error('此请求只能允许一次');
    this.pending.delete(id);
    if (decision === 'session') { const grant = { id: randomUUID(), member: p.member, command: p.operation.command!, cwd: p.operation.cwd }; this.grants.set(grant.id, grant); this.emit('permission-grant', grant); }
    const result = { allowed: decision === 'once' || decision === 'session', reason: decision === 'reject' ? '用户拒绝' : decision === 'cancel' ? '平台取消，旧请求需要重新发起' : '用户批准' };
    this.emit('permission-result', { id, member: p.member, decision, ...result }); p.resolve(result);
  }
  cancel(member?: string) { for (const p of [...this.pending.values()]) if (!member || p.member === member) this.answer(p.id, 'cancel'); }
  revoke(id: string) { if (!this.grants.delete(id)) throw Error('未知授权'); this.emit('permission-revoked', { id }); }
  snapshot() { return { networkAccess: this.config.networkAccess, members: this.config.members.map(m => ({ name: m.name, level: m.permission, harness: m.harness })), grants: [...this.grants.values()], pending: [...this.pending.values()].map(({ resolve, ...p }) => p) }; }
}
