import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { CONFIG_LIMITS_SI } from '../src/model.js';
import { createProject, serializeProject } from '../src/project.js';
import { COMPONENTS } from '../src/geometry.js';
import { describeBuoyancyDetail } from '../src/detail-model.js';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'output/detail-browser');
const baseURL = 'http://127.0.0.1:5336/';
const G = 9.80665, AT = .175, AB = .01, VF = .0385;
await fs.mkdir(output, { recursive: true });
const server = await createServer({ root, server: { host: '127.0.0.1', port: 5336, strictPort: true, hmr: false, watch: null } });
await server.listen();
const hardware = process.env.BUOYANCY_BROWSER_HARDWARE === '1';
let browser, page, gpu, failure;
const checks = [], errors = [], externalRequests = [];
const check = async (name, action) => { await action(); checks.push(name); console.log(`PASS ${name}`); };
const near = (actual, expected, relative = 2e-12, absolute = 1e-12) => assert.ok(Number.isFinite(actual)
  && Math.abs(actual - expected) <= absolute + relative * Math.abs(expected), `${actual} != ${expected}`);
const state = () => page.evaluate(() => window.buoyancyLab.getState());
const project = () => page.evaluate(() => window.buoyancyLab.project());
const detail = () => page.evaluate(() => window.buoyancyLab.getDetail());
const debug = () => page.evaluate(() => window.buoyancyLab.sceneDebug());
const inspection = () => page.evaluate(() => window.buoyancyLab.getInspection());
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const load = value => page.evaluate(raw => window.buoyancyLab.loadProject(raw), serializeProject(value));
const selectPart = id => page.locator('#part-select').selectOption(id);
function sameCamera(actual, expected) {
  for (const key of ['position', 'target']) actual[key].forEach((value, i) => near(value, expected[key][i], 0, 1e-10));
  near(actual.zoom ?? 1, expected.zoom ?? 1, 0, 1e-12);
}
function fixture(config = {}) {
  return createProject({ experiment: { config: { bodyMassKg: .4, bodyVolumeM3: .001, fluidDensityKgM3: 1000, mode: 'held', heldBottomM: .18, ...config } },
    comparison: { label: '원래 자유부유 조건', experiment: { config: { bodyMassKg: .7123456789, bodyVolumeM3: .00123456789, fluidDensityKgM3: 1023.456789, mode: 'equilibrium', heldBottomM: .123456789 } } },
    view: { cutaway: true, forces: false, pressures: false, labels: false, selectedPart: 'test-body' },
    camera: { position: [.7, .6, .8], target: [0, .24, 0], zoom: 1.2 } });
}
function watch(target) {
  target.on('pageerror', error => errors.push(error.message));
  target.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  target.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
}
async function ready() {
  await page.waitForFunction(() => window.buoyancyLab?.sceneDebug()?.ready && window.buoyancyLab.getDetail);
  await paint();
}
async function capture(name, selector) {
  if (!selector) return page.screenshot({ path: path.join(output, name), fullPage: true });
  const locator = page.locator(selector);
  await locator.evaluate(element => element.scrollIntoView({ behavior: 'instant', block: 'center' })); await paint();
  const box = await locator.boundingBox();
  assert.ok(box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0);
  // This static app uses real animation frames. Locator capture accounts for
  // document scroll and can include an element taller than the viewport.
  await locator.screenshot({ path: path.join(output, name), timeout: 15000 });
}
async function change(id, value) { await page.locator(`#${id}-number`).fill(String(value)); await page.locator(`#${id}-number`).press('Tab'); }
const read = (object, key) => key.split('.').reduce((value, part) => value[part], object);
function formatted(value, digits = 3) {
  return value !== 0 && Math.abs(value) < .5 * 10 ** -digits ? value.toExponential(2)
    : value.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
function heldReference(config) {
  const b = config.heldBottomM, height = config.bodyVolumeM3 / AB, rho = config.fluidDensityKgM3;
  // Solve the entire volume equation by monotone bisection, independently of
  // the product's dry/partial/full branch equations.
  let low = 0, high = .5;
  for (let i = 0; i < 90; i++) {
    const level = (low + high) / 2, volume = AT * level - AB * Math.max(0, Math.min(height, level - b));
    if (volume < VF) low = level; else high = level;
  }
  const H = (low + high) / 2, h = Math.max(0, Math.min(height, H - b));
  const p = y => rho * G * Math.max(0, H - y), pb = p(b), pt = p(b + height);
  let sideForce = 0, firstMoment = 0;
  // Simpson quadrature integrates pressure and y*pressure over the actual
  // wetted height; no center-of-pressure closed form is copied from the app.
  for (let i = 0; i <= 128; i++) {
    const y = b + h * i / 128, weight = i === 0 || i === 128 ? 1 : i % 2 ? 4 : 2;
    const contribution = weight * p(y) * .1 * h / (3 * 128);
    sideForce += contribution; firstMoment += y * contribution;
  }
  return { b, height, H, h, pb, pt, sideForce, sideY: sideForce > 0 ? firstMoment / sideForce : null, buoyancy: rho * G * AB * h };
}
async function panelParity() {
  const s = (await state()).snapshot, d = await detail();
  const rows = await page.locator('#buoyancy-details [data-detail-value]').evaluateAll(elements => elements.map(element => ({
    key: element.dataset.detailValue, raw: element.dataset.raw, factor: Number(element.dataset.factor), digits: Number(element.dataset.digits), unit: element.dataset.unit, text: element.textContent,
  })));
  assert.ok(rows.length >= 14);
  for (const row of rows) {
    const value = read(d, row.key); assert.equal(row.raw, value === null ? 'null' : String(value));
    assert.equal(row.text, value === null ? '해당 없음' : `${formatted(value * row.factor, row.digits)} ${row.unit}`.trim());
  }
  const sum = { x: 0, y: 0, z: 0 };
  for (const [id, face] of Object.entries(d.faces)) {
    const row = page.locator(`[data-pressure-face="${id}"]`);
    assert.equal(Number(await row.getAttribute('data-area-m2')), face.areaM2);
    assert.deepEqual(JSON.parse(await row.getAttribute('data-center')), face.centerOfPressureM);
    assert.equal(Number(await page.locator(`[data-face-pressure="${id}"]`).getAttribute('data-raw')), face.meanGaugePressurePa);
    const force = page.locator(`[data-face-force="${id}"]`), axis = await force.getAttribute('data-axis');
    assert.equal(Number(await force.getAttribute('data-raw')), face.forceN[axis]);
    assert.equal(await force.textContent(), face.forceN[axis] === 0 ? '0 N' : `${formatted(Math.abs(face.forceN[axis]))} N · ${face.forceN[axis] > 0 ? '+' : '−'}${axis}`);
    for (const key of Object.keys(sum)) sum[key] += face.forceN[key];
  }
  near(sum.x, 0); near(sum.z, 0); near(sum.y, s.buoyancyN);
  near(d.fluid.massKg, s.config.fluidDensityKgM3 * VF); near(d.fluid.bottomFluidLoadN, d.fluid.weightN + s.buoyancyN);
  near(d.balance.buoyancyResidualN, 0); near(d.balance.volumeResidualM3, 0); near(d.balance.tankLoadResidualN, 0);
  const lower = Math.max(0, Math.min(s.bodyBottomM, s.waterLevelM) - .018), upper = Math.min(.5, Math.max(s.bodyTopM, s.waterLevelM) + .018);
  const y = height => 267 - (height - lower) / (upper - lower) * 237;
  for (const [id, value] of [['profile-cp', d.faces.right.centerOfPressureM?.y ?? null], ['profile-cb', d.body.centerOfBuoyancyM]]) {
    const marker = page.locator(`#${id}`); assert.equal(await marker.getAttribute('data-raw'), value === null ? 'null' : String(value));
    assert.equal(await marker.isVisible(), value !== null); if (value !== null) near(Number(await marker.getAttribute('cy')), y(value));
  }
  near(Number(await page.locator('#profile-surface').getAttribute('y1')), y(s.waterLevelM));
  for (const sample of JSON.parse(await page.locator('#profile-pressure').getAttribute('data-samples'))) near(sample.gaugePressurePa, s.config.fluidDensityKgM3 * G * Math.max(s.waterLevelM - sample.heightM, 0));
  assert.doesNotMatch(await page.locator('#profile-pressure').getAttribute('d'), /NaN|Infinity/);
}
async function factParity(partId, selector = '#part-facts') {
  const s = (await state()).snapshot, description = describeBuoyancyDetail(partId, s);
  const rows = await page.locator(`${selector} > div`).evaluateAll(elements => elements.map(element => ({ label: element.querySelector('dt').textContent, raw: element.querySelector('dd').dataset.raw, text: element.querySelector('dd').textContent })));
  assert.equal(rows.length, description.facts.length); assert.ok(rows.length > 0 && rows.length <= 6);
  rows.forEach((row, i) => {
    const fact = description.facts[i]; assert.equal(row.label, fact.label); assert.equal(row.raw, fact.value === null ? 'null' : String(fact.value));
    assert.equal(row.text, typeof fact.value === 'number' ? `${formatted(fact.value, fact.digits ?? 3)} ${fact.unit ?? ''}`.trim() : fact.value === null ? '해당 없음' : String(fact.value));
  });
}

try {
  browser = await chromium.launch({ headless: true, ...(hardware ? { args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] } : {}) });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
  page = await context.newPage(); page.setDefaultTimeout(20000); watch(page);
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' }); await ready();
  gpu = await page.evaluate(() => { const gl = document.querySelector('#scene canvas').getContext('webgl2'), extension = gl.getExtension('WEBGL_debug_renderer_info'); return { webgl2: Boolean(gl), renderer: gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER) }; });
  assert.equal(gpu.webgl2, true); if (hardware) assert.match(gpu.renderer, /RTX 5080.*D3D11|D3D11.*RTX 5080/);

  await check('arbitrary SI imports survive unchanged L/cm fields, inspection, original keyboard increments and file round trips', async () => {
    const config = { bodyMassKg: .4567890123, bodyVolumeM3: .000514014014, fluidDensityKgM3: 1023.4567891234, mode: 'held', heldBottomM: .020205205204 };
    // Both values lose one ULP when an unchanged unit display is multiplied back.
    assert.notEqual(config.bodyVolumeM3 / .001 * .001, config.bodyVolumeM3);
    assert.notEqual(config.heldBottomM / .01 * .01, config.heldBottomM);
    const fields = [['mass', 'bodyMassKg', 1, .01, .1, 'kg'], ['volume', 'bodyVolumeM3', .001, .01, .1, 'L'],
      ['density', 'fluidDensityKgM3', 1, 1, 10, 'kg/m³'], ['height', 'heldBottomM', .01, .1, .1, 'cm']];
    await load(fixture(config)); await page.locator('#inspect-part').click();
    const saved = await project(), originalSnapshot = (await state()).snapshot;
    assert.equal((await inspection()).id, 'test-body');
    for (const [id, key, factor, , , unit] of fields) {
      for (const selector of [`#${id}`, `#${id}-number`]) {
        const display = config[key] / factor, actual = Number(await page.locator(selector).inputValue());
        if (selector.endsWith('-number')) assert.equal(actual, display);
        // Native range canonicalization is allowed only in its last decimal;
        // the saved SI value and the accessible number display stay exact.
        else near(actual, display, 2 * Number.EPSILON, 0);
        assert.equal(await page.locator(selector).getAttribute('aria-valuetext'), `${display} ${unit}`);
        assert.equal(await page.locator(selector).evaluate(input => input.validity.stepMismatch), false);
      }
      await page.locator(`#${id}-number`).focus(); await page.keyboard.press('Tab');
      const number = page.locator(`#${id}-number`); await number.scrollIntoViewIfNeeded();
      assert.equal(await number.evaluate(input => getComputedStyle(input).appearance), 'textfield');
      const box = await number.boundingBox();
      await page.mouse.click(box.x + box.width - 7, box.y + box.height * .25);
      await number.press('Tab');
    }
    await page.evaluate(() => {
      for (const id of ['mass', 'volume', 'density', 'height']) {
        const number = document.querySelector(`#${id}-number`), range = document.querySelector(`#${id}`);
        number.dispatchEvent(new Event('change', { bubbles: true })); number.dispatchEvent(new Event('blur'));
        range.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    assert.deepEqual(await project(), saved); assert.deepEqual((await state()).snapshot, originalSnapshot);
    assert.equal((await inspection()).id, 'test-body');
    const originalDetail = await detail();
    assert.deepEqual(await page.evaluate(() => window.advanceTime(2000)), originalSnapshot);
    assert.deepEqual(await detail(), originalDetail);
    for (const [id, key, factor, rangeStep, numberStep] of fields) {
      await load(saved); let expected = config[key]; const range = page.locator(`#${id}`);
      for (const [pressed, magnitude] of [['ArrowRight', 1], ['Shift+ArrowLeft', -.1], ['PageUp', 10]]) {
        await range.press(pressed); expected += magnitude * rangeStep * factor;
        near((await state()).experiment.config[key], expected, 3e-15, 0);
        for (const other of Object.keys(config).filter(other => other !== key)) assert.equal((await state()).experiment.config[other], config[other]);
      }
      await range.press('Home'); assert.equal((await state()).experiment.config[key], CONFIG_LIMITS_SI[key].min);
      await range.press('End'); assert.equal((await state()).experiment.config[key], CONFIG_LIMITS_SI[key].max);
      await load(saved); expected = config[key]; const number = page.locator(`#${id}-number`);
      for (const pressed of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) await number.press(pressed);
      assert.deepEqual(await project(), saved);
      for (const [pressed, magnitude] of [['ArrowUp', 1], ['Shift+ArrowDown', -.1], ['PageUp', 10]]) {
        await number.press(pressed); expected += magnitude * numberStep * factor;
        near((await state()).experiment.config[key], expected, 3e-15, 0);
      }
      assert.deepEqual((await state()).comparison, saved.comparison); sameCamera((await project()).observation.camera, saved.observation.camera);
    }
    await load(saved); const pending = page.waitForEvent('download'); await page.locator('#save-project').click();
    const filename = path.join(output, 'precision.buoyancy.json'); await (await pending).saveAs(filename);
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), saved);
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready();
    assert.deepEqual(await project(), saved); assert.equal((await state()).experiment.config.heldBottomM, config.heldBottomM);
  });

  await check('all six pressure forces and their actual SVG centers agree with independent wetted-face quadrature', async () => {
    for (const config of [
      { heldBottomM: .28 }, { heldBottomM: .18 }, { heldBottomM: .06 },
      { bodyVolumeM3: .0007, heldBottomM: .205, fluidDensityKgM3: 815 },
      { bodyVolumeM3: .0018, heldBottomM: .07, fluidDensityKgM3: 1175 },
      { bodyVolumeM3: .002, heldBottomM: .015, fluidDensityKgM3: 1200 },
    ]) {
      await load(fixture(config)); const s = (await state()).snapshot, d = await detail(), ref = heldReference(s.config);
      near(s.waterLevelM, ref.H); near(s.submergedHeightM, ref.h); near(s.buoyancyN, ref.buoyancy);
      const expected = { bottom: [0, ref.pb * AB, 0], top: [0, -ref.pt * AB, 0],
        left: [ref.sideForce, 0, 0], right: [-ref.sideForce, 0, 0], front: [0, 0, -ref.sideForce], back: [0, 0, ref.sideForce] };
      for (const [id, force] of Object.entries(expected)) {
        ['x', 'y', 'z'].forEach((axis, i) => near(d.faces[id].forceN[axis], force[i]));
        if (force.every(value => value === 0)) assert.equal(d.faces[id].centerOfPressureM, null);
        else if (['left', 'right', 'front', 'back'].includes(id)) near(d.faces[id].centerOfPressureM.y, ref.sideY);
      }
      if (ref.h > 0) {
        near(d.faces.left.centerOfPressureM.x, -.05); near(d.faces.right.centerOfPressureM.x, .05);
        near(d.faces.front.centerOfPressureM.z, .05); near(d.faces.back.centerOfPressureM.z, -.05);
        assert.ok(d.faces.right.centerOfPressureM.y < d.body.centerOfBuoyancyM);
      }
      await panelParity();
    }
    await load(fixture()); await capture('pressure-partial.png', '#buoyancy-details');
    await load(fixture({ heldBottomM: .06 })); await capture('pressure-full.png', '#buoyancy-details');
    await load(fixture({ heldBottomM: .28 })); await capture('pressure-dry.png', '#buoyancy-details');
  });

  await check('held finite-tank derivatives match independent finite differences and disappear at both exact contact boundaries', async () => {
    await page.locator('#held-sensitivity summary').click();
    for (const bottom of [.18, .06, .28]) {
      const value = fixture({ heldBottomM: bottom }); await load(value); const d = await detail();
      const step = 1e-6, plus = heldReference({ ...value.experiment.config, heldBottomM: bottom + step }), minus = heldReference({ ...value.experiment.config, heldBottomM: bottom - step });
      near(d.sensitivity.waterLevelPerBottom, (plus.H - minus.H) / (2 * step), 0, 1e-9);
      near(d.sensitivity.buoyancyPerBottomNPerM, (plus.buoyancy - minus.buoyancy) / (2 * step), 0, 1e-7);
      near(d.sensitivity.holdingPerBottomNPerM, -(plus.buoyancy - minus.buoyancy) / (2 * step), 0, 1e-7);
      assert.equal(d.sensitivity.differentiable, true); await panelParity();
    }
    const fullContact = (VF + .001) / AT - .001 / AB;
    for (const [boundary, branch] of [[.22, 'dry-contact'], [fullContact, 'full-contact']]) {
      for (const offset of [0, Number.EPSILON]) {
        await load(fixture({ heldBottomM: boundary + offset })); const d = await detail();
        assert.equal(d.sensitivity.branch, branch); assert.equal(d.sensitivity.differentiable, false);
        for (const key of ['waterLevelPerBottom', 'buoyancyPerBottomNPerM', 'holdingPerBottomNPerM']) assert.equal(d.sensitivity[key], null);
        assert.match(await page.locator('#sensitivity-state').textContent(), /접촉 경계/); await panelParity();
      }
      for (const offset of [-1e-7, 1e-7]) {
        await load(fixture({ heldBottomM: boundary + offset })); assert.equal((await detail()).sensitivity.differentiable, true);
      }
    }
    await load(fixture({ heldBottomM: .18 })); await panelParity();
    near((await detail()).sensitivity.finiteTankFactor, AT / (AT - AB));
    await capture('sensitivity.png', '#held-sensitivity');
  });

  await check('free, neutral and overweight reference poses retain their physical meaning without a fictitious time evolution', async () => {
    for (const [mass, kind, equilibrium] of [[.4, 'equilibrium', 'unique'], [1, 'neutral-reference', 'continuum'], [1.2, 'submerged-reference', 'none']]) {
      await load(fixture({ bodyMassKg: mass, mode: 'equilibrium' })); const current = await state(), d = await detail();
      assert.equal(current.snapshot.poseKind, kind); assert.equal(current.snapshot.freeEquilibrium, equilibrium);
      assert.equal(current.snapshot.holdingForceYN, 0); assert.equal(d.sensitivity.applicable, false);
      assert.equal(d.sensitivity.waterLevelPerBottom, null); assert.equal(Object.hasOwn(current, 'running'), false);
      if (equilibrium !== 'unique') assert.equal(current.snapshot.equilibriumBottomM, null);
      assert.deepEqual(await page.evaluate(() => window.advanceTime(86400000)), current.snapshot);
      const text = await page.evaluate(() => JSON.parse(window.render_game_to_text())); assert.equal(text.mode, 'static');
      assert.deepEqual(text.snapshot, current.snapshot); await panelParity();
    }
  });

  await check('fourteen component fact tables preserve applied conditions, frozen comparison and the manual camera', async () => {
    await load(fixture()); const before = await project();
    for (const { id } of COMPONENTS) {
      await selectPart(id); await factParity(id); const current = await project();
      assert.deepEqual(current.experiment, before.experiment); assert.deepEqual(current.comparison, before.comparison);
      sameCamera(current.observation.camera, before.observation.camera); assert.equal(await inspection(), null);
    }
    await selectPart('fluid-volume'); assert.match(await page.locator('#part-detail-note').textContent(), /38.5 L/);
    await change('density', 850); await factParity('fluid-volume'); near((await detail()).fluid.massKg, 850 * VF);
    assert.deepEqual((await state()).comparison, before.comparison);
  });

  await check('eight explicit inspections expose only their intended physical context and restore the original camera and flags', async () => {
    const ids = ['holding-frame', 'holding-carriage', 'holding-link', 'test-body', 'submerged-volume', 'free-surface', 'pressure-bottom', 'pressure-top'];
    for (const id of ids) {
      await load(fixture({ heldBottomM: .06 })); await selectPart(id); const before = await project();
      await page.locator('#inspect-part').click(); const active = await inspection(), scene = await debug();
      assert.equal(active.id, id); assert.equal(active.kind, id.startsWith('holding-') ? 'mechanism' : 'hydrostatic');
      assert.equal(scene.mechanical.groundVisible, false); assert.equal(scene.visibleParts.includes('tank-shell'), false);
      assert.notDeepEqual(scene.camera, before.observation.camera); sameCamera(scene.projectCamera, before.observation.camera);
      assert.deepEqual(await project(), before); assert.deepEqual((await state()).view, before.observation.view);
      assert.equal(scene.mechanical.sectionFrontRemoved, active.kind === 'mechanism');
      if (active.kind === 'mechanism') {
        assert.equal(scene.visibleParts.includes('holding-carriage'), true); assert.equal(scene.visibleParts.includes('fluid-volume'), false);
        near(scene.mechanical.guide.minimumClearanceM, .0003, 0, 1e-8);
        assert.ok(scene.mechanical.clamp.radialClearanceM > 0); assert.ok(scene.mechanical.clamp.padPocketRadialClearanceM > 0);
        near(scene.mechanical.clamp.padContactGapM, 0, 0, 1e-7); near(scene.mechanical.clamp.knobToScrewGapM, 0, 0, 1e-7);
      } else {
        assert.equal(scene.localSurfacePatch.visible, true); near(scene.localSurfacePatch.heightM, (await state()).snapshot.waterLevelM);
        assert.equal(scene.visibleParts.includes('holding-frame'), false); assert.equal(scene.visibleParts.includes('test-body'), true);
      }
      await page.locator('#end-inspection').click(); assert.equal(await inspection(), null);
      sameCamera((await debug()).camera, before.observation.camera); assert.deepEqual(await project(), before);
      assert.equal((await debug()).mechanical.groundVisible, true);
    }
    await load(fixture()); await selectPart('holding-carriage'); await page.locator('#inspect-part').click(); await capture('carriage-inspection.png', '.observation');
    await page.locator('#inspection-select').selectOption('holding-link'); await capture('holding-link-inspection.png', '.observation');
    await page.locator('#end-inspection').click();
  });

  await check('isolated hydrostatic pressures follow actual body faces while saved display flags and force arrows remain distinct', async () => {
    for (const [bottom, file] of [[.18, 'hydrostatic-partial.png'], [.06, 'hydrostatic-full.png'], [.28, 'hydrostatic-dry.png']]) {
      await load(fixture({ heldBottomM: bottom })); await selectPart('pressure-bottom'); const before = await project();
      await page.locator('#inspect-part').click(); const s = (await state()).snapshot, scene = await debug();
      for (const group of scene.pressureArrows) {
        const pressure = group.id === 'pressure-bottom' ? s.bottomGaugePressurePa : s.topGaugePressurePa;
        for (const arrow of group.arrows) {
          assert.equal(arrow.visible, pressure > 0);
          if (arrow.visible) {
            const faceHeight = group.id === 'pressure-bottom' ? s.bodyBottomM : s.bodyTopM;
            near(arrow.endM[1], faceHeight, 0, 1e-7);
            near(Math.abs(arrow.endM[1] - arrow.startM[1]), pressure * .000015, 0, 1e-7);
          }
        }
      }
      assert.equal(scene.forces.some(force => force.visible), false);
      assert.equal(scene.localSurfacePatch.hasBodyOpening, s.immersion === 'partial');
      await capture(file, '.observation'); await page.locator('#end-inspection').click();
      assert.deepEqual(await project(), before); assert.equal((await state()).view.pressures, false);
      assert.equal((await debug()).pressureArrows.some(group => group.arrows.some(arrow => arrow.visible)), false);
    }
  });

  await check('inspection file saves contain only original schema fields and restore the complete ordinary observation', async () => {
    await load(fixture()); await selectPart('holding-carriage'); const before = await project();
    await page.locator('#inspect-part').click(); const pending = page.waitForEvent('download'); await page.locator('#save-project').click();
    const filename = path.join(output, 'inspection.buoyancy.json'); await (await pending).saveAs(filename);
    const raw = await fs.readFile(filename, 'utf8'); assert.deepEqual(JSON.parse(raw), before);
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['comparison', 'experiment', 'modelVersion', 'observation', 'schemaVersion', 'type']);
    await page.reload({ waitUntil: 'domcontentloaded' }); await ready(); assert.equal(await inspection(), null);
    sameCamera((await debug()).camera, before.observation.camera); assert.deepEqual(await project(), before);
    await page.locator('#inspect-part').click(); await page.locator('#project-file').setInputFiles(filename);
    await page.waitForFunction(() => window.buoyancyLab.getInspection() === null); assert.deepEqual(await project(), before);
    assert.equal(await fs.readFile(filename, 'utf8'), raw);
  });

  await check('live conditions update inspected meshes without leaking geometry or changing the saved camera and restored display choices', async () => {
    await load(fixture()); const original = await project(); await page.locator('#inspect-part').click();
    for (const [key, value] of [['cutaway', false], ['forces', true], ['pressures', true], ['labels', true]]) await page.locator(`[data-view="${key}"]`).setChecked(value);
    await change('height', 6); await change('volume', 2);
    const s = (await state()).snapshot, scene = await debug();
    assert.equal((await inspection()).id, 'test-body'); near(scene.bodyBoundsM.min[1], .06, 0, 1e-7);
    near(scene.bodyBoundsM.max[1], .26, 0, 1e-7); near(scene.bodyMeshVolumeM3, .002, 0, 1e-9);
    near(scene.waterMeshVolumeM3, VF, 0, 2e-8); near(scene.submergedMeshVolumeM3, s.displacedVolumeM3, 0, 1e-9);
    sameCamera(scene.projectCamera, original.observation.camera);
    const resources = scene.resources;
    for (const id of ['pressure-bottom', 'free-surface', 'test-body', 'pressure-bottom']) await page.locator('#inspection-select').selectOption(id);
    const after = (await debug()).resources;
    for (const key of ['bodyGeometryId', 'waterGeometryId', 'waterlineGeometryId', 'linkGeometryId']) assert.equal(after[key], resources[key]);
    assert.equal(after.geometries, resources.geometries); assert.equal(after.textures, resources.textures);
    await page.locator('#end-inspection').click(); const restored = await debug();
    assert.equal(restored.frontWallVisible, true); assert.equal(restored.forces.some(force => force.visible), true);
    assert.equal(restored.pressureArrows.some(group => group.arrows.some(arrow => arrow.visible)), true);
    sameCamera(restored.camera, original.observation.camera); assert.deepEqual((await state()).comparison, original.comparison);
  });

  await check('depth guide evidence, new and undo preserve their existing meaning while inspections are temporary', async () => {
    await load(fixture()); const before = await project(); await page.locator('[data-lesson="depth"]').click();
    await page.locator('[data-view="pressures"]').check(); await selectPart('pressure-bottom'); await page.locator('#inspect-part').click();
    assert.equal(await page.locator('#guide-next').isEnabled(), true); await page.locator('#guide-next').click();
    const first = await page.evaluate(() => window.buoyancyLab.guide().evidence[0]);
    await change('height', 1.5); await page.locator('#guide-next').click();
    const completed = await page.evaluate(() => window.buoyancyLab.guide()); assert.equal(completed.status, 'completed');
    assert.equal(completed.evidence.length, 2); near(completed.evidence[1].buoyancyN, first.buoyancyN);
    assert.ok(completed.evidence[1].bottomGaugePressurePa > first.bottomGaugePressurePa);
    const guideProject = await project(); await page.locator('#new-project').click(); assert.equal(await inspection(), null);
    await page.locator('#undo-new').click(); assert.deepEqual(await project(), guideProject);
    assert.deepEqual(await page.evaluate(() => window.buoyancyLab.guide()), completed); assert.equal(await inspection(), null);
    await load(before); assert.deepEqual(await project(), before);
  });

  await check('a settled detail view and inspection redraw only on interaction and leave the static experiment untouched', async () => {
    await load(fixture()); await page.locator('#inspect-part').click(); await paint();
    await page.waitForTimeout(300); const original = await state(), d = await detail(), before = await debug();
    await page.waitForTimeout(250); assert.equal((await debug()).renderFrame, before.renderFrame);
    assert.deepEqual(await state(), original); assert.deepEqual(await detail(), d);
    await page.evaluate(() => { const value = window.buoyancyLab.getDetail(); value.fluid.massKg = -1; value.faces.bottom.forceN.y = -1; });
    assert.deepEqual(await detail(), d); await page.locator('#end-inspection').click();
    await load(createProject()); await capture('overview.png');
  });

  await check('390px pressure details remain readable and focused inspection can switch all eight targets without changing the saved camera', async () => {
    await page.setViewportSize({ width: 390, height: 844 }); await load(fixture()); await paint();
    await panelParity();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    const tick = page.locator('#pressure-grid text').first();
    assert.ok(Number.parseFloat(await tick.evaluate(element => getComputedStyle(element).fontSize)) >= 17);
    const matrix = await page.locator('.pressure-profile svg').evaluate(svg => ({ scale: svg.getScreenCTM().a, width: svg.getBoundingClientRect().width }));
    assert.ok(matrix.width > 300 && matrix.scale * 17 >= 9.5);
    const summary = page.locator('#fluid-balance summary'), before = await project();
    await summary.focus(); const wasOpen = await page.locator('#fluid-balance').evaluate(element => element.open);
    await page.keyboard.press('Space'); assert.equal(await page.locator('#fluid-balance').evaluate(element => element.open), !wasOpen);
    assert.deepEqual(await project(), before); await capture('mobile-pressure.png', '#buoyancy-details');
    await page.locator('[data-detail-inspect="pressure-bottom"]').click(); await page.locator('#focus').click();
    assert.equal(await page.locator('body').evaluate(element => element.classList.contains('focus-mode')), true);
    assert.equal(await page.locator('#inspection-select').isVisible(), true);
    const selectedProject = await project(), options = await page.locator('#inspection-select option').evaluateAll(elements => elements.map(element => element.value));
    assert.equal(options.length, 8);
    for (const id of options) {
      await page.locator('#inspection-select').selectOption(id); assert.equal((await inspection()).id, id);
      const current = await project(); assert.deepEqual(current.experiment, before.experiment); assert.deepEqual(current.comparison, before.comparison);
      sameCamera(current.observation.camera, selectedProject.observation.camera);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await page.locator('#inspection-select').selectOption('holding-carriage'); await capture('mobile-carriage.png', '.observation');
    await page.locator('#inspection-select').selectOption('pressure-bottom'); await capture('mobile-hydrostatic.png', '.observation');
    await page.locator('#end-inspection').click(); sameCamera((await debug()).camera, selectedProject.observation.camera);
    await page.locator('#focus').click(); await panelParity(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.setViewportSize({ width: 1600, height: 1000 });
    await load(fixture());
    for (const id of ['fluid-balance', 'held-sensitivity']) if (!await page.locator(`#${id}`).evaluate(element => element.open)) await page.locator(`#${id} summary`).click();
    await capture('details-expanded.png', '#buoyancy-details');
  });

  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
} catch (error) {
  failure = { message: error.message, stack: error.stack };
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ state: await state().catch(() => null), debug: await debug().catch(() => null), detail: await detail().catch(() => null) }, null, 2));
  }
} finally {
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ checks, errors, externalRequests, gpu, failure }, null, 2));
  await browser?.close(); await server.close();
}
if (failure) throw new Error(failure.stack);
console.log(`Validated ${checks.length} detail browser checks.`);
