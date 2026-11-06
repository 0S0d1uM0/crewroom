import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { scrubbedEnv } from '../dist/platform/env.js';
const require = createRequire(import.meta.url);
const child = spawn(require('electron'), [fileURLToPath(new URL('../dist/app/electron/main.js', import.meta.url))], { env: scrubbedEnv(), stdio: 'inherit', windowsHide: true, shell: false });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
