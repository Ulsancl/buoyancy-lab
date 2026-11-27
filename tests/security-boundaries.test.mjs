import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { readBounded } from '../desktop/bounded-read.cjs';
import { appendLog, openProfileDirectory, readWindowState, writeWindowState } from '../desktop/profile-files.cjs';
import { createProject, MAX_PROJECT_BYTES, parseProject, serializeProject } from '../src/project.js';
import { requirePublisherFingerprint } from '../scripts/verify-signature.mjs';
import { stagingDirectory } from '../scripts/safe-files.mjs';

test('read budget is enforced across short reads and a file that supplies an extra byte', async () => {
  const limit = 16;
  const file = size => ({
    position: 0,
    async read(buffer, offset, length, position) {
      assert.equal(buffer.length, limit + 1);
      assert.equal(position, this.position);
      assert.ok(position + length <= limit + 1);
      const bytesRead = Math.min(3, length, size - position);
      buffer.fill(65, offset, offset + bytesRead);
      this.position += bytesRead;
      return { bytesRead };
    },
  });
  const exact = file(limit);
  assert.equal((await readBounded(exact, limit, 'oversized')).toString(), 'A'.repeat(limit));
  const growing = file(1024);
  await assert.rejects(readBounded(growing, limit, 'oversized'), /oversized/);
  assert.equal(growing.position, limit + 1);
});

test('project cap counts UTF-8 bytes and accepts well-formed legacy data with BOM and whitespace', () => {
  const value = createProject();
  const text = '\ufeff' + serializeProject(value);
  const padded = text + ' '.repeat(MAX_PROJECT_BYTES - Buffer.byteLength(text));
  assert.deepEqual(parseProject(padded), value);
  assert.throws(() => parseProject(padded + ' '), { code: 'PROJECT_TOO_LARGE' });
  assert.throws(() => parseProject('한'.repeat(MAX_PROJECT_BYTES / 2)), { code: 'PROJECT_TOO_LARGE' });
});

test('profile rejects linked locations and linked state files and bounds state and logging', async t => {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'buoyancy-profile-'));
  t.after(async () => {
    assert.equal(await fs.realpath(directory), directory);
    await fs.rm(directory, { recursive: true });
  });
  const profile = openProfileDirectory(directory, 'app');
  const elsewhere = path.join(directory, 'elsewhere');
  await fs.mkdir(elsewhere);
  const link = path.join(directory, 'link');
  await fs.symlink(elsewhere, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => openProfileDirectory(directory, 'app', path.join(link, 'profile')), /real directory/);
  assert.deepEqual(await fs.readdir(elsewhere), []);
  const state = path.join(profile, 'window.json');
  const log = path.join(profile, 'desktop.log');
  await fs.writeFile(state, ' '.repeat(4097));
  assert.deepEqual(readWindowState(profile), {});
  const bounds = { x: 25, y: 31, width: 1000, height: 800, maximized: false };
  writeWindowState(profile, bounds);
  assert.deepEqual(readWindowState(profile), bounds);
  const target = path.join(elsewhere, 'keep.txt');
  await fs.writeFile(target, 'fixture');
  await fs.unlink(state);
  await fs.link(target, state);
  await fs.link(target, log);
  assert.deepEqual(readWindowState(profile), {});
  assert.throws(() => writeWindowState(profile, bounds), /Invalid profile file/);
  assert.throws(() => appendLog(profile, 'message'), /Invalid profile file/);
  assert.equal(await fs.readFile(target, 'utf8'), 'fixture');
  await fs.unlink(log);
  await fs.writeFile(log, ' '.repeat(128 * 1024));
  appendLog(profile, 'bounded entry');
  assert.match(await fs.readFile(log, 'utf8'), /^\S+ bounded entry\n$/);
});

test('development server denies staged diagnostics while serving the app', async t => {
  const root = path.resolve(import.meta.dirname, '..');
  const stage = stagingDirectory(root);
  t.after(async () => {
    assert.equal(await fs.realpath(stage), stage);
    await fs.rm(stage, { recursive: true });
  });
  await fs.writeFile(path.join(stage, 'diagnostics.json'), '{}');
  const server = await createServer({ root, server: { port: 0, hmr: false } });
  try {
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
    assert.equal((await fetch(url)).status, 200);
    const denied = await fetch(new URL(`${path.basename(stage)}/diagnostics.json`, url));
    assert.equal(denied.status, 403);
  } finally { await server.close(); }
});

test('release packaging requires an explicit full signing certificate fingerprint', () => {
  assert.throws(() => requirePublisherFingerprint(undefined), /BUOYANCY_SIGNER_SHA256/);
  assert.throws(() => requirePublisherFingerprint('a'.repeat(40)), /BUOYANCY_SIGNER_SHA256/);
  assert.equal(requirePublisherFingerprint('a'.repeat(64)), 'A'.repeat(64));
});
