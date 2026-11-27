import './style.css';
import { DEFAULT_CONFIG, CONSTANTS_SI, CONFIG_LIMITS_SI, normalizeConfig, createExperiment, getSnapshot } from './model.js';
import { createProject, parseProject, serializeProject, normalizeView, DEFAULT_VIEW } from './project.js';
import { createBrowserAutosave, supportsAutosaveLock, withAutosaveLock, writeIfUnchanged, readTabDraft, writeTabDraft, clearTabDraft } from './browser-autosave.js';
import { COMPONENTS, GEOMETRY_SI } from './geometry.js';
import { BuoyancyScene } from './scene.js';
import { BuoyancyChart } from './chart.js';
import { buoyancyDetail } from './detail-model.js';
import { BuoyancyDetailPanel } from './detail-panel.js';
import './detail-panel.css';
import { LESSONS, createGuide, lessonReady, confirmObservation, guideText } from './lessons.js';

const $=q=>document.querySelector(q), $$=q=>[...document.querySelectorAll(q)], copy=v=>structuredClone(v);
const text=(q,v)=>{const node=$(q);if(node.textContent!==v)node.textContent=v;};
const fmt=(n,d=2)=>(Math.abs(n)<.5*10**-d?0:n).toLocaleString('ko-KR',{minimumFractionDigits:d,maximumFractionDigits:d});
const conditionValue=(key,config)=>config[key]??CONSTANTS_SI[key];
function name({config}) {
  const fillL=conditionValue('fluidVolumeM3',config)*1000, gravity=conditionValue('gravityMps2',config);
  return `${fmt(config.bodyMassKg)} kg · ${fmt(config.bodyVolumeM3*1000)} L · ${fmt(config.fluidDensityKgM3,0)} kg/m³ · 액체 ${fmt(fillL,3)} L · g ${fmt(gravity,5)} m/s²`;
}
const KEY='buoyancy-lab-project-v1', desktop=window.buoyancyDesktop;
let experiment=createExperiment(),view=normalizeView(DEFAULT_VIEW),comparison=null,scene=null,initialCamera=null,snapshot;
let guide=null,previous=null,busy=false,restoring=false,chartDisplay='both',saveTimer,toastTimer,recoveredRaw=null,storageBlocked=false;
const chart=new BuoyancyChart($('#force-chart'),$('#immersion-chart'));
const inspectionParts=new Set(['holding-frame','holding-carriage','holding-link','test-body','submerged-volume','free-surface','pressure-bottom','pressure-top']);
const detailPanel=new BuoyancyDetailPanel($('#buoyancy-details'),$('#part-facts'),$('#part-detail-note'),{onInspect:beginInspection});
function selectPart(id){if(busy){syncControls();return;}if(!COMPONENTS.some(part=>part.id===id))throw new RangeError('Unknown buoyancy component');view.selectedPart=id;if(scene?.getInspection?.()){if(inspectionParts.has(id))scene.beginInspection(id);else scene.endInspection();}syncControls();refresh();scheduleSave();}
function beginInspection(id=view.selectedPart){if(busy||!inspectionParts.has(id)||!scene?.beginInspection?.(id))return false;view.selectedPart=id;syncControls();refresh();$('#toast').hidden=true;requestAnimationFrame(()=>$('.observation').scrollIntoView({block:'start'}));scheduleSave();return true;}
function endInspection(){scene?.endInspection?.();refresh();scheduleSave();}
function toast(message){clearTimeout(toastTimer);const close=Object.assign(document.createElement('button'),{textContent:'닫기',type:'button'});close.onclick=()=>{$('#toast').hidden=true;};$('#toast').replaceChildren(Object.assign(document.createElement('span'),{textContent:message}),close);$('#toast').hidden=false;toastTimer=setTimeout(()=>{$('#toast').hidden=true;},6500);}
function capture(){return createProject({experiment,comparison,view,camera:scene?.getProjectCameraState?.()??scene?.getCameraState()??initialCamera});}
let lastStoredRaw = null, browserAutosave = null, guardArmed = false;
let resumedTabDraft = false, interruptedTabDraft = null, tabDraftProtected = false;
const draftStorage = () => sessionStorage;
const getBrowserLocks = () => { try { return navigator.locks; } catch { return undefined; } };
const currentProjectText = () => serializeProject(capture());
const autosaveIssues = {
  conflict: ['다른 탭에서 저장한 실험을 보호했어요.', '이 탭의 변경은 자동 저장하지 않습니다. 아래에서 이 탭의 실험을 내려받고, 최신에 저장된 실험을 보려면 새로고침하세요.', '다른 탭에서 자동 저장이 변경됨 · 이 탭의 실험은 파일로 보관하세요'],
  unavailable: ['이 환경에서는 안전한 자동 저장을 사용할 수 없어요.', '기존 자동 저장 기록을 덮어쓰지 않습니다. 변경한 실험은 아래에서 파일로 내려받으세요.', '안전한 자동 저장을 사용할 수 없음 · 파일로 보관하세요'],
  failed: ['자동 저장을 완료하지 못했어요.', '현재 실험을 잃지 않으려면 아래에서 파일로 내려받으세요.', '자동 저장을 완료하지 못했습니다 · 파일로 보관하세요'],
};
function rememberBrowserDraft() {
  try {
    const draft = browserAutosave.unsavedDraft();
    // This is private to the current tab and survives a reload, not a safe
    // replacement for a project file if the tab/browser is closed.
    if (draft && !restoring && !tabDraftProtected) writeTabDraft(draftStorage, KEY, draft);
    return Boolean(draft);
  } catch { return true; }
}
function warnOnUnsavedExit(event) {
  if (!rememberBrowserDraft()) return;
  event.preventDefault();
  event.returnValue = true;
}
function armUnloadGuard() {
  if (desktop || !browserAutosave || guardArmed) return;
  guardArmed = true;
  window.addEventListener('beforeunload', warnOnUnsavedExit);
}
function disarmUnloadGuard() {
  guardArmed = false;
  window.removeEventListener('beforeunload', warnOnUnsavedExit);
}
function reportAutosave(status, contents) {
  if (status === 'saved' || status === 'unchanged') {
    if (!desktop && !tabDraftProtected) clearTabDraft(draftStorage, KEY, contents);
    disarmUnloadGuard();
    $('#autosave-recovery').hidden = true;
    text('#save-status', status === 'saved' ? '이 기기에 자동 저장됨' : '자동 저장할 변경 없음');
    return;
  }
  const [title, hint, footer] = autosaveIssues[status];
  text('#autosave-title', title); text('#autosave-hint', hint); text('#save-status', footer);
  $('#autosave-recovery').hidden = false;
}
function saveLocal() {
  clearTimeout(saveTimer);
  if (restoring) return;
  if (!desktop) {
    armUnloadGuard();
    if (!storageBlocked && browserAutosave?.canSave()) {
      text('#save-status', '자동 저장 확인 중');
      void browserAutosave.flush();
    }
    return;
  }
  if (storageBlocked) return;
  try {
    const contents = currentProjectText();
    // The installed app uses its existing single-instance, synchronous path.
    if (!writeIfUnchanged(localStorage, KEY, lastStoredRaw, contents)) {
      storageBlocked = true;
      reportAutosave('conflict');
      return;
    }
    lastStoredRaw = contents;
    reportAutosave('saved');
  } catch { reportAutosave('failed'); }
}
function scheduleSave() {
  if (restoring) return;
  armUnloadGuard();
  if (storageBlocked || (!desktop && !browserAutosave?.canSave())) return;
  if (!desktop) text('#save-status', '자동 저장 확인 중');
  clearTimeout(saveTimer); saveTimer = setTimeout(saveLocal, 230);
}
function flushBrowserOnHide() {
  if (!guardArmed || restoring || !browserAutosave) return;
  rememberBrowserDraft();
  if (!storageBlocked && browserAutosave.canSave()) {
    clearTimeout(saveTimer);
    void browserAutosave.flush();
  }
}
function protectOriginal(raw, future) {
  storageBlocked = true; recoveredRaw = raw;
  const backup = () => {
    const prefix = `${KEY}-original-`;
    const backedUp = Object.keys(localStorage).some(k => k.startsWith(prefix) && localStorage.getItem(k) === raw);
    if (!backedUp) localStorage.setItem(`${prefix}${Date.now()}`, raw);
  };
  // Recovery remains available from the primary record and in memory, even
  // when backup storage is full or browser coordination is unavailable.
  if (desktop) { try { backup(); } catch { /* Keep the original. */ } }
  else {
    const locks = getBrowserLocks();
    if (supportsAutosaveLock(locks)) void withAutosaveLock(locks, KEY, backup).catch(() => {});
  }
  $('#storage-recovery').hidden = false;
  if (future) text('#storage-recovery strong', '더 새로운 버전의 실험입니다. 원문을 보존합니다.');
  text('#save-status', '자동 저장 원문 보호 중 · 현재 실험은 파일로 보관하세요');
}
function applyRestoredProject(saved) {
  ({experiment,comparison} = saved);
  ({view,camera:initialCamera} = saved.observation);
}
try {
  const raw = localStorage.getItem(KEY); lastStoredRaw = raw;
  if (raw !== null) try {
    applyRestoredProject(parseProject(raw));
  } catch (error) { protectOriginal(raw, error.futureVersion); }
} catch { storageBlocked = true; reportAutosave('unavailable'); }
function restoreTabDraft() {
  if (desktop) return;
  // Even if a new tab inherited sessionStorage from an opener, it must not
  // silently reapply that draft to the shared experiment.
  const reloading = performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload';
  const draft = readTabDraft(draftStorage, KEY);
  if (!draft) return;
  if (draft.contents === lastStoredRaw) {
    clearTabDraft(draftStorage, KEY, draft.contents);
    return;
  }
  try {
    const saved = parseProject(draft.contents);
    if (reloading && !draft.interrupted && !storageBlocked && draft.expected === lastStoredRaw
        && supportsAutosaveLock(getBrowserLocks())) {
      applyRestoredProject(saved);
      resumedTabDraft = true;
    } else {
      // The latest shared version remains the active experiment. Hold the old
      // tab draft apart, even if the primary value later returns to old bytes.
      interruptedTabDraft = draft.contents;
      tabDraftProtected = true;
      writeTabDraft(draftStorage, KEY, { ...draft, interrupted: true });
      $('#tab-draft-recovery').hidden = false;
    }
  } catch { clearTabDraft(draftStorage, KEY, draft.contents); }
}
restoreTabDraft();
snapshot=getSnapshot(experiment);
function remember(){previous={project:capture(),guide:copy(guide)};$('#undo-new').hidden=false;}
function readProject(project,restoredGuide=null){const saved=parseProject(serializeProject(project));scene?.endInspection?.();restoring=true;try{({experiment,comparison}=saved);({view,camera:initialCamera}=saved.observation);guide=restoredGuide;chartDisplay='both';snapshot=getSnapshot(experiment);syncControls();refresh();if(initialCamera)scene?.setCameraState(initialCamera);else scene?.resetCamera();}finally{restoring=false;}saveLocal();}
function changeConfig(patch){if(busy)return;const config=normalizeConfig({...experiment.config,...patch});if(Object.keys(config).every(k=>config[k]===experiment.config[k])){syncControls();return;}experiment=createExperiment(config);snapshot=getSnapshot(experiment);syncControls();refresh();scheduleSave();}
function newExperiment(){if(busy)return;remember();scene?.endInspection?.();experiment=createExperiment(DEFAULT_CONFIG);comparison=null;guide=null;view=normalizeView(DEFAULT_VIEW);chartDisplay='both';snapshot=getSnapshot(experiment);syncControls();refresh();scene?.resetCamera();saveLocal();toast('새 실험을 시작했습니다. 직전 실험은 되돌릴 수 있습니다.');}
function setBusy(value){busy=value;$('#save-project').disabled=value;$('#open-project').disabled=value;if(desktop?.setBusy)Promise.resolve(desktop.setBusy(value)).catch(()=>{});}
// Display factor, range increment and number increment retain the original units.
const fields=[
  ['mass','bodyMassKg',1,.01,.1,'kg'],
  ['volume','bodyVolumeM3',.001,.01,.1,'L'],
  ['density','fluidDensityKgM3',1,1,10,'kg/m³'],
  ['height','heldBottomM',.01,.1,.1,'cm'],
  ['fill','fluidVolumeM3',.001,.1,.1,'L'],
  ['gravity','gravityMps2',1,.01,.1,'m/s²'],
];
const conditionDisplays=new WeakMap();
function syncControls(){
  for(const[id,key,factor,,,unit]of fields){
    const applied=conditionValue(key,experiment.config),value=String(applied/factor);
    for(const selector of [`#${id}`,`#${id}-number`]){
      const input=$(selector);input.step='any';input.value=value;input.setAttribute('aria-valuetext',`${value} ${unit}`);
      // A native range can canonicalize its final decimal even with step=any.
      // Keep that display associated with the exact applied SI value.
      conditionDisplays.set(input,{value:Number(input.value),applied});
    }
  }
  for(const b of $$('[data-mode]'))b.setAttribute('aria-pressed',String(b.dataset.mode===experiment.config.mode));$('#height-control').hidden=experiment.config.mode!=='held';$('#part-select').value=view.selectedPart;for(const input of $$('[data-view]'))input.checked=view[input.dataset.view];for(const b of $$('[data-lesson]'))b.setAttribute('aria-pressed',String(b.dataset.lesson===guide?.id));
}
function poseSummary(s) {
  return s.poseKind === 'held' ? '높이 고정' : s.freeEquilibrium === 'unique' ? '자유부유 평형'
    : s.freeEquilibrium === 'continuum' ? '중성 · 대표 위치' : '평형 없음 · 기준 위치';
}
function stateLabel(){if(snapshot.poseKind==='held')return '높이 고정 · 고정장치가 힘의 균형을 유지합니다';if(snapshot.poseKind==='neutral-reference')return '중성부력 · 여러 높이에서 평형, 현재 그림은 대표 위치';if(snapshot.poseKind==='submerged-reference')return '완전잠김 기준 위치 · 자유부유 평형 없음';return '자유부유 평형 · 무게와 부력이 같아요';}
const signedForce=value=>Math.abs(value)*GEOMETRY_SI.forceWorldPerN<=1e-10?'0.00 N':`${value>0?'위로':'아래로'} ${Math.abs(value)<.01?'<0.01':fmt(Math.abs(value))} N`;
function drawChart(){chart.update(snapshot,comparison?getSnapshot(comparison.experiment):null,chartDisplay);}
function renderGuide(){ $('#lesson-guide').hidden=!guide;if(!guide)return;const info=guideText(guide),ready=lessonReady(guide,experiment,view);text('#guide-title',LESSONS[guide.id].title);text('#guide-progress',guide.status==='completed'?'관찰 완료':`관찰 ${guide.stage+1} / ${info.total}`);text('#guide-action',info.action);text('#guide-result',info.result);$('#guide-next').hidden=guide.status!=='active';$('#guide-next').disabled=!ready;text('#guide-next',ready?'관찰 확인 · 다음으로':'조건을 맞춘 뒤 관찰 확인');$('#guide-evidence').replaceChildren(...guide.evidence.map((s,i)=>Object.assign(document.createElement('li'),{textContent:`${i+1}차 · ${fmt(s.submergedFraction*100,1)}% 잠김 · 부력 ${fmt(s.buoyancyN)} N · 밑면 ${fmt(s.bottomGaugePressurePa,1)} Pa / 윗면 ${fmt(s.topGaugePressurePa,1)} Pa`})) );}
function refresh(){
  $('#focus-forces').disabled=!view.forces;$('#focus-forces-hint').hidden=view.forces;
  text('#immersion',`${fmt(snapshot.submergedFraction*100,1)}%`);text('#buoyancy',`${fmt(snapshot.buoyancyN)} N`);text('#weight',`${fmt(snapshot.weightN)} N`);text('#water-level',`${fmt(snapshot.waterLevelM*100)} cm`);
  text('#condition-immersion',`${fmt(snapshot.submergedFraction*100,1)}% 잠김`);text('#condition-state',poseSummary(snapshot));
  text('#pose-status',stateLabel());$('#pose-status').dataset.state=snapshot.freeEquilibrium;
  text('#mode-description',experiment.config.mode==='held'?'물체 아랫면의 높이를 고정하고 필요한 당김·누름을 계산합니다.':'떠 있을 수 있는 위치를 계산합니다. 중성·평형 없음은 기준 위치로 구별합니다.');
  text('#body-density',`${fmt(snapshot.bodyDensityKgM3,1)} kg/m³`);text('#displaced',`${fmt(snapshot.displacedVolumeM3*1000,3)} L`);text('#holder-force',experiment.config.mode==='held'?signedForce(snapshot.holdingForceYN):'사용하지 않음');text('#free-force',signedForce(snapshot.unrestrainedForceYN));
  text('#bottom-pressure',`${fmt(snapshot.bottomGaugePressurePa,1)} Pa`);text('#top-pressure',`${fmt(snapshot.topGaugePressurePa,1)} Pa`);
  text('#empty-water-level',`${fmt(snapshot.emptyWaterLevelM*100)} cm`);
  text('#fluid-total',`${fmt(snapshot.fluidVolumeM3*1000,3)} L`);
  text('#part-description',COMPONENTS.find(p=>p.id===view.selectedPart)?.description??'요소를 선택하세요.');$('#comparison-panel').hidden=!comparison;
  detailPanel.render(snapshot,view.selectedPart);
  const inspection=scene?.getInspection?.()??null;$('#inspection-strip').hidden=!inspection;text('#inspection-note',inspection?.note??'');if(inspection)$('#inspection-select').value=inspection.id;
  $('#inspect-part').disabled=!inspectionParts.has(view.selectedPart);$('#inspect-part').setAttribute('aria-pressed',String(Boolean(inspection)));text('#inspect-part',inspection?'상세 관찰 마치기':'구조·압력 자세히');
  if(comparison)text('#comparison-summary',`현재 ${name(experiment)} / 보관 ${name(comparison.experiment)} · ${poseSummary(getSnapshot(comparison.experiment))}`);
  for(const b of $$('[data-chart-mode]'))b.setAttribute('aria-pressed',String(b.dataset.chartMode===chartDisplay));drawChart();renderGuide();scene?.update(snapshot,view);
}
function startLesson(id){if(busy||!Object.hasOwn(LESSONS,id))return;remember();scene?.endInspection?.();experiment=createExperiment(LESSONS[id].config);guide=createGuide(id);comparison=null;view=normalizeView(DEFAULT_VIEW);chartDisplay='both';snapshot=getSnapshot(experiment);syncControls();refresh();scene?.resetCamera();saveLocal();$('#lesson-guide').scrollIntoView({block:'nearest'});}
function download(contents,filename,mime='application/json;charset=utf-8'){const url=URL.createObjectURL(new Blob([contents],{type:mime}));Object.assign(document.createElement('a'),{href:url,download:filename}).click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function projectFilename(suffix = '') {
  return `buoyancy-lab-${new Date().toISOString().slice(0,10)}${suffix}.buoyancy.json`;
}
function downloadBrowserProject(contents, filename) {
  download(contents, filename);
  // The browser owns the download prompt; this records the snapshot offered
  // to it, not a guarantee that the user kept the file.
  browserAutosave.markExported(contents);
  if (!tabDraftProtected) clearTabDraft(draftStorage, KEY);
  disarmUnloadGuard();
}
function exportInterruptedTabDraft() {
  if (busy || interruptedTabDraft === null) return;
  try {
    download(interruptedTabDraft, projectFilename('-interrupted'));
    if (tabDraftProtected) clearTabDraft(draftStorage, KEY, interruptedTabDraft);
    tabDraftProtected = false;
    toast('내려받은 복구 사본을 확인하세요.');
  } catch (error) { toast(`내려받지 못했습니다. ${error.message}`); }
}
function exportUnsavedProject() {
  if (busy) return;
  if (desktop) { void saveFile(); return; }
  try {
    downloadBrowserProject(currentProjectText(), projectFilename('-recovered'));
    toast('내려받은 실험 파일을 확인한 뒤 새로고침하세요.');
  } catch (error) { toast(`내려받지 못했습니다. ${error.message}`); }
}
async function saveFile(){if(busy)return;setBusy(true);try{const contents=currentProjectText(),filename=projectFilename();if(desktop){const r=await desktop.saveProject({contents,name:filename});if(r.canceled){toast('저장을 취소했습니다. 현재 실험은 유지합니다.');return;}}else downloadBrowserProject(contents,filename);saveLocal();toast('실험 조건, 비교, 관찰 시점과 표시 선택을 저장했습니다.');}catch(error){toast(`저장하지 못했습니다. ${error.message}`);}finally{setBusy(false);}}
async function openFile(){if(busy)return;if(!desktop){$('#project-file').click();return;}setBusy(true);try{const r=await desktop.openProject();if(r.canceled){toast('열기를 취소했습니다. 현재 실험은 유지합니다.');return;}const p=parseProject(r.content);remember();readProject(p);toast('저장한 부력 실험을 복원했습니다.');}catch(error){toast(`열지 못했습니다. ${error.message}`);}finally{setBusy(false);}}
function toggleFocus(){document.body.classList.toggle('focus-mode');text('#focus',document.body.classList.contains('focus-mode')?'실험 화면으로':'3D 크게 보기');$('.observation').scrollIntoView({block:'start'});}
function help(){$('#help-dialog').showModal();}
$('#part-select').replaceChildren(...COMPONENTS.map(p=>Object.assign(document.createElement('option'),{value:p.id,textContent:p.label})));
$('#inspection-select').replaceChildren(...COMPONENTS.filter(part=>inspectionParts.has(part.id)).map(part=>Object.assign(document.createElement('option'),{value:part.id,textContent:part.label})));
try{scene=new BuoyancyScene($('#scene'),{onSelect:selectPart,onCameraChange:scheduleSave});if(initialCamera)scene.setCameraState(initialCamera);}catch(error){$('#scene-error').hidden=false;text('#scene-error',`3D 화면을 시작하지 못했습니다. ${error.message}`);}
text('#force-scale',`힘 화살표 1 N당 ${fmt(GEOMETRY_SI.forceWorldPerN*1000,0)} mm`);
syncControls();refresh();if(!initialCamera)scene?.resetCamera();
if (!desktop) {
  browserAutosave = createBrowserAutosave({
    key: KEY, storage: () => localStorage, locks: getBrowserLocks(), expected: lastStoredRaw,
    baseline: resumedTabDraft ? null : currentProjectText(), capture: currentProjectText, onStatus: reportAutosave,
  });
  if (!storageBlocked && !browserAutosave.canSave()) reportAutosave('unavailable');
  else if (resumedTabDraft) saveLocal();
}
for(const[id,key,factor,rangeStep,numberStep]of fields){
  const apply=event=>{
    const input=event.target,value=Number(input.value),displayed=conditionDisplays.get(input),current=conditionValue(key,experiment.config);
    // Merely leaving an unchanged L/cm field must not round-trip and alter SI.
    if(busy||!input.value.trim()||!Number.isFinite(value)||value===current/factor
      ||(displayed?.applied===current&&value===displayed.value)){syncControls();return;}
    changeConfig({[key]:value*factor});
  };
  for(const selector of [`#${id}`,`#${id}-number`]){
    const input=$(selector),range=input.type==='range';
    for(const event of range?['input']:['change','blur'])input.addEventListener(event,apply);
    input.addEventListener('keydown',event=>{
      if(event.altKey||event.ctrlKey||event.metaKey)return;
      const directions=range?{ArrowLeft:-1,ArrowDown:-1,ArrowRight:1,ArrowUp:1,PageDown:-10,PageUp:10}
        :{ArrowDown:-1,ArrowUp:1,PageDown:-10,PageUp:10};
      if(!(event.key in directions)&&!(range&&['Home','End'].includes(event.key)))return;
      event.preventDefault();if(busy){syncControls();return;}
      const value=Number(input.value),current=conditionValue(key,experiment.config),displayed=conditionDisplays.get(input);
      const unchanged=value===current/factor||(displayed?.applied===current&&value===displayed.value);
      const base=input.value.trim()&&Number.isFinite(value)&&!unchanged?value*factor:current;
      const {min,max}=CONFIG_LIMITS_SI[key];
      const next=event.key==='Home'?min:event.key==='End'?max
        :Math.max(min,Math.min(max,base+directions[event.key]*(range?rangeStep:numberStep)*(event.shiftKey?.1:1)*factor));
      changeConfig({[key]:next});
    });
  }
}
for(const b of $$('[data-mode]'))b.addEventListener('click',()=>changeConfig({mode:b.dataset.mode}));
for(const input of $$('[data-view]'))input.addEventListener('change',()=>{if(busy){syncControls();return;}view[input.dataset.view]=input.checked;refresh();scheduleSave();});
for(const b of $$('[data-camera]'))b.addEventListener('click',()=>{scene?.endInspection?.();scene?.resetCamera(b.dataset.camera);refresh();});
$('#part-select').addEventListener('change',event=>selectPart(event.target.value));
$('#focus-part').addEventListener('click',()=>{scene?.endInspection?.();scene?.focusPart(view.selectedPart);refresh();$('#toast').hidden=true;$('.observation').scrollIntoView({block:'start'});});$('#focus').addEventListener('click',toggleFocus);
$('#focus-forces').addEventListener('click',()=>{if(busy||!view.forces)return;scene?.endInspection?.();scene?.focusForces();refresh();$('#toast').hidden=true;$('.observation').scrollIntoView({block:'start'});});
$('#inspect-part').addEventListener('click',()=>scene?.getInspection?.()?endInspection():beginInspection());$('#end-inspection').addEventListener('click',endInspection);$('#inspection-select').addEventListener('change',event=>beginInspection(event.target.value));
for(const b of $$('[data-lesson]'))b.addEventListener('click',()=>startLesson(b.dataset.lesson));
$('#guide-next').addEventListener('click',()=>{if(!busy&&confirmObservation(guide,experiment,view))refresh();});$('#guide-restart').addEventListener('click',()=>{if(guide)startLesson(guide.id);});$('#guide-exit').addEventListener('click',()=>{guide=null;syncControls();refresh();});
$('#pin-comparison').addEventListener('click',()=>{if(busy)return;comparison={label:name(experiment),experiment:copy(experiment)};chartDisplay='both';refresh();scheduleSave();});$('#clear-comparison').addEventListener('click',()=>{if(busy)return;comparison=null;chartDisplay='both';refresh();scheduleSave();});
for(const b of $$('[data-chart-mode]'))b.addEventListener('click',()=>{chartDisplay=b.dataset.chartMode;drawChart();for(const button of $$('[data-chart-mode]'))button.setAttribute('aria-pressed',String(button.dataset.chartMode===chartDisplay));});
$('#new-project').addEventListener('click',newExperiment);$('#undo-new').addEventListener('click',()=>{if(!previous||busy)return;const before=previous;previous=null;readProject(before.project,before.guide);$('#undo-new').hidden=true;toast('직전 실험을 복원했습니다.');});
$('#export-unsaved-project').addEventListener('click', exportUnsavedProject);
$('#export-interrupted-draft').addEventListener('click', exportInterruptedTabDraft);
$('#save-project').addEventListener('click',saveFile);$('#open-project').addEventListener('click',openFile);$('#project-file').addEventListener('change',async event=>{const file=event.target.files?.[0];if(!file||busy)return;setBusy(true);try{if(file.size>10*1024*1024)throw new Error('실험 파일은 10 MiB 이하여야 합니다.');const p=parseProject(await file.text());remember();readProject(p);toast('저장한 부력 실험을 복원했습니다.');}catch(error){toast(`열지 못했습니다. ${error.message}`);}finally{event.target.value='';setBusy(false);}});
$('#recover-original').addEventListener('click',()=>{if(recoveredRaw!==null)download(recoveredRaw,'buoyancy-lab-original.txt','text/plain;charset=utf-8');});$('#help').addEventListener('click',help);$('#close-help').addEventListener('click',()=>$('#help-dialog').close());
desktop?.onCommand(command=>{if(busy)return;const actions={'new-project':newExperiment,'open-project':openFile,'save-project':saveFile,focus:toggleFocus,help,'set-equilibrium':()=>changeConfig({mode:'equilibrium'}),'set-held':()=>changeConfig({mode:'held'})};actions[command]?.();});
if (desktop) window.addEventListener('beforeunload', saveLocal);
else {
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushBrowserOnHide(); });
  window.addEventListener('pagehide', flushBrowserOnHide);
}
new ResizeObserver(drawChart).observe($('#force-chart'));
window.buoyancyLab={getState:()=>copy({experiment,snapshot,view,comparison}),project:()=>copy(capture()),loadProject:raw=>{const p=parseProject(raw);remember();readProject(p);return copy(capture());},sceneDebug:()=>scene?.getDebug()??null,guide:()=>copy(guide),chartDebug:()=>copy(chart.debug),getDetail:()=>buoyancyDetail(snapshot),getInspection:()=>scene?.getInspection?.()??null,beginInspection,endInspection};
window.render_game_to_text=()=>JSON.stringify({mode:'static',coordinateSystem:'SI metres; +x right, +y up from tank floor, +z front; force arrows .003m/N; no physical clock',snapshot,selectedPart:view.selectedPart,inspection:scene?.getInspection?.()??null,comparison:Boolean(comparison)});
window.advanceTime=milliseconds=>{if(!Number.isFinite(milliseconds)||milliseconds<0)throw new RangeError('Expected nonnegative milliseconds');return copy(snapshot);};
