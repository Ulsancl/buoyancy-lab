import test from 'node:test';
import assert from 'node:assert/strict';
import { getSnapshot, DEFAULT_CONFIG, CONSTANTS_SI as C } from '../src/model.js';
import { buoyancyDetail, describeBuoyancyDetail } from '../src/detail-model.js';
import { COMPONENTS } from '../src/geometry.js';
import { createProject, serializeProject, parseProject } from '../src/project.js';

const G = 9.80665, AT = .175, AB = .01, VF = .0385;
const experiment = patch => ({ config: { ...DEFAULT_CONFIG, ...patch } });
const snapshot = patch => getSnapshot(experiment(patch));
const near = (a, b, relative = 3e-13, absolute = 1e-12) => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= absolute + relative * Math.abs(b), `${a} != ${b}`);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

// Integrate the unoccupied cross-sectional area, then bisect. Neither the
// model's immersion branch nor its algebraic water-level formula is reused.
function volumeAt(level, bottom, height) {
  const cuts = [0, level, ...[bottom, bottom + height].filter(y => y > 0 && y < level)].sort((a, b) => a - b);
  return cuts.slice(1).reduce((sum, upper, i) => {
    const lower = cuts[i], midpoint = (lower + upper) / 2;
    return sum + (upper - lower) * (midpoint > bottom && midpoint < bottom + height ? AT - AB : AT);
  }, 0);
}
function levelOracle(bottom, height) {
  let lower = 0, upper = .5;
  for (let i = 0; i < 70; i++) {
    const middle = (lower + upper) / 2;
    if (volumeAt(middle, bottom, height) < VF) lower = middle; else upper = middle;
  }
  return (lower + upper) / 2;
}

// Composite Simpson quadrature of actual surface traction and its height
// moment. Splitting at the free surface makes dry areas exactly zero while
// integrating p(y)*y independently of the closed center-of-pressure formula.
function sideIntegral(bottom, bodyHeight, level, rho, width = .1) {
  const top = Math.min(level, bottom + bodyHeight);
  if (top <= bottom) return { force: 0, moment: 0, center: null, area: 0 };
  const N = 64, dy = (top - bottom) / N;
  let force = 0, moment = 0;
  for (let i = 0; i <= N; i++) {
    const y = bottom + i * dy, p = rho * G * Math.max(level - y, 0), weight = i === 0 || i === N ? 1 : i % 2 ? 4 : 2;
    force += weight * p; moment += weight * p * y;
  }
  force *= dy * width / 3; moment *= dy * width / 3;
  return { force, moment, center: moment / force, area: width * (top - bottom) };
}

test('known partial immersion distinguishes one side pressure center from center of buoyancy', () => {
  const s = snapshot({ mode: 'held', heldBottomM: .18 }), d = buoyancyDetail(s);
  near(d.faces.right.forceN.x, -.8825084481175399);
  near(d.faces.right.centerOfPressureM.y, .19414141414141414);
  near(d.body.centerOfBuoyancyM, .20121212121212123);
  assert.ok(d.faces.right.centerOfPressureM.y < d.body.centerOfBuoyancyM);
  near(d.faces.right.areaM2, .004242424242424242);
  near(d.faces.right.meanGaugePressurePa, 208.01984848484848);
  assert.deepEqual(d.faces.top.forceN, { x: 0, y: 0, z: 0 }); assert.equal(d.faces.top.areaM2, 0); assert.equal(d.faces.top.centerOfPressureM, null);
  near(d.fluid.displacedMassKg, .4242424242424242);
  near(d.sensitivity.holdingPerBottomNPerM, 104.00992424242424);
});

test('individual side loads and pressure moments agree with independently bisected fluid and surface quadrature', () => {
  for (const volume of [.0005, .00075, .001, .0015, .002]) for (const bottom of [.015, .06, .12, .18, .21, .22, .26]) for (const rho of [800, 1000, 1200]) {
    const s = snapshot({ mode: 'held', bodyVolumeM3: volume, heldBottomM: bottom, fluidDensityKgM3: rho }), d = buoyancyDetail(s);
    const H = levelOracle(bottom, volume / AB), integral = sideIntegral(bottom, volume / AB, H, rho);
    for (const [id, axis, sign] of [['left', 'x', 1], ['right', 'x', -1], ['front', 'z', -1], ['back', 'z', 1]]) {
      const face = d.faces[id]; near(face.forceN[axis], sign * integral.force);
      near(face.areaM2, integral.area); near(face.fullFaceAreaM2, .1 * volume / AB);
      if (integral.force === 0) assert.equal(face.centerOfPressureM, null);
      else {
        near(face.centerOfPressureM.y, integral.center);
        near(Math.abs(face.forceN[axis]) * face.centerOfPressureM.y, integral.moment);
        near(face.meanGaugePressurePa, integral.force / integral.area);
      }
    }
  }
});

test('six face forces are inward, horizontal pairs cancel and vertical pressure already is buoyancy', () => {
  for (const heldBottomM of [.02, .1, .2, .25]) {
    const s = snapshot({ mode: 'held', heldBottomM }), d = buoyancyDetail(s), f = d.faces;
    assert.ok(f.bottom.forceN.y >= 0 && f.top.forceN.y <= 0);
    assert.ok(f.left.forceN.x >= 0 && f.right.forceN.x <= 0 && f.front.forceN.z <= 0 && f.back.forceN.z >= 0);
    assert.equal(f.left.forceN.x + f.right.forceN.x, 0); assert.equal(f.front.forceN.z + f.back.forceN.z, 0);
    assert.equal(d.balance.pressureResultantN.x, 0); assert.equal(d.balance.pressureResultantN.z, 0);
    near(f.bottom.forceN.y + f.top.forceN.y, s.buoyancyN);
    near(d.balance.pressureResultantN.y, s.buoyancyN);
    near(d.balance.buoyancyResidualN, 0, 0, 1e-13);
    if (s.immersion !== 'dry') {
      assert.equal(f.left.centerOfPressureM.x, -.05); assert.equal(f.right.centerOfPressureM.x, .05);
      assert.equal(f.front.centerOfPressureM.z, .05); assert.equal(f.back.centerOfPressureM.z, -.05);
      near(f.bottom.centerOfPressureM.y, heldBottomM);
    }
  }
});

test('fully immersed depth shift adds common cap pressure while side pressure center moves toward face midpoint', () => {
  const upper = snapshot({ mode: 'held', heldBottomM: .06 }), lower = snapshot({ mode: 'held', heldBottomM: .015 });
  const u = buoyancyDetail(upper), l = buoyancyDetail(lower);
  near(u.faces.right.forceN.x, -11.347695); near(u.faces.right.centerOfPressureM.y, .10279835390946503);
  near(l.faces.bottom.meanGaugePressurePa - u.faces.bottom.meanGaugePressurePa, 1000 * G * .045);
  near(l.faces.top.meanGaugePressurePa - u.faces.top.meanGaugePressurePa, 1000 * G * .045);
  near(l.balance.pressureResultantN.y, u.balance.pressureResultantN.y);
  const upperOffset = upper.bodyCenterM - u.faces.right.centerOfPressureM.y;
  const lowerOffset = lower.bodyCenterM - l.faces.right.centerOfPressureM.y;
  assert.ok(lowerOffset > 0 && lowerOffset < upperOffset);
  assert.ok(l.faces.right.areaM2 === u.faces.right.areaM2 && Math.abs(l.faces.right.forceN.x) > Math.abs(u.faces.right.forceN.x));
});

test('dry faces have zero wetted area and no pressure centers while body-to-water gap differs from exposed height', () => {
  for (const heldBottomM of [.22, .28]) {
    const s = snapshot({ mode: 'held', heldBottomM }), d = buoyancyDetail(s);
    for (const face of Object.values(d.faces)) {
      assert.equal(face.areaM2, 0); assert.ok(face.fullFaceAreaM2 > 0); assert.equal(face.meanGaugePressurePa, 0);
      assert.deepEqual(face.forceN, { x: 0, y: 0, z: 0 }); assert.equal(face.centerOfPressureM, null);
    }
    assert.equal(d.body.centerOfBuoyancyM, null); assert.equal(d.body.exposedHeightM, s.bodyHeightM);
    near(d.body.topSurfaceClearanceM - d.body.exposedHeightM, heldBottomM - .22);
    assert.equal(d.fluid.displacedMassKg, 0);
  }
});

test('zero-gauge full-top contact has contact area but no resultant pressure center', () => {
  const bottom = (VF + .001) / AT - .1, s = snapshot({ mode: 'held', heldBottomM: bottom }), d = buoyancyDetail(s);
  assert.equal(s.immersion, 'full'); assert.equal(s.topGaugePressurePa, 0);
  assert.equal(d.faces.top.areaM2, AB); assert.equal(d.faces.top.centerOfPressureM, null);
  assert.deepEqual(d.faces.top.forceN, { x: 0, y: 0, z: 0 });
  assert.equal(d.sensitivity.branch, 'full-contact'); assert.equal(d.sensitivity.differentiable, false);
  assert.equal(d.sensitivity.holdingPerBottomNPerM, null);
});

test('fluid mass changes with density while real liquid volume and virtual displaced volume remain distinct', () => {
  const low = snapshot({ mode: 'held', heldBottomM: .18, fluidDensityKgM3: 800 });
  const high = snapshot({ mode: 'held', heldBottomM: .18, fluidDensityKgM3: 1200 });
  const l = buoyancyDetail(low), h = buoyancyDetail(high);
  near(l.fluid.massKg, 30.8); near(h.fluid.massKg, 46.2);
  near(h.fluid.displacedMassKg / l.fluid.displacedMassKg, 1.5); near(h.fluid.weightN / l.fluid.weightN, 1.5);
  assert.equal(low.fluidVolumeM3, high.fluidVolumeM3); assert.equal(low.waterLevelM, high.waterLevelM);
  near(l.fluid.waterRiseM * AT, low.displacedVolumeM3);
  near(l.fluid.massKg / low.config.fluidDensityKgM3, VF);
});

test('tank bottom pressure load closes the fluid force balance in floating, held and non-equilibrium reference poses', () => {
  for (const bodyMassKg of [.1, 1, 3]) for (const mode of ['held', 'equilibrium']) for (const heldBottomM of [.015, .18, .28]) {
    const s = snapshot({ bodyMassKg, mode, heldBottomM }), d = buoyancyDetail(s);
    near(d.fluid.bottomGaugePressurePa, 1000 * G * s.waterLevelM);
    near(d.fluid.bottomFluidLoadN, d.fluid.weightN + d.balance.pressureResultantN.y);
    near(d.balance.tankLoadResidualN, 0, 0, 1e-12);
    near(d.balance.volumeResidualM3, 0, 0, 5e-17);
    if (bodyMassKg === 3 && mode === 'equilibrium') { assert.equal(s.holdingForceYN, 0); assert.ok(s.netForceYN < 0); }
  }
});

test('held partial static derivatives agree with independent geometric-volume finite differences', () => {
  const delta = 1e-6;
  for (const volume of [.0005, .001, .002]) for (const rho of [800, 1200]) {
    const fullBoundary = (VF + volume) / AT - volume / AB, bottom = (fullBoundary + .22) / 2;
    const s = snapshot({ mode: 'held', bodyVolumeM3: volume, heldBottomM: bottom, fluidDensityKgM3: rho }), d = buoyancyDetail(s);
    const lowH = levelOracle(bottom - delta, volume / AB), highH = levelOracle(bottom + delta, volume / AB);
    const lowBuoyancy = rho * G * AB * Math.min(volume / AB, Math.max(lowH - bottom + delta, 0));
    const highBuoyancy = rho * G * AB * Math.min(volume / AB, Math.max(highH - bottom - delta, 0));
    assert.equal(d.sensitivity.applicable, true); assert.equal(d.sensitivity.differentiable, true); assert.equal(d.sensitivity.branch, 'partial');
    near(d.sensitivity.waterLevelPerBottom, (highH - lowH) / (2 * delta), 1e-8, 1e-10);
    near(d.sensitivity.buoyancyPerBottomNPerM, (highBuoyancy - lowBuoyancy) / (2 * delta), 1e-8, 1e-8);
    near(d.sensitivity.holdingPerBottomNPerM, (lowBuoyancy - highBuoyancy) / (2 * delta), 1e-8, 1e-8);
    assert.ok(d.sensitivity.holdingPerBottomNPerM > rho * G * AB);
    near(d.sensitivity.finiteTankFactor, 35 / 33);
  }
});

test('dry/full interiors have zero height sensitivity and free-equilibrium mode has no held-input derivative', () => {
  for (const heldBottomM of [.03, .1, .26]) {
    const s = snapshot({ mode: 'held', heldBottomM }), d = buoyancyDetail(s);
    assert.equal(d.sensitivity.differentiable, true); assert.equal(d.sensitivity.waterLevelPerBottom, 0);
    assert.equal(d.sensitivity.buoyancyPerBottomNPerM, 0); assert.equal(d.sensitivity.holdingPerBottomNPerM, 0);
    assert.equal(snapshot({ mode: 'held', heldBottomM: heldBottomM + 1e-5 }).buoyancyN, snapshot({ mode: 'held', heldBottomM: heldBottomM - 1e-5 }).buoyancyN);
  }
  for (const bodyMassKg of [.4, 1, 2]) {
    const d = buoyancyDetail(snapshot({ bodyMassKg }));
    assert.equal(d.sensitivity.applicable, false); assert.equal(d.sensitivity.branch, 'inactive');
    assert.equal(d.sensitivity.waterLevelPerBottom, null); assert.equal(d.sensitivity.holdingPerBottomNPerM, null);
  }
});

test('both contact boundaries are continuous but have unequal one-sided slopes and conservatively null derivatives', () => {
  const stiffness = 1000 * G * AB * AT / (AT - AB), delta = 1e-6;
  for (const [bottom, branch, leftSlope, rightSlope] of [
    [.22, 'dry-contact', -stiffness, 0], [(VF + .001) / AT - .1, 'full-contact', 0, -stiffness],
  ]) {
    const current = snapshot({ mode: 'held', heldBottomM: bottom }), d = buoyancyDetail(current);
    const left = snapshot({ mode: 'held', heldBottomM: bottom - delta }), right = snapshot({ mode: 'held', heldBottomM: bottom + delta });
    assert.equal(d.sensitivity.branch, branch); assert.equal(d.sensitivity.differentiable, false);
    assert.equal(d.sensitivity.buoyancyPerBottomNPerM, null);
    near((current.buoyancyN - left.buoyancyN) / delta, leftSlope, 1e-8, 1e-8);
    near((right.buoyancyN - current.buoyancyN) / delta, rightSlope, 1e-8, 1e-8);
    assert.ok(Math.abs(right.waterLevelM - left.waterLevelM) < delta);
    for (const offset of [-Number.EPSILON, Number.EPSILON]) assert.equal(buoyancyDetail(snapshot({ mode: 'held', heldBottomM: bottom + offset })).sensitivity.differentiable, false);
    assert.equal(buoyancyDetail(left).sensitivity.differentiable, true); assert.equal(buoyancyDetail(right).sensitivity.differentiable, true);
  }
});

test('neutral tolerance and unsupported free settling retain original signed forces without manufactured support', () => {
  for (const offset of [-32, 32]) {
    const s = snapshot({ bodyMassKg: 1 + offset * Number.EPSILON }), before = structuredClone(s), d = buoyancyDetail(s);
    assert.equal(s.freeEquilibrium, 'continuum'); assert.notEqual(s.netForceYN, 0); assert.equal(s.holdingForceYN, 0);
    assert.equal(Math.sign(s.netForceYN), -Math.sign(offset)); assert.equal(d.sensitivity.applicable, false);
    assert.deepEqual(s, before);
  }
  const heavy = snapshot({ bodyMassKg: 3 }); buoyancyDetail(heavy);
  assert.equal(heavy.poseKind, 'submerged-reference'); assert.equal(heavy.bottomContact, false); assert.equal(heavy.holdingForceYN, 0); assert.ok(heavy.netForceYN < 0);
});

test('all fourteen component fact sets use finite SI conversions and meaningful null text', () => {
  for (const mode of ['held', 'equilibrium']) for (const heldBottomM of [.06, .18, .22, .28]) {
    const s = snapshot({ mode, heldBottomM }), d = buoyancyDetail(s);
    for (const { id } of COMPONENTS) {
      const result = describeBuoyancyDetail(id, s, d); assert.ok(result.facts.length >= 4 && result.facts.length <= 6); assert.ok(result.note.length > 20);
      assert.equal(new Set(result.facts.map(f => f.label)).size, result.facts.length);
      for (const f of result.facts) { assert.equal(typeof f.label, 'string'); assert.equal(typeof f.unit, 'string'); assert.ok(Number.isInteger(f.digits)); assert.ok(typeof f.value === 'string' || Number.isFinite(f.value)); }
    }
    const submerged = Object.fromEntries(describeBuoyancyDetail('submerged-volume', s).facts.map(f => [f.label, f]));
    near(submerged['잠긴 체적'].value / 1000, s.displacedVolumeM3);
    if (s.centerOfBuoyancyM === null) assert.equal(submerged['부심 높이'].value, '작용점 없음');
    else near(submerged['부심 높이'].value / 100, s.centerOfBuoyancyM);
    const bottom = Object.fromEntries(describeBuoyancyDetail('pressure-bottom', s).facts.map(f => [f.label, f.value]));
    near(bottom['밑면의 젖은 면적'] / 1e4, d.faces.bottom.areaM2);
  }
  assert.throws(() => describeBuoyancyDetail('unknown', snapshot()), RangeError);
});

test('strict diagnostics reject invalid or inconsistent solved snapshots without normalization', () => {
  for (const input of [null, [], {}, { ...snapshot(), config: { ...DEFAULT_CONFIG, extra: 1 } },
    { ...snapshot(), config: { ...DEFAULT_CONFIG, bodyMassKg: '1' } }, { ...snapshot(), waterLevelM: NaN },
    { ...snapshot(), displacedVolumeM3: .5 }, { ...snapshot(), centerOfBuoyancyM: 0 },
    { ...snapshot(), pressureSamples: [] }, { ...snapshot(), immersion: 'full' }]) assert.throws(() => buoyancyDetail(input));
});

test('experiment, comparison and saved bytes are immutable and returned face coordinates are detached', () => {
  const exp = freeze(experiment({ mode: 'held', heldBottomM: .18 })), s = freeze(getSnapshot(exp));
  const project = freeze(createProject({ experiment: exp, comparison: { label: '부유 기준', experiment: experiment({}) },
    camera: { position: [1, .6, 1], target: [0, .2, 0], zoom: 1.2 } }));
  const before = serializeProject(project), snapshotBefore = JSON.stringify(s), d = buoyancyDetail(s);
  for (const { id } of COMPONENTS) describeBuoyancyDetail(id, s, d);
  d.faces.right.centerOfPressureM.y = 100; d.faces.bottom.forceN.y = 100; d.balance.pressureResultantN.y = 100;
  assert.equal(serializeProject(project), before); assert.equal(JSON.stringify(s), snapshotBefore); assert.deepEqual(parseProject(before), project);
  assert.notEqual(buoyancyDetail(s).faces.right.centerOfPressureM.y, 100);
  assert.deepEqual(Object.keys(project.experiment), ['config']);
});

test('near-contact face loads stay finite, retain small nonzero pressure and clean signed zeros', () => {
  const inspect = value => {
    if (typeof value === 'number') { assert.ok(Number.isFinite(value)); assert.equal(Object.is(value, -0), false); }
    else if (value && typeof value === 'object') Object.values(value).forEach(inspect);
  };
  for (const bodyVolumeM3 of [.0005, .002]) for (const fluidDensityKgM3 of [800, 1200]) for (const heldBottomM of [.015, .22 - 1e-12, .22, .28]) {
    const d = buoyancyDetail(snapshot({ mode: 'held', bodyVolumeM3, fluidDensityKgM3, heldBottomM })); inspect(d);
    if (heldBottomM < .22 && heldBottomM > .21) { assert.ok(d.faces.right.forceN.x < 0); assert.ok(d.faces.bottom.forceN.y > 0); assert.notEqual(d.faces.right.centerOfPressureM, null); }
  }
});
