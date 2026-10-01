import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'output/browser-integration');
const baseURL = 'http://127.0.0.1:5271/', storageKey = 'buoyancy-lab-project-v1';
const G = 9.80665, TANK_AREA = .175, BODY_AREA = .01, LIQUID_VOLUME = .0385;
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (tolerance ${tolerance})`);
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5271, strictPort: true, hmr: false } });
await server.listen();
const hardware = process.env.BUOYANCY_BROWSER_HARDWARE === '1';
let browser, context, page, gpu, failure, dragEvidence;
const checks = [], errors = [], externalRequests = [];
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
const state = () => page.evaluate(() => window.buoyancyLab.getState());
const project = () => page.evaluate(() => window.buoyancyLab.project());
const guide = () => page.evaluate(() => window.buoyancyLab.guide());
const debug = () => page.evaluate(() => window.buoyancyLab.sceneDebug());
const chart = () => page.evaluate(() => window.buoyancyLab.chartDebug());
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const choose = id => page.locator(`[data-lesson="${id}"]`).click();
const mode = value => page.locator(`[data-mode="${value}"]`).click();
async function change(id, value) { await page.locator(`#${id}`).fill(String(value)); await page.locator(`#${id}`).press('Tab'); }
async function conditions(mass, volumeL, density) {
  await change('mass-number', mass); await change('volume-number', volumeL); await change('density-number', density);
  const actual = (await state()).experiment.config;
  near(actual.bodyMassKg, mass, 0); near(actual.bodyVolumeM3, volumeL / 1000, 1e-18); near(actual.fluidDensityKgM3, density, 0);
}
async function confirm() { assert.equal(await page.locator('#guide-next').isEnabled(), true); await page.locator('#guide-next').click(); }
async function dismissToast() { if (await page.locator('#toast').isVisible()) await page.locator('#toast button').click(); }
function watch(target) {
  target.on('pageerror', error => errors.push(error.message));
  target.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  target.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
}
// Independent monotone volume-balance oracle; it does not use product branch logic.
function heldWaterLevel(volumeM3, bottomM) {
  const heightM = volumeM3 / BODY_AREA;
  let low = 0, high = .5;
  for (let i = 0; i < 85; i++) {
    const level = (low + high) / 2;
    const displaced = BODY_AREA * Math.max(0, Math.min(heightM, level - bottomM));
    if (TANK_AREA * level - displaced < LIQUID_VOLUME) low = level; else high = level;
  }
  return (low + high) / 2;
}

try {
  browser = await chromium.launch({ headless: true, ...(hardware ? { args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] } : {}) });
  context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  page = await context.newPage(); page.setDefaultTimeout(20000); watch(page);
  await page.goto(baseURL); await page.waitForFunction(() => window.buoyancyLab?.sceneDebug()?.ready);

  await check('initial finite-tank observation is static, uses SI conditions and has no idle redraw loop', async () => {
    const initial = await state();
    assert.deepEqual(initial.experiment.config, { bodyMassKg: .4, bodyVolumeM3: .001, fluidDensityKgM3: 1000, mode: 'equilibrium', heldBottomM: .06 });
    assert.equal(initial.comparison, null); assert.equal(Object.hasOwn(initial, 'running'), false);
    assert.equal((await debug()).componentCount, 14); assert.equal(await page.locator('#play').count(), 0);
    near(initial.snapshot.submergedFraction, .4); near(initial.snapshot.buoyancyN, .4 * G);
    near(initial.snapshot.waterLevelM, (.0385 + .0004) / .175); near(initial.snapshot.fluidVolumeM3, .0385);
    assert.match(await page.locator('.scope-note').textContent(), /정적 계산/);
    gpu = await page.evaluate(() => { const gl = document.querySelector('#scene canvas').getContext('webgl2'), extension = gl.getExtension('WEBGL_debug_renderer_info'); return { webgl2: Boolean(gl), renderer: gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER) }; });
    assert.equal(gpu.webgl2, true); if (hardware) assert.match(gpu.renderer, /RTX 5080.*D3D11|D3D11.*RTX 5080/);
    await paint(); await page.waitForTimeout(150); const before = await debug(); await page.waitForTimeout(150);
    assert.equal((await debug()).renderFrame, before.renderFrame); assert.deepEqual((await state()).experiment, initial.experiment);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); delete document.hidden; });
    assert.deepEqual((await state()).experiment, initial.experiment);
  });

  await check('actual mass, volume and density controls agree with independent floating force and liquid balance', async () => {
    await mode('equilibrium');
    for (const [mass, volumeL, density] of [[.4, 1, 1000], [.8, 1, 1000], [.8, 1, 900], [.8, 1, 1200], [.1, .5, 800], [1.5, 2, 1200]]) {
      await conditions(mass, volumeL, density); const snapshot = (await state()).snapshot;
      const displaced = mass / density, height = volumeL / 1000 / BODY_AREA, level = (LIQUID_VOLUME + displaced) / TANK_AREA;
      assert.equal(snapshot.freeEquilibrium, 'unique'); assert.equal(snapshot.poseKind, 'equilibrium');
      near(snapshot.submergedFraction, displaced / (volumeL / 1000)); near(snapshot.buoyancyN, mass * G);
      near(snapshot.waterLevelM, level); near(snapshot.bodyBottomM, level - displaced / BODY_AREA);
      near(snapshot.bodyHeightM, height); near(snapshot.holdingForceYN, 0); near(snapshot.netForceYN, 0);
      near(TANK_AREA * snapshot.waterLevelM - snapshot.displacedVolumeM3, LIQUID_VOLUME);
    }
  });

  await check('held height crosses dry, partial and full immersion using independent volume balance and signed holding force', async () => {
    await conditions(1.2, 1, 1000); await mode('held');
    for (const [heightCm, immersion] of [[28, 'dry'], [18, 'partial'], [6, 'full'], [1.5, 'full']]) {
      await change('height-number', heightCm); const s = (await state()).snapshot, y = heightCm / 100, level = heldWaterLevel(.001, y);
      const submerged = Math.max(0, Math.min(.1, level - y)), displaced = BODY_AREA * submerged;
      assert.equal(s.immersion, immersion); assert.equal(s.poseKind, 'held'); near(s.bodyBottomM, y); near(s.waterLevelM, level);
      near(s.displacedVolumeM3, displaced); near(s.buoyancyN, 1000 * G * displaced); near(s.holdingForceYN, 1.2 * G - s.buoyancyN); near(s.netForceYN, 0);
      near(s.bottomGaugePressurePa, 1000 * G * Math.max(0, level - y)); near(s.topGaugePressurePa, 1000 * G * Math.max(0, level - y - .1));
      near(s.buoyancyN, BODY_AREA * (s.bottomGaugePressurePa - s.topGaugePressurePa)); assert.equal(s.bottomContact, false);
    }
    await conditions(.4, 1, 1000); near((await state()).snapshot.holdingForceYN, -5.88399); assert.match(await page.locator('#holder-force').textContent(), /아래|누름|−|-/);
    await page.screenshot({ path: path.join(output, 'buoyancy-held-downward.png'), fullPage: true });
  });

  await check('actual body, submerged and water meshes follow meter geometry without occupying the displaced liquid volume', async () => {
    await mode('held'); await conditions(.4, 1, 1000);
    for (const heightCm of [28, 18, 6]) {
      await change('height-number', heightCm); const mesh = await debug(), bottom = heightCm / 100;
      const water = heldWaterLevel(.001, bottom), submergedHeight = Math.max(0, Math.min(.1, water - bottom));
      near(mesh.bodyBoundsM.min[0], -.05, 1e-7); near(mesh.bodyBoundsM.max[0], .05, 1e-7);
      near(mesh.bodyBoundsM.min[1], bottom, 1e-7); near(mesh.bodyBoundsM.max[1], bottom + .1, 1e-7);
      near(mesh.bodyBoundsM.min[2], -.05, 1e-7); near(mesh.bodyBoundsM.max[2], .05, 1e-7);
      near(mesh.bodyMeshVolumeM3, .001, 1e-9); near(mesh.submergedMeshVolumeM3, BODY_AREA * submergedHeight, 1e-9);
      near(mesh.waterMeshVolumeM3, LIQUID_VOLUME, 1e-8); near(mesh.waterSurfaceYM, water, 1e-7);
      if (submergedHeight === 0) assert.equal(mesh.submergedBoundsM, null);
      else { near(mesh.submergedBoundsM.min[1], bottom, 1e-7); near(mesh.submergedBoundsM.max[1], bottom + submergedHeight, 1e-7); }
      const before = await project(); await page.locator('[data-view="cutaway"]').uncheck();
      near((await debug()).waterMeshVolumeM3, LIQUID_VOLUME, 1e-8); assert.deepEqual((await state()).experiment, before.experiment); assert.deepEqual((await project()).observation.camera, before.observation.camera);
      await page.locator('[data-view="cutaway"]').check();
    }
  });

  await check('neutral and heavy free conditions explain reference poses rather than inventing a unique equilibrium', async () => {
    await mode('equilibrium'); await conditions(1, 1, 1000);
    let s = (await state()).snapshot; assert.equal(s.freeEquilibrium, 'continuum'); assert.equal(s.poseKind, 'neutral-reference'); assert.equal(s.equilibriumBottomM, null);
    assert.ok(Array.isArray(s.neutralBottomRangeM)); assert.match(await page.locator('#pose-status').textContent(), /중성|대표/); assert.match(await page.locator('#condition-state').textContent(), /중성|대표/);
    await change('mass-number', 1.2); s = (await state()).snapshot;
    assert.equal(s.freeEquilibrium, 'none'); assert.equal(s.poseKind, 'submerged-reference'); assert.equal(s.equilibriumBottomM, null); assert.equal(s.neutralBottomRangeM, null);
    near(s.holdingForceYN, 0); near(s.netForceYN, -.2 * G); assert.match(await page.locator('#pose-status').textContent(), /평형 없음/); assert.match(await page.locator('#condition-state').textContent(), /평형 없음/);
    const before = (await state()).experiment; await page.waitForTimeout(150); assert.deepEqual((await state()).experiment, before);
  });

  await check('mass guide requires two actual conditions and completed evidence remains stable during later exploration', async () => {
    await choose('mass'); assert.deepEqual((await guide()).evidence, []); await page.waitForTimeout(100); assert.equal((await guide()).stage, 0);
    await conditions(.6, 1, 1000); assert.equal(await page.locator('#guide-next').isEnabled(), false); await conditions(.4, 1, 1000); await confirm();
    assert.equal((await guide()).stage, 1); assert.equal(await page.locator('#guide-next').isEnabled(), false);
    await change('mass-number', .8); await confirm(); const done = await guide();
    assert.equal(done.status, 'completed'); assert.equal(done.evidence.length, 2);
    near(done.evidence[0].submergedFraction, .4); near(done.evidence[1].submergedFraction, .8); near(done.evidence[1].buoyancyN, .8 * G);
    const result = await page.locator('#guide-result').textContent(); await conditions(.9, 1.5, 1100);
    assert.deepEqual(await guide(), done); assert.equal(await page.locator('#guide-result').textContent(), result);
    await page.locator('#guide-restart').click(); assert.equal((await guide()).stage, 0); assert.deepEqual((await guide()).evidence, []);
  });

  await check('density guide records lower immersed fraction at equal supported weight only after the required change', async () => {
    await choose('density'); await conditions(.8, 1, 900); await confirm();
    assert.equal(await page.locator('#guide-next').isEnabled(), false); await change('density-number', 1200); await confirm();
    const done = await guide(); assert.equal(done.status, 'completed'); assert.equal(done.evidence.length, 2);
    near(done.evidence[0].submergedFraction, 8 / 9); near(done.evidence[1].submergedFraction, 2 / 3);
    done.evidence.forEach(item => near(item.buoyancyN, .8 * G));
  });

  await check('depth guide requires surface-pressure observation and preserves its evidence through new-experiment undo', async () => {
    await choose('depth'); await mode('held'); await conditions(1.2, 1, 1000); await change('height-number', 6);
    await page.locator('[data-view="pressures"]').uncheck(); assert.equal(await page.locator('#guide-next').isEnabled(), false);
    await page.locator('[data-view="pressures"]').check(); await confirm(); assert.equal(await page.locator('#guide-next').isEnabled(), false);
    await change('height-number', 1.5); await confirm(); const done = await guide();
    assert.equal(done.status, 'completed'); assert.equal(done.evidence.length, 2);
    for (const item of done.evidence) { near(item.buoyancyN, G); near(item.holdingForceYN, .2 * G); assert.equal(item.pressuresVisible, true); }
    near(done.evidence[1].bottomGaugePressurePa - done.evidence[0].bottomGaugePressurePa, 1000 * G * .045);
    near(done.evidence[1].topGaugePressurePa - done.evidence[0].topGaugePressurePa, 1000 * G * .045);
    const saved = await project(); await page.locator('#new-project').click(); assert.equal(await guide(), null); await dismissToast(); await page.locator('#undo-new').click();
    assert.deepEqual(await project(), saved); assert.deepEqual(await guide(), done); await page.locator('#guide-exit').click(); assert.equal(await guide(), null);
  });

  await check('manual camera, target selection, cutaway and overlays preserve physics while explicit focus changes viewpoint', async () => {
    await dismissToast(); await page.locator('#scene').scrollIntoViewIfNeeded(); const original = (await project()).observation.camera;
    // Labels are intentional real buttons. Use a verified empty canvas path,
    // rather than letting a fixed coordinate drag a label instead of the camera.
    dragEvidence = await page.locator('#scene canvas').evaluate(canvas => {
      const b = canvas.getBoundingClientRect(), old = document.elementFromPoint(b.x + b.width * .45, b.y + b.height * .65);
      const originalHit = { tag: old?.tagName, className: old?.className, text: old?.textContent?.slice(0, 100) };
      for (const fx of [.15, .72, .27, .58]) for (const fy of [.4, .55, .25]) {
        const start = { x: b.x + b.width * fx, y: b.y + b.height * fy }, end = { x: start.x + b.width * .09, y: start.y - b.height * .08 };
        if (Array.from({ length: 13 }, (_, i) => document.elementFromPoint(start.x + (end.x - start.x) * i / 12, start.y + (end.y - start.y) * i / 12)).every(hit => hit === canvas)) return { originalHit, start, end, canvasHitSamples: 13 };
      }
      throw new Error('No unobstructed visible canvas drag path');
    });
    await page.mouse.move(dragEvidence.start.x, dragEvidence.start.y); await page.mouse.down();
    await page.mouse.move(dragEvidence.end.x, dragEvidence.end.y, { steps: 12 }); await page.mouse.up(); await paint();
    assert.notDeepEqual((await project()).observation.camera, original); const before = await project();
    await page.locator('#part-select').selectOption('holding-carriage'); assert.deepEqual((await project()).observation.camera, before.observation.camera);
    for (const key of ['cutaway', 'forces', 'pressures', 'labels']) { const control = page.locator(`[data-view="${key}"]`), old = await control.isChecked(); await control.setChecked(!old); assert.equal((await state()).view[key], !old); await control.setChecked(old); }
    await page.setViewportSize({ width: 1280, height: 720 }); await paint(); assert.deepEqual((await project()).observation.camera, before.observation.camera); assert.deepEqual((await state()).experiment, before.experiment);
    await page.locator('#focus-part').click(); assert.notDeepEqual((await project()).observation.camera, before.observation.camera); assert.deepEqual((await state()).experiment, before.experiment);
    await page.locator('#focus').click(); assert.equal(await page.locator('body').evaluate(el => el.classList.contains('focus-mode')), true); await page.locator('#focus').click();
  });

  await check('frozen comparison keeps its own conditions and actual SVG bars use common signed-force and immersion axes', async () => {
    await mode('equilibrium'); await conditions(.4, 1, 1000); await page.locator('#pin-comparison').click(); const saved = (await state()).comparison;
    await conditions(.8, 1, 1000); assert.deepEqual((await state()).comparison, saved);
    for (const display of ['current', 'saved', 'both']) {
      await page.locator(`[data-chart-mode="${display}"]`).click(); const plot = await chart();
      assert.deepEqual(plot.forceAxisN, [-30, 30]); assert.deepEqual(plot.immersionAxis, [0, 1]);
      const expectedKinds = display === 'both' ? ['current', 'saved'] : [display];
      assert.deepEqual([...new Set(plot.forces.map(r => r.kind))].sort(), expectedKinds);
      const actualLines = await page.locator('#force-chart line[stroke-width="7"]').evaluateAll(nodes => nodes.map(n => ({ start: Number(n.getAttribute('x1')), end: Number(n.getAttribute('x2')) })));
      assert.equal(actualLines.length, plot.forces.length);
      plot.forces.forEach((item, index) => {
        const mass = item.kind === 'current' ? .8 : .4, expected = item.key === 'buoyancyN' ? mass * G : item.key === 'weightN' ? -mass * G : 0;
        near(item.valueN, expected); near(actualLines[index].start, item.startX); near(actualLines[index].end, item.endX);
        near((actualLines[index].end - actualLines[index].start) / item.axisWidth, expected / 60);
      });
      const actualWidths = await page.locator('#immersion-chart rect').evaluateAll(nodes => nodes.map(n => Number(n.getAttribute('width'))));
      assert.equal(actualWidths.length, plot.fractions.length); plot.fractions.forEach((item, index) => { const expected = item.kind === 'current' ? .8 : .4; near(item.fraction, expected); near(actualWidths[index] / item.axisWidth, expected); });
    }
    await page.screenshot({ path: path.join(output, 'buoyancy-comparison.png'), fullPage: true });
  });

  await check('file download, BOM import, reload and failed import preserve exact conditions, comparison and camera', async () => {
    await mode('held'); await change('height-number', 12.3); const saved = await project();
    const pending = page.waitForEvent('download'); await page.locator('#save-project').click(); const file = path.join(output, 'saved.buoyancy.json'); await (await pending).saveAs(file); assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), saved);
    await page.locator('#new-project').click(); await page.locator('#project-file').setInputFiles({ name: 'bom.buoyancy.json', mimeType: 'application/json', buffer: Buffer.from('\ufeff' + JSON.stringify(saved)) });
    await page.waitForFunction(expected => JSON.stringify(window.buoyancyLab.project()) === JSON.stringify(expected), saved); assert.deepEqual(await project(), saved);
    await page.reload(); await page.waitForFunction(() => window.buoyancyLab?.sceneDebug()?.ready); assert.deepEqual(await project(), saved); assert.equal(await guide(), null);
    for (const raw of ['{invalid JSON', JSON.stringify({ ...saved, schemaVersion: 99 }), JSON.stringify({ ...saved, experiment: { config: { ...saved.experiment.config, heldBottomM: 0 } } })]) {
      const before = await project(); const message = await page.evaluate(raw => { try { window.buoyancyLab.loadProject(raw); return ''; } catch (error) { return error.message; } }, raw);
      assert.ok(message.length > 0); assert.deepEqual(await project(), before);
    }
  });

  await check('future and corrupt automatic-save originals remain byte-exact and exportable after edits', async () => {
    for (const [name, raw] of [['future', '\ufeff{"type":"buoyancy-lab-project","schemaVersion":99,"original":"한글 원문"}'], ['corrupt', '{"original":"손상 원문"']]) {
      const isolated = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
      try {
        const other = await isolated.newPage(); watch(other);
        await other.addInitScript(({ key, raw }) => { if (location.hostname === '127.0.0.1') localStorage.setItem(key, raw); }, { key: storageKey, raw });
        await other.goto(baseURL); await other.waitForFunction(() => window.buoyancyLab?.sceneDebug()?.ready && !document.querySelector('#storage-recovery').hidden);
        await other.locator('#mass-number').fill('.8'); await other.locator('#mass-number').press('Tab'); await other.locator('[data-mode="held"]').click(); await other.waitForTimeout(300);
        assert.equal(await other.evaluate(key => localStorage.getItem(key), storageKey), raw);
        const pending = other.waitForEvent('download'); await other.locator('#recover-original').click(); const file = path.join(output, `${name}-original.txt`); await (await pending).saveAs(file); assert.equal(await fs.readFile(file, 'utf8'), raw);
      } finally { await isolated.close(); }
    }
  });

  await check('loaded offline app keeps static experiment and comparison controls usable without remote requests', async () => {
    await context.setOffline(true);
    try { await mode('held'); await conditions(.4, 1, 1000); await change('height-number', 6); near((await state()).snapshot.holdingForceYN, -5.88399);
      await page.locator('#pin-comparison').click(); assert.equal((await state()).comparison.experiment.config.mode, 'held');
      await page.locator('#help').click(); assert.equal(await page.locator('#help-dialog').isVisible(), true); await page.locator('#close-help').click();
    } finally { await context.setOffline(false); }
  });

  await check('1600, 1024 and 390 pixel layouts keep mode, numeric conditions, local result and file controls reachable', async () => {
    await dismissToast(); await mode('held');
    for (const [width, height] of [[1600, 1000], [1024, 768], [390, 844]]) {
      await page.setViewportSize({ width, height }); await paint(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth) <= 1, `horizontal overflow at ${width}`);
      for (const id of ['mode-equilibrium', 'mode-held', 'mass', 'mass-number', 'volume', 'volume-number', 'density', 'density-number', 'height', 'height-number', 'part-select', 'focus-part', 'save-project', 'open-project', 'help']) {
        const control = page.locator(`#${id}`); await control.scrollIntoViewIfNeeded(); assert.equal(await control.isVisible(), true, `${id} at ${width}`);
        const box = await control.boundingBox(); assert.ok(box.width > 0 && box.x >= -1 && box.x + box.width <= width + 1, `${id} clipped at ${width}`);
      }
      assert.equal(await page.locator('#condition-immersion').isVisible(), true); assert.equal(await page.locator('#condition-state').isVisible(), true);
      for (const id of ['mass', 'density', 'depth']) assert.equal(await page.locator(`[data-lesson="${id}"]`).isVisible(), true);
      await page.screenshot({ path: path.join(output, `buoyancy-${width}.png`), fullPage: true });
    }
    await conditions(.8, 1, 1200); await mode('equilibrium'); near((await state()).snapshot.submergedFraction, 2 / 3);
  });
  await page.setViewportSize({ width: 1600, height: 1000 }); await page.locator('#new-project').click(); await dismissToast(); await page.locator('[data-camera="iso"]').click(); await page.evaluate(() => scrollTo(0, 0)); await paint();
  await page.screenshot({ path: path.join(output, 'buoyancy-default-viewport.png') }); await page.screenshot({ path: path.join(output, 'buoyancy-default-full.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
} catch (error) {
  failure = error; console.error(error.stack); await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'FAILED' : 'PASSED', failure: failure?.stack, checks, gpu, dragEvidence, errors, externalRequests }, null, 2));
  await context?.close(); await browser?.close(); await server.close();
}
if (failure) process.exitCode = 1;
