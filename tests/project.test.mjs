import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, parseProject, serializeProject, normalizeView, DEFAULT_VIEW, ProjectError } from '../src/project.js';
import { DEFAULT_CONFIG, MODEL_VERSION, getSnapshot } from '../src/model.js';
import { COMPONENTS } from '../src/geometry.js';
const roundtrip = value => parseProject(serializeProject(value));
const experiment = () => ({ config: { bodyMassKg: .7123456789, bodyVolumeM3: .00123456789,
  fluidDensityKgM3: 1023.456789, mode: 'held', heldBottomM: .123456789 } });
const rejects = edit => { const value = createProject(); edit(value); const raw = JSON.stringify(value);
  assert.throws(() => parseProject(raw), e => e instanceof ProjectError && e.preserveOriginal);
  assert.equal(JSON.stringify(value), raw); };

test('default envelope stores static conditions and separate observation without a clock', () => {
  const value = createProject();
  assert.deepEqual(value, { type: 'buoyancy-lab-project', schemaVersion: 1, modelVersion: MODEL_VERSION,
    experiment: { config: { ...DEFAULT_CONFIG } }, comparison: null,
    observation: { view: { ...DEFAULT_VIEW }, camera: null } });
  assert.deepEqual(roundtrip(value), value);
});

test('both modes and all input endpoints remain exact after saving and opening', () => {
  for (const bodyMassKg of [.1, 3]) for (const bodyVolumeM3 of [.0005, .002])
    for (const fluidDensityKgM3 of [800, 1200]) for (const heldBottomM of [.015, .28])
      for (const mode of ['equilibrium', 'held']) {
        const value = { config: { bodyMassKg, bodyVolumeM3, fluidDensityKgM3, mode, heldBottomM } };
        assert.deepEqual(roundtrip(createProject({ experiment: value })).experiment, value);
      }
});

test('fractional held conditions and a frozen free-floating comparison reconstruct identical snapshots', () => {
  const current = experiment(), comparison = { label: '가벼운 물체', experiment: { config: { ...DEFAULT_CONFIG } } };
  const value = createProject({ experiment: current, comparison }), restored = roundtrip(value);
  assert.deepEqual(restored, value);
  assert.deepEqual(getSnapshot(restored.experiment), getSnapshot(current));
  assert.deepEqual(getSnapshot(restored.comparison.experiment), getSnapshot(comparison.experiment));
  assert.ok(Math.abs(getSnapshot(restored.comparison.experiment).buoyancyN - .4 * 9.80665) < 1e-12);
});

test('strict imports reject display-unit confusion, invalid enum, missing keys and unknown conditions', () => {
  for (const bodyVolumeM3 of [.00049, .00201, 1, '0.001', null]) rejects(p => { p.experiment.config.bodyVolumeM3 = bodyVolumeM3; });
  for (const heldBottomM of [0, .281, 6, '0.06', null]) rejects(p => { p.experiment.config.heldBottomM = heldBottomM; });
  for (const bodyMassKg of [.099, 3.01]) rejects(p => { p.experiment.config.bodyMassKg = bodyMassKg; });
  for (const fluidDensityKgM3 of [799, 1201]) rejects(p => { p.experiment.config.fluidDensityKgM3 = fluidDensityKgM3; });
  rejects(p => { p.experiment.config.mode = 'falling'; }); rejects(p => { delete p.experiment.config.mode; });
  rejects(p => { p.experiment.config.bodyHeightM = .1; });
});

test('nonfinite and signed-zero numbers are rejected rather than silently canonicalized on import', () => {
  for (const number of [NaN, Infinity, -Infinity, -0]) {
    const value = createProject(); value.experiment.config.bodyMassKg = number;
    assert.throws(() => serializeProject(value), ProjectError);
    value.experiment.config.bodyMassKg = .4;
    value.observation.camera = { position: [number, .5, 1], target: [0, 0, 0] };
    assert.throws(() => serializeProject(value), ProjectError);
  }
  const raw = serializeProject(createProject({ camera: { position: [0, .5, 1], target: [0, 0, 0] } }));
  assert.throws(() => parseProject(raw.replace('"position": [\n        0,', '"position": [\n        -0,')), ProjectError);
});

test('live construction repairs only live defaults and preserves valid input exactly', () => {
  const value = createProject({ experiment: { config: { bodyMassKg: 99, bodyVolumeM3: -1,
    fluidDensityKgM3: 2000, mode: 'bad', heldBottomM: 0 } } });
  assert.deepEqual(value.experiment.config, { bodyMassKg: 3, bodyVolumeM3: .0005,
    fluidDensityKgM3: 1200, mode: 'equilibrium', heldBottomM: .015 });
  assert.deepEqual(createProject({ experiment: experiment() }).experiment, experiment());
  assert.deepEqual(createProject(null), createProject());
  assert.deepEqual(createProject({ experiment: { config: null } }).experiment, createProject().experiment);
});

test('all fourteen apparatus targets and the four observation flags roundtrip independently', () => {
  assert.equal(COMPONENTS.length, 14); assert.deepEqual(normalizeView(null), DEFAULT_VIEW);
  for (const { id } of COMPONENTS) {
    const view = { cutaway: false, forces: false, pressures: true, labels: false, selectedPart: id };
    assert.deepEqual(roundtrip(createProject({ view })).observation.view, view);
  }
  rejects(p => { p.observation.view.selectedPart = 'orbiter'; });
  rejects(p => { p.observation.view.forces = 1; }); rejects(p => { p.observation.view.exploded = true; });
});

test('camera meter boundaries and optional zoom preserve exact coordinates', () => {
  for (const camera of [null, { position: [.08, 0, 0], target: [0, 0, 0] },
    { position: [30, 0, 0], target: [-10, 0, 0], zoom: .25 },
    { position: [.7323456789, .55, .8], target: [.01, .2, -.03], zoom: 4 }])
    assert.deepEqual(roundtrip(createProject({ camera })).observation.camera, camera);
  for (const camera of [{ position: [0, 0, 0], target: [0, 0, 0] },
    { position: [.079, 0, 0], target: [0, 0, 0] }, { position: [30, 0, 0], target: [-10.01, 0, 0] },
    { position: [31, 0, 0], target: [1, 0, 0] }, { position: [1, 0], target: [0, 0, 0] },
    { position: [1, 0, 0], target: [0, 0, 0], zoom: 5 }]) rejects(p => { p.observation.camera = camera; });
});

test('neutral and unavailable free equilibrium stay derived and held height is still preserved in free mode', () => {
  for (const [bodyMassKg, kind] of [[1, 'continuum'], [1.2, 'none']]) {
    const input = { config: { ...DEFAULT_CONFIG, bodyMassKg, heldBottomM: .23456789 } };
    const restored = roundtrip(createProject({ experiment: input }));
    assert.deepEqual(restored.experiment, input);
    assert.equal(getSnapshot(restored.experiment).freeEquilibrium, kind);
    assert.equal(getSnapshot(restored.experiment).equilibriumBottomM, null);
    assert.equal(restored.experiment.config.heldBottomM, .23456789);
  }
});

test('comparison and detached copies prevent caller-state or camera aliasing', () => {
  const input = { experiment: experiment(), comparison: { label: ' 보관 조건 ', experiment: experiment() },
    camera: { position: [1, 1, 1], target: [0, 0, 0] } };
  const before = structuredClone(input), value = createProject(input);
  value.experiment.config.bodyMassKg = .4; value.comparison.experiment.config.heldBottomM = .015;
  value.observation.camera.position[0] = 2;
  assert.deepEqual(input, before); assert.equal(roundtrip(value).comparison.label, input.comparison.label);
  for (const label of ['', ' ', 'a'.repeat(81), 'bad\nname']) rejects(p => { p.comparison = { label, experiment: experiment() }; });
  rejects(p => { p.comparison = { label: 'bad', experiment: { config: { ...DEFAULT_CONFIG, heldBottomM: 0 } } }; });
  assert.equal(createProject({ comparison: { label: 'bad', experiment: null } }).comparison, null);
});

test('derived forces, reference poses, time, guide progress and playback are not saved physical state', () => {
  for (const key of ['running', 'elapsedS', 'clock', 'guide', 'snapshot']) rejects(p => { p[key] = 1; });
  for (const key of ['bodyBottomM', 'holdingForceYN', 'buoyancyN', 'freeEquilibrium', 'velocity']) rejects(p => { p.experiment[key] = 0; });
  for (const key of ['rate', 'daysPerSecond', 'running']) rejects(p => { p.observation[key] = 1; });
  rejects(p => { p.comparison = { label: 'derived', experiment: experiment(), displacedVolumeM3: .001 }; });
});

test('future formats protect original records and unrelated products are refused', () => {
  for (const [key, value, code] of [['schemaVersion', 2, 'FUTURE_SCHEMA'], ['modelVersion', 'buoyancy-static-2', 'FUTURE_MODEL']]) {
    assert.throws(() => parseProject(JSON.stringify({ ...createProject(), [key]: value })),
      e => e instanceof ProjectError && e.futureVersion && e.preserveOriginal && e.code === code);
  }
  rejects(p => { p.type = 'orbit-lab-project'; }); rejects(p => { p.modelVersion = 'orbit-kepler-1'; });
  rejects(p => { p.schemaVersion = '1'; }); rejects(p => { delete p.comparison; });
});

test('one BOM is accepted while invalid JSON and oversized UTF-8 text are refused without changing input', () => {
  const value = createProject(), raw = serializeProject(value); assert.deepEqual(parseProject('\ufeff' + raw), value);
  for (const input of ['\ufeff\ufeff' + raw, '{원본\r\n', null, 4]) assert.throws(() => parseProject(input), e => e.code === 'INVALID_JSON');
  for (const input of [' '.repeat(10 * 1024 * 1024 + 1), '가'.repeat(4 * 1024 * 1024)]) assert.throws(() => parseProject(input), e => e.code === 'PROJECT_TOO_LARGE');
});
