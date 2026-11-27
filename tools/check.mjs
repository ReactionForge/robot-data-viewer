import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

for (const directory of ['.', 'tools', 'tests']) {
  for (const name of readdirSync(directory)) {
    if (!/\.(?:js|mjs)$/.test(name)) continue;
    const result = spawnSync(process.execPath, ['--check', directory + '/' + name], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1);
  }
}
console.log('JavaScript source and test syntax checked.');