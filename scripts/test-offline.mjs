import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
const base = resolve('.test-state'); mkdirSync(base, {recursive:true});
const root = mkdtempSync(join(base, 'suite-'));
const child = spawn(process.execPath, ['--test','--test-concurrency=1',...process.argv.slice(2)], {
  stdio:'inherit', windowsHide:true, env:{...process.env, TMP:root,TEMP:root,TMPDIR:root,
    CREWROOM_HOME:join(root,'app-home'),GIT_CEILING_DIRECTORIES:base}
});
const code = await new Promise((yes,no)=>{child.on('error',no);child.on('exit',yes);});
if (!resolve(root).startsWith(base + sep)) throw Error('Test cleanup escaped workspace');
rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
process.exitCode=code ?? 1;
