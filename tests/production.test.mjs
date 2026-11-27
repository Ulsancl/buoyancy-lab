import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { FuseV1Options, getCurrentFuseWire } from '@electron/fuses';
import { preview } from 'vite';
import { artifactDirectory } from '../scripts/safe-files.mjs';
import { verifySignature } from '../scripts/verify-signature.mjs';

const root = path.resolve(import.meta.dirname, '..');

async function checkRenderer(page) {
  await page.waitForSelector('#scene canvas', { timeout: 20_000 });
  assert.deepEqual(await page.evaluate(() => [
    typeof window.buoyancyLab, typeof window.advanceTime, typeof window.render_game_to_text,
  ]), ['undefined', 'undefined', 'undefined']);
  assert.equal(await page.locator('#immersion').textContent(), '40.0%');
  await page.locator('#mass-number').fill('0.6');
  await page.locator('#mass-number').press('Tab');
  await page.waitForFunction(() => document.querySelector('#immersion').textContent === '60.0%');
  assert.equal(await page.locator('#pressure-grid line').count(), 10);
}

async function checkWeb() {
  const server = await preview({ root, preview: { host: '127.0.0.1', port: 0, strictPort: true } });
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /form-action 'none'/);
    await checkRenderer(page);
    assert.deepEqual(consoleErrors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
}

async function checkPackaged() {
  const release = path.join(root, 'release', 'windows');
  const executable = path.join(release, 'win-unpacked', 'Buoyancy Lab.exe');
  const wire = await getCurrentFuseWire(executable);
  for (const setting of ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments']) {
    assert.equal(wire[FuseV1Options[setting]], '0'.charCodeAt(0), setting);
  }
  for (const setting of ['EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar']) {
    assert.equal(wire[FuseV1Options[setting]], '1'.charCodeAt(0), setting);
  }
  const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  const installer = path.join(release, `Buoyancy-Lab-Setup-${version}.exe`);
  assert.throws(() => verifySignature(installer, '0'.repeat(64)), /no trusted Authenticode signature/);

  // Playwright's Electron adapter requires the main-process inspector, which
  // is disabled on this build. Connect only to the temporary renderer port.
  const profile = artifactDirectory(root, path.join(root, 'output', 'production-smoke'));
  const env = { ...process.env, BUOYANCY_LAB_DATA_DIR: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, ['--remote-debugging-port=0'], {
    env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = once(child, 'close');
  let browser;
  try {
    const endpoint = await new Promise((resolve, reject) => {
      let output = '';
      const finish = callback => payload => { clearTimeout(timer); callback(payload); };
      const timer = setTimeout(finish(reject), 25_000, new Error('Packaged renderer did not start'));
      child.once('error', finish(reject));
      child.once('exit', code => finish(reject)(new Error(`Packaged executable exited with code ${code}`)));
      child.stderr.setEncoding('utf8').on('data', chunk => {
        output = (output + chunk).slice(-4096);
        const match = /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/.exec(output);
        if (match) finish(resolve)(match[1]);
      });
    });
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 20_000 });
    await page.waitForURL('app://buoyancy/');
    await checkRenderer(page);
    await page.evaluate(() => setTimeout(() => window.close(), 0));
    const [code] = await Promise.race([
      exited, new Promise(resolve => setTimeout(resolve, 8_000, [-1]).unref()),
    ]);
    assert.equal(code, 0, 'The packaged application should exit normally');
  } finally {
    await browser?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  }
}

if (process.argv[2] === 'desktop') await checkPackaged();
else await checkWeb();
console.log('Production build checks passed.');
