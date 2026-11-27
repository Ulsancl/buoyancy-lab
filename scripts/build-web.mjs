import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { appConfig } from '../vite.config.js';
import { checkTree, copyInput, publishDirectory, stagingDirectory } from './safe-files.mjs';

const root = path.resolve(import.meta.dirname, '..');

export async function buildWeb({ testHooks = false, output = path.join(root, 'dist') } = {}) {
  const stage = stagingDirectory(root);
  const input = path.join(stage, 'web');
  const bundle = path.join(stage, 'bundle');
  try {
    for (const entry of ['index.html', 'src', 'public']) {
      copyInput(root, path.join(root, entry), path.join(input, entry));
    }
    checkTree(root, path.join(root, 'node_modules', 'three'));
    const mode = testHooks ? 'desktop-test' : 'production';
    await build({
      ...appConfig({ command: 'build', mode }),
      configFile: false,
      mode,
      root: input,
      cacheDir: path.join(stage, 'cache'),
      build: { outDir: bundle, emptyOutDir: false },
    });
    checkTree(root, bundle);
    publishDirectory(root, bundle, output);
  } finally {
    checkTree(root, stage);
    fs.rmSync(stage, { recursive: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildWeb();
