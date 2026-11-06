import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { scrubbedEnv } from '../env.js';
import { redact } from '../../config.js';
import type { Launch } from '../../acp.js';

export class JsonRpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  private dead?: Error;
  private next = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  onNotification: (method: string, params: any) => void = () => {};
  onRequest: (method: string, params: any) => Promise<unknown> = async () => { throw new Error('Unsupported server request'); };
  constructor(launch: Launch) {
    this.child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: scrubbedEnv(launch.env), windowsHide: true, shell: false, stdio: 'pipe' });
    this.child.stdin.on('error', () => {});
    // Keep only a redacted tail, so an exit at startup can say why.
    let stderr = '';
    this.child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000); });
    this.closed = new Promise(resolve => {
      const finish = (error: Error) => { if (this.dead) return; this.dead = error; for (const p of this.pending.values()) p.reject(error); this.pending.clear(); resolve(); };
      this.child.once('exit', code => finish(new Error(`HARNESS_EXITED (${code})${stderr ? ': ' + redact(stderr).trim() : ''}`)));
      this.child.once('error', error => finish(error));
    });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let f: any; try { f = JSON.parse(line); } catch { return; }
      if (f.method && f.id !== undefined) {
        void this.onRequest(f.method, f.params ?? {}).then(result => this.send({ jsonrpc: '2.0', id: f.id, result }), error => this.send({ jsonrpc: '2.0', id: f.id, error: { code: -32601, message: String(error) } }));
      } else if (f.method) this.onNotification(f.method, f.params ?? {});
      else if (f.id !== undefined) {
        const p = this.pending.get(f.id); this.pending.delete(f.id);
        if (f.error) p?.reject(new Error(`${JSON.stringify(f.error)}`)); else p?.resolve(f.result);
      }
    });
  }
  private send(frame: unknown) { if (!this.dead) this.child.stdin.write(JSON.stringify(frame) + '\n'); }
  notify(method: string, params?: unknown) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method: string, params?: unknown, timeoutMs = 60000): Promise<any> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async stop() {
    if (this.dead) return;
    this.child.stdin.end();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.closed, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]); clearTimeout(timer);
    if (!this.dead) {
      if (process.platform === 'win32' && this.child.pid) {
        const killer = spawn('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { env: scrubbedEnv(), windowsHide: true, stdio: 'ignore' });
        await new Promise<void>(resolve => { killer.once('exit', () => resolve()); killer.once('error', () => resolve()); });
      } else this.child.kill('SIGKILL');
      await this.closed;
    }
  }
}
