import { getSnapshot, CONSTANTS_SI as C } from './model.js';

const { gravityMps2: G, tankAreaM2: AT, bodyAreaM2: AB, emptyWaterLevelM: H0 } = C;
const clean = value => value === 0 ? 0 : value;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function sameSolved(actual, expected, name) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) throw new TypeError(`${name} must match the solved array`);
    expected.forEach((value, i) => sameSolved(actual[i], value, `${name}[${i}]`));
  } else if (record(expected)) {
    if (!record(actual)) throw new TypeError(`${name} must be a plain object`);
    for (const [key, value] of Object.entries(expected)) sameSolved(actual[key], value, `${name}.${key}`);
  } else if (actual !== expected) throw new RangeError(`${name} does not match its experiment`);
}

function checkedSnapshot(snapshot) {
  if (!record(snapshot)) throw new TypeError('snapshot must be a plain object');
  // Strict original inputs, not normalizeConfig. No mutable state or geometry.
  sameSolved(snapshot, getSnapshot({ config: snapshot.config }), 'snapshot');
  return snapshot;
}

function sensitivity(s) {
  const factor = AT / (AT - AB);
  const result = { applicable: s.config.mode === 'held', branch: 'inactive', differentiable: false,
    waterLevelPerBottom: null, buoyancyPerBottomNPerM: null, holdingPerBottomNPerM: null,
    finiteTankFactor: factor };
  if (!result.applicable) return result;
  const fullBoundary = (C.fluidVolumeM3 + s.config.bodyVolumeM3) / AT - s.bodyHeightM;
  // At contact the two one-sided derivatives differ. A conservative coordinate
  // roundoff band also avoids claiming a branch derivative for an ambiguous ULP.
  const resolution = 32 * Number.EPSILON * Math.max(H0, s.waterLevelM, s.bodyBottomM, s.bodyHeightM);
  if (Math.abs(s.bodyBottomM - H0) <= resolution) return { ...result, branch: 'dry-contact' };
  if (Math.abs(s.bodyBottomM - fullBoundary) <= resolution) return { ...result, branch: 'full-contact' };
  const partial = s.immersion === 'partial', stiffness = s.config.fluidDensityKgM3 * G * AB * factor;
  return { ...result, branch: s.immersion, differentiable: true,
    waterLevelPerBottom: partial ? -AB / (AT - AB) : 0,
    buoyancyPerBottomNPerM: partial ? -stiffness : 0,
    holdingPerBottomNPerM: partial ? stiffness : 0 };
}

/** Read-only SI diagnostics of the existing static liquid/body snapshot.
 * Surface force vectors are inward pressure tractions on the body, excluding
 * atmospheric pressure. They already sum to buoyancy; do not add it again. */
export function buoyancyDetail(input) {
  const s = checkedSnapshot(input), rho = s.config.fluidDensityKgM3;
  const b = s.bodyBottomM, h = s.submergedHeightM, height = s.bodyHeightM;
  const pb = s.bottomGaugePressurePa, pt = s.topGaugePressurePa;
  const sideMean = h === 0 ? 0 : (pb + pt) / 2;
  // First pressure moment / force, factored to avoid subtracting cubic heights.
  // pt is also the upper wetted-edge pressure: zero for partial immersion.
  const sideY = h === 0 ? null : b + h * ((pb + 2 * pt) / (pb + pt)) / 3;
  const face = (areaM2, fullFaceAreaM2, meanGaugePressurePa, direction, point) => {
    const magnitude = areaM2 * meanGaugePressurePa;
    return { areaM2, fullFaceAreaM2, meanGaugePressurePa,
      forceN: { x: clean(magnitude * direction[0]), y: clean(magnitude * direction[1]), z: clean(magnitude * direction[2]) },
      centerOfPressureM: magnitude === 0 ? null : { x: clean(point[0]), y: clean(point[1]), z: clean(point[2]) } };
  };
  const X = C.bodyWidthM / 2, Z = C.bodyDepthM / 2;
  const faces = {
    bottom: face(h === 0 ? 0 : AB, AB, pb, [0, 1, 0], [0, b, 0]),
    // A fully immersed top exactly touching the surface has its full contact
    // area but zero gauge force and no pressure center. Dry faces have area 0.
    top: face(s.immersion === 'full' ? AB : 0, AB, pt, [0, -1, 0], [0, s.bodyTopM, 0]),
    left: face(C.bodyDepthM * h, C.bodyDepthM * height, sideMean, [1, 0, 0], [-X, sideY, 0]),
    right: face(C.bodyDepthM * h, C.bodyDepthM * height, sideMean, [-1, 0, 0], [X, sideY, 0]),
    front: face(C.bodyWidthM * h, C.bodyWidthM * height, sideMean, [0, 0, -1], [0, sideY, Z]),
    back: face(C.bodyWidthM * h, C.bodyWidthM * height, sideMean, [0, 0, 1], [0, sideY, -Z]),
  };
  const pressureResultantN = Object.fromEntries(['x', 'y', 'z'].map(axis =>
    [axis, clean(Object.values(faces).reduce((sum, item) => sum + item.forceN[axis], 0))]));
  const massKg = rho * s.fluidVolumeM3, weightN = massKg * G;
  const bottomGaugePressurePa = rho * G * s.waterLevelM, bottomFluidLoadN = bottomGaugePressurePa * AT;
  return {
    fluid: {
      massKg, weightN, displacedMassKg: rho * s.displacedVolumeM3,
      waterRiseM: clean(s.waterLevelM - H0), tankHeadroomM: C.tankHeightM - s.waterLevelM,
      bottomGaugePressurePa, bottomFluidLoadN,
    },
    body: {
      exposedHeightM: clean(height - h), topSurfaceClearanceM: clean(s.bodyTopM - s.waterLevelM),
      bottomClearanceM: b, centerOfBuoyancyM: s.centerOfBuoyancyM,
    },
    faces,
    balance: {
      pressureResultantN, buoyancyResidualN: clean(pressureResultantN.y - s.buoyancyN),
      volumeResidualM3: clean(AT * s.waterLevelM - s.displacedVolumeM3 - s.fluidVolumeM3),
      tankLoadResidualN: clean(bottomFluidLoadN - weightN - s.buoyancyN),
    },
    sensitivity: sensitivity(s),
  };
}

const fact = (label, value, unit = '', digits = 3) => ({ label, value, unit, digits });
const heightFact = (label, value) => fact(label, value === null ? '작용점 없음' : value * 100, value === null ? '' : 'cm');
const slopeFact = (label, value) => fact(label, value === null ? '이 조건에서 표시하지 않음' : value, value === null ? '' : 'N/m');
const holderNote = '높이 고정에서만 작용하는 양방향 강체 구속입니다. 양수는 위로 당김, 음수는 아래로 누름입니다. 연결선은 체적 없는 기호이며 로프의 음수 장력이 아닙니다.';

export function describeBuoyancyDetail(partId, snapshot, detail = buoyancyDetail(snapshot)) {
  const s = snapshot, d = detail, f = d.fluid, h = d.body, sensitivity = d.sensitivity;
  switch (partId) {
    case 'tank-shell': return {
      facts: [fact('수조 수평 면적', AT * 1e4, 'cm²', 1), fact('수조 바닥 게이지 압력', f.bottomGaugePressurePa, 'Pa', 1),
        fact('액체가 바닥에 가하는 하중', f.bottomFluidLoadN, 'N'), fact('액체 자체 무게', f.weightN, 'N'),
        fact('수면 위 수조 여유', f.tankHeadroomM * 100, 'cm')],
      note: '현재 정수압장의 바닥 하중은 액체 무게와 물체가 액체에 가하는 부력 반작용의 합입니다. 유리 자체 무게·응력·강도와 전체 장치의 지지력은 계산하지 않습니다.',
    };
    case 'fluid-volume': return {
      facts: [fact('실제 액체 체적', s.fluidVolumeM3 * 1000, 'L', 1), fact('액체 질량', f.massKg, 'kg'),
        fact('액체 무게', f.weightN, 'N'), fact('배제한 액체 질량', f.displacedMassKg, 'kg'),
        fact('수면 상승', f.waterRiseM * 1000, 'mm')],
      note: '일정한 것은 실제 액체의 체적 38.5 L입니다. 밀도를 바꾸면 액체 질량이 달라집니다. 배제한 액체는 물체가 차지하는 공간에 해당하는 가상 액체이며 실제 액체가 소실된 것이 아닙니다.',
    };
    case 'test-body': return {
      facts: [fact('물체 질량', s.config.bodyMassKg, 'kg'), fact('물체 평균 밀도', s.bodyDensityKgM3, 'kg/m³', 1),
        fact('실제 높이', s.bodyHeightM * 100, 'cm'), fact('물체의 미잠김 높이', h.exposedHeightM * 100, 'cm'),
        fact('윗면의 수면 상대 높이', h.topSurfaceClearanceM * 100, 'cm'), fact('바닥 여유', h.bottomClearanceM * 100, 'cm')],
      note: '윗면의 수면 상대 높이는 top−수면으로 완전잠김에서 음수입니다. 건조한 물체는 밑면과 수면 사이에 공기 틈이 있어 이 값과 물체 자체의 미잠김 높이가 다릅니다. 질량과 체적은 독립 입력입니다.',
    };
    case 'submerged-volume': return {
      facts: [fact('잠긴 체적', s.displacedVolumeM3 * 1000, 'L'), fact('잠긴 높이', s.submergedHeightM * 100, 'cm'),
        fact('배제한 액체 질량', f.displacedMassKg, 'kg'), heightFact('부심 높이', h.centerOfBuoyancyM),
        heightFact('오른쪽 옆면 압력중심 높이', d.faces.right.centerOfPressureM?.y ?? null)],
      note: '부심은 잠긴 체적의 중심이고, 옆면 압력중심은 그 한 면에 작용하는 압력의 가중 중심입니다. 부분잠김에서 밑면으로부터 각각 잠긴 높이의 1/2과 1/3이며 서로 다른 점입니다.',
    };
    case 'free-surface': return {
      facts: [fact('현재 수면 높이', s.waterLevelM * 100, 'cm'), fact('물체 없는 기준 수면', H0 * 100, 'cm', 1),
        fact('수면 상승', f.waterRiseM * 1000, 'mm'), fact('잠긴 체적', s.displacedVolumeM3 * 1000, 'L'),
        fact('유한 수조 감도 배율', sensitivity.finiteTankFactor, '배', 6)],
      note: 'At×수면−잠긴 체적은 일정한 액체 체적입니다. 부분잠김 높이 고정에서 물체를 올리면 수면도 내려갑니다. 감도 배율 At/(At−Ab)는 무한히 넓은 수조와 비교한 기하학적 값입니다.',
    };
    case 'holding-frame': return {
      facts: [fact('현재 모드', s.config.mode === 'held' ? '높이 고정' : '자유평형 판단'), fact('물체 무게', s.weightN, 'N'),
        fact('현재 부력', s.buoyancyN, 'N'), fact('물체에 가하는 구속힘 +Y', s.holdingForceYN, 'N'),
        fact('구속 없는 합력 +Y', s.unrestrainedForceYN, 'N')], note: holderNote,
    };
    case 'holding-carriage': return {
      facts: [fact('현재 밑면 높이', s.bodyBottomM * 100, 'cm'), fact('기억한 높이 입력', s.config.heldBottomM * 100, 'cm'),
        fact('물체에 가하는 구속힘 +Y', s.holdingForceYN, 'N'), slopeFact('높이당 구속힘 변화', sensitivity.holdingPerBottomNPerM),
        slopeFact('높이당 부력 변화', sensitivity.buoyancyPerBottomNPerM)],
      note: !sensitivity.applicable ? '자유평형 모드에서는 기억한 높이 입력을 현재 위치에 사용하지 않습니다. 높이 고정 감도를 이 모드의 운동이나 실제 스프링 강성으로 표시하지 않습니다.'
        : !sensitivity.differentiable ? '액체 접촉이 바뀌는 경계에서는 양쪽 기울기가 달라 단일 미분값을 표시하지 않습니다. 수치 좌표의 반올림 범위에서도 보수적으로 같은 처리합니다.'
          : '고정 질량·체적·밀도에서 밑면 높이를 조금 바꿨을 때의 정적 변화율입니다. 부분잠김은 유한 수조 수면 변화를 포함하며 건조·완전잠김 내부는 0입니다. 진동·침강 속도를 계산하지 않습니다.',
    };
    case 'holding-link': return {
      facts: [fact('물체에 가하는 구속힘 +Y', s.holdingForceYN, 'N'), fact('장치가 받는 반작용 +Y', clean(-s.holdingForceYN), 'N'),
        fact('구속 없는 합력 +Y', s.unrestrainedForceYN, 'N'), fact('구속 포함 합력 +Y', s.netForceYN, 'N')], note: holderNote,
    };
    case 'force-buoyancy': return {
      facts: [fact('밑면 압력 힘 +Y', d.faces.bottom.forceN.y, 'N'), fact('윗면 압력 힘 +Y', d.faces.top.forceN.y, 'N'),
        fact('여섯 면 압력 합력 +Y', d.balance.pressureResultantN.y, 'N'), fact('배제한 액체 질량', f.displacedMassKg, 'kg'),
        heightFact('부심 높이', h.centerOfBuoyancyM)],
      note: '반대 옆면의 수평 힘은 서로 상쇄되고 위아래 압력 힘의 차가 부력이 됩니다. 압력 합력에 부력을 또 더하지 않습니다. 부심은 합력의 수직 작용선 위 잠긴 체적 중심입니다.',
    };
    case 'force-weight': return {
      facts: [fact('물체 질량', s.config.bodyMassKg, 'kg'), fact('중력가속도', G, 'm/s²', 5),
        fact('무게 +Y', -s.weightN, 'N'), fact('배제한 액체 질량', f.displacedMassKg, 'kg'), fact('구속 없는 합력 +Y', s.unrestrainedForceYN, 'N')],
      note: '질량 kg과 힘 N은 다릅니다. 자유평형이 없는 무거운 물체의 그림은 잠긴 기준 위치이며 아래쪽 합력을 지지력으로 없애지 않습니다. 이 합력으로 침강 운동을 적분하지 않습니다.',
    };
    case 'force-holder': return {
      facts: [fact('물체에 가하는 구속힘 +Y', s.holdingForceYN, 'N'), fact('장치가 받는 반작용 +Y', clean(-s.holdingForceYN), 'N'),
        fact('구속 없는 합력 +Y', s.unrestrainedForceYN, 'N'), fact('구속 포함 합력 +Y', s.netForceYN, 'N'),
        slopeFact('높이당 구속힘 변화', sensitivity.holdingPerBottomNPerM)], note: holderNote,
    };
    case 'pressure-bottom': return {
      facts: [fact('밑면 게이지 압력', s.bottomGaugePressurePa, 'Pa', 1), fact('밑면의 젖은 면적', d.faces.bottom.areaM2 * 1e4, 'cm²', 1),
        fact('밑면 압력 힘 +Y', d.faces.bottom.forceN.y, 'N'), heightFact('밑면 압력중심 높이', d.faces.bottom.centerOfPressureM?.y ?? null),
        fact('오른쪽 한 옆면 압력 힘 크기', Math.abs(d.faces.right.forceN.x), 'N'),
        heightFact('오른쪽 옆면 압력중심 높이', d.faces.right.centerOfPressureM?.y ?? null)],
      note: '수평 밑면 압력은 균일하므로 합력이 있으면 면의 중심에 작용합니다. 옆면은 깊이에 따라 압력이 커져 가중 작용점이 젖은 면의 중심보다 아래입니다. 합력이 0이면 압력중심을 정하지 않습니다.',
    };
    case 'pressure-top': return {
      facts: [fact('윗면 게이지 압력', s.topGaugePressurePa, 'Pa', 1), fact('윗면의 젖은 면적', d.faces.top.areaM2 * 1e4, 'cm²', 1),
        fact('윗면 압력 힘 +Y', d.faces.top.forceN.y, 'N'), heightFact('윗면 압력중심 높이', d.faces.top.centerOfPressureM?.y ?? null),
        fact('윗면의 수면 상대 높이', h.topSurfaceClearanceM * 100, 'cm')],
      note: '대기압을 뺀 값이므로 공기 중과 수면의 게이지 압력은 0입니다. 완전잠김 윗면이 정확히 수면에 닿으면 접촉 면적은 있지만 압력 합력과 압력중심은 없습니다.',
    };
    case 'level-scale': return {
      facts: [fact('수조 바닥 기준', 0, 'cm', 0), fact('현재 밑면 높이', s.bodyBottomM * 100, 'cm'),
        fact('현재 윗면 높이', s.bodyTopM * 100, 'cm'), fact('현재 수면 높이', s.waterLevelM * 100, 'cm'),
        fact('물체 없는 기준 수면', H0 * 100, 'cm', 1), heightFact('부심 높이', h.centerOfBuoyancyM)],
      note: '모든 높이는 수조 바닥 y=0에서 위로 잽니다. 밑면 높이와 수면 아래 깊이는 서로 다릅니다. 부심은 잠긴 체적이 있을 때만 정의됩니다.',
    };
    default: throw new RangeError(`Unknown buoyancy component: ${partId}`);
  }
}
