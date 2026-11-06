import type { ServiceInfo } from './lock.js';
export function closeAction(quitting: boolean) { return quitting ? 'close' : 'hide'; }
export function serviceEnded(expected: ServiceInfo, current: ServiceInfo | undefined, alive: boolean) {
  return !alive || !current || current.pid !== expected.pid || current.token !== expected.token;
}
export function confirmation(count: number) { return { title: '退出 Crewroom', message: `有 ${count} 个会话正在运行，退出会停止所有会话和 Harness。确定退出吗？` }; }
export function activeCount(state: { sessions: { status: string }[] }) { return state.sessions.filter(s => ['运行中', '空闲', '已暂停'].includes(s.status)).length; }
export async function stopService(info: ServiceInfo, hooks: {
  request: (signal: AbortSignal) => Promise<unknown>; alive: () => boolean; same: () => boolean | undefined;
  kill: (pid: number) => void; now?: () => number; delay?: () => Promise<void>; timeout?: number;
}) {
  const now = hooks.now ?? Date.now, timeout = hooks.timeout ?? 15000, deadline = now() + timeout;
  if (!hooks.alive()) return 'absent';
  const controller = new AbortController();
  // Bound the whole operation, including a server that never sends headers.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([hooks.request(controller.signal).catch(() => {}), new Promise<void>(r => { timer = setTimeout(r, timeout); })]); }
  finally { clearTimeout(timer); controller.abort(); }
  // A released lock may precede process exit; wait, but never kill an unknown identity.
  while (hooks.alive() && hooks.same() !== false && now() < deadline) await (hooks.delay ?? (() => new Promise(r => setTimeout(r, 100))))();
  if (!hooks.alive()) return 'stopped';
  if (!hooks.same()) return 'replaced';
  hooks.kill(info.pid); return 'forced';
}
