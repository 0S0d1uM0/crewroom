import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomic, readJson } from './persistence.js';
export interface ServiceInfo { pid: number; port: number; token: string }
export function serviceInfo(home: string): ServiceInfo | undefined { return readJson(join(home, 'service.lock', 'info.json'), undefined); }
export function acquireLock(home: string) {
  const path = join(home, 'service.lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    try { mkdirSync(path); atomic(join(path, 'owner.json'), { pid: process.pid }); return () => { const o = readJson(join(path, 'owner.json'), {}); if (o.pid === process.pid) rmSync(path, { recursive: true, force: true }); }; }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const owner = readJson(join(path, 'owner.json'), undefined);
      if (owner?.pid) { try { process.kill(owner.pid, 0); throw new Error('服务已在运行'); } catch (e: any) { if (e.code !== 'ESRCH') throw e; } }
      else if (Date.now() - statSync(path).mtimeMs < 10000) throw new Error('服务正在启动');
      const stale = path + '.stale-' + randomUUID();
      try { renameSync(path, stale); rmSync(stale, { recursive: true, force: true }); } catch {}
    }
  }
  throw new Error('无法取得服务锁');
}
export function publishLock(home: string, info: ServiceInfo) { atomic(join(home, 'service.lock', 'info.json'), info); }
