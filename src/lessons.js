import { DEFAULT_CONFIG, getSnapshot } from './model.js';
const config = patch => ({ ...DEFAULT_CONFIG, ...patch });
export const LESSONS = {
  mass: { title:'무게를 더하면 얼마나 잠길까요?', config:config({}),
    steps:[{action:'자유부유 평형에서 질량 0.40 kg · 체적 1.00 L · 액체 밀도 1,000 kg/m³를 맞추고 잠긴 비율을 확인하세요.',config:config({})},
      {action:'물체 질량만 0.80 kg으로 바꾸세요. 체적 1.00 L와 액체 밀도 1,000 kg/m³를 유지하고 잠긴 비율을 비교하세요.',config:config({bodyMassKg:.8})}],
    result:'질량을 두 배로 늘리면 잠긴 비율은 40%에서 80%로 늘어납니다. 부력은 새 무게와 같아지고, 더 많은 액체를 밀어내 수면도 조금 올라갑니다.' },
  density: { title:'같은 물체, 다른 액체라면?', config:config({bodyMassKg:.8,fluidDensityKgM3:900}),
    steps:[{action:'자유부유 평형에서 0.80 kg · 1.00 L 물체와 액체 밀도 900 kg/m³를 맞추고 잠긴 비율과 부력을 확인하세요.',config:config({bodyMassKg:.8,fluidDensityKgM3:900})},
      {action:'액체 밀도만 1,200 kg/m³로 바꾸세요. 같은 물체의 잠긴 비율과 부력을 비교하세요.',config:config({bodyMassKg:.8,fluidDensityKgM3:1200})}],
    result:'잠긴 비율은 약 88.9%에서 66.7%로 줄지만 부력은 약 7.85 N으로 같습니다. 더 조밀한 액체에서는 더 적은 체적만 밀어내도 같은 무게를 지지합니다.' },
  depth: { title:'더 깊으면 부력이 더 커질까요?', config:config({bodyMassKg:1.2,mode:'held',heldBottomM:.06}),
    steps:[{action:'높이 고정에서 1.20 kg · 1.00 L · 밀도 1,000 kg/m³, 아랫면 높이 6.0 cm를 맞추세요. 표면 압력을 켜고 완전잠김의 부력과 위·아래 압력을 읽으세요.',config:config({bodyMassKg:1.2,mode:'held',heldBottomM:.06}),pressures:true},
      {action:'물체 아랫면 높이만 1.5 cm로 낮추세요. 표면 압력을 유지하고 두 면의 압력과 부력을 다시 확인하세요.',config:config({bodyMassKg:1.2,mode:'held',heldBottomM:.015}),pressures:true}],
    result:'더 깊이 내리면 위·아래 압력이 함께 증가합니다. 하지만 압력차는 같아 부력은 약 9.81 N, 위로 당기는 고정장치 힘은 약 1.96 N으로 유지됩니다.' }
};
export function createGuide(id){if(!Object.hasOwn(LESSONS,id))throw new RangeError('알 수 없는 안내 실험입니다.');return{id,stage:0,status:'active',evidence:[]};}
export function lessonReady(guide,experiment,view){
  if(!guide||guide.status!=='active')return false;
  const step=LESSONS[guide.id]?.steps[guide.stage];if(!step)return false;
  const keys=['bodyMassKg','bodyVolumeM3','fluidDensityKgM3','mode'];if(step.config.mode==='held')keys.push('heldBottomM');
  return keys.every(key=>typeof step.config[key]==='number'?Math.abs(experiment.config[key]-step.config[key])<=1e-9*Math.max(1,Math.abs(step.config[key])):experiment.config[key]===step.config[key])&&(step.pressures===undefined||view?.pressures===step.pressures);
}
export function confirmObservation(guide,experiment,view){
  if(!lessonReady(guide,experiment,view))return false;
  const s=getSnapshot(experiment);guide.evidence.push({experiment:structuredClone(experiment),submergedFraction:s.submergedFraction,waterLevelM:s.waterLevelM,buoyancyN:s.buoyancyN,weightN:s.weightN,holdingForceYN:s.holdingForceYN,bottomGaugePressurePa:s.bottomGaugePressurePa,topGaugePressurePa:s.topGaugePressurePa,pressuresVisible:Boolean(view.pressures)});
  guide.stage++;if(guide.stage===LESSONS[guide.id].steps.length)guide.status='completed';return true;
}
export function guideText(guide){const lesson=LESSONS[guide.id];return{action:guide.status==='completed'?'관찰을 마쳤습니다. 조건을 더 바꿔 자유롭게 실험하세요.':lesson.steps[guide.stage].action,result:guide.status==='completed'?lesson.result:'',total:lesson.steps.length};}
