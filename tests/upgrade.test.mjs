// Opt-in two-phase compatibility test. Never installs or deletes anything.
// prepare-old uses the immutable 0.1 runtime; check-new uses installed 1.0.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// Explicit paths make this opt-in Windows test portable; it never installs an app.
// Required both phases: BUOYANCY_UPGRADE_GPU_START, _WORKSPACE, _BASELINE,
// _OLD_PACKAGE, _OUTPUT, _BASELINE_SHA256, _PACKAGE_MANIFEST_SHA256.
// check-new additionally requires _NEW_EXE, _NEW_ASAR_SHA256 and _PREPARED_SHA256.
const mode = process.argv[2];
assert.ok(['prepare-old', 'check-new'].includes(mode), 'Use prepare-old or check-new');
const preparing = mode === 'prepare-old', version = preparing ? '0.1.0' : '1.0.0';
assert.equal(process.platform, 'win32');
assert.equal(process.env.BUOYANCY_UPGRADE_GPU_START, version, 'Explicit GPU phase/version authorization is required');
function envPath(name) {
  const value = process.env['BUOYANCY_UPGRADE_' + name];
  assert.ok(value && path.isAbsolute(value), name + ' requires an absolute path');
  return path.resolve(value);
}
function approvedHash(name) {
  const value = process.env['BUOYANCY_UPGRADE_' + name];
  assert.match(value ?? '', /^[a-f0-9]{64}$/, name + ' requires an approved SHA256'); return value;
}
const root = envPath('WORKSPACE'), appRoot = path.resolve(import.meta.dirname, '..');
const baseline = envPath('BASELINE'), oldPackage = envPath('OLD_PACKAGE'), output = envPath('OUTPUT');
const baselineHash = approvedHash('BASELINE_SHA256'), packageManifestHash = approvedHash('PACKAGE_MANIFEST_SHA256');
const oldHash = 'b35301b0ba333e98af44b1c0a21904aa9f7b11fd3e052db2301af7dfbc52c688';
const oldInstallerHash = '6134c68f51e5bcdc8a3688c48f8e36754f942b983c7db344b6cfc5f22728944f';
const installed = path.join(process.env.LOCALAPPDATA, 'Programs/Buoyancy Lab');
const executablePath = preparing ? path.join(oldPackage, 'win-unpacked/Buoyancy Lab.exe') : envPath('NEW_EXE');
if (!preparing) assert.equal(executablePath, path.join(installed, 'Buoyancy Lab.exe'), 'Use the actual per-user installed 1.0 executable');
const runtime = path.dirname(executablePath), asarFile = path.join(runtime, 'resources/app.asar');
const profile = path.join(output, 'profile'), originalProfile = path.join(process.env.APPDATA, 'Buoyancy Lab');
function inside(child, parent) { const relative = path.relative(parent, child); return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
for (const directory of [baseline, oldPackage, output]) assert.ok(inside(directory, root), 'All evidence paths must stay inside the supplied workspace');
assert.ok(inside(output, path.join(root, 'output')), 'Synthetic output must be a new workspace/output child');
for (const protectedPath of [baseline, oldPackage, appRoot, installed, originalProfile]) {
  assert.notEqual(output.toLowerCase(), protectedPath.toLowerCase());
  assert.equal(!!inside(output, protectedPath) || !!inside(protectedPath, output), false, 'Output cannot overlap protected sources, runtime or profiles');
}
const oldReportFile = path.join(output, 'old-report.json'), reportFile = preparing ? oldReportFile : path.join(output, 'new-report.json');
const projectFile = path.join(output, 'old-native-observation.buoyancy.json'), newProjectFile = path.join(output, 'new-native-observation.buoyancy.json');
const bomFile = path.join(output, 'old-UTF8-BOM.buoyancy.json'), originalFile = path.join(output, 'old-recovered-original.txt');
const storageKey = 'buoyancy-lab-project-v1', syntheticOriginal = '\ufeff{Buoyancy Lab 0.1 synthetic original\r\n업데이트 뒤에도 보존 ♪\t"미완료": true\0';
const require = createRequire(path.join(appRoot, 'package.json'));
const { _electron: electron } = require('playwright'), asar = require('@electron/asar'), exec = promisify(execFile);
const slash = value => value.replaceAll('\\', '/');
async function hash(file) { const h = createHash('sha256'); for await (const bytes of createReadStream(file)) h.update(bytes); return h.digest('hex'); }
async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function ordinary(file) {
  assert.ok(path.isAbsolute(file));
  for (let current = file; ; current = path.dirname(current)) {
    if (await exists(current)) assert.equal((await fs.lstat(current)).isSymbolicLink(), false, `Linked path: ${current}`);
    if (path.dirname(current) === current) break;
  }
}
async function tree(directory) {
  if (!await exists(directory)) return null;
  await ordinary(directory); const records = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name); assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) await visit(file);
      else { assert.ok(entry.isFile()); records.push({ path: slash(path.relative(directory, file)), bytes: (await fs.stat(file)).size, sha256: await hash(file) }); }
    }
  }
  await visit(directory); return records.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
async function buoyancyProcesses() {
  const { stdout } = await exec(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='Buoyancy Lab.exe'\" | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress"], {
    windowsHide: true,
    env: { ...process.env, PSModulePath: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules') },
  });
  const result = stdout.trim() ? JSON.parse(stdout) : []; return Array.isArray(result) ? result : [result];
}
for (const [directory, expected, count] of [[baseline, baselineHash, 47], [oldPackage, packageManifestHash, 86]]) {
  const file = path.join(directory, 'manifest.json'); await ordinary(file); assert.equal(await hash(file), expected);
  const manifest = JSON.parse(await fs.readFile(file, 'utf8')); assert.equal(manifest.status, 'PASSED'); assert.equal(manifest.version, '0.1.0'); assert.equal(manifest.records.length, count); if (directory === baseline) assert.equal(manifest.evidenceRecords.length, 6);
  const records = [...manifest.records, ...(manifest.evidenceRecords ?? [])];
  assert.equal(new Set(records.map(record => record.copy)).size, records.length, 'Duplicate preservation record');
  for (const record of records) {
    const copy = path.resolve(root, record.copy); assert.ok(inside(copy, directory), 'Manifest path escaped its baseline');
    await ordinary(copy); assert.equal((await fs.stat(copy)).size, record.bytes); assert.equal(await hash(copy), record.sha256);
  }
}
assert.equal(await hash(path.join(oldPackage, 'Buoyancy-Lab-Setup-0.1.0.exe')), oldInstallerHash);
const oldCodec = await import(pathToFileURL(path.join(baseline, 'source/src/project.js')).href);
const { getSnapshot } = await import(pathToFileURL(path.join(baseline, 'source/src/model.js')).href);
assert.equal(oldCodec.projectModelVersion, 'buoyancy-static-1'); assert.equal(oldCodec.projectVersion, 1);
await ordinary(output); await ordinary(originalProfile); await ordinary(asarFile);
assert.equal(await exists(reportFile), false, 'Never replace existing evidence');
assert.ok(profile.startsWith(path.join(root, 'output') + path.sep)); assert.notEqual(profile.toLowerCase(), originalProfile.toLowerCase());
assert.deepEqual(await buoyancyProcesses(), [], 'Preserve an existing Buoyancy session');
let previous, expectedAsar;
if (preparing) { expectedAsar = oldHash; assert.equal(await exists(output), false, 'Preparation requires new output/profile'); }
else {
  assert.match(process.env.BUOYANCY_UPGRADE_NEW_ASAR_SHA256 || '', /^[a-f0-9]{64}$/);
  assert.match(process.env.BUOYANCY_UPGRADE_PREPARED_SHA256 || '', /^[a-f0-9]{64}$/);
  expectedAsar = process.env.BUOYANCY_UPGRADE_NEW_ASAR_SHA256; assert.notEqual(expectedAsar, oldHash);
  assert.equal(await hash(oldReportFile), process.env.BUOYANCY_UPGRADE_PREPARED_SHA256);
  previous = JSON.parse(await fs.readFile(oldReportFile, 'utf8'));
  assert.equal(previous.status, 'PASSED'); assert.equal(previous.checks.length, 8); assert.equal(previous.profile, profile);
  assert.equal(previous.oldASARSHA256, oldHash); assert.equal(previous.baselineSHA256, baselineHash); assert.equal(previous.packageManifestSHA256, packageManifestHash); assert.equal(previous.mode, 'prepare-old'); assert.equal(previous.version, '0.1.0');
  assert.equal(previous.runtimeUnchanged && previous.baselineUnchanged && previous.oldPackageUnchanged && previous.defaultProfileUnchanged, true);
  assert.deepEqual(await tree(profile), previous.syntheticProfileAfter, 'Old synthetic profile changed before restart');
  assert.equal(await hash(projectFile), previous.nativeFileSHA256); assert.equal(await hash(originalFile), previous.recoveredFileSHA256);
  assert.equal(await hash(bomFile), previous.bomFileSHA256);
}
assert.equal(await hash(asarFile), expectedAsar);
const extract = file => asar.extractFile(asarFile, path.normalize(file));
const packageJSON = JSON.parse(extract('package.json').toString('utf8'));
assert.equal(packageJSON.name, 'buoyancy-lab'); assert.equal(packageJSON.version, version);
const main = extract('desktop/main.cjs').toString('utf8');
assert.match(main, /const APP_ID\s*=\s*['"]com\.buoyancylab\.app['"]/); assert.match(main, /const APP_URL\s*=\s*['"]app:\/\/buoyancy\/['"]/);
const baselineBefore = await tree(baseline), packageBefore = await tree(oldPackage), runtimeBefore = await tree(runtime), originalBefore = await tree(originalProfile);
if (!preparing) assert.deepEqual(originalBefore, previous.defaultProfileBefore);
if (preparing) { await fs.mkdir(output); await fs.mkdir(profile); }
const env = { ...process.env, BUOYANCY_LAB_DATA_DIR: profile }; delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [], remoteRequests = [], processes = [];
let app, page, failure, observation, snapshot, storage, bounds, gpu, display, savedWindow;
let nativeFileSHA256, bomFileSHA256, recoveredFileSHA256, newNativeFileSHA256, runtimeUnchanged, baselineUnchanged, oldPackageUnchanged, defaultProfileUnchanged, syntheticProfileAfter, residualProcesses;
async function waitFor(predicate, label) { const until = Date.now() + 15000; while (Date.now() < until) { if (await predicate()) return; await delay(40); } throw new Error(`Timed out: ${label}`); }
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
function sameProject(actual, expected) {
  assert.equal(actual.type, expected.type); assert.equal(actual.schemaVersion, expected.schemaVersion); assert.equal(actual.modelVersion, expected.modelVersion);
  assert.deepEqual(actual.experiment, expected.experiment); assert.deepEqual(actual.comparison, expected.comparison); assert.deepEqual(actual.observation.view, expected.observation.view);
  assert.deepEqual(Object.keys(actual.observation).sort(), ['camera', 'view']);
  const a = actual.observation.camera, b = expected.observation.camera;
  if (b === null) assert.equal(a, null);
  else { assert.ok(a); for (const key of ['position', 'target']) for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[key][i] - b[key][i]) < 1e-9); assert.equal(a.zoom ?? 1, b.zoom ?? 1); }
}
function sameSnapshot(actual, expected, label = 'snapshot') {
  if (typeof expected === 'number') {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-10 * Math.max(1, Math.abs(expected)), label + ' differs'); return;
  }
  if (expected === null || typeof expected !== 'object') { assert.equal(actual, expected, label); return; }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), label + ' shape');
  for (const key of Object.keys(expected)) {
    if (key === 'config') assert.deepEqual(actual[key], expected[key]);
    else sameSnapshot(actual[key], expected[key], label + '.' + key);
  }
}
const fixtureExperiment = { config: { bodyMassKg: .73, bodyVolumeM3: 1.35 / 1000, fluidDensityKgM3: 1075, mode: 'held', heldBottomM: 18 / 100 } };
const comparisonExperiment = { config: { bodyMassKg: .8, bodyVolumeM3: 1 / 1000, fluidDensityKgM3: 1200, mode: 'equilibrium', heldBottomM: 3.5 / 100 } };
const expectedSnapshot = experiment => getSnapshot(experiment);
const getProject = () => page.evaluate(() => window.buoyancyLab.project());
const getState = () => page.evaluate(() => window.buoyancyLab.getState());
function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
const getStorage = () => page.evaluate(key => Object.fromEntries(Object.keys(localStorage).filter(k => k === key || k.startsWith(key + '-original-')).sort().map(k => [k, localStorage.getItem(k)])), storageKey);
async function launch() {
  app = await electron.launch({ executablePath, args: [], env, timeout: 45000 });
  const child = app.process(), record = { pid: child.pid, exited: false }; processes.push(record); child.once('exit', (code, signal) => Object.assign(record, { exited: true, code, signal }));
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await page.waitForFunction(() => window.buoyancyLab?.project && document.querySelector('#scene canvas'));
  assert.equal(page.url(), 'app://buoyancy/');
  assert.deepEqual(await app.evaluate(({ app }) => ({ name: app.name, version: app.getVersion(), profile: app.getPath('userData') })), { name: 'Buoyancy Lab', version, profile });
  assert.equal(Object.hasOwn(await getState(), 'running'), false, 'Static observations must not invent playback');
 
  record.processIds = await app.evaluate(({ app }) => app.getAppMetrics().map(value => value.pid));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].focus());
}
async function closeNormally() {
  const record = processes.at(-1), pids = await app.evaluate(({ app }) => app.getAppMetrics().map(value => value.pid));
  record.processIds = [...new Set([record.pid, ...(record.processIds ?? []), ...pids])];
  await app.close(); app = null; page = null; await waitFor(() => record.exited, 'normal app exit');
  assert.equal(record.code, 0); assert.equal(record.signal, null);
  await waitFor(() => { record.residualPids = record.processIds.filter(processExists); return record.residualPids.length === 0; }, 'all owned app processes exit');
}
async function stableBounds() {
  let actual, last, stable = 0; await waitFor(async () => { actual = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds()); stable = JSON.stringify(actual) === JSON.stringify(last) ? stable + 1 : 0; last = actual; return stable >= 2; }, 'stable bounds'); return actual;
}
async function waitAutosave(expected) { await waitFor(async () => { try { sameProject(JSON.parse((await getStorage())[storageKey]), expected); return true; } catch { return false; } }, 'automatic observation save'); }
async function nativeSave(target, expected) {
  assert.ok(target.startsWith(output + path.sep)); assert.equal(await exists(target), false);
  await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, target);
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#toast').textContent = ''; });
  await page.locator('#save-project').click();
  await waitFor(async () => { const result = await page.evaluate(() => ({ toast: document.querySelector('#toast').textContent, busy: document.querySelector('#save-project').disabled })); if (/저장하지 못했습니다|저장을 취소했습니다/.test(result.toast)) throw new Error(result.toast); return !result.busy && /저장했습니다/.test(result.toast); }, 'resolved native save IPC');
  sameProject(oldCodec.parseProject(await fs.readFile(target, 'utf8')), expected);
}
async function nativeOpen(target, expected) {
  assert.ok(target.startsWith(output + path.sep));
  await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, target);
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#toast').textContent = ''; });
  await page.locator('#open-project').click();
  await waitFor(async () => {
    const result = await page.evaluate(() => ({ toast: document.querySelector('#toast').textContent, busy: document.querySelector('#open-project').disabled }));
    if (/열지 못했습니다/.test(result.toast)) throw new Error(result.toast);
    return !result.busy && /복원했습니다/.test(result.toast);
  }, 'resolved native open IPC');
  sameProject(await getProject(), expected); assert.equal(Object.hasOwn(await getState(), 'running'), false);
 
  sameSnapshot((await getState()).snapshot, expectedSnapshot(expected.experiment));
}
try {
  await launch();
  await check('actual packaged identity, stable app origin and isolated profile', async () => {
    gpu = await page.evaluate(() => { const gl = document.querySelector('#scene canvas').getContext('webgl2'), extension = gl.getExtension('WEBGL_debug_renderer_info'); return { version: gl.getParameter(gl.VERSION), renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) }; });
    display = await app.evaluate(({ BrowserWindow, screen }) => { const value = screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getNormalBounds()); return { workArea: value.workArea, scaleFactor: value.scaleFactor }; });
  });
  if (preparing) {
    await check('old UI records held conditions and an independent frozen floating comparison', async () => {
      await page.locator('[data-mode=held]').click();
      await page.locator('#height').fill('3.5'); await page.locator('#mass').fill('0.8');
      await page.locator('#volume').fill('1'); await page.locator('#density').fill('1200');
      await page.locator('[data-mode=equilibrium]').click(); await page.locator('#pin-comparison').click();
      await page.locator('[data-mode=held]').click();
      await page.locator('#mass').fill('0.73'); await page.locator('#volume').fill('1.35');
      await page.locator('#density').fill('1075'); await page.locator('#height').fill('18');
      const state = await getState(); assert.deepEqual(state.experiment, fixtureExperiment);
      assert.deepEqual(state.comparison.experiment, comparisonExperiment); assert.equal(Object.hasOwn(state, 'running'), false);
      sameSnapshot(state.snapshot, expectedSnapshot(fixtureExperiment));
      const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-10);
      near(state.snapshot.waterLevelM, 367 / 1650); near(state.snapshot.displacedVolumeM3, 7 / 16500);
      near(state.snapshot.buoyancyN, 1075 * 9.80665 * 7 / 16500);
      near(state.snapshot.holdingForceYN, .73 * 9.80665 - 1075 * 9.80665 * 7 / 16500);
      const plot = await page.evaluate(() => window.buoyancyLab.chartDebug());
      assert.deepEqual(plot.forceAxisN, [-30, 30]); assert.deepEqual(plot.immersionAxis, [0, 1]);
      near(plot.forces.find(bar => bar.kind === 'saved' && bar.key === 'buoyancyN').valueN, 7.84532);
      near(plot.fractions.find(bar => bar.kind === 'saved').fraction, 2 / 3);
    });
    await check('old app records flags, selected pressure surface, manual camera and actual window bounds', async () => {
      await app.evaluate(({ BrowserWindow, screen }) => { const win = BrowserWindow.getAllWindows()[0]; win.unmaximize(); const area = screen.getDisplayMatching(win.getNormalBounds()).workArea, minimum = win.getMinimumSize(); const width = Math.max(minimum[0], Math.min(1050, area.width - 24)), height = Math.max(minimum[1], Math.min(780, area.height - 24)); win.setBounds({ x: area.x + Math.max(0, Math.floor((area.width - width) / 2) + 1), y: area.y + Math.max(0, Math.floor((area.height - height) / 2) + 1), width, height }); });
      bounds = await stableBounds();
      await page.locator('[data-view=cutaway]').check(); await page.locator('[data-view=forces]').check();
      await page.locator('[data-view=pressures]').check(); await page.locator('[data-view=labels]').uncheck();
      await page.locator('#part-select').selectOption('pressure-bottom');
      const custom = await getProject(); custom.observation.camera = { position: [.7, .52, .68], target: [.02, .19, -.015], zoom: 1.3 };
      await page.evaluate(text => window.buoyancyLab.loadProject(text), JSON.stringify(custom));
      observation = await getProject(); sameProject(observation, custom);
      assert.deepEqual(observation.observation.view, { cutaway: true, forces: true, pressures: true, labels: false, selectedPart: 'pressure-bottom' });
      await waitAutosave(observation);
    });
    await check('old native JSON and BOM import preserve exact conditions, comparison and observation', async () => {
      await nativeSave(projectFile, observation); nativeFileSHA256 = await hash(projectFile);
      const bomRaw = '\ufeff' + await fs.readFile(projectFile, 'utf8'); await fs.writeFile(bomFile, bomRaw, { flag: 'wx' });
      bomFileSHA256 = await hash(bomFile);
      await page.locator('#new-project').click(); await nativeOpen(bomFile, observation);
      assert.equal(await fs.readFile(bomFile, 'utf8'), bomRaw); assert.equal(await hash(projectFile), nativeFileSHA256);
    });
    await check('old recovery exports original bytes and the synthetic primary is explicitly restored', async () => {
      await page.addInitScript(({ key, raw }) => { if (location.protocol === 'app:' && location.hostname === 'buoyancy' && !sessionStorage.getItem('buoyancy-upgrade-seeded')) { localStorage.setItem(key, raw); sessionStorage.setItem('buoyancy-upgrade-seeded', 'yes'); } }, { key: storageKey, raw: syntheticOriginal });
      await page.reload(); await page.waitForFunction(() => window.buoyancyLab?.project && !document.querySelector('#storage-recovery').hidden);
      assert.equal((await getStorage())[storageKey], syntheticOriginal);
      await page.locator('#mass').fill('1.01'); await delay(280);
      assert.equal((await getStorage())[storageKey], syntheticOriginal, 'Corrupt primary must not be overwritten by interaction or save attempts');
      await app.evaluate(({ session }, target) => { globalThis.buoyancyUpgradeDownload = null; session.defaultSession.once('will-download', (_event, item) => { item.setSavePath(target); item.once('done', (_event, status) => { globalThis.buoyancyUpgradeDownload = status; }); }); }, originalFile);
      await page.locator('#recover-original').click(); await waitFor(() => app.evaluate(() => globalThis.buoyancyUpgradeDownload === 'completed'), 'original export');
      assert.equal(await fs.readFile(originalFile, 'utf8'), syntheticOriginal);
      assert.ok(Object.entries(await getStorage()).some(([key, value]) => key.startsWith(storageKey + '-original-') && value === syntheticOriginal));
      await page.evaluate(({ key, text }) => localStorage.setItem(key, text), { key: storageKey, text: JSON.stringify(observation) });
      await page.reload(); await page.waitForFunction(() => window.buoyancyLab?.project && document.querySelector('#storage-recovery').hidden);
      sameProject(await getProject(), observation); await waitAutosave(observation); storage = await getStorage();
      assert.equal(await hash(projectFile), nativeFileSHA256); recoveredFileSHA256 = await hash(originalFile);
    });
    await check('old disk profile reopens exact observations, backups and saved native bounds', async () => {
      bounds = await stableBounds(); await closeNormally(); savedWindow = JSON.parse(await fs.readFile(path.join(profile, 'window.json'), 'utf8')); assert.deepEqual(savedWindow, { ...bounds, maximized: false });
      await launch(); sameProject(await getProject(), observation); assert.deepEqual(await stableBounds(), bounds);
      sameSnapshot((await getState()).snapshot, expectedSnapshot(observation.experiment));
      const restored = await getStorage(); sameProject(JSON.parse(restored[storageKey]), observation); for (const [key, value] of Object.entries(storage)) if (key !== storageKey) assert.equal(restored[key], value); storage = restored;
    });
  } else {
    await check('installed 1.0 restores 0.1 conditions, comparison and observation without reinterpretation', async () => {
      observation = await getProject(); sameProject(observation, previous.observation); const state = await getState();
      sameSnapshot(state.snapshot, previous.snapshot); sameSnapshot(state.snapshot, expectedSnapshot(previous.observation.experiment));
      assert.equal(Object.hasOwn(state, 'running'), false); assert.deepEqual(state.experiment, fixtureExperiment);
      storage = await getStorage(); sameProject(JSON.parse(storage[storageKey]), previous.observation);
    });
    await check('restored old file does not invent completed lesson evidence', async () => { assert.equal(await page.evaluate(() => window.buoyancyLab.guide()), null); assert.equal(await page.locator('#lesson-guide').isHidden(), true); });
    await check('old original backups and native file bytes remain exact', async () => {
      for (const [key, value] of Object.entries(previous.storage)) if (key !== storageKey) assert.equal(storage[key], value);
      assert.equal(await hash(projectFile), previous.nativeFileSHA256); assert.equal(await hash(originalFile), previous.recoveredFileSHA256); assert.equal(await fs.readFile(originalFile, 'utf8'), syntheticOriginal);
      assert.equal(await hash(bomFile), previous.bomFileSHA256);
    });
    await check('old native JSON opens in 1.0 and saves a new exact file without replacing the original', async () => {
      await page.locator('#new-project').click(); await waitFor(async () => (await getState()).experiment.config.bodyMassKg === .4, 'new experiment');
      await nativeOpen(projectFile, previous.observation);
      await page.locator('#new-project').click(); await nativeOpen(bomFile, previous.observation);
      observation = await getProject(); await waitAutosave(observation); storage = await getStorage(); assert.equal(await page.evaluate(() => window.buoyancyLab.guide()), null);
      await nativeSave(newProjectFile, observation); newNativeFileSHA256 = await hash(newProjectFile);
      assert.equal(await hash(projectFile), previous.nativeFileSHA256); assert.equal(await hash(originalFile), previous.recoveredFileSHA256);
      assert.equal(await hash(bomFile), previous.bomFileSHA256);
    });
    await check('old actual native rectangle restores without fractional-DPI growth', async () => { bounds = await stableBounds(); assert.deepEqual(bounds, previous.bounds); assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()), false); });
  }
  snapshot = (await getState()).snapshot;
  await page.screenshot({ path: path.join(output, mode + '.png') }); nativeFileSHA256 = await hash(projectFile); bomFileSHA256 = await hash(bomFile); recoveredFileSHA256 = await hash(originalFile);
  await check('observation and native file operations produce no errors or remote requests', async () => { assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []); });
} catch (error) { failure = error; process.exitCode = 1; console.error(error.stack); if (page) await page.screenshot({ path: path.join(output, mode + '-failure.png'), timeout: 3000 }).catch(() => {}); }
finally {
  if (app) await closeNormally().catch(error => { failure ??= error; process.exitCode = 1; });
  try {
    assert.deepEqual(await tree(runtime), runtimeBefore); runtimeUnchanged = true;
    assert.deepEqual(await tree(baseline), baselineBefore); baselineUnchanged = true;
    assert.deepEqual(await tree(oldPackage), packageBefore); oldPackageUnchanged = true;
    assert.deepEqual(await tree(originalProfile), originalBefore); defaultProfileUnchanged = true;
    for (const record of processes) { assert.equal(record.exited && record.code === 0 && record.signal === null, true); assert.deepEqual(record.residualPids, []); }
    await waitFor(async () => (residualProcesses = await buoyancyProcesses()).length === 0, 'no residual Buoyancy process');
    if (bounds) { savedWindow = JSON.parse(await fs.readFile(path.join(profile, 'window.json'), 'utf8')); assert.deepEqual(savedWindow, { ...bounds, maximized: false }); if (!preparing) assert.deepEqual(savedWindow, previous.savedWindow); }
    syntheticProfileAfter = await tree(profile);
    checks.push('normal owned-process exit and unchanged runtime, baselines and real profile');
  } catch (error) { failure ??= error; process.exitCode = 1; }
  const record = { status: failure ? 'FAILED' : 'PASSED', mode, version, sourceVersion: '0.1.0', targetVersion: '1.0.0', executablePath, profile,
    oldASARSHA256: oldHash, oldInstallerSHA256: oldInstallerHash, baselineSHA256: baselineHash, packageManifestSHA256: packageManifestHash,
    ...(preparing ? {} : { newASARSHA256: expectedAsar, preparedOldReportSHA256: await hash(oldReportFile) }),
    checks, observation, snapshot, storage, bounds, display, savedWindow, nativeFileSHA256, bomFileSHA256, recoveredFileSHA256, newNativeFileSHA256,
    gpu, errors, remoteRequests, processes, residualProcesses, runtimeUnchanged, baselineUnchanged, oldPackageUnchanged, defaultProfileUnchanged,
    defaultProfileBefore: originalBefore, syntheticProfileAfter,
    originalRestorationMethod: 'Only this harness synthetic primary key was restored after testing corrupt-text export; user storage was never written.',
    ...(failure ? { failure: failure.message, stack: failure.stack } : {}) };
  await fs.writeFile(reportFile, JSON.stringify(record, null, 2), { flag: 'wx' }); console.log(`${record.status}: ${checks.length} checks; ${reportFile}; SHA256 ${await hash(reportFile)}`);
}
