import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { methods } from '@agentclientprotocol/sdk';
import { AcpAdapter } from './acp.js';
import { dshLaunch } from '../../dsh.js';
import { localModel, type LocalModel } from '../../models.js';
import type { MemberConfig } from '../config.js';
import type { Launch } from '../../acp.js';

export function disableSandbox(patch: string) {
  const updated = patch.replace(/(- id: sandbox-policy\r?\n\s+config:\r?\n\s+mode: )\S+/, '$1danger-full-access');
  if (!updated.includes('mode: danger-full-access')) throw new Error('DSH launch patch has no sandbox-policy mode; no inference submitted');
  return updated;
}
// A local member keeps the cloud route pointed at a closed port, so it can never spend money. A
// member that chose DeepSeek gets DSH's own route, using the credentials DSH itself holds.
export function useDirectCloud(patch: string) {
  const updated = patch.replace(/- id: llm-deepseek\r?\n\s+config:\r?\n\s+baseURL: .*\r?\n/, '');
  if (updated === patch) throw new Error('DSH launch patch has no DeepSeek route; no inference submitted');
  return updated;
}
// The launch points every cloud service at a closed port. Only the model route should stay closed for
// a local member: search and fetch are services the user wants members to have.
export function restoreWebServices(patch: string) {
  const updated = patch.replace(/- id: web-search-deepseek\r?\n\s+config:\r?\n\s+baseURL: .*\r?\n/, '').replace(/(- id: web-deepseek-api\r?\n\s+disabled: false\r?\n\s+config:\r?\n)\s+baseURL: .*\r?\n/, '$1');
  if (updated === patch || /baseURL: "http:\/\/127\.0\.0\.1:9\/(anthropic\/v1|v1\/tools)"/.test(updated)) throw new Error('DSH launch patch has an unexpected web configuration; no inference submitted');
  return updated;
}
export class DshAdapter extends AcpAdapter {
  private inbox: string;
  constructor(private member: MemberConfig, workspace: string, sessionDir: string, private testOptions?: { launch: Launch; model: LocalModel }) {
    super(workspace, sessionDir, true); this.inbox = join(sessionDir, 'members', member.name, 'inbox');
  }
  async resume(id: string, instructions: string) { await this.open(instructions, id); }
  async start(instructions: string) { await this.open(instructions); }
  private async open(instructions: string, id?: string) {
    const cloud = this.member.model !== 'local';
    mkdirSync(this.inbox, { recursive: true });
    const model = cloud ? undefined : this.testOptions?.model ?? localModel();
    const home = join(this.sessionDir, 'members', this.member.name);
    const launch = this.testOptions?.launch ?? dshLaunch(home, { baseURL: 'http://127.0.0.1:9/anthropic', maxOutputTokens: null,
      research: true, allowWrite: true, workspace: this.workspace, shell: { mode: 'workspace-write' }, ...(model ? { local: { model, baseURL: model.config.baseURL } } : {}) });
    if (!this.testOptions) {
      const file = join(home, 'dsh-home', 'profiles', 'acp', 'cordis.patch.yml');
      const patch = YAML.parse(readFileSync(file, 'utf8'));
      // The platform's plugin replaces collab's guard here: that one would put the session back
      // in a sandbox, and DSH's sandbox blocks child processes with pipes, so test runners fail.
      const dshPackages = join(process.env.CREWROOM_DSH_INSTALL ?? 'D:\\DSH', 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
      const readyPath = patch[0].insert.find((p: any) => p.id === 'crewroom-shell-policy')?.config?.readyPath;
      if (!readyPath) throw new Error('DSH launch has no guard readiness path; no inference submitted');
      patch[0].insert = [{ id: 'crewroom-platform-steer', name: fileURLToPath(new URL('../dsh-steer-plugin.js', import.meta.url)), config: {
        inbox: this.inbox, readyPath, workspace: this.workspace, sessionDir: this.sessionDir,
        llmModule: join(dshPackages, 'dsh-llm', 'lib', 'index.js'),
        ...(this.tools?.endpoint ? { toolsModule: join(dshPackages, 'dsh-tools', 'lib', 'index.js'), tools: this.tools.definitions, toolEndpoint: this.tools.endpoint } : {}),
      } }];
      writeFileSync(file, YAML.stringify(patch));
      const launchPatch = launch.args[launch.args.indexOf('--patch') + 1]!;
      const launchText = restoreWebServices(disableSandbox(readFileSync(launchPatch, 'utf8')));
      writeFileSync(launchPatch, cloud ? useDirectCloud(launchText) : launchText);
      launch.env = { ...launch.env, DSH_PERMISSION_MODE: 'danger-full-access' };
    }
    await this.connect({ ...launch, cwd: this.workspace });
    this.sessionId = await this.worker!.session(this.workspace, id ?? null);
    await this.worker!.selectModel(this.sessionId, model?.selection ?? this.member.model);
    // A paid route defaults to high, so a level that did not take must not reach inference silently.
    if (this.member.effort) {
      const applied: any = await this.setOption('reasoning_effort', this.member.effort);
      const current = applied.configOptions?.find((o: any) => o.id === 'reasoning_effort')?.currentValue;
      if (current !== this.member.effort) throw new Error(`EFFORT_NOT_APPLIED: requested ${this.member.effort}, received ${current}; no inference submitted`);
    }
    this.prefix = instructions + '\n\n';
    this.ready = true;
  }
  private setOption(configId: string, value: string) {
    return this.worker!.bounded(this.worker!.connection.agent.request(methods.agent.session.setConfigOption, { sessionId: this.sessionId!, configId, value }), 10000);
  }
  // Everything DSH can route to. Sends no prompt.
  async modelCatalog() {
    const local = (this.testOptions?.model ?? localModel()).selection;
    const flat = (option: any) => (option?.options ?? []).flatMap((o: any) => o.options ?? [o]);
    const first: any = await this.setOption('model', local);
    const entries = [];
    for (const o of flat(first.configOptions?.find((c: any) => c.id === 'model'))) {
      // Levels and the default differ by route: the local model has none of its own, DeepSeek defaults to high.
      const reasoning = (await this.setOption('model', o.value) as any).configOptions?.find((c: any) => c.id === 'reasoning_effort');
      const levels = { efforts: flat(reasoning).map((e: any) => String(e.value)).filter(Boolean), ...(reasoning?.currentValue ? { defaultEffort: String(reasoning.currentValue) } : {}) };
      if (o.value === local) { entries.push({ id: 'local', label: `${o.name}（本地，免费）`, description: o.description, ...levels, available: true }); continue; }
      let provider = ''; try { provider = JSON.parse(o.value)[0]; } catch {}
      entries.push({ id: String(o.value), label: `${o.name}（${provider}，按量计费）`, description: o.description, ...levels, available: true });
    }
    // The form preselects the first entry, and paying has to be something the user chooses.
    return [...entries.filter((e: any) => e.id === 'local'), ...entries.filter((e: any) => e.id !== 'local')];
  }
  async steer(text: string): Promise<'steered' | 'idle' | 'unsupported'> {
    if (!this.busy) return 'idle';
    const path = join(this.inbox, randomUUID() + '.json');
    writeFileSync(path + '.tmp', JSON.stringify({ sessionId: this.sessionId, text })); renameSync(path + '.tmp', path);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (existsSync(path + '.taken.ok')) return 'steered';
      if (existsSync(path + '.taken.err')) return 'unsupported';
      if (!this.busy && existsSync(path)) { renameSync(path, path + '.cancelled'); return 'idle'; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    // Revoke an unclaimed envelope so a fallback prompt cannot later be duplicated.
    if (existsSync(path)) { try { renameSync(path, path + '.cancelled'); } catch {} }
    return 'unsupported';
  }
}
