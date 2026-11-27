import { CONSTANTS_SI } from './model.js';
import './chart.css';

const NS = 'http://www.w3.org/2000/svg';
const colors = { current: '#176d65', saved: '#994d24', grid: '#d5dfd6', text: '#435e56' };
const labels = { current: '현재', saved: '보관' };
const immersionLabels = { dry: '액체 밖', partial: '부분잠김', full: '완전잠김' };
const poseLabels = {
  held: '높이 고정', equilibrium: '자유부유 평형',
  'neutral-reference': '중성부력 · 대표 위치',
  'submerged-reference': '자유부유 평형 없음 · 기준 위치',
};
const pressureAxisPa = [0, 4000];
const depthAxisM = [0, .32];
const volumeAxisL = [0, 2];
const forces = [
  ['buoyancyN', '부력'], ['weightN', '무게'], ['holdingForceYN', '고정 힘'], ['netForceYN', '합력'],
];

function svgNode(name, attrs = {}, content) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (content !== undefined) node.textContent = content;
  return node;
}

function svgText(x, y, value, attrs = {}) {
  return svgNode('text', { x, y, fill: colors.text, ...attrs }, value);
}

function line(x1, y1, x2, y2, attrs = {}) {
  return svgNode('line', { x1, y1, x2, y2, stroke: colors.grid, ...attrs });
}

function makeSvg(width, height) {
  return svgNode('svg', { viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true' });
}

const rounded = (value, digits) =>
  value.toLocaleString('ko-KR', { maximumFractionDigits: digits });

function reading(value, digits, signed = false) {
  if (value === 0) return '0';
  const sign = value < 0 ? '−' : signed ? '+' : '';
  const magnitude = Math.abs(value);
  if (magnitude < .5 * 10 ** -digits) return '≈0';
  return sign + rounded(magnitude, digits);
}

const dash = kind => kind === 'saved' ? { 'stroke-dasharray': '5 3' } : {};
const chartWidth = container => Math.max(250, container.clientWidth);
const stateText = snapshot => `${immersionLabels[snapshot.immersion]} · ${poseLabels[snapshot.poseKind]}`;
const forceValue = (snapshot, key) => key === 'weightN' ? -snapshot.weightN : snapshot[key];

function renderForces(container, conditions) {
  const width = chartWidth(container);
  const height = 192;
  const left = 43;
  const axisWidth = width - left - 59;
  const x = value => left + (value + 30) * axisWidth / 60;
  const zero = x(0);
  const svg = makeSvg(width, height);
  for (const value of [-30, -15, 0, 15, 30]) {
    const px = x(value);
    svg.append(
      line(px, 7, px, 165, value === 0 ? { stroke: '#849e94', 'stroke-width': 1.5 } : {}),
      svgText(px, 184, reading(value, 0, true), { 'text-anchor': 'middle' }),
    );
  }

  const records = [];
  forces.forEach(([key, label], index) => {
    const y = 16 + 40 * index;
    svg.append(svgText(left - 7, y + 10, label, { 'text-anchor': 'end' }));
    conditions.forEach(({ kind, snapshot }, conditionIndex) => {
      const value = forceValue(snapshot, key);
      const end = x(value);
      const row = conditions.length === 1 ? y + 6 : y + 13 * conditionIndex;
      const color = colors[kind];
      svg.append(
        line(zero, row, end, row, { stroke: color, 'stroke-width': 7,
          'data-force': key, 'data-kind': kind, 'data-force-n': value, ...dash(kind) }),
        svgNode('circle', { cx: end, cy: row, r: 2.8, fill: color }),
        svgText(width - 3, row + 3.5, reading(value, 3, true),
          { fill: color, 'text-anchor': 'end', class: 'condition-value' }),
      );
      records.push({ kind, key, valueN: value, startX: zero, endX: end, axisWidth });
    });
  });
  container.setAttribute('aria-label', [
    '현재와 보관 조건의 부력, 무게, 고정장치 힘과 합력 비교. 위쪽은 양수',
    ...conditions.map(({ kind, snapshot }) => `${labels[kind]} 조건, ${forces.map(([key, label]) =>
      `${label} ${reading(forceValue(snapshot, key), 3, true)} N`).join(', ')}`),
  ].join('. '));
  container.replaceChildren(svg);
  return records;
}

function renderBars(container, conditions, { key, maximum, scale, unit, digits, label }) {
  const width = chartWidth(container);
  const svg = makeSvg(width, 96);
  const left = 34;
  const axisWidth = width - left - 68;
  for (const value of [0, maximum / 2, maximum]) {
    const x = left + value / maximum * axisWidth;
    svg.append(line(x, 10, x, 64),
      svgText(x, 86, `${value}${unit}`, { 'text-anchor': 'middle' }));
  }
  const bars = conditions.map(({ kind, snapshot }, index) => {
    const value = snapshot[key] * scale;
    const y = 18 + 27 * index;
    const barWidth = value * axisWidth / maximum;
    const color = colors[kind];
    svg.append(
      svgText(left - 7, y + 10, labels[kind], { fill: color, 'text-anchor': 'end' }),
      svgNode('rect', { x: left, y, width: barWidth, height: 12, rx: 2,
        fill: kind === 'saved' ? 'none' : color, stroke: color, 'data-kind': kind,
        'data-raw': snapshot[key], ...dash(kind) }),
      svgText(left + barWidth + 7, y + 10, `${reading(value, digits)}${unit}`,
        { fill: color, class: 'condition-value' }),
    );
    if (value === 0) svg.append(svgNode('circle', { cx: left, cy: y + 6, r: 2.5, fill: color }));
    return { kind, value, width: barWidth, axisWidth };
  });
  container.setAttribute('aria-label', [
    `현재와 보관 조건의 ${label} 비교`,
    ...bars.map(({ kind, value }) => `${labels[kind]} ${reading(value, digits)}${unit}`),
  ].join('. '));
  container.replaceChildren(svg);
  return bars;
}

function pressureProfile({ kind, snapshot }) {
  const gravity = snapshot.gravityMps2 ?? CONSTANTS_SI.gravityMps2;
  const pressureGradientPaPerM = snapshot.config.fluidDensityKgM3 * gravity;
  const faces = [
    { face: 'bottom', depthM: snapshot.waterLevelM - snapshot.bodyBottomM,
      gaugePressurePa: snapshot.bottomGaugePressurePa },
    { face: 'top', depthM: snapshot.waterLevelM - snapshot.bodyTopM,
      gaugePressurePa: snapshot.topGaugePressurePa },
  ];
  return { kind, pressureGradientPaPerM, faces,
    tankBottom: { depthM: snapshot.waterLevelM, gaugePressurePa: pressureGradientPaPerM * snapshot.waterLevelM } };
}

function renderPressure(container, conditions) {
  const width = chartWidth(container);
  const height = 192;
  const left = 36;
  const top = 17;
  const right = width - 23;
  const bottom = height - 40;
  const x = pressurePa => left + pressurePa / pressureAxisPa[1] * (right - left);
  const y = depthM => top + depthM / depthAxisM[1] * (bottom - top);
  const svg = makeSvg(width, height);
  for (let pressure = 0; pressure <= pressureAxisPa[1]; pressure += 1000) {
    const px = x(pressure);
    svg.append(line(px, top, px, bottom), svgText(px, bottom + 17, rounded(pressure, 0),
      { 'text-anchor': 'middle' }));
  }
  for (const depth of [0, .08, .16, .24, depthAxisM[1]]) {
    const py = y(depth);
    svg.append(line(left, py, right, py, depth === 0 ? { stroke: '#849e94' } : {}),
      svgText(left - 7, py + 3.5, rounded(depth * 100, 0), { 'text-anchor': 'end' }));
  }
  svg.append(svgText(left - 7, 9, 'cm', { 'text-anchor': 'end' }),
    svgText((left + right) / 2, height - 4, '게이지 압력 (Pa)', { 'text-anchor': 'middle' }));

  const profiles = conditions.map(pressureProfile);
  for (const { kind, tankBottom } of profiles) {
    svg.append(line(x(0), y(0), x(tankBottom.gaugePressurePa), y(tankBottom.depthM), {
      stroke: colors[kind], 'stroke-width': 2.5, 'data-pressure-profile': kind,
      'data-depth-m': tankBottom.depthM, 'data-gauge-pressure-pa': tankBottom.gaugePressurePa, ...dash(kind),
    }));
  }
  for (const { kind, faces } of profiles) {
    for (const { face, depthM, gaugePressurePa } of faces) {
      if (depthM < 0) continue;
      svg.append(svgNode('circle', {
        cx: x(gaugePressurePa), cy: y(depthM), r: 4,
        fill: face === 'bottom' ? colors[kind] : '#fffffb', stroke: colors[kind], 'stroke-width': 1.75,
        'data-kind': kind, 'data-profile-face': face, 'data-depth-m': depthM,
        'data-gauge-pressure-pa': gaugePressurePa,
      }));
    }
  }
  container.setAttribute('aria-label', [
    '현재와 보관 조건의 수심별 게이지 압력 비교. 수면은 0 cm, 선의 끝은 수조 바닥',
    ...profiles.map(({ kind, tankBottom, faces }) => `${labels[kind]} 조건, 수조 바닥 수심 ${reading(tankBottom.depthM * 100, 2)} cm, ${reading(tankBottom.gaugePressurePa, 1)} Pa, ${faces.map(face =>
      `${face.face === 'bottom' ? '물체 밑면' : '물체 윗면'} ${reading(face.gaugePressurePa, 1)} Pa`).join(', ')}`),
  ].join('. '));
  container.replaceChildren(svg);
  return profiles;
}

export class BuoyancyChart {
  constructor(forceContainer, immersionContainer) {
    this.forceContainer = forceContainer;
    this.immersionContainer = immersionContainer;
    this.debug = null;
    const layout = document.createElement('div');
    layout.className = 'condition-charts';
    layout.innerHTML = `
      <p class="condition-empty" data-chart-empty hidden>보관된 조건이 없습니다. 비교 보관을 눌러 현재 조건을 저장하세요.</p>
      <table class="condition-summary">
        <caption>물체 상태와 표면 압력</caption>
        <thead><tr><th scope="col">조건</th><th scope="col">잠김 상태와 위치</th><th scope="col">밑면 (Pa)</th><th scope="col">윗면 (Pa)</th></tr></thead>
        <tbody></tbody>
      </table>
      <div class="condition-plots">
        <figure class="condition-plot">
          <h3>수심과 게이지 압력</h3>
          <p>수면에서 수조 바닥까지 · ● 물체 밑면 · ○ 물체 윗면</p>
          <div id="condition-pressure-chart" role="img"></div>
        </figure>
        <figure class="condition-plot">
          <h3>물체에 작용하는 힘 (N)</h3>
          <p>위쪽 + · 아래쪽 − · 합력 = 부력 + 무게 + 고정 힘</p>
          <div data-force-mount></div>
        </figure>
        <figure class="condition-plot">
          <h3>물체가 잠긴 비율 (%)</h3>
          <div data-immersion-mount></div>
        </figure>
        <figure class="condition-plot">
          <h3>배제 체적 (L)</h3>
          <div id="condition-volume-chart" role="img"></div>
        </figure>
      </div>`;
    forceContainer.before(layout);
    layout.querySelector('[data-force-mount]').replaceWith(forceContainer);
    layout.querySelector('[data-immersion-mount]').replaceWith(immersionContainer);
    this.pressureContainer = layout.querySelector('#condition-pressure-chart');
    this.volumeContainer = layout.querySelector('#condition-volume-chart');
    this.summary = layout.querySelector('.condition-summary');
    this.plots = layout.querySelector('.condition-plots');
    this.emptyMessage = layout.querySelector('[data-chart-empty]');
  }

  update(current, saved = null, mode = 'both') {
    const conditions = [{ kind: 'current', snapshot: current }, { kind: 'saved', snapshot: saved }]
      .filter(({ kind, snapshot }) => snapshot && (mode === 'both' || mode === kind));
    this.emptyMessage.hidden = conditions.length !== 0;
    this.summary.hidden = this.plots.hidden = conditions.length === 0;
    this.summary.tBodies[0].replaceChildren(...conditions.map(({ kind, snapshot }) => {
      const row = document.createElement('tr');
      row.dataset.kind = kind;
      const label = document.createElement('th');
      label.scope = 'row';
      label.textContent = labels[kind];
      const state = row.insertCell();
      state.textContent = stateText(snapshot);
      state.dataset.immersion = snapshot.immersion;
      state.dataset.poseKind = snapshot.poseKind;
      row.prepend(label);
      for (const [face, value] of [['bottom', snapshot.bottomGaugePressurePa], ['top', snapshot.topGaugePressurePa]]) {
        const cell = row.insertCell();
        cell.dataset.face = face;
        cell.dataset.gaugePressurePa = String(value);
        cell.textContent = reading(value, 1);
      }
      return row;
    }));

    const pressureProfiles = renderPressure(this.pressureContainer, conditions);
    const forceRecords = renderForces(this.forceContainer, conditions);
    const fractions = renderBars(this.immersionContainer, conditions, {
      key: 'submergedFraction', maximum: 100, scale: 100, unit: '%', digits: 1, label: '잠긴 비율',
    }).map(({ value, ...bar }, index) => ({ ...bar, fraction: conditions[index].snapshot.submergedFraction }));
    const volumes = renderBars(this.volumeContainer, conditions, {
      key: 'displacedVolumeM3', maximum: volumeAxisL[1], scale: 1000, unit: ' L', digits: 3, label: '배제 체적',
    }).map(({ value, ...bar }) => ({ ...bar, volumeL: value }));
    this.debug = {
      mode, forceAxisN: [-30, 30], immersionAxis: [0, 1], volumeAxisL, pressureAxisPa, depthAxisM,
      forces: forceRecords, fractions, volumes, pressureProfiles,
    };
  }
}
