import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseDocument } from 'yaml';
import { z } from 'zod';

export const modelChoice = z.enum(['deepseek', 'local']);
export type ModelChoice = z.infer<typeof modelChoice>;
export const cloudSelection = '["deepseek-official","deepseek-v4-flash"]';
export function localUsage(receipts: any[]) {
  const local = receipts.filter(r => r.source === 'local-model');
  const verified = local.length > 0 && local.every(r => r.usageVerified);
  return { requests: local.length, inputTokens: verified ? local.reduce((n, r) => n + r.usage.input_tokens, 0) : null,
    outputTokens: verified ? local.reduce((n, r) => n + r.usage.output_tokens, 0) : null,
    unmeasuredRequests: local.filter(r => !r.usageVerified).length, costEstimateUsd: 0,
    scope: 'local inference only; paid search/fetch is accounted separately' };
}
export interface LocalModel { provider: string; model: string; selection: string; config: Record<string, any> }

// Read only the chosen local provider, never the desktop's UI/default settings.
export function localModel(file = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')): LocalModel {
  try {
    const document = parseDocument(readFileSync(file, 'utf8'), { prettyErrors: false, uniqueKeys: true });
    if (document.errors.length) throw new Error();
    const entries = document.toJS();
    // The desktop profile may rename the provider (strata-local, strata); the pinned
    // model and the loopback checks below are what identify it.
    const providers: Record<string, any> = entries.find((e: any) => e.id === 'llm-pi-ai')?.config?.providers ?? {};
    const found = Object.entries(providers).find(([, p]) => p?.models?.some((m: any) => m.id === 'iq3_s'));
    if (!found) throw new Error();
    const [provider, config] = found;
    const endpoint = new URL(config?.baseURL);
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || config.api !== 'openai-responses') throw new Error();
    const model = config.models?.find((m: any) => m.id === 'iq3_s');
    if (!model || !Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) throw new Error();
    // Explicit allowlist prevents custom headers/secrets or extra model routes
    // from silently broadening this integration.
    const safe = { displayName: config.displayName, apiKeyEnv: config.apiKeyEnv, api: config.api, baseURL: config.baseURL,
      models: [{ id: model.id, name: model.name, contextWindow: model.contextWindow, ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }), reasoningEfforts: model.reasoningEfforts }] };
    return { provider, model: model.id, selection: JSON.stringify([provider, model.id]), config: safe };
  } catch { throw new Error('LOCAL_MODEL_CONFIG_UNAVAILABLE: expected a provider with model iq3_s on a loopback OpenAI Responses endpoint in the DSH desktop profile; no cloud fallback'); }
}
