import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import { createProject } from '../src/project.js';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
const packaged = !!process.env.BUOYANCY_DESKTOP_EXE;
const executablePath = packaged ? process.env.BUOYANCY_DESKTOP_EXE : require('electron');
assert.ok(path.isAbsolute(executablePath), 'The tested executable must be an absolute path');
const output = path.join(root, 'output', `${packaged ? 'desktop-packaged' : 'desktop'}-v${expectedVersion}`);
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(output, 'profile-'));
const evidence = path.join(profile, 'test-artifacts');
await fs.mkdir(evidence);
const env = { ...process.env, BUOYANCY_LAB_DATA_DIR: profile };
delete env.ELECTRON_RUN_AS_NODE;
const projectPath = path.join(evidence, '부력 관찰.buoyancy.json');
const checks = [], errors = [], remoteRequests = [], processes = [];
const defaultProfilePath = process.platform === 'win32' && process.env.APPDATA ? path.join(process.env.APPDATA, 'Buoyancy Lab') : null;
let app, page, saved, windowRestoration, gpu, failure, defaultProfile;
const state = () => page.evaluate(() => window.buoyancyLab.getState());
const project = () => page.evaluate(() => window.buoyancyLab.project());
async function profileManifest(directory) {
  if (directory === null) return null;
  const entries = [];
  async function visit(target, relative) {
    let stat;
    try { stat = await fs.lstat(target); }
    catch (error) { if (relative === '' && error.code === 'ENOENT') return false; throw error; }
    if (stat.isSymbolicLink()) entries.push({ path: relative, type: 'link', target: await fs.readlink(target) });
    else if (stat.isDirectory()) {
      entries.push({ path: relative, type: 'directory' });
      for (const name of (await fs.readdir(target)).sort()) await visit(path.join(target, name), relative ? `${relative}/${name}` : name);
    } else if (stat.isFile()) entries.push({ path: relative, bytes: stat.size, sha256: createHash('sha256').update(await fs.readFile(target)).digest('hex') });
    else throw new Error(`Unsupported default profile entry: ${relative}`);
    return true;
  }
  return { exists: await visit(directory, ''), entries };
}
function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

async function waitFor(predicate, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(30); }
  throw new Error(`Timed out: ${label}`);
}
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
function sameProject(actual, expected) {
  assert.equal(actual.type, expected.type); assert.equal(actual.schemaVersion, expected.schemaVersion);
  assert.equal(actual.modelVersion, expected.modelVersion); assert.deepEqual(actual.experiment, expected.experiment);
  assert.deepEqual(actual.comparison, expected.comparison);
  assert.deepEqual(actual.observation.view, expected.observation.view);
  assert.deepEqual(Object.keys(actual.observation).sort(), ['camera', 'view']);
  const a = actual.observation.camera, b = expected.observation.camera;
  if (b === null) assert.equal(a, null);
  else {
    assert.ok(a);
    for (const key of ['position', 'target']) for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(a[key][i] - b[key][i]) < 1e-9, `Camera ${key}[${i}] changed`);
    }
    assert.equal(a.zoom ?? 1, b.zoom ?? 1);
  }
}
async function launch() {
  app = await electron.launch({ executablePath, args: packaged ? [] : [root], env, timeout: 45000 });
  const child = app.process(), processRecord = { pid: child.pid, exited: false };
  processes.push(processRecord);
  child.once('exit', (code, signal) => Object.assign(processRecord, { exited: true, code, signal }));
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await page.waitForFunction(() => window.buoyancyLab?.project && document.querySelector('#scene canvas'));
  assert.equal(Object.hasOwn(await state(), 'running'), false, 'This static model has no invented playback state');
 
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
  if (defaultProfilePath) assert.equal(await app.evaluate(({ app }) => app.getPath('appData')), process.env.APPDATA);
  processRecord.processIds = await app.evaluate(({ app }) => app.getAppMetrics().map(value => value.pid));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setTitle('Buoyancy Lab · 자동 검사'); window.focus(); });
}
async function closeNormally() {
  const record = processes.at(-1);
  const pids = await app.evaluate(({ app }) => app.getAppMetrics().map(value => value.pid));
  record.processIds = [...new Set([record.pid, ...(record.processIds ?? []), ...pids])];
  await app.close(); app = null; page = null;
  await waitFor(() => record.exited, 'normal native process exit');
  assert.equal(record.code, 0); assert.equal(record.signal, null);
  await waitFor(() => { record.residualPids = record.processIds.filter(processExists); return record.residualPids.length === 0; }, 'owned native processes exit');
}
async function menu(group, label) {
  await app.evaluate(({ Menu }, names) => {
    const item = Menu.getApplicationMenu().items.find(value => value.label === names[0])?.submenu?.items.find(value => value.label === names[1]);
    if (!item || typeof item.click !== 'function') throw new Error(`Missing native menu: ${names.join(' > ')}`);
    item.click();
  }, [group, label]);
}
async function saveDialog(filePath, canceled = false) {
  await app.evaluate(({ dialog }, payload) => {
    globalThis.buoyancySaveCalls = 0;
    dialog.showSaveDialog = async () => { globalThis.buoyancySaveCalls++; return { canceled: payload.canceled, filePath: payload.filePath }; };
  }, { filePath, canceled });
}
async function openDialog(filePath, canceled = false) {
  await app.evaluate(({ dialog }, payload) => {
    globalThis.buoyancyOpenCalls = 0;
    dialog.showOpenDialog = async () => { globalThis.buoyancyOpenCalls++; return { canceled: payload.canceled, filePaths: payload.canceled ? [] : [payload.filePath] }; };
  }, { filePath, canceled });
}
async function freshToast(action, pattern) {
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#toast').textContent = ''; });
  await action();
  await page.waitForFunction(pattern => {
    const node = document.querySelector('#toast'); return !node.hidden && new RegExp(pattern).test(node.textContent);
  }, pattern);
}
async function stableBounds(label) {
  let actual, previous, stable = 0;
  await waitFor(async () => {
    actual = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
    stable = JSON.stringify(actual) === JSON.stringify(previous) ? stable + 1 : 0; previous = actual;
    return stable >= 2;
  }, label);
  return actual;
}

try {
  defaultProfile = { path: defaultProfilePath, before: await profileManifest(defaultProfilePath) };
  await launch();
  await check('isolated Buoyancy Lab identity, offline bundle, sandbox and native bridge', async () => {
    assert.equal(page.url(), 'app://buoyancy/');
    const identity = await app.evaluate(({ app, BrowserWindow }) => {
      const p = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
      return { name: app.name, version: app.getVersion(), userData: app.getPath('userData'), sandbox: p.sandbox,
        contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
    });
    assert.deepEqual(identity, { name: 'Buoyancy Lab', version: expectedVersion, userData: profile,
      sandbox: true, contextIsolation: true, nodeIntegration: false });
    const bridge = await page.evaluate(() => ({ keys: Object.keys(window.buoyancyDesktop).sort(), native: window.buoyancyDesktop.isDesktop,
      node: typeof window.require, process: typeof window.process, others: [typeof window.orbitDesktop, typeof window.soundDesktop, typeof window.thermalDesktop, typeof window.lensDesktop, typeof window.motorDesktop, typeof window.hydraulicDesktop, typeof window.engineDesktop, typeof window.brakeDesktop] }));
    assert.deepEqual(bridge, { keys: ['isDesktop', 'onCommand', 'openProject', 'saveProject', 'setBusy'],
      native: true, node: 'undefined', process: 'undefined', others: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined'] });
    assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
    const access = await page.evaluate(async () => ({
      local: await fetch('app://buoyancy/index.html').then(response => response.ok),
      remote: await fetch('https://example.com/').then(() => true).catch(() => false),
      popup: window.open('https://example.com/') === null,
    }));
    assert.equal(access.local, true); assert.equal(access.remote, false);
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    // Ignore the intentionally denied fetch's CSP message, not application errors.
    assert.ok(errors.every(message => /Content Security Policy|Refused to connect|fetch/i.test(message)), errors.join('\n'));
    errors.length = 0; remoteRequests.length = 0;
    gpu = await app.evaluate(async ({ app }) => ({ info: await app.getGPUInfo('basic'), features: app.getGPUFeatureStatus() }));
    gpu.sceneContext = await page.evaluate(() => {
      const gl = document.querySelector('#scene canvas').getContext('webgl2');
      if (!gl) return { webgl2: false, unmaskedRenderer: null };
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      return { webgl2: true, renderer: gl.getParameter(gl.RENDERER), version: gl.getParameter(gl.VERSION),
        unmaskedRenderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : null,
        unmaskedVendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : null };
    });
  });
  await check('native import restores held hydrostatics, a frozen floating comparison and manual camera', async () => {
    saved = createProject({ experiment: { config: { bodyMassKg: .73, bodyVolumeM3: .00135, fluidDensityKgM3: 1075, mode: 'held', heldBottomM: .18 } },
      comparison: { label: '밀도 1200 액체의 자유부유', experiment: { config: { bodyMassKg: .8, bodyVolumeM3: .001, fluidDensityKgM3: 1200, mode: 'equilibrium', heldBottomM: .035 } } },
      view: { cutaway: true, forces: true, pressures: true, labels: false, selectedPart: 'pressure-bottom' },
      camera: { position: [.7, .52, .68], target: [.02, .19, -.015], zoom: 1.3 } });
    await fs.writeFile(projectPath, JSON.stringify(saved));
    await openDialog(projectPath); await page.locator('#open-project').click();
    await waitFor(async () => (await state()).experiment.config.bodyMassKg === .73, 'native buoyancy import');
    sameProject(await project(), saved);
    const imported = await state(), result = imported.snapshot;
    const near = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, actual + ' != ' + expected);
    // Independent finite-tank partial case: H=367/1650 m and displaced V=7/16500 m³.
    assert.equal(result.poseKind, 'held'); assert.equal(result.immersion, 'partial');
    assert.equal(result.bodyBottomM, .18); near(result.waterLevelM, 367 / 1650, 1e-14);
    near(result.displacedVolumeM3, 7 / 16500, 1e-15);
    near(result.buoyancyN, 1075 * 9.80665 * 7 / 16500);
    near(result.holdingForceYN, .73 * 9.80665 - 1075 * 9.80665 * 7 / 16500);
    near(result.bottomGaugePressurePa, 1075 * 9.80665 * 7 / 165); assert.equal(result.topGaugePressurePa, 0);
    near(result.netForceYN, 0); assert.equal(result.bottomContact, false);
    assert.deepEqual(imported.comparison, saved.comparison); assert.equal(Object.hasOwn(imported, 'running'), false);
    assert.deepEqual(Object.keys(imported).sort(), ['comparison', 'experiment', 'snapshot', 'view']);
    assert.equal(await page.locator('#height-control').isVisible(), true);
    const chart = await page.evaluate(() => window.buoyancyLab.chartDebug());
    assert.deepEqual(chart.forceAxisN, [-30, 30]); assert.deepEqual(chart.immersionAxis, [0, 1]);
    near(chart.forces.find(item => item.kind === 'saved' && item.key === 'buoyancyN').valueN, 7.84532);
    near(chart.forces.find(item => item.kind === 'saved' && item.key === 'weightN').valueN, -7.84532);
    near(chart.fractions.find(item => item.kind === 'saved').fraction, 2 / 3);
  });
  await check('native static mode commands and real SI controls preserve frozen comparison and observation camera', async () => {
    const before = await project(), near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, actual + ' != ' + expected);
    await menu('실험', '자유부유 평형');
    await waitFor(async () => (await state()).experiment.config.mode === 'equilibrium', 'native equilibrium command');
    const resting = await state(); await delay(120); assert.deepEqual(await state(), resting);
    assert.equal(resting.snapshot.poseKind, 'equilibrium'); near(resting.snapshot.submergedFraction, .73 / (1075 * .00135));
    assert.equal(resting.snapshot.holdingForceYN, 0); assert.equal(resting.experiment.config.heldBottomM, .18);
    sameProject(await project(), { ...before, experiment: { config: { ...before.experiment.config, mode: 'equilibrium' } } });
    await menu('실험', '높이 고정');
    await waitFor(async () => (await state()).experiment.config.mode === 'held', 'native held command');
    assert.equal((await state()).snapshot.bodyBottomM, .18);
    await page.locator('#mass').fill('1.2'); await page.locator('#volume').fill('1');
    await page.locator('#density').fill('1000'); await page.locator('#height').fill('6');
    const upper = (await state()).snapshot; near(upper.buoyancyN, 9.80665); near(upper.holdingForceYN, 1.96133);
    assert.equal(upper.immersion, 'full'); near(upper.bottomGaugePressurePa, 1625.102);
    await page.locator('#height').fill('1.5'); const lower = (await state()).snapshot;
    assert.equal(lower.bodyBottomM, .015); near(lower.buoyancyN, upper.buoyancyN);
    near(lower.bottomGaugePressurePa, 2066.40125); near(lower.topGaugePressurePa, 1085.73625);
    await menu('실험', '자유부유 평형'); await waitFor(async () => (await state()).experiment.config.mode === 'equilibrium', 'free heavy reference');
    let current = await state(); assert.equal(current.snapshot.freeEquilibrium, 'none'); assert.equal(current.snapshot.poseKind, 'submerged-reference');
    assert.equal(current.snapshot.equilibriumBottomM, null); assert.equal(current.snapshot.holdingForceYN, 0); near(current.snapshot.netForceYN, -1.96133);
    assert.match(await page.locator('#pose-status').textContent(), /평형 없음/);
    await page.locator('#mass').fill('1'); current = await state();
    assert.equal(current.snapshot.freeEquilibrium, 'continuum'); assert.equal(current.snapshot.poseKind, 'neutral-reference');
    assert.equal(current.snapshot.equilibriumBottomM, null); assert.match(await page.locator('#pose-status').textContent(), /대표 위치/);
    await page.locator('#mass').fill('0.8'); near((await state()).snapshot.submergedFraction, .8);
    await menu('실험', '높이 고정'); await waitFor(async () => (await state()).experiment.config.mode === 'held', 'held partial restore');
    await page.locator('#height').fill('18');
    const expected = { ...before, experiment: { config: { bodyMassKg: .8, bodyVolumeM3: .001, fluidDensityKgM3: 1000, mode: 'held', heldBottomM: .18 } } };
    sameProject(await project(), expected); assert.deepEqual((await state()).comparison, before.comparison);
    const chart = await page.evaluate(() => window.buoyancyLab.chartDebug());
    near(chart.fractions.find(item => item.kind === 'saved').fraction, 2 / 3);
    near(chart.forces.find(item => item.kind === 'saved' && item.key === 'buoyancyN').valueN, 7.84532);
    saved = await project();
  });
  await check('native save replaces only a complete file; BOM import retains every state field and original bytes', async () => {
    await fs.writeFile(projectPath, 'previous destination remains until complete replacement');
    await page.evaluate(() => { document.querySelector('#toast').hidden = true; document.querySelector('#toast').textContent = ''; });
    await saveDialog(projectPath); await page.locator('#save-project').click();
    // Wait for the resolved native IPC result before opening its destination.
    // Repeated reads while Windows replaces that file can disturb the operation
    // being tested, and would hide a rejected save behind a generic timeout.
    await waitFor(async () => {
      const completion = await page.evaluate(() => ({ toast: document.querySelector('#toast').textContent,
        busy: document.querySelector('#save-project').disabled }));
      if (/저장하지 못했습니다|저장을 취소했습니다/.test(completion.toast)) throw new Error(completion.toast);
      return !completion.busy && /저장했습니다/.test(completion.toast);
    }, 'native atomic file save completion');
    assert.equal(await app.evaluate(() => globalThis.buoyancySaveCalls), 1);
    const raw = await fs.readFile(projectPath, 'utf8'); sameProject(JSON.parse(raw), saved);
    assert.equal((await fs.readdir(evidence)).some(name => name.endsWith('.tmp')), false);
    await menu('파일', '새 실험'); await waitFor(async () => (await state()).experiment.config.bodyMassKg === .4, 'new experiment');
    await openDialog(projectPath); await page.locator('#open-project').click();
    await waitFor(async () => (await state()).experiment.config.bodyMassKg === saved.experiment.config.bodyMassKg, 'native saved experiment restore');
    assert.equal(Object.hasOwn(await state(), 'running'), false);
    sameProject(await project(), saved); assert.equal(await fs.readFile(projectPath, 'utf8'), raw);
    const bomPath = path.join(evidence, 'Windows-UTF8.buoyancy.json'), bomRaw = '\ufeff' + raw;
    await fs.writeFile(bomPath, bomRaw);
    await menu('파일', '새 실험'); await waitFor(async () => (await state()).experiment.config.bodyMassKg === .4, 'new before BOM import');
    await openDialog(bomPath); await page.locator('#open-project').click();
    await waitFor(async () => (await state()).experiment.config.bodyMassKg === saved.experiment.config.bodyMassKg, 'native BOM restore');
    assert.equal(Object.hasOwn(await state(), 'running'), false);
    sameProject(await project(), saved); assert.equal(await fs.readFile(bomPath, 'utf8'), bomRaw);
  });
  await check('cancel, malformed/future/oversized files and directory/link targets preserve current and original records', async () => {
    const before = await project(), original = await fs.readFile(projectPath, 'utf8');
    await saveDialog(projectPath, true); await freshToast(() => page.locator('#save-project').click(), '저장을 취소');
    assert.equal(await app.evaluate(() => globalThis.buoyancySaveCalls), 1);
    await openDialog(projectPath, true); await freshToast(() => page.locator('#open-project').click(), '열기를 취소');
    assert.equal(await app.evaluate(() => globalThis.buoyancyOpenCalls), 1);
    sameProject(await project(), before); assert.equal(await fs.readFile(projectPath, 'utf8'), original);
    for (const [name, raw] of [
      ['broken.json', '{synthetic invalid JSON\r\n원문'],
      ['future.json', JSON.stringify({ ...saved, schemaVersion: 2 })],
      ['future-model.json', JSON.stringify({ ...saved, modelVersion: 'buoyancy-static-2' })],
      ['invalid-config.json', JSON.stringify({ ...saved, experiment: { config: { ...saved.experiment.config, heldBottomM: 0 } } })],
      ['too-large.json', ' '.repeat(10 * 1024 * 1024 + 1)],
    ]) {
      const file = path.join(evidence, name); await fs.writeFile(file, raw);
      await openDialog(file); await freshToast(() => page.locator('#open-project').click(), '못|실패|지원|파일');
      sameProject(await project(), before); assert.equal(await fs.readFile(file, 'utf8'), raw);
    }
    const linked = path.join(evidence, 'linked-directory'), originalDirectory = path.join(evidence, 'real-directory');
    await fs.mkdir(originalDirectory); await fs.writeFile(path.join(originalDirectory, 'observation.json'), original);
    await fs.symlink(originalDirectory, linked, process.platform === 'win32' ? 'junction' : 'dir');
    for (const file of [originalDirectory, path.join(linked, 'observation.json')]) {
      await openDialog(file); await freshToast(() => page.locator('#open-project').click(), '못|실패|지원|파일');
      sameProject(await project(), before);
      await saveDialog(file); await freshToast(() => page.locator('#save-project').click(), '못|실패|지원|파일');
      sameProject(await project(), before);
    }
    assert.equal(await fs.readFile(path.join(originalDirectory, 'observation.json'), 'utf8'), original);
    assert.equal(await fs.readFile(projectPath, 'utf8'), original);
  });
  await check('About version and model scope are accurate and help/view menus are reversible', async () => {
    await app.evaluate(({ dialog }) => {
      globalThis.buoyancyAbout = null;
      dialog.showMessageBox = async (_window, options) => { globalThis.buoyancyAbout = options; return { response: 0 }; };
    });
    await menu('도움말', '프로그램 정보');
    const about = await app.evaluate(() => globalThis.buoyancyAbout);
    assert.equal(about.message, 'Buoyancy Lab ' + expectedVersion);
    assert.match(about.detail, /정적/); assert.match(about.detail, /중성부력/); assert.match(about.detail, /바닥 접촉/); assert.match(about.detail, /계산하지 않습니다/);
    await menu('도움말', '사용 안내'); await waitFor(() => page.locator('#help-dialog').evaluate(node => node.open), 'help dialog');
    assert.match(await page.locator('#help-dialog').textContent(), /부력|정적|중성/); await page.locator('#close-help').click();
    await menu('보기', '3D 크게 보기'); await waitFor(() => page.locator('body').evaluate(node => node.classList.contains('focus-mode')), 'large view');
    await menu('보기', '3D 크게 보기'); await waitFor(() => page.locator('body').evaluate(node => !node.classList.contains('focus-mode')), 'normal view');
    sameProject(await project(), saved);
  });
  await check('an outstanding native file dialog prevents close and cancel leaves the original file intact', async () => {
    const before = await project(), original = await fs.readFile(projectPath, 'utf8');
    await app.evaluate(({ dialog }) => {
      globalThis.buoyancyPendingSave = false; globalThis.buoyancyClosePrompts = 0;
      dialog.showSaveDialog = () => new Promise(resolve => { globalThis.buoyancyResolveSave = resolve; globalThis.buoyancyPendingSave = true; });
      dialog.showMessageBox = async () => { globalThis.buoyancyClosePrompts++; return { response: 0 }; };
    });
    await page.locator('#save-project').click();
    await waitFor(() => app.evaluate(() => globalThis.buoyancyPendingSave), 'pending native save dialog');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await waitFor(() => app.evaluate(() => globalThis.buoyancyClosePrompts === 1), 'busy close prompt');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    sameProject(await project(), before);
    await app.evaluate(() => { globalThis.buoyancyResolveSave({ canceled: true }); globalThis.buoyancyPendingSave = false; });
    await waitFor(() => page.locator('#save-project').isEnabled(), 'native cancellation has finished');
    assert.equal(await fs.readFile(projectPath, 'utf8'), original); sameProject(await project(), before);
  });
  await check('reload and repeated full relaunch preserve observations and arbitrary-position window dimensions', async () => {
    saved = await project();
    const display = await app.evaluate(({ screen, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]; if (window.isMaximized()) window.unmaximize();
      const current = window.getNormalBounds(), display = screen.getDisplayMatching(current);
      return { bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor, minimumSize: window.getMinimumSize() };
    });
    const area = display.workArea, [minWidth, minHeight] = display.minimumSize;
    const gridStep = Array.from({ length: 100 }, (_, index) => index + 1)
      .find(step => Math.abs(step * display.scaleFactor - Math.round(step * display.scaleFactor)) < 1e-7);
    assert.ok(gridStep);
    const sizeOnGrid = (desired, minimum, available) => Math.max(Math.ceil(minimum / gridStep), Math.floor(Math.min(desired, available - 32) / gridStep)) * gridStep;
    const requested = { width: sizeOnGrid(1050, minWidth, area.width), height: sizeOnGrid(780, minHeight, area.height) };
    const centered = (origin, start, available, size) => origin + Math.floor((start + (available - size) / 2 - origin) / gridStep) * gridStep;
    requested.x = centered(display.bounds.x, area.x, area.width, requested.width);
    requested.y = centered(display.bounds.y, area.y, area.height, requested.height);
    windowRestoration = { display, gridStep, requested };
    await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].setBounds(target), requested);
    const aligned = await stableBounds('aligned native rectangle'); windowRestoration.aligned = aligned;
    assert.deepEqual(aligned, requested);
    await page.reload(); await page.waitForFunction(() => window.buoyancyLab?.project && document.querySelector('#scene canvas'));
    sameProject(await project(), saved); assert.equal(Object.hasOwn(await state(), 'running'), false);
    assert.deepEqual(await stableBounds('reloaded native rectangle'), aligned);
    await closeNormally();
    const savedWindow = JSON.parse(await fs.readFile(path.join(profile, 'window.json'), 'utf8'));
    assert.deepEqual(savedWindow, { ...aligned, maximized: false });
    await launch(); sameProject(await project(), saved);
    assert.deepEqual(await stableBounds('restarted aligned rectangle'), aligned);
    const offset = (coordinate, start, available, size) => coordinate + size + 2 <= start + available ? coordinate + 1 : coordinate - 1 >= start ? coordinate - 1 : coordinate;
    const arbitrary = { ...requested, x: offset(requested.x, area.x, area.width, requested.width), y: offset(requested.y, area.y, area.height, requested.height) };
    await app.evaluate(({ BrowserWindow }, target) => BrowserWindow.getAllWindows()[0].setBounds(target), arbitrary);
    const initialActual = await stableBounds('arbitrary native rectangle');
    assert.ok(Math.abs(initialActual.width - arbitrary.width) <= 1 && Math.abs(initialActual.height - arbitrary.height) <= 1);
    windowRestoration.arbitraryPosition = { requested: arbitrary, initialActual, cycles: [] };
    for (let restart = 1; restart <= 2; restart++) {
      await closeNormally();
      const recorded = JSON.parse(await fs.readFile(path.join(profile, 'window.json'), 'utf8'));
      assert.deepEqual(recorded, { ...initialActual, maximized: false });
      await launch(); sameProject(await project(), saved);
      const restored = await stableBounds(`arbitrary rectangle after restart ${restart}`);
      assert.deepEqual(restored, initialActual);
      windowRestoration.arbitraryPosition.cycles.push({ restart, saved: recorded, restored });
    }
    await page.screenshot({ path: path.join(evidence, 'native-app-restarted.png') });
  });
  await check('corrupt automatic-save original can be exported verbatim from its native recovery control', async () => {
    const raw = '{synthetic Buoyancy Lab original\r\n원문 보존';
    // Seed the synthetic original before the new renderer reads storage. The
    // existing renderer legitimately saves its current observation on unload.
    await page.addInitScript(value => {
      if (location.protocol === 'app:' && location.hostname === 'buoyancy') localStorage.setItem('buoyancy-lab-project-v1', value);
    }, raw);
    await page.reload();
    await page.waitForFunction(() => window.buoyancyLab?.project && !document.querySelector('#storage-recovery').hidden);
    const target = path.join(evidence, 'recovered-original.txt');
    await app.evaluate(({ session }, filename) => {
      globalThis.buoyancyDownload = null;
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(filename); item.once('done', (_event, status) => { globalThis.buoyancyDownload = status; });
      });
    }, target);
    await page.locator('#recover-original').click();
    await waitFor(() => app.evaluate(() => globalThis.buoyancyDownload === 'completed'), 'native original download');
    assert.equal(await fs.readFile(target, 'utf8'), raw);
    assert.ok(await page.evaluate(value => Object.keys(localStorage).some(key => key.startsWith('buoyancy-lab-project-v1-original-') && localStorage.getItem(key) === value), raw));
    await page.locator('#mass').fill('0.81'); await delay(280);
    assert.equal((await state()).experiment.config.bodyMassKg, .81);
    assert.equal(await page.evaluate(() => localStorage.getItem('buoyancy-lab-project-v1')), raw);
   
  });
  assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
} catch (error) {
  failure = error; process.exitCode = 1;
  const diagnostic = page ? await page.evaluate(() => ({ toast: document.querySelector('#toast')?.textContent, state: window.buoyancyLab?.getState() })).catch(() => null) : null;
  if (page) await page.screenshot({ path: path.join(output, 'failure.png'), timeout: 3000 }).catch(() => {});
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, errors, remoteRequests, windowRestoration, diagnostic }, null, 2));
  console.error(error.stack);
} finally {
  if (app) {
    await app.evaluate(() => { globalThis.buoyancyResolveSave?.({ canceled: true }); }).catch(() => {});
    await page?.evaluate(() => window.buoyancyDesktop?.setBusy(false)).catch(() => {});
    await closeNormally().catch(error => { failure ??= error; process.exitCode = 1; });
  }
  if (defaultProfile) {
    try {
      defaultProfile.after = await profileManifest(defaultProfilePath);
      assert.deepEqual(defaultProfile.after, defaultProfile.before, 'The real default profile must remain untouched');
      defaultProfile.unchanged = true;
    } catch (error) { defaultProfile.unchanged = false; failure ??= error; process.exitCode = 1; }
  }
  await fs.writeFile(path.join(output, 'result.json'), JSON.stringify({ status: failure ? 'FAILED' : 'PASSED', version: expectedVersion,
    packaged, executablePath, profile, evidence, checks, errors, remoteRequests, processes, defaultProfile, windowRestoration, gpu,
    ...(failure ? { failure: failure.message } : {}) }, null, 2));
  console.log(`Desktop validation: ${checks.length} checks ${failure ? 'completed before failure' : 'passed'}.`);
}
