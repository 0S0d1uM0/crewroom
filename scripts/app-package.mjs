import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export function productionPaths(lock) {
  return Object.entries(lock.packages).filter(([path, pkg]) => path.startsWith('node_modules/') && !pkg.dev && !pkg.devOptional && !/(^|\/)node_modules\/(electron|typescript|@types)(\/|$)/.test(path)).map(([path]) => path).sort((a, b) => a.length - b.length);
}
export function packageApp(root) {
  const release = join(root, 'release'), target = join(release, 'Crewroom'), stage = join(release, 'Crewroom.staging'), backup = join(release, 'Crewroom.previous');
  mkdirSync(release, { recursive: true });
  const busy = error => new Error('无法替换打包目录；请退出 release/Crewroom、Crewroom.staging 或 Crewroom.previous 中正在运行的 App，并检查文件占用。', { cause: error });
  try {
    // Windows denies write access to a running image. Check before touching the old tree.
    if (existsSync(join(target, 'Crewroom.exe'))) closeSync(openSync(join(target, 'Crewroom.exe'), 'r+'));
    rmSync(backup, { recursive: true, force: true });
    rmSync(stage, { recursive: true, force: true });
  } catch (error) { throw busy(error); }
  try {
    cpSync(join(root, 'node_modules/electron/dist'), stage, { recursive: true });
    renameSync(join(stage, 'electron.exe'), join(stage, 'Crewroom.exe'));
    rmSync(join(stage, 'resources/default_app.asar'), { force: true });
    const dest = join(stage, 'resources/app'); mkdirSync(dest, { recursive: true });
    for (const folder of ['dist', 'ui', 'assets']) cpSync(join(root, folder), join(dest, folder), { recursive: true });
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
    for (const path of productionPaths(lock)) {
      const source = join(root, path); if (!existsSync(source) && lock.packages[path].optional) continue;
      const output = join(dest, path); mkdirSync(dirname(output), { recursive: true });
      cpSync(source, output, { recursive: true, filter: path => path === source || !['node_modules', '.bin'].includes(basename(path)) });
    }
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    writeFileSync(join(dest, 'package.json'), JSON.stringify({ name: 'crewroom', version: pkg.version, type: 'module', main: 'dist/app/electron/main.js', dependencies: pkg.dependencies }, null, 2));
    // Publish only a complete package; restore the previous tree if publication fails.
    try {
      if (existsSync(target)) renameSync(target, backup);
      try { renameSync(stage, target); }
      catch (error) { if (existsSync(backup)) renameSync(backup, target); throw error; }
    } catch (error) { throw busy(error); }
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
  try { rmSync(backup, { recursive: true, force: true }); }
  catch (error) { throw new Error('新打包产物已完整生成，但旧目录 Crewroom.previous 无法清理；请退出旧 App 后重试。', { cause: error }); }
  return target;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(packageApp(fileURLToPath(new URL('../', import.meta.url))));
