import { checkedPath, readInput, copyInput, stagingDirectory, publishDirectory, writeArtifact, checkTree } from './safe-files.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { buildWeb } from './build-web.mjs';
import { requirePublisherFingerprint, verifySignature } from './verify-signature.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
if (!['start', 'package', 'prepare-test', 'package-test', 'package-release'].includes(mode)) throw new Error('Unknown desktop mode');
if (mode === 'prepare-test' && process.env.BUOYANCY_DESKTOP_EXE) process.exit(0);
const testPackage = mode === 'package-test', signedRelease = mode === 'package-release';
const expectedPublisher = signedRelease ? requirePublisherFingerprint(process.env.BUOYANCY_SIGNER_SHA256) : null;
if (signedRelease && process.platform !== 'win32') throw new Error('Build and verify the signed release on Windows');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
if (!signedRelease) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  for (const key of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD']) delete env[key];
}
function run(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Process exited with code ${code}`)));
  });
}
for (const input of ['src', 'public', 'desktop', 'docs', 'node_modules/electron']) checkTree(root, path.join(root, input));
const electronPackage = path.dirname(require.resolve('electron/package.json'));
await run(process.execPath, [path.join(electronPackage, 'install.js')]);
if (mode === 'start' || mode === 'prepare-test') {
  await buildWeb({ testHooks: mode === 'prepare-test' });
  if (mode === 'start') await run(require('electron'), [root]);
} else {
  const stage = stagingDirectory(root), app = path.join(stage, 'app'), output = path.join(stage, 'windows');
  try {
    const configuration = JSON.parse(readInput(root, path.join(root, 'electron-builder.json')));
    const packageInfo = JSON.parse(readInput(root, path.join(root, 'package.json')));
    const optionsFile = path.join(stage, 'builder.json');
    if (testPackage) configuration.electronFuses.enableNodeCliInspectArguments = true;
    if (signedRelease) configuration.forceCodeSigning = true;
    fs.writeFileSync(optionsFile, JSON.stringify(configuration), { flag: 'wx', mode: 0o600 });
    const inputs = [...new Set(['desktop', 'package.json', configuration.directories.buildResources, ...configuration.files.filter(file => !file.includes('*')), ...configuration.extraResources.map(item => item.from)])];
    for (const input of inputs.filter(file => !inputs.some(parent => file !== parent && file.startsWith(parent + '/')))) {
      copyInput(root, path.join(root, input), path.join(app, input));
    }
    for (const dependency of Object.keys(packageInfo.dependencies || {})) {
      copyInput(root, path.join(root, 'node_modules', dependency), path.join(app, 'node_modules', dependency));
    }
    await buildWeb({ testHooks: testPackage, output: path.join(app, 'dist') });
    const electronDist = checkedPath(root, path.join(root, 'node_modules', 'electron', 'dist'));
    checkTree(root, electronDist);
    await run(process.execPath, [path.join(path.dirname(require.resolve('electron-builder/package.json')), 'cli.js'),
      '--win', ...(testPackage ? ['--dir'] : ['nsis']), '--x64', '--config', optionsFile,
      '--projectDir', app, `--config.electronDist=${electronDist}`, `--config.directories.output=${output}`,
      '--config.npmRebuild=false', '--publish', 'never']);
    const destination = testPackage ? path.join(root, 'output', 'desktop-instrumented') : path.join(root, 'release', 'windows');
    if (!testPackage) {
      const file = path.join(output, `Buoyancy-Lab-Setup-${packageInfo.version}.exe`);
      if (signedRelease) {
        verifySignature(file, expectedPublisher);
        verifySignature(path.join(output, 'win-unpacked', 'Buoyancy Lab.exe'), expectedPublisher);
      }
      writeArtifact(root, file + '.sha256', `${createHash('sha256').update(readInput(root, file)).digest('hex')}  ${path.basename(file)}\n`);
      console.log(`Installer: ${path.join(destination, path.basename(file))}`);
    }
    checkTree(root, output);
    publishDirectory(root, output, destination);
  } finally {
    checkTree(root, stage);
    fs.rmSync(stage, { recursive: true });
  }
}
