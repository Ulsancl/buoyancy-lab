import test from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../src/model.js';

const { MODEL_VERSION, CONSTANTS_SI, DEFAULT_CONFIG, CONFIG_LIMITS_SI,
  assertConfig, normalizeConfig, createExperiment, assertExperiment, getSnapshot, samplePressurePa } = model;
const experiment = (overrides = {}) => ({ config: { ...DEFAULT_CONFIG, ...overrides } });
const snapshot = (overrides = {}) => getSnapshot(experiment(overrides));
const near = (actual, expected, tolerance = 1e-12) => {
  assert.ok(Number.isFinite(actual), `Non-finite value: ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}; tolerance ${tolerance}`);
};
const SNAPSHOT_KEYS = [
  'config', 'bodyDensityKgM3', 'freeEquilibrium', 'immersion', 'poseKind', 'equilibriumBottomM',
  'neutralBottomRangeM', 'bodyBottomM', 'bodyTopM', 'bodyHeightM', 'bodyCenterM',
  'waterLevelM', 'emptyWaterLevelM', 'fluidVolumeM3', 'displacedVolumeM3', 'submergedHeightM',
  'submergedFraction', 'centerOfBuoyancyM', 'weightN', 'buoyancyN', 'holdingForceYN',
  'unrestrainedForceYN', 'netForceYN', 'bottomGaugePressurePa', 'topGaugePressurePa',
  'bottomPressureForceYN', 'topPressureForceYN', 'pressureSamples', 'bottomContact', 'fluidVolumeResidualM3',
].sort();

// Independent geometric oracle: integrate unoccupied horizontal cross-sections,
// splitting at body faces, then bisect to recover the fixed amount of liquid.
// It does not choose the model's dry/partial/full branch or call its pressure API.
function geometricLiquidVolume(level, bottom, height) {
  const cuts = [0, level, ...[bottom, bottom + height].filter(y => y > 0 && y < level)].sort((a, b) => a - b);
  return cuts.slice(1).reduce((sum, end, index) => {
    const start = cuts[index], midpoint = (start + end) / 2;
    const occupiedArea = midpoint > bottom && midpoint < bottom + height ? 0.01 : 0;
    return sum + (end - start) * (0.175 - occupiedArea);
  }, 0);
}

function levelOracle(bottom, height) {
  let low = 0, high = 0.50;
  for (let iteration = 0; iteration < 70; iteration += 1) {
    const middle = (low + high) / 2;
    if (geometricLiquidVolume(middle, bottom, height) < 0.0385) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

// Pressure traction -p*n on six closed-box faces. Opposite vertical faces have
// nonzero horizontal loads that cancel; bottom/top contributions are integrated
// separately rather than taking the product's displacedVolumeM3 as an oracle.
function integratedSurfaceForce(bottom, height, level, density) {
  const faces = [
    { normal: [0, -1, 0], area: 0.01, y: () => bottom },
    { normal: [0, 1, 0], area: 0.01, y: () => bottom + height },
    { normal: [-1, 0, 0], area: 0.1 * height, y: t => bottom + t * height },
    { normal: [1, 0, 0], area: 0.1 * height, y: t => bottom + t * height },
    { normal: [0, 0, -1], area: 0.1 * height, y: t => bottom + t * height },
    { normal: [0, 0, 1], area: 0.1 * height, y: t => bottom + t * height },
  ];
  const forces = faces.map(face => {
    const sum = [0, 0, 0];
    for (let i = 0; i < 8; i += 1) {
      const pressure = density * 9.80665 * Math.max(level - face.y((i + 0.5) / 8), 0);
      for (let axis = 0; axis < 3; axis += 1) sum[axis] -= pressure * face.normal[axis] * face.area / 8;
    }
    return sum;
  });
  return { forces, total: forces.reduce((sum, force) => sum.map((value, i) => value + force[i]), [0, 0, 0]) };
}

test('public API, fixed SI constants and defaults have immutable exact shapes', () => {
  assert.deepEqual(Object.keys(model).sort(), ['MODEL_VERSION', 'CONSTANTS_SI', 'DEFAULT_CONFIG', 'CONFIG_LIMITS_SI',
    'assertConfig', 'normalizeConfig', 'createExperiment', 'assertExperiment', 'getSnapshot', 'samplePressurePa'].sort());
  assert.equal(MODEL_VERSION, 'buoyancy-static-1');
  assert.deepEqual(CONSTANTS_SI, { gravityMps2: 9.80665, tankWidthM: .5, tankDepthM: .35,
    tankHeightM: .5, tankAreaM2: .175, bodyWidthM: .1, bodyDepthM: .1, bodyAreaM2: .01,
    fluidVolumeM3: .0385, emptyWaterLevelM: .22, minBottomM: .015 });
  assert.deepEqual(DEFAULT_CONFIG, { bodyMassKg: .4, bodyVolumeM3: .001, fluidDensityKgM3: 1000,
    mode: 'equilibrium', heldBottomM: .06 });
  for (const value of [CONSTANTS_SI, DEFAULT_CONFIG, CONFIG_LIMITS_SI, ...Object.values(CONFIG_LIMITS_SI)]) assert.ok(Object.isFrozen(value));
  assert.throws(() => { DEFAULT_CONFIG.bodyMassKg = 2; }, TypeError);
  assert.throws(() => { CONFIG_LIMITS_SI.bodyMassKg.max = 100; }, TypeError);
});

test('live normalization repairs only live inputs without coercion or aliases', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  for (const bad of [null, [], 4, 'x', new Date(), Object.create({ bodyMassKg: 2 })]) assert.deepEqual(normalizeConfig(bad), DEFAULT_CONFIG);
  const input = { bodyMassKg: 9, bodyVolumeM3: -1, fluidDensityKgM3: '1200', heldBottomM: Infinity, mode: 'held', timeS: 12 };
  const original = structuredClone(input);
  assert.deepEqual(normalizeConfig(input), { ...DEFAULT_CONFIG, bodyMassKg: 3, bodyVolumeM3: .0005, mode: 'held' });
  assert.deepEqual(input, original);
  assert.deepEqual(normalizeConfig({ bodyMassKg: NaN, bodyVolumeM3: undefined, mode: 'falling', heldBottomM: -0 }),
    { ...DEFAULT_CONFIG, heldBottomM: .015 });
  const nullPrototype = Object.assign(Object.create(null), { bodyMassKg: .8 });
  assert.equal(normalizeConfig(nullPrototype).bodyMassKg, .8);
});

test('strict config rejects missing/unknown fields, nonnumbers, nonfinite values and every numeric boundary violation', () => {
  assert.equal(assertConfig(DEFAULT_CONFIG), DEFAULT_CONFIG);
  for (const [key, limit] of Object.entries(CONFIG_LIMITS_SI)) {
    assert.doesNotThrow(() => assertConfig({ ...DEFAULT_CONFIG, [key]: limit.min }));
    assert.doesNotThrow(() => assertConfig({ ...DEFAULT_CONFIG, [key]: limit.max }));
    for (const bad of [NaN, Infinity, -Infinity, -0, '1', true, null, undefined, 1n]) {
      assert.throws(() => assertConfig({ ...DEFAULT_CONFIG, [key]: bad }), TypeError, key);
    }
    for (const bad of [limit.min - Math.abs(limit.min) * 1e-10, limit.max + Math.abs(limit.max) * 1e-10]) {
      assert.throws(() => assertConfig({ ...DEFAULT_CONFIG, [key]: bad }), RangeError, key);
    }
    const missing = { ...DEFAULT_CONFIG }; delete missing[key]; assert.throws(() => assertConfig(missing), TypeError);
  }
  for (const bad of [null, [], new Date(), 'config', { ...DEFAULT_CONFIG, running: false },
    { ...DEFAULT_CONFIG, mode: 'free' }, { ...DEFAULT_CONFIG, [Symbol('extra')]: 1 }]) assert.throws(() => assertConfig(bad), TypeError);
  const hidden = { ...DEFAULT_CONFIG }; Object.defineProperty(hidden, 'hidden', { value: 1 }); assert.throws(() => assertConfig(hidden), TypeError);
});

test('experiment is exactly one config, strict calculations never normalize or mutate an invalid import', () => {
  const valid = Object.freeze({ config: Object.freeze({ ...DEFAULT_CONFIG }) });
  assert.equal(assertExperiment(valid), valid); assert.doesNotThrow(() => getSnapshot(valid));
  for (const bad of [null, [], {}, { config: DEFAULT_CONFIG, timeS: 0 }, { config: DEFAULT_CONFIG, running: false },
    { config: { ...DEFAULT_CONFIG, bodyMassKg: 0 } }, { config: { ...DEFAULT_CONFIG, mode: 'free' } }]) {
    const before = structuredClone(bad);
    assert.throws(() => assertExperiment(bad)); assert.throws(() => getSnapshot(bad)); assert.throws(() => samplePressurePa(bad, .1));
    assert.deepEqual(bad, before);
  }
  const repaired = createExperiment({ bodyMassKg: 0 }); assert.equal(repaired.config.bodyMassKg, .1);
  assert.deepEqual(Reflect.ownKeys(repaired), ['config']);
});

test('default 40 percent floating body has independently calculated position, center and force in the exact snapshot shape', () => {
  const result = snapshot();
  assert.deepEqual(Object.keys(result).sort(), SNAPSHOT_KEYS);
  assert.equal(result.freeEquilibrium, 'unique'); assert.equal(result.poseKind, 'equilibrium'); assert.equal(result.immersion, 'partial');
  assert.equal(result.submergedFraction, .4); near(result.displacedVolumeM3, .0004);
  near(result.bodyBottomM, .182285714285714286); near(result.waterLevelM, .222285714285714286);
  near(result.bodyCenterM, .232285714285714286); near(result.centerOfBuoyancyM, .202285714285714286);
  assert.equal(result.bodyDensityKgM3, 400); near(result.weightN, 3.92266); near(result.buoyancyN, 3.92266);
  assert.equal(result.holdingForceYN, 0); near(result.netForceYN, 0);
  assert.equal(result.equilibriumBottomM, result.bodyBottomM); assert.equal(result.neutralBottomRangeM, null); assert.equal(result.bottomContact, false);
});

test('doubling floating mass doubles displacement and raises the finite-tank surface', () => {
  const light = snapshot(), heavy = snapshot({ bodyMassKg: .8 });
  near(heavy.submergedFraction, .8); near(heavy.waterLevelM, .224571428571428571);
  near(heavy.bodyBottomM, .144571428571428571); near(heavy.buoyancyN, 7.84532);
  near(heavy.displacedVolumeM3, 2 * light.displacedVolumeM3);
  near(heavy.waterLevelM - light.waterLevelM, .002285714285714286);
  assert.ok(heavy.bodyBottomM < light.bodyBottomM); near(heavy.netForceYN, 0);
});

test('changing liquid density changes the floating fraction but not its supported weight', () => {
  const low = snapshot({ bodyMassKg: .8, fluidDensityKgM3: 900 });
  const high = snapshot({ bodyMassKg: .8, fluidDensityKgM3: 1200 });
  near(low.submergedFraction, 8 / 9); near(high.submergedFraction, 2 / 3);
  near(low.bodyBottomM, .136190476190476190); near(high.bodyBottomM, .157142857142857143);
  near(low.buoyancyN, 7.84532); near(high.buoyancyN, 7.84532);
  assert.equal(low.fluidVolumeM3, high.fluidVolumeM3); assert.ok(low.waterLevelM > high.waterLevelM);
});

test('volume changes height and body density while a floating mass displaces the same liquid amount', () => {
  const short = snapshot({ bodyVolumeM3: .0005 }), tall = snapshot({ bodyVolumeM3: .002 });
  near(short.bodyHeightM, .05); near(tall.bodyHeightM, .20);
  assert.equal(short.bodyDensityKgM3, 800); assert.equal(tall.bodyDensityKgM3, 200);
  near(short.submergedFraction, .8); near(tall.submergedFraction, .2);
  assert.equal(short.displacedVolumeM3, tall.displacedVolumeM3); assert.equal(short.waterLevelM, tall.waterLevelM);
  assert.equal(short.bodyBottomM, tall.bodyBottomM); near(tall.bodyTopM - short.bodyTopM, .15);
});

test('held partial immersion uses the finite liquid volume rather than a fixed water level', () => {
  const result = snapshot({ mode: 'held', heldBottomM: .18 });
  assert.equal(result.immersion, 'partial'); assert.equal(result.poseKind, 'held'); assert.equal(result.bodyBottomM, .18);
  near(result.waterLevelM, .222424242424242424); near(result.displacedVolumeM3, .000424242424242424242);
  near(result.buoyancyN, 4.160396969696969697); near(result.bottomGaugePressurePa, 416.03969696969697, 1e-10);
  assert.ok(result.waterLevelM > .22); assert.ok(Math.abs(result.buoyancyN - 3.92266) > .2);
  near(result.netForceYN, 0); near(result.fluidVolumeResidualM3, 0, 1e-17);
});

test('dry and just-touching poses have no immersed center, no fluid force and a supporting holder', () => {
  for (const heldBottomM of [.22, .28]) {
    const result = snapshot({ mode: 'held', heldBottomM });
    assert.equal(result.immersion, 'dry'); assert.equal(result.waterLevelM, .22);
    for (const key of ['displacedVolumeM3', 'submergedHeightM', 'submergedFraction', 'buoyancyN', 'bottomGaugePressurePa', 'topGaugePressurePa']) assert.equal(result[key], 0);
    assert.equal(result.centerOfBuoyancyM, null); assert.equal(result.holdingForceYN, result.weightN); near(result.netForceYN, 0);
    assert.ok(result.pressureSamples.every(point => point.gaugePressurePa === 0));
  }
});

test('fully submerged depth change increases both face pressures equally without changing buoyancy', () => {
  const upper = snapshot({ bodyMassKg: 1.2, mode: 'held', heldBottomM: .06 });
  const lower = snapshot({ bodyMassKg: 1.2, mode: 'held', heldBottomM: .015 });
  for (const result of [upper, lower]) {
    assert.equal(result.immersion, 'full'); assert.equal(result.submergedFraction, 1);
    near(result.buoyancyN, 9.80665); near(result.holdingForceYN, 1.96133); near(result.netForceYN, 0);
  }
  near(upper.bottomGaugePressurePa, 1625.102, 1e-10); near(lower.bottomGaugePressurePa, 2066.40125, 1e-10);
  near(upper.topGaugePressurePa, 644.437, 1e-10); near(lower.topGaugePressurePa, 1085.73625, 1e-10);
  near(lower.bottomGaugePressurePa - upper.bottomGaugePressurePa, 441.29925, 1e-10);
  near(lower.topGaugePressurePa - upper.topGaugePressurePa, 441.29925, 1e-10);
  assert.equal(upper.waterLevelM, lower.waterLevelM);
});

test('signed holder supports, pushes down or exerts zero force as required at the same held height', () => {
  const down = snapshot({ mode: 'held' }), up = snapshot({ bodyMassKg: 1.2, mode: 'held' }), zero = snapshot({ bodyMassKg: 1, mode: 'held' });
  near(down.holdingForceYN, -5.88399); near(up.holdingForceYN, 1.96133); near(zero.holdingForceYN, 0);
  for (const result of [down, up, zero]) { assert.equal(result.bodyBottomM, .06); near(result.netForceYN, 0); near(result.holdingForceYN, -result.unrestrainedForceYN); }
  assert.ok(down.unrestrainedForceYN > 0); assert.ok(up.unrestrainedForceYN < 0);
});

test('neutral buoyancy has a continuum, not a manufactured unique equilibrium depth', () => {
  const result = snapshot({ bodyMassKg: 1 });
  assert.equal(result.freeEquilibrium, 'continuum'); assert.equal(result.poseKind, 'neutral-reference');
  assert.equal(result.equilibriumBottomM, null); assert.equal(result.immersion, 'full');
  near(result.neutralBottomRangeM[0], .015); near(result.neutralBottomRangeM[1], .125714285714285714);
  near(result.bodyBottomM, .070357142857142857); assert.equal(result.holdingForceYN, 0); near(result.netForceYN, 0);
  for (const heldBottomM of [.015, .04, .08, .12]) {
    const held = snapshot({ bodyMassKg: 1, mode: 'held', heldBottomM });
    assert.equal(held.freeEquilibrium, 'continuum'); assert.equal(held.poseKind, 'held'); near(held.netForceYN, 0);
    near(held.holdingForceYN, 0); assert.deepEqual(held.neutralBottomRangeM, result.neutralBottomRangeM);
  }
});

test('an overweight reference retains negative net force and never silently inserts support or a floor', () => {
  const result = snapshot({ bodyMassKg: 1.2 });
  assert.equal(result.freeEquilibrium, 'none'); assert.equal(result.poseKind, 'submerged-reference');
  assert.equal(result.equilibriumBottomM, null); assert.equal(result.neutralBottomRangeM, null);
  assert.equal(result.holdingForceYN, 0); near(result.unrestrainedForceYN, -1.96133); near(result.netForceYN, -1.96133);
  assert.equal(result.immersion, 'full'); assert.equal(result.bottomContact, false); assert.ok(result.bodyBottomM >= .015);
  assert.equal(result.bodyBottomM, snapshot({ bodyMassKg: 1 }).bodyBottomM);
});

test('neutral classification uses only the specified ULP interval and retains signed force residuals', () => {
  for (const offset of [-63, 0, 63]) assert.equal(snapshot({ bodyMassKg: 1 + offset * Number.EPSILON }).freeEquilibrium, 'continuum');
  assert.equal(snapshot({ bodyMassKg: 1 - 65 * Number.EPSILON }).freeEquilibrium, 'unique');
  assert.equal(snapshot({ bodyMassKg: 1 + 65 * Number.EPSILON }).freeEquilibrium, 'none');
  const below = snapshot({ bodyMassKg: 1 - 32 * Number.EPSILON }), above = snapshot({ bodyMassKg: 1 + 32 * Number.EPSILON });
  assert.ok(below.netForceYN > 0); assert.ok(above.netForceYN < 0);
  assert.equal(above.weightN, above.config.bodyMassKg * 9.80665); assert.equal(above.buoyancyN, 9.80665);
  assert.notEqual(above.weightN, above.buoyancyN); assert.equal(above.holdingForceYN, 0);
});

test('held mode reports possible free equilibrium separately from its actual controlled pose', () => {
  const free = snapshot(), held = snapshot({ mode: 'held', heldBottomM: .28 });
  assert.equal(held.freeEquilibrium, 'unique'); assert.equal(held.equilibriumBottomM, free.equilibriumBottomM);
  assert.equal(held.poseKind, 'held'); assert.equal(held.bodyBottomM, .28); assert.equal(held.immersion, 'dry');
  const neutralDry = snapshot({ bodyMassKg: 1, mode: 'held', heldBottomM: .28 });
  assert.equal(neutralDry.freeEquilibrium, 'continuum'); assert.equal(neutralDry.immersion, 'dry');
  assert.ok(neutralDry.holdingForceYN > 0); assert.equal(neutralDry.equilibriumBottomM, null);
  const alternativeMemory = snapshot({ heldBottomM: .28 });
  assert.deepEqual({ ...alternativeMemory, config: free.config }, free);
});

test('5022 held conditions agree with independent geometric volume and six-face pressure integration', () => {
  let count = 0;
  for (let vi = 0; vi <= 30; vi += 1) {
    const bodyVolumeM3 = .0005 + vi * .0015 / 30, height = bodyVolumeM3 / .01;
    for (let yi = 0; yi <= 53; yi += 1) {
      const heldBottomM = .015 + yi * .265 / 53, expectedLevel = levelOracle(heldBottomM, height);
      for (const fluidDensityKgM3 of [800, 1000, 1200]) {
        const result = snapshot({ mode: 'held', bodyVolumeM3, heldBottomM, fluidDensityKgM3 });
        near(result.waterLevelM, expectedLevel, 2e-15);
        near(geometricLiquidVolume(result.waterLevelM, heldBottomM, height), .0385, 3e-17);
        const integrated = integratedSurfaceForce(heldBottomM, height, expectedLevel, fluidDensityKgM3);
        near(integrated.total[0], 0); near(integrated.total[2], 0); near(result.buoyancyN, integrated.total[1], 2e-12);
        near(result.bottomPressureForceYN, integrated.forces[0][1], 2e-12);
        near(result.topPressureForceYN, integrated.forces[1][1], 2e-12);
        near(result.fluidVolumeResidualM3, 0, 3e-17); near(result.netForceYN, 0, 1e-13);
        assert.ok(result.submergedFraction >= 0 && result.submergedFraction <= 1); count += 1;
      }
    }
  }
  assert.equal(count, 5022);
});

test('dry/full transitions are continuous and do not hide physically finite gaps with rounding clamps', () => {
  for (const bodyVolumeM3 of [.0005, .001, .002]) {
    const fullBoundary = levelOracle(.015, bodyVolumeM3 / .01) - bodyVolumeM3 / .01;
    for (const boundary of [.22, fullBoundary]) {
      const values = [-1e-8, 0, 1e-8].map(offset => snapshot({ mode: 'held', bodyVolumeM3, heldBottomM: boundary + offset }));
      near(values[0].waterLevelM, values[2].waterLevelM, 2e-9);
      near(values[0].buoyancyN, values[2].buoyancyN, 3e-6);
      assert.ok(values[0].displacedVolumeM3 >= values[1].displacedVolumeM3 - 1e-17);
      assert.ok(values[1].displacedVolumeM3 >= values[2].displacedVolumeM3 - 1e-17);
    }
    assert.equal(snapshot({ mode: 'held', bodyVolumeM3, heldBottomM: .22 - 1e-8 }).immersion, 'partial');
    assert.equal(snapshot({ mode: 'held', bodyVolumeM3, heldBottomM: fullBoundary + 1e-8 }).immersion, 'partial');
    assert.equal(snapshot({ mode: 'held', bodyVolumeM3, heldBottomM: fullBoundary - 1e-8 }).immersion, 'full');
  }
});

test('all physical corners and equilibrium classes remain inside the noncontact apparatus with finite results', () => {
  for (const bodyVolumeM3 of [.0005, .001, .002]) for (const fluidDensityKgM3 of [800, 1000, 1200]) {
    for (const bodyMassKg of [.1, fluidDensityKgM3 * bodyVolumeM3, 3]) for (const mode of ['equilibrium', 'held']) {
      for (const heldBottomM of [.015, .28]) {
        const result = snapshot({ bodyVolumeM3, fluidDensityKgM3, bodyMassKg, mode, heldBottomM });
        assert.ok(result.bodyBottomM >= .015 && result.bodyTopM <= .5);
        assert.ok(result.waterLevelM >= .22 && result.waterLevelM <= .231428571428572);
        assert.ok(result.bodyHeightM >= .05 && result.bodyHeightM <= .2);
        assert.ok(result.bottomGaugePressurePa >= 0 && result.bottomGaugePressurePa < 3000);
        for (const value of Object.values(result)) if (typeof value === 'number') assert.ok(Number.isFinite(value));
        if (result.neutralBottomRangeM) assert.ok(result.neutralBottomRangeM[1] >= result.neutralBottomRangeM[0]);
        if (mode === 'held') assert.equal(result.bodyBottomM, heldBottomM);
        if (mode === 'equilibrium' && result.freeEquilibrium !== 'unique') assert.equal(result.immersion, 'full');
      }
    }
  }
});

test('pressure samples are monotone gauge values at physical heights and scalar probe bounds are strict', () => {
  const state = experiment({ mode: 'held', heldBottomM: .18, fluidDensityKgM3: 1200 }), result = getSnapshot(state);
  assert.equal(result.pressureSamples.length, 9);
  assert.equal(result.pressureSamples[0].heightM, result.bodyBottomM); assert.equal(result.pressureSamples.at(-1).heightM, result.bodyTopM);
  assert.equal(result.pressureSamples[0].gaugePressurePa, result.bottomGaugePressurePa);
  assert.equal(result.pressureSamples.at(-1).gaugePressurePa, result.topGaugePressurePa);
  for (let i = 0; i < 9; i += 1) {
    const point = result.pressureSamples[i]; assert.deepEqual(Object.keys(point).sort(), ['gaugePressurePa', 'heightM']);
    near(point.gaugePressurePa, samplePressurePa(state, point.heightM));
    if (i) { assert.ok(point.heightM > result.pressureSamples[i - 1].heightM); assert.ok(point.gaugePressurePa <= result.pressureSamples[i - 1].gaugePressurePa); }
  }
  near(samplePressurePa(state, 0), 1200 * 9.80665 * result.waterLevelM);
  assert.equal(samplePressurePa(state, result.waterLevelM), 0); assert.equal(samplePressurePa(state, .5), 0);
  near(samplePressurePa(state, .04) - samplePressurePa(state, .10), 706.0788, 1e-10);
  for (const bad of [NaN, Infinity, -Infinity, -0, '0.1', null]) assert.throws(() => samplePressurePa(state, bad), TypeError);
  for (const bad of [-1e-15, .500000000001]) assert.throws(() => samplePressurePa(state, bad), RangeError);
});

test('experiments and every nested snapshot output are detached and repeated statics are deterministic', () => {
  const state = createExperiment({ bodyMassKg: 1 }), original = structuredClone(state), first = getSnapshot(state), expected = structuredClone(first);
  assert.deepEqual(getSnapshot(state), first); assert.notEqual(first.config, state.config);
  first.config.bodyMassKg = 2; first.neutralBottomRangeM[0] = -1; first.pressureSamples[0].heightM = 99;
  assert.deepEqual(state, original); assert.deepEqual(getSnapshot(state), expected);
  const other = createExperiment(); other.config.bodyMassKg = 3; assert.equal(DEFAULT_CONFIG.bodyMassKg, .4);
  assert.equal(createExperiment().config.bodyMassKg, .4);
  assert.equal('timeS' in expected, false); assert.equal('running' in expected, false);
});
