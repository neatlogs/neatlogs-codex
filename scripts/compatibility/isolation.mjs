import { chmod, cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Make a runner-owned copy that the unprivileged handler can read but cannot edit. */
export async function isolatedCode(includeTests = false) {
  const directory = await mkdtemp(join(tmpdir(), 'neatlogs-codex-code-'));
  await chmod(directory, 0o755);
  try {
    const paths = includeTests
      ? ['dist', 'node_modules', 'package.json', 'src', 'test', 'tsconfig.json', 'tsup.config.ts', 'hooks', '.codex-plugin']
      : ['dist', 'node_modules', 'package.json'];
    for (const path of paths) await cp(join(root, path), join(directory, path), { recursive: true, dereference: true });
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
