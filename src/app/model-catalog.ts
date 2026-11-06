import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomic, readJson } from './persistence.js';
import { builtinCatalog, type Catalog, type HarnessCatalog, type HarnessName, type ModelEntry } from './models.js';
import { ClaudeAdapter } from '../platform/adapters/claude.js';
import { codexModels } from '../platform/adapters/codex.js';
import { DshAdapter } from '../platform/adapters/dsh.js';

const SCAN_LIMIT_MS = 120_000;
const file = (home: string) => join(home, 'model-catalog.json');
export function loadCatalog(home: string): Catalog {
  const saved = readJson(file(home), {}) as Partial<Catalog>, result = builtinCatalog();
  for (const harness of Object.keys(result) as HarnessName[]) if (Array.isArray(saved[harness]?.models)) result[harness] = saved[harness]!;
  return result;
}
export function saveCatalog(home: string, catalog: Catalog) { atomic(file(home), catalog); }

export type Scanners = Record<HarnessName, () => Promise<ModelEntry[]>>;
// Asks each harness what it can run. Sessions are opened but no prompt is sent, so this costs no
// inference. A harness that fails keeps its previous list and reports why.
export async function scanCatalog(current: Catalog, scanners: Scanners = realScanners): Promise<Catalog> {
  const next = { ...current };
  await Promise.all((Object.keys(scanners) as HarnessName[]).map(async harness => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const models = await Promise.race([scanners[harness](), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('扫描超时')), SCAN_LIMIT_MS); })]);
      if (!models.length) throw new Error('没有返回任何模型');
      next[harness] = { models, scannedAt: new Date().toISOString() };
    } catch (error: any) {
      next[harness] = { ...current[harness], error: String(error?.message ?? error).slice(0, 300) } as HarnessCatalog;
    } finally { clearTimeout(timer); }
  }));
  return next;
}
async function inTempFolder<T>(work: (root: string) => Promise<T>) {
  const root = mkdtempSync(join(tmpdir(), 'agents-model-scan-'));
  try { return await work(root); } finally { try { rmSync(root, { recursive: true, force: true }); } catch {} }
}
export const realScanners: Scanners = {
  codex: () => inTempFolder(root => codexModels(root)),
  claude: () => inTempFolder(async root => {
    const adapter = new ClaudeAdapter({ name: 'scan', harness: 'claude', model: 'default', effort: 'low', permission: 'safe-write', role: 'worker' }, root, root);
    try { await adapter.start('Model scan.'); return await adapter.modelCatalog(); } finally { await adapter.stop().catch(() => {}); }
  }),
  dsh: () => inTempFolder(async root => {
    const sessionDir = join(root, 'session'); mkdirSync(sessionDir);
    const adapter = new DshAdapter({ name: 'scan', harness: 'dsh', model: 'local', permission: 'safe-write', role: 'worker' }, root, sessionDir);
    try { await adapter.start('Model scan.'); return await adapter.modelCatalog(); } finally { await adapter.stop().catch(() => {}); }
  }),
};
