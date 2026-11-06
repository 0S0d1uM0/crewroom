export type HarnessName = 'claude' | 'codex' | 'dsh';
export interface ModelEntry { id: string; label: string; description?: string; efforts: string[]; defaultEffort?: string; available: boolean; note?: string }
export interface HarnessCatalog { models: ModelEntry[]; scannedAt?: string; error?: string }
export type Catalog = Record<HarnessName, HarnessCatalog>;

// Only what the app shows until the first scan finishes, or if a harness cannot be scanned.
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'], CODEX_EFFORTS = [...CLAUDE_EFFORTS, 'ultra'];
const entries = (efforts: string[], list: [string, string][]): ModelEntry[] => list.map(([id, label]) => ({ id, label, efforts, available: true }));
export function builtinCatalog(): Catalog {
  return {
    claude: { models: entries(CLAUDE_EFFORTS, [['opus', 'Opus 5.5'], ['sonnet', 'Sonnet 5.5'], ['fable', 'Fable 5.1'], ['haiku', 'Haiku 5.5']]) },
    codex: { models: [...entries(CODEX_EFFORTS, [['gpt-6.1-sol', 'gpt-6.1-sol'], ['gpt-6-sol', 'gpt-6-sol'], ['gpt-6.1-terra', 'gpt-6.1-terra'], ['gpt-6-astra', 'gpt-6-astra']]), ...entries(CLAUDE_EFFORTS, [['gpt-6-luna', 'gpt-6-luna']])] },
    dsh: { models: [{ id: 'local', label: '本地 Qwen', efforts: ['off', 'low', 'medium', 'high', 'max'], available: true }] },
  };
}
export const defaultTeam = [ { harness: 'claude', model: 'opus', effort: 'high', role: 'lead' }, { harness: 'dsh', model: 'local', role: 'worker' }, { harness: 'codex', model: 'gpt-6.1-sol', effort: 'high', role: 'worker' } ];
// Efforts for a model the catalog does not list, such as an ID typed by hand.
export function allowedEfforts(catalog: Catalog, harness: HarnessName, model: string) {
  const known = catalog[harness].models.find(m => m.id === model);
  return known ? known.efforts : [...new Set(catalog[harness].models.flatMap(m => m.efforts))];
}
