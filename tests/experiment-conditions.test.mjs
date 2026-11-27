import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_LIMITS_SI, CONSTANTS_SI as C, DEFAULT_CONFIG, createExperiment, getSnapshot, samplePressurePa } from '../src/model.js';
import { getBodyGeometry, getFluidBoxes } from '../src/geometry.js';
import { buoyancyDetail, describeBuoyancyDetail } from '../src/detail-model.js';
import { createGuide, lessonReady } from '../src/lessons.js';
import { createProject, parseProject, serializeProject } from '../src/project.js';

const experiment = (patch = {}) => ({ config: { ...DEFAULT_CONFIG, ...patch } });
const snapshot = patch => getSnapshot(experiment(patch));
const near = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

test('changing fill moves the floating equilibrium and the held contact boundaries', () => {
  const before = snapshot(), after = snapshot({ fluidVolumeM3: .052 });
  const rise = (.052 - .0385) / .175;
  near(after.waterLevelM - before.waterLevelM, rise);
  near(after.bodyBottomM - before.bodyBottomM, rise);
  near(after.buoyancyN, before.buoyancyN);
  near(after.submergedFraction, .4);

  const pose = { mode: 'held', heldBottomM: .26 };
  assert.equal(snapshot(pose).immersion, 'dry');
  const held = snapshot({ ...pose, fluidVolumeM3: .052 });
  assert.equal(held.immersion, 'partial');
  near(held.waterLevelM, (.052 - .01 * .26) / .165);
  near(held.displacedVolumeM3, (held.waterLevelM - .26) * .01, 1e-16);
  near(held.holdingForceYN, held.weightN - held.buoyancyN);
});

test('gravity scales pressure and forces at the same geometry, including an equivalent free and held pose', () => {
  const conditions = { bodyMassKg: .7, fluidVolumeM3: .047, fluidDensityKgM3: 1075 };
  const free = snapshot({ ...conditions, gravityMps2: 1.62 });
  const alternate = snapshot({ ...conditions, gravityMps2: 10 });
  assert.equal(free.waterLevelM, alternate.waterLevelM);
  assert.equal(free.displacedVolumeM3, alternate.displacedVolumeM3);
  assert.equal(free.bodyBottomM, alternate.bodyBottomM);
  for (const key of ['buoyancyN', 'weightN', 'bottomGaugePressurePa', 'bottomPressureForceYN']) {
    near(free[key], alternate[key] * 1.62 / 10);
  }
  const heldExperiment = experiment({ ...conditions, gravityMps2: 1.62, mode: 'held', heldBottomM: free.bodyBottomM });
  const held = getSnapshot(heldExperiment), detail = buoyancyDetail(held);
  near(held.waterLevelM, free.waterLevelM);
  near(held.holdingForceYN, 0);
  near(held.netForceYN, 0);
  near(samplePressurePa(heldExperiment, held.bodyBottomM), held.bottomGaugePressurePa);
  near(detail.fluid.weightN, 1075 * .047 * 1.62);
  near(detail.fluid.bottomFluidLoadN, detail.fluid.weightN + held.buoyancyN);
  near(detail.fluid.waterRiseM, held.displacedVolumeM3 / .175);
  near(detail.balance.pressureResultantN.y, held.buoyancyN);
  near(detail.faces.right.forceN.x, -.1 * held.submergedHeightM * held.bottomGaugePressurePa / 2);
  assert.deepEqual(detail.balance.pressureResultantN, { x: 0, y: detail.balance.pressureResultantN.y, z: 0 });
  assert.equal(describeBuoyancyDetail('force-weight', held, detail).facts[1].value, 1.62);
});

test('held pressure, free-body balance and sensitivity follow changed fill at both contact boundaries', () => {
  const conditions = { bodyMassKg: .6, fluidVolumeM3: .046, gravityMps2: 3.71, mode: 'held' };
  const fullBoundary = (.046 + .001) / .175 - .1, dryBoundary = .046 / .175;
  for (const [bottom, boundaryName, branches] of [
    [fullBoundary, 'full-contact', ['full', 'partial']],
    [dryBoundary, 'dry-contact', ['partial', 'dry']],
  ]) {
    const at = snapshot({ ...conditions, heldBottomM: bottom });
    const sides = [-1e-7, 1e-7].map(offset => snapshot({ ...conditions, heldBottomM: bottom + offset }));
    assert.equal(buoyancyDetail(at).sensitivity.branch, boundaryName);
    assert.equal(buoyancyDetail(at).sensitivity.differentiable, false);
    assert.deepEqual(sides.map(s => s.immersion), branches);
    for (const s of [at, ...sides]) {
      near(s.fluidVolumeResidualM3, 0, 1e-16);
      near(s.netForceYN, 0);
      near(s.bottomPressureForceYN + s.topPressureForceYN, s.buoyancyN);
      near(s.waterLevelM, at.waterLevelM, 1e-7);
      near(s.buoyancyN, at.buoyancyN, 1e-5);
      near(buoyancyDetail(s).balance.tankLoadResidualN, 0);
    }
    const partial = sides.find(s => s.immersion === 'partial');
    const { sensitivity } = buoyancyDetail(partial);
    const observedSlope = (partial.buoyancyN - at.buoyancyN) / (partial.bodyBottomM - bottom);
    near(sensitivity.buoyancyPerBottomNPerM, -1000 * 3.71 * .01 * .175 / .165);
    near(sensitivity.buoyancyPerBottomNPerM, observedSlope, 1e-7);
    near(sensitivity.holdingPerBottomNPerM, -observedSlope, 1e-7);
  }
});

test('both fill extrema keep the water and every supported pose clear of tank bounds', () => {
  const { min, max } = CONFIG_LIMITS_SI.fluidVolumeM3;
  for (const fluidVolumeM3 of [min, max]) for (const bodyVolumeM3 of [.0005, .002]) {
    for (const fluidDensityKgM3 of [800, 1200]) for (const bodyMassKg of [.1, fluidDensityKgM3 * bodyVolumeM3, 3]) {
      for (const mode of ['equilibrium', 'held']) for (const heldBottomM of [.015, .28]) {
        const s = snapshot({ fluidVolumeM3, bodyVolumeM3, fluidDensityKgM3, bodyMassKg, mode, heldBottomM, gravityMps2: 10 });
        const { body } = getBodyGeometry(s);
        assert.ok(body.min[1] >= C.minBottomM && body.max[1] <= C.tankHeightM - .005 + 1e-15);
        assert.ok(s.waterLevelM <= .055 / .175 + 1e-15);
        assert.ok(s.weightN <= 30 && s.buoyancyN <= 30 && Math.abs(s.holdingForceYN) <= 30);
        if (s.neutralBottomRangeM) assert.ok(s.neutralBottomRangeM[1] > s.neutralBottomRangeM[0]);
        const volume = getFluidBoxes(s).reduce((total, { min, max }) => total +
          max.reduce((size, value, axis) => size * (value - min[axis]), 1), 0);
        near(volume, fluidVolumeM3, 1e-16);
      }
    }
  }
});

test('legacy project and comparison defaults restore, while optional overrides validate independently', () => {
  const legacy = createProject({ experiment: experiment(), comparison: { label: '이전 조건', experiment: experiment({ mode: 'held' }) } });
  const restoredLegacy = parseProject('\ufeff' + JSON.stringify(legacy));
  assert.deepEqual(restoredLegacy, legacy);
  for (const state of [restoredLegacy.experiment, restoredLegacy.comparison.experiment]) {
    const s = getSnapshot(state);
    assert.equal(s.fluidVolumeM3, .0385);
    assert.equal(s.emptyWaterLevelM, .22);
    assert.equal(s.gravityMps2, 9.80665);
  }
  const current = createProject({
    experiment: experiment({ fluidVolumeM3: .0467812345, gravityMps2: 1.623456789 }),
    comparison: { label: '다른 액체량', experiment: experiment({ fluidVolumeM3: .048 }) },
  });
  assert.deepEqual(parseProject(serializeProject(current)), current);
  assert.equal(getSnapshot(current.comparison.experiment).gravityMps2, 9.80665);
  for (const patch of [{ fluidVolumeM3: .054 }, { fluidVolumeM3: 53 }, { gravityMps2: 0 }, { gravityMps2: '9.8' }, { gravityMps2: null }]) {
    for (const target of [p => p.experiment, p => p.comparison.experiment]) {
      const invalid = structuredClone(legacy);
      Object.assign(target(invalid).config, patch);
      assert.throws(() => parseProject(JSON.stringify(invalid)), { code: 'INVALID_EXPERIMENT' });
    }
  }
  assert.deepEqual(createExperiment({ fluidVolumeM3: .7, gravityMps2: 0 }).config,
    { ...DEFAULT_CONFIG, fluidVolumeM3: .053, gravityMps2: 1 });
});

test('guided comparisons keep the specified fill and gravity consistent across observations', () => {
  const guide = createGuide('mass');
  assert.equal(lessonReady(guide, experiment(), {}), true);
  assert.equal(lessonReady(guide, experiment({ fluidVolumeM3: .052 }), {}), false);
  assert.equal(lessonReady(guide, experiment({ gravityMps2: 3.71 }), {}), false);
  assert.equal(lessonReady(guide, experiment({ fluidVolumeM3: .0385, gravityMps2: 9.80665 }), {}), true);
});
