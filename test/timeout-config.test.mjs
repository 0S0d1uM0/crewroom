import test from 'node:test';
import assert from 'node:assert/strict';
import { configSchema, limitsSchema } from '../dist/config.js';

test('default prompt execution window is thirty minutes, matching the task window', () => {
  const config = configSchema.parse({});
  assert.equal(config.limits.promptTimeoutMs, 1_800_000);
  assert.equal(config.limits.taskTimeoutMs, 1_800_000);
});

test('explicit shorter execution windows remain supported and the thirty-minute bound remains enforced', () => {
  assert.equal(limitsSchema.parse({ promptTimeoutMs: 600_000 }).promptTimeoutMs, 600_000);
  assert.equal(limitsSchema.parse({ promptTimeoutMs: 1_800_000 }).promptTimeoutMs, 1_800_000);
  assert.throws(() => limitsSchema.parse({ promptTimeoutMs: 1_800_001 }));
});
