import { rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve, sep } from 'node:path';

export function removeTestHome(home) {
  const target = realpathSync(home), root = realpathSync(tmpdir());
  const normalize = x => process.platform === 'win32' ? x.toLowerCase() : x;
  if (!normalize(target).startsWith(normalize(root + sep)) || !/^collab-(test|cli|recovery|budget)-/.test(basename(target))) throw new Error('Refusing to remove a path outside an owned test directory');
  rmSync(target, { recursive: true, force: true });
}
