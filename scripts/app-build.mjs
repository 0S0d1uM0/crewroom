import { copyFileSync } from 'node:fs';
copyFileSync(new URL('../src/app/electron/preload.cjs', import.meta.url), new URL('../dist/app/electron/preload.cjs', import.meta.url));
