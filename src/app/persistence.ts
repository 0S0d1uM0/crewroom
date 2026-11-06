import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
export function atomicText(path: string, value: string) { const tmp = path + '.' + randomUUID() + '.tmp'; writeFileSync(tmp, value); renameSync(tmp, path); }
export function atomic(path: string, value: unknown) { const tmp = path + '.' + randomUUID() + '.tmp'; writeFileSync(tmp, JSON.stringify(value, null, 2)); renameSync(tmp, path); }
export function readJson(path: string, fallback: any): any { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
export function events(dir: string): any[] { try { return readFileSync(join(dir, 'events.jsonl'), 'utf8').split('\n').flatMap(line => { try { const e = JSON.parse(line); return e && typeof e.type === 'string' && typeof e.at === 'string' ? [e] : []; } catch { return []; } }); } catch { return []; } }
export function prepare(home: string) { for (const d of ['', 'sessions', 'quota']) mkdirSync(join(home, d), { recursive: true }); }
export function hasFile(path: string) { return existsSync(path); }
