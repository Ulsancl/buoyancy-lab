export const MODEL_VERSION = 'buoyancy-static-1';

export const CONSTANTS_SI = Object.freeze({
  gravityMps2: 9.80665,
  tankWidthM: 0.50,
  tankDepthM: 0.35,
  tankHeightM: 0.50,
  tankAreaM2: 0.175,
  bodyWidthM: 0.10,
  bodyDepthM: 0.10,
  bodyAreaM2: 0.01,
  fluidVolumeM3: 0.0385,
  emptyWaterLevelM: 0.22,
  minBottomM: 0.015,
});

export const DEFAULT_CONFIG = Object.freeze({
  bodyMassKg: 0.4,
  bodyVolumeM3: 0.001,
  fluidDensityKgM3: 1000,
  mode: 'equilibrium',
  heldBottomM: 0.06,
});

export const CONFIG_LIMITS_SI = Object.freeze({
  bodyMassKg: Object.freeze({ min: 0.1, max: 3 }),
  bodyVolumeM3: Object.freeze({ min: 0.0005, max: 0.002 }),
  fluidDensityKgM3: Object.freeze({ min: 800, max: 1200 }),
  heldBottomM: Object.freeze({ min: 0.015, max: 0.28 }),
});

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);
const { gravityMps2: G, tankAreaM2: AT, bodyAreaM2: AB,
  fluidVolumeM3: VF, emptyWaterLevelM: H0, minBottomM: MIN_BOTTOM } = CONSTANTS_SI;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactRecord(value, keys, name) {
  if (!isPlainObject(value)) throw new TypeError(`${name} must be a plain object`);
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))
      || keys.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${name} has unexpected or missing fields`);
  }
}

function bounded(value, min, max, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Object.is(value, -0)) {
    throw new TypeError(`${name} must be a finite number without negative zero`);
  }
  if (value < min || value > max) throw new RangeError(`${name} is outside its supported range`);
  return value;
}

export function assertConfig(value) {
  exactRecord(value, CONFIG_KEYS, 'config');
  for (const [key, { min, max }] of Object.entries(CONFIG_LIMITS_SI)) bounded(value[key], min, max, key);
  if (value.mode !== 'equilibrium' && value.mode !== 'held') throw new TypeError('Unsupported mode');
  return value;
}

export function normalizeConfig(value) {
  const input = isPlainObject(value) ? value : {};
  const config = { ...DEFAULT_CONFIG };
  for (const [key, { min, max }] of Object.entries(CONFIG_LIMITS_SI)) {
    const supplied = Object.hasOwn(input, key) ? input[key] : undefined;
    if (typeof supplied === 'number' && Number.isFinite(supplied)) config[key] = Math.max(min, Math.min(max, supplied));
  }
  if (Object.hasOwn(input, 'mode') && (input.mode === 'held' || input.mode === 'equilibrium')) config.mode = input.mode;
  return config;
}

// The factory repairs live UI input. Imported data must use assertExperiment.
export function createExperiment(config = DEFAULT_CONFIG) {
  return { config: normalizeConfig(config) };
}

export function assertExperiment(value) {
  exactRecord(value, ['config'], 'experiment');
  assertConfig(value.config);
  return value;
}

function heldImmersion(y, height, volume, fullWaterLevel) {
  if (y >= H0) return { waterLevelM: H0, submergedHeightM: 0, displacedVolumeM3: 0, immersion: 'dry' };
  if (y + height <= fullWaterLevel) {
    return { waterLevelM: fullWaterLevel, submergedHeightM: height, displacedVolumeM3: volume, immersion: 'full' };
  }
  const waterLevelM = (VF - AB * y) / (AT - AB);
  let submergedHeightM = waterLevelM - y;
  // Only remove arithmetic overshoot at the two contact boundaries. A wrong
  // branch cannot be concealed by clamping an arbitrary physical penetration.
  const rounding = 32 * Number.EPSILON * Math.max(waterLevelM, y, height);
  if (submergedHeightM < 0 && submergedHeightM >= -rounding) submergedHeightM = 0;
  if (submergedHeightM > height && submergedHeightM <= height + rounding) submergedHeightM = height;
  if (submergedHeightM < 0 || submergedHeightM > height) throw new RangeError('Invalid immersed height');
  const immersion = submergedHeightM === 0 ? 'dry' : submergedHeightM === height ? 'full' : 'partial';
  return { waterLevelM, submergedHeightM,
    displacedVolumeM3: immersion === 'full' ? volume : AB * submergedHeightM, immersion };
}

function pressureAt(rho, waterLevel, height) {
  return rho * G * Math.max(waterLevel - height, 0);
}

export function getSnapshot(experiment) {
  assertExperiment(experiment);
  const config = { ...experiment.config };
  const { bodyMassKg: mass, bodyVolumeM3: volume, fluidDensityKgM3: rho, mode } = config;
  const bodyHeightM = volume / AB;
  const fullWaterLevel = (VF + volume) / AT;
  const fullMass = rho * volume;
  const neutralTolerance = 64 * Number.EPSILON * Math.max(mass, fullMass);
  const freeEquilibrium = Math.abs(mass - fullMass) <= neutralTolerance
    ? 'continuum' : mass < fullMass ? 'unique' : 'none';
  const neutralBottomRangeM = freeEquilibrium === 'continuum' ? [MIN_BOTTOM, fullWaterLevel - bodyHeightM] : null;
  const floatingVolume = freeEquilibrium === 'unique' ? mass / rho : null;
  const floatingWaterLevel = floatingVolume === null ? null : (VF + floatingVolume) / AT;
  const equilibriumBottomM = floatingVolume === null ? null : floatingWaterLevel - floatingVolume / AB;
  // Neutral and overweight bodies share a drawing reference, not a computed
  // settling depth. Overweight equilibrium-mode bodies have no holding force.
  const referenceBottom = (MIN_BOTTOM + fullWaterLevel - bodyHeightM) / 2;
  const bodyBottomM = mode === 'held' ? config.heldBottomM : equilibriumBottomM ?? referenceBottom;
  const poseKind = mode === 'held' ? 'held' : freeEquilibrium === 'unique' ? 'equilibrium'
    : freeEquilibrium === 'continuum' ? 'neutral-reference' : 'submerged-reference';
  const water = mode === 'equilibrium' && freeEquilibrium === 'unique'
    ? { waterLevelM: floatingWaterLevel, submergedHeightM: floatingVolume / AB,
      displacedVolumeM3: floatingVolume, immersion: 'partial' }
    : heldImmersion(bodyBottomM, bodyHeightM, volume, fullWaterLevel);
  const { waterLevelM, submergedHeightM, displacedVolumeM3, immersion } = water;
  const bodyTopM = bodyBottomM + bodyHeightM;
  const weightN = mass * G;
  const buoyancyN = rho * G * displacedVolumeM3;
  const holdingForceYN = mode === 'held' ? weightN - buoyancyN : 0;
  const bottomGaugePressurePa = pressureAt(rho, waterLevelM, bodyBottomM);
  const topGaugePressurePa = pressureAt(rho, waterLevelM, bodyTopM);
  return {
    config,
    bodyDensityKgM3: mass / volume,
    freeEquilibrium,
    immersion,
    poseKind,
    equilibriumBottomM,
    neutralBottomRangeM,
    bodyBottomM,
    bodyTopM,
    bodyHeightM,
    bodyCenterM: bodyBottomM + bodyHeightM / 2,
    waterLevelM,
    emptyWaterLevelM: H0,
    fluidVolumeM3: VF,
    displacedVolumeM3,
    submergedHeightM,
    submergedFraction: displacedVolumeM3 / volume,
    centerOfBuoyancyM: displacedVolumeM3 === 0 ? null : bodyBottomM + submergedHeightM / 2,
    weightN,
    buoyancyN,
    holdingForceYN,
    unrestrainedForceYN: buoyancyN - weightN,
    netForceYN: buoyancyN + holdingForceYN - weightN,
    bottomGaugePressurePa,
    topGaugePressurePa,
    bottomPressureForceYN: AB * bottomGaugePressurePa,
    topPressureForceYN: topGaugePressurePa === 0 ? 0 : -AB * topGaugePressurePa,
    pressureSamples: Array.from({ length: 9 }, (_, index) => {
      const heightM = index === 8 ? bodyTopM : bodyBottomM + bodyHeightM * index / 8;
      return { heightM, gaugePressurePa: pressureAt(rho, waterLevelM, heightM) };
    }),
    bottomContact: false,
    fluidVolumeResidualM3: AT * waterLevelM - displacedVolumeM3 - VF,
  };
}

export function samplePressurePa(experiment, heightM) {
  bounded(heightM, 0, CONSTANTS_SI.tankHeightM, 'heightM');
  const snapshot = getSnapshot(experiment);
  return pressureAt(snapshot.config.fluidDensityKgM3, snapshot.waterLevelM, heightM);
}
