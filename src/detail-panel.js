import { buoyancyDetail, describeBuoyancyDetail } from './detail-model.js';
import { CONSTANTS_SI } from './model.js';

const numeric=(value,digits=3)=>{
  if(value===null)return '—';
  if(value!==0&&Math.abs(value)<.5*10**-digits)return value.toExponential(2);
  return value.toLocaleString('ko-KR',{minimumFractionDigits:digits,maximumFractionDigits:digits});
};
const field=(label,key,factor=1,unit='',digits=3)=>`<div><dt>${label}</dt><dd data-detail-value="${key}" data-factor="${factor}" data-unit="${unit}" data-digits="${digits}"></dd></div>`;
const faces=[['bottom','밑면','y'],['top','윗면','y'],['left','왼쪽 면','x'],['right','오른쪽 면','x'],['front','앞면','z'],['back','뒷면','z']];
const read=(object,key)=>key.split('.').reduce((value,part)=>value[part],object);

export class BuoyancyDetailPanel {
  constructor(root,facts,note,{onInspect}={}) {
    this.root=root;this.facts=facts;this.note=note;
    root.innerHTML=`<div class="panel-head"><div><p class="eyebrow">READ THE PRESSURE</p><h2 id="buoyancy-detail-title">압력은 어디에서, 얼마나 밀까요?</h2></div><button data-detail-inspect="pressure-bottom">물속 압력 자세히</button></div>
      <div class="hydro-detail-grid"><section><h3>깊이에 따른 압력과 작용점</h3><figure class="pressure-profile"><svg viewBox="0 0 560 330" role="img" aria-label="물체 높이에 따른 게이지 압력과 옆면 압력중심, 부심"><g id="pressure-grid"></g><rect id="profile-body" x="91" width="66" fill="#ddccaa" stroke="#776345"/><rect id="profile-wet" x="92" width="64" fill="#94c8c0"/><path id="profile-pressure" fill="#176b6a20" stroke="#176b6a" stroke-width="2.5"/><line id="profile-surface" x1="66" x2="503" stroke="#549cab" stroke-width="1.5" stroke-dasharray="6 4"/><circle id="profile-cp" cx="176" r="5.5" fill="#b66a2e" stroke="white" stroke-width="2"/><circle id="profile-cb" cx="145" r="5.5" fill="#176b6a" stroke="white" stroke-width="2"/><text x="47" y="15">높이 cm</text><text x="123" y="300" text-anchor="middle">물체 단면</text><text x="356" y="323" text-anchor="middle">게이지 압력 Pa · 공통 0–3,000</text></svg><figcaption>파란 점선은 현재 수면입니다. 높이 0은 수조 바닥이며 세로축은 표시된 cm 눈금에 맞춰 확대합니다.</figcaption></figure>
      <dl class="hydro-values point-values"><div><dt><i class="cp-dot"></i>한 옆면 압력중심 높이</dt><dd id="side-pressure-center"></dd></div>${field('<i class="cb-dot"></i>부심 · 잠긴 체적의 중심','body.centerOfBuoyancyM',100,'cm')}</dl>
      <p class="hint">갈색 점은 한 옆면을 미는 힘의 작용점, 청록 점은 부력의 작용점입니다. 옆면 압력이 깊이에 따라 커지므로 두 점은 일반적으로 다릅니다. 압력이 없으면 작용점도 표시하지 않습니다.</p></section>
      <section class="face-details"><h3>여섯 면에 작용하는 액체의 힘</h3><div class="face-table-wrap"><table class="face-table"><thead><tr><th scope="col">면</th><th scope="col">젖은 면 평균</th><th scope="col">힘 · 방향</th></tr></thead><tbody>${faces.map(([id,label,axis])=>`<tr data-pressure-face="${id}"><th scope="row">${label}</th><td data-face-pressure="${id}"></td><td data-face-force="${id}" data-axis="${axis}"></td></tr>`).join('')}</tbody></table></div><p class="axes-note">+x 오른쪽 · +y 위쪽 · +z 앞쪽<br>같은 축의 양쪽 옆면 힘은 서로 상쇄됩니다.</p><div class="pressure-sum"><span>압력 합력 · 위쪽 부력</span><strong data-detail-value="balance.pressureResultantN.y" data-unit="N" data-factor="1" data-digits="3"></strong></div><p class="hint">대기압을 뺀 게이지 압력입니다. 밑면의 위쪽 힘에서 윗면의 아래쪽 힘을 뺀 결과가 부력입니다. 표면 압력과 부력을 별개의 추가 힘으로 더하지 않습니다.</p><p id="pressure-balance-note" class="hint"></p></section></div>
      <details class="hydro-extra" id="fluid-balance"><summary>액체 체적·바닥 하중과 물체의 여유</summary><dl class="hydro-values detail-stat-grid">${[
        field('액체 질량','fluid.massKg',1,'kg'),field('배제한 액체 질량','fluid.displacedMassKg',1,'kg'),field('물체가 올린 수면','fluid.waterRiseM',1000,'mm'),field('수조 위쪽 남은 높이','fluid.tankHeadroomM',100,'cm'),field('액체의 무게','fluid.weightN',1,'N'),field('액체가 수조 바닥에 미는 힘','fluid.bottomFluidLoadN',1,'N'),field('물체 자체의 미잠김 높이','body.exposedHeightM',100,'cm'),field('물체 윗면 − 현재 수면','body.topSurfaceClearanceM',100,'cm'),field('물체와 바닥 사이','body.bottomClearanceM',100,'cm')
      ].join('')}</dl><p class="hint">액체는 항상 38.5 L입니다. 수조 바닥 하중은 액체 무게와 물체가 액체에 전달한 부력의 반작용을 더한 값입니다. 유리·프레임 무게나 전체 실험대 하중은 포함하지 않습니다. 윗면 − 수면이 음수이면 윗면까지 물속에 있습니다.</p><p id="fluid-balance-note" class="hint"></p></details>
      <details class="hydro-extra" id="held-sensitivity"><summary>높이를 아주 조금 바꾸면?</summary><p id="sensitivity-state"></p><dl class="hydro-values detail-stat-grid">${field('수면 높이의 변화율','sensitivity.waterLevelPerBottom',1,'cm/cm',6)}${field('부력 변화율','sensitivity.buoyancyPerBottomNPerM',.01,'N/cm',6)}${field('고정장치 힘의 변화율','sensitivity.holdingPerBottomNPerM',.01,'N/cm',6)}</dl><p class="hint">현재 질량·체적·액체를 그대로 두고 아랫면을 위로 아주 조금 옮길 때의 국소 변화율입니다. 큰 높이 이동의 예측값이나 흔들림·스프링·진동 계산이 아닙니다. 고정장치 힘은 위로 당김이 양수입니다.</p></details>`;
    root.querySelectorAll('[data-detail-inspect]').forEach(button=>button.addEventListener('click',()=>onInspect?.(button.dataset.detailInspect)));
  }
  render(snapshot,partId) {
    const detail=buoyancyDetail(snapshot);
    for(const element of this.root.querySelectorAll('[data-detail-value]')){
      const value=read(detail,element.dataset.detailValue);element.dataset.raw=value===null?'null':String(value);
      element.textContent=value===null?'해당 없음':`${numeric(value*Number(element.dataset.factor),Number(element.dataset.digits))} ${element.dataset.unit}`.trim();
    }
    for(const [id,,axis] of faces){
      const face=detail.faces[id],row=this.root.querySelector(`[data-pressure-face="${id}"]`),pressure=this.root.querySelector(`[data-face-pressure="${id}"]`),force=this.root.querySelector(`[data-face-force="${id}"]`);
      row.dataset.areaM2=String(face.areaM2);row.dataset.center=JSON.stringify(face.centerOfPressureM);pressure.dataset.raw=String(face.meanGaugePressurePa);force.dataset.raw=String(face.forceN[axis]);
      pressure.textContent=`${numeric(face.meanGaugePressurePa,1)} Pa`;
      const value=face.forceN[axis];force.textContent=value===0?'0 N':`${numeric(Math.abs(value))} N · ${value>0?'+':'−'}${axis}`;
    }
    const center=detail.faces.right.centerOfPressureM,cp=this.root.querySelector('#side-pressure-center');cp.dataset.raw=center?String(center.y):'null';cp.textContent=center?`${numeric(center.y*100)} cm`:'하중 없음';
    this.root.querySelector('#pressure-balance-note').textContent=`압력 적분 − 부력의 수치 잔차 ${detail.balance.buoyancyResidualN.toExponential(2)} N. 모형의 수치 일치이며 실제 측정 오차가 아닙니다.`;
    this.root.querySelector('#fluid-balance-note').textContent=`체적 잔차 ${detail.balance.volumeResidualM3.toExponential(2)} m³ · 바닥 하중 잔차 ${detail.balance.tankLoadResidualN.toExponential(2)} N`;
    const sensitivity=detail.sensitivity;
    this.root.querySelector('#sensitivity-state').textContent=!sensitivity.applicable?'자유부유 모드에서는 높이를 직접 고정하지 않으므로 이 변화율을 적용하지 않습니다.':!sensitivity.differentiable?'수면 접촉 경계이거나 수치상 매우 가까운 위치입니다. 접촉 경계 양쪽의 기울기가 달라 하나의 변화율을 표시하지 않습니다.':snapshot.immersion==='partial'?'부분잠김입니다. 물체를 올리면 배제 체적이 줄고 수면도 내려갑니다. 유한 수조의 수면 변화를 함께 반영합니다.':snapshot.immersion==='full'?'완전잠김입니다. 작은 높이 이동으로 배제 체적과 부력은 변하지 않지만 각 면의 압력은 달라집니다.':'물체가 액체 밖에 있습니다. 수면에 닿기 전까지 부력은 0으로 유지됩니다.';
    this.profile(snapshot,detail);
    const description=describeBuoyancyDetail(partId,snapshot,detail);
    this.facts.replaceChildren(...description.facts.map(fact=>{const group=document.createElement('div'),label=document.createElement('dt'),value=document.createElement('dd');label.textContent=fact.label;value.textContent=typeof fact.value==='number'?`${numeric(fact.value,fact.digits??3)} ${fact.unit??''}`.trim():fact.value===null?'해당 없음':String(fact.value);value.dataset.raw=fact.value===null?'null':String(fact.value);group.append(label,value);return group;}));this.note.textContent=description.note;
    return detail;
  }
  profile(s,d) {
    const lower=Math.max(0,Math.min(s.bodyBottomM,s.waterLevelM)-.018),upper=Math.min(.5,Math.max(s.bodyTopM,s.waterLevelM)+.018),y=value=>267-(value-lower)/(upper-lower)*237,x=pressure=>220+pressure/3000*272;
    let grid='';for(let i=0;i<=4;i++){const value=lower+(upper-lower)*i/4,py=y(value);grid+=`<line x1="66" x2="503" y1="${py}" y2="${py}" stroke="#dde5df"/><text x="59" y="${py+4}" text-anchor="end">${numeric(value*100,1)}</text>`;}
    for(let pressure=0;pressure<=3000;pressure+=1000){const px=x(pressure);grid+=`<line x1="${px}" x2="${px}" y1="30" y2="267" stroke="#e4eae4"/><text x="${px}" y="292" text-anchor="middle">${pressure.toLocaleString('ko-KR')}</text>`;}
    this.root.querySelector('#pressure-grid').innerHTML=grid;
    for(const [id,top,height] of [['profile-body',s.bodyTopM,s.bodyHeightM],['profile-wet',s.bodyBottomM+s.submergedHeightM,s.submergedHeightM]]){const rectangle=this.root.querySelector('#'+id);rectangle.setAttribute('y',y(top));rectangle.setAttribute('height',height/(upper-lower)*237);}
    const pressureAt=height=>s.config.fluidDensityKgM3*CONSTANTS_SI.gravityMps2*Math.max(s.waterLevelM-height,0);
    const heights=[s.bodyBottomM,Math.max(s.bodyBottomM,Math.min(s.bodyTopM,s.waterLevelM)),s.bodyTopM],points=heights.map(height=>[x(pressureAt(height)),y(height)]);
    const profile=this.root.querySelector('#profile-pressure');profile.setAttribute('d',`M ${x(0)} ${y(s.bodyBottomM)} L ${points.map(point=>point.join(' ')).join(' L ')} L ${x(0)} ${y(s.bodyTopM)} Z`);profile.dataset.samples=JSON.stringify(heights.map(height=>({heightM:height,gaugePressurePa:pressureAt(height)})));
    const surface=this.root.querySelector('#profile-surface');surface.setAttribute('y1',y(s.waterLevelM));surface.setAttribute('y2',y(s.waterLevelM));
    for(const [id,value] of [['profile-cp',d.faces.right.centerOfPressureM?.y??null],['profile-cb',d.body.centerOfBuoyancyM]]){const marker=this.root.querySelector('#'+id);marker.style.display=value===null?'none':'';marker.dataset.raw=value===null?'null':String(value);if(value!==null)marker.setAttribute('cy',y(value));}
  }
}
