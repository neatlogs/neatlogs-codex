import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedCode } from './isolation.mjs';

const directory = await isolatedCode();
try {
  for (const args of [
    ['test', '!', '-w', directory],
    ['test', '-r', join(directory, 'dist/cli.js')],
    ['test', '-r', join(directory, 'node_modules/protobufjs/package.json')],
    ['env', '-i', `PATH=${process.env.PATH}`, 'HOME=/tmp', process.execPath, join(directory, 'dist/cli.js'), '--help'],
  ]) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn('sudo', ['-n', '-u', 'nobody', '--', ...args], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('close', resolve);
    });
    if (code !== 0) throw new Error(`Isolated CLI check failed: ${args.slice(0, 3).join(' ')}`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
