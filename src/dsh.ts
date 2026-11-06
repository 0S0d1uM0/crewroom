import { existsSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { Launch } from './acp.js';
import YAML from 'yaml';
import type { LocalModel } from './models.js';
import type { ShellGrant } from './shell-policy.js';
import { randomUUID } from 'node:crypto';

export function mockLaunch(home: string): Launch {
  return { command: process.execPath, args: [fileURLToPath(new URL('./mock-agent.js', import.meta.url))], cwd: home, env: { ...process.env, MOCK_HOME: join(home, 'mock-sessions') } };
}
export function dshLaunch(home: string, live?: { baseURL: string; maxOutputTokens: number | null; research?: boolean; allowWrite?: boolean; exam?: boolean; shell?: ShellGrant; workspace?: string; local?: { model: LocalModel; baseURL: string } }): Launch {
  const install = process.env.CREWROOM_DSH_INSTALL ?? 'D:\\DSH';
  const command = join(install, 'DeepSeek Harness.exe');
  const entry = join(install, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
  if (!existsSync(command)) throw new Error('DSH executable not found; set CREWROOM_DSH_INSTALL to the installation directory');
  const dshHome = join(home, 'dsh-home');
  const workspace = join(home, 'probe-workspace');
  mkdirSync(dshHome, { recursive: true }); mkdirSync(workspace, { recursive: true });
  const patch = join(home, 'dsh-readonly.patch.yml');
  const policyReady = live ? join(home, 'shell-policy-' + randomUUID() + '.ready') : undefined;
  const mode = live?.research ? live.shell?.mode ?? (live.allowWrite ? 'workspace-write' : 'read-only') : 'read-only';
  writeFileSync(patch, `# Only this isolated launch is affected. No global configuration changes.\n` +
    `- id: sandbox-policy\n  config:\n    mode: ${mode}\n    workspaceRoot: ${JSON.stringify(live?.workspace ?? workspace)}\n` +
    `- id: approval\n  config:\n    policy: ask\n` +
    ['tool-subagent', 'tool-subagent-fork', 'tool-subagent-control', 'tool-subagent-list-agents', 'tool-workflow', 'session-title-llm', 'session-telemetry-otel', ...(live ? ['llm-retry', 'tool-pwsh', 'tool-bash', 'tool-jobs', 'tool-skill', 'tool-goal', 'tool-todo', ...(live.research ? ['web-search-deepseek', 'web-fetch-http'] : ['tool-web', 'tool-fs', 'tool-fs-search'])] : [])]
      .map(id => `- id: ${id}\n  disabled: true\n`).join('') +
    (live ? `- id: credentials\n  config:\n    path: ${JSON.stringify(join(homedir(), '.dsh', '.credentials.yaml'))}\n` +
      `- id: llm-deepseek\n  config:\n    baseURL: ${JSON.stringify(live.baseURL)}\n` + (live.maxOutputTokens === null ? '' : `    maxTokens: ${live.maxOutputTokens}\n`) +
      `- id: web-search-deepseek\n  config:\n    baseURL: ${JSON.stringify(live.baseURL + '/v1')}\n` : ''), { mode: 0o600 });
  if (live?.research) {
    const extra = `- id: web\n  config:\n    searchProvider: deepseek-search-api\n    fetchProvider: deepseek-fetch-api\n` +
      `- id: web-deepseek-api\n  disabled: false\n  config:\n    baseURL: ${JSON.stringify(live.baseURL.replace(/\/anthropic$/, '/v1/tools'))}\n    count: 5\n    sendOriginalQuestion: false\n` +
      `- id: tool-fs\n  disabled: false\n  config:\n    read: true\n    readImage: false\n    write: ${!!live.allowWrite}\n    edit: ${!!live.allowWrite}\n    readMaxBytes: 32768\n`;
    // This file is generated only for our isolated process.
    appendFileSync(patch, extra);
  }
  if (live?.local) {
    appendFileSync(patch, YAML.stringify([{ id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers: {
      [live.local.model.provider]: { ...live.local.model.config, baseURL: live.local.baseURL, retryPolicy: { mode: 'normal', maxRetries: 0 } },
    } } }]));
  }
  if (live) {
    if (live.shell && !live.research) throw new Error('Shell requires the persistent collaboration policy');
    const profile = join(dshHome, 'profiles', 'acp');
    mkdirSync(profile, { recursive: true });
    if (!existsSync(join(profile, 'package.json'))) writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'collab-isolated-acp', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] } } }));
    // New plugins require the official insert patch operation; an id/name
    // override alone is silently ignored when the id does not already exist.
    writeFileSync(join(profile, 'cordis.patch.yml'), YAML.stringify([{ insert: [{ id: 'crewroom-shell-policy', name: fileURLToPath(new URL('./shell-policy-plugin.js', import.meta.url)), config: { workspace: live.workspace ?? workspace, allowWrite: !!live.allowWrite, exam: !!live.exam, shell: live.shell, readyPath: policyReady } }] }]));
    if (live.shell) appendFileSync(patch, YAML.stringify([
      ...(live.shell ? [{ id: 'tool-pwsh', disabled: false, config: { enableRunInBackground: false, promoteOnTimeout: false } }] : []),
    ]));
  }
  // Offline control probes intentionally have no API credentials, even if the caller has them.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome, DSH_PERMISSION_MODE: mode };
  for (const key of Object.keys(env)) if (/^(DEEPSEEK_|OPENAI_|ANTHROPIC_)/.test(key)) delete (env as NodeJS.ProcessEnv)[key];
  return { command, args: ['--expose-internals', entry, '--profile', 'acp', '--patch', patch], cwd: workspace, env, policyReady };
}
