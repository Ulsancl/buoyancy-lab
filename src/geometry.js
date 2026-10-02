import { CONSTANTS_SI as C } from './model.js';

export const COMPONENTS = Object.freeze([
  ['tank-shell','유리 수조','벽과 바닥이 액체를 담습니다. 앞벽 절개는 관찰용 표시이며 액체의 양을 바꾸지 않습니다.'],
  ['fluid-volume','일정 체적의 액체','액체 38.5 L는 일정합니다. 물체가 밀어낸 부피만큼 자유수면이 올라갑니다.'],
  ['test-body','시험 물체','가로와 깊이는 각각 10 cm입니다. 체적을 바꾸면 실제 높이가 변하고, 평균 밀도는 질량을 체적으로 나눈 값입니다.'],
  ['submerged-volume','잠긴 부분','물체 중 현재 수면 아래에 있는 부분입니다. 이 체적이 배제한 액체의 체적과 같습니다.'],
  ['free-surface','현재 수면','작은 유한 수조의 실제 수면입니다. 액체가 없는 가상의 무한 수조처럼 높이를 고정하지 않습니다.'],
  ['holding-frame','고정장치 프레임','액체 밖의 금속 프레임이 높이 고정장치를 지지합니다. 자유부유 모드에서는 물체에 고정 힘을 가하지 않습니다.'],
  ['holding-carriage','높이 설정 장치','높이 고정 모드에서 필요한 당김 또는 누름을 받는 장치입니다. 위치 조절은 조건 카드에서 합니다.'],
  ['holding-link','이상적 강체 연결','곧은 점선은 무체적 강체 구속의 기호입니다. 위로 당기거나 아래로 누를 수 있으며 실제 굵기의 잠수봉이나 로프가 아닙니다.'],
  ['force-buoyancy','부력','물체의 잠긴 체적이 배제한 액체의 무게만큼 위로 작용합니다. 표면 압력의 합력입니다.'],
  ['force-weight','무게','물체 질량과 고정 중력가속도의 곱이며 아래로 작용합니다. 질량 kg과 힘 N을 구분합니다.'],
  ['force-holder','고정장치 힘','높이 고정 모드에서만 작용합니다. 양수는 위로 당김, 음수는 아래로 누름이며 로프의 음수 장력이 아닙니다.'],
  ['pressure-bottom','밑면 압력','대기압을 뺀 밑면의 압력입니다. 액체 깊이가 깊을수록 커지고 밑면에는 위쪽 힘을 만듭니다.'],
  ['pressure-top','윗면 압력','액체에 잠긴 윗면의 압력은 아래쪽 힘을 만듭니다. 공기 중인 윗면의 게이지 압력은 0 Pa입니다.'],
  ['level-scale','높이 눈금','수조 바닥이 0 cm입니다. 점선 기준은 물체가 없을 때의 22 cm 수면이며 현재 수면과 구분합니다.'],
].map(([id,label,description])=>Object.freeze({id,label,name:label,description})));

export const DEFAULT_VIEW = Object.freeze({cutaway:true,forces:true,pressures:false,labels:true,selectedPart:'test-body'});
export const GEOMETRY_SI = Object.freeze({
  wallThicknessM:.006, floorThicknessM:.009, baseWidthM:.62, baseDepthM:.47,
  frameHeightM:.615, framePostXM:.294, frameBackZM:-.218,
  holdingAnchorM:Object.freeze([0,.554,0]),
  forceWorldPerN:.003, forceColumnXM:.093,
  pressureMaxPa:3000, cameraMinDistanceM:.08, cameraMaxDistanceM:40,
});
// Representative external fixture dimensions. These do not add displaced
// volume, a compliance law, screw travel, or a second force model.
export const APPARATUS_SI = Object.freeze({
  railCenterM:Object.freeze([0,.604,-.218]),railSizeM:Object.freeze([.604,.024,.027]),
  sleeveSizeM:Object.freeze([.070,.045,.043]),guideClearanceM:.0003,
  clampBoreRadiusM:.0034,screwRadiusM:.0028,padRadiusM:.0055,padThicknessM:.001,padPocketRadiusM:.0058,padPocketDepthM:.001,
  knobRadiusM:.019,knobLengthM:.014,knobCenterZM:-.180,
  deckThicknessM:.007,baseThicknessM:.035,footHeightM:.020,
});
export function getApparatusGeometry() {
  const a=APPARATUS_SI,[x,y,z]=a.railCenterM,[L,H,D]=a.railSizeM,[w,h,d]=a.sleeveSizeM,c=a.guideClearanceM;
  const rail={min:[x-L/2,y-H/2,z-D/2],max:[x+L/2,y+H/2,z+D/2]};
  const sleeve={min:[x-w/2,y-h/2,z-d/2],max:[x+w/2,y+h/2,z+d/2]};
  const passage={min:[-w/2,rail.min[1]-c,rail.min[2]-c],max:[w/2,rail.max[1]+c,rail.max[2]+c]};
  const walls={
    lower:{min:[...sleeve.min],max:[w/2,passage.min[1],sleeve.max[2]]},
    upper:{min:[-w/2,passage.max[1],sleeve.min[2]],max:[...sleeve.max]},
    rear:{min:[-w/2,passage.min[1],sleeve.min[2]],max:[w/2,passage.max[1],passage.min[2]]},
    front:{min:[-w/2,passage.min[1],passage.max[2]],max:[w/2,passage.max[1],sleeve.max[2]]},
  };
  const armTop=sleeve.min[1],floorBottom=-GEOMETRY_SI.floorThicknessM,deckBottom=floorBottom-a.deckThicknessM,baseBottom=deckBottom-a.baseThicknessM;
  return {rail,sleeve,passage,walls,
    arm:{min:[-.011,armTop-.016,-.2145],max:[.011,armTop,-.0195]},
    head:{min:[-.0205,.5535,-.0195],max:[.0205,.5785,.0195]},
    pad:{center:[0,y,rail.max[2]+a.padThicknessM/2],backZM:rail.max[2],frontZM:rail.max[2]+a.padThicknessM},
    screw:{center:[0,y,(rail.max[2]+a.padThicknessM+a.knobCenterZM-a.knobLengthM/2)/2],minZM:rail.max[2]+a.padThicknessM,maxZM:a.knobCenterZM-a.knobLengthM/2},
    floor:{min:[-.25,floorBottom,-.175],max:[.25,0,.175]},
    deck:{min:[-.31,deckBottom,-.235],max:[.31,floorBottom,.235]},
    base:{min:[-.31,baseBottom,-.235],max:[.31,deckBottom,.235]},
    footTopM:baseBottom,footBottomM:baseBottom-a.footHeightM,groundYM:baseBottom-a.footHeightM,
    framePadBottomM:floorBottom,
  };
}
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const box=(min,max)=>({min,max});
const volume=shape=>shape.max.reduce((product,value,i)=>product*(value-shape.min[i]),1);
function validateSnapshot(s) {
  if(!s||!['bodyBottomM','bodyTopM','bodyHeightM','waterLevelM','submergedHeightM'].every(key=>finite(s[key])))throw new TypeError('Finite snapshot dimensions required');
  if(s.bodyBottomM<C.minBottomM-1e-12||s.bodyTopM<s.bodyBottomM||s.bodyHeightM<=0||s.waterLevelM<0||s.waterLevelM>C.tankHeightM||s.submergedHeightM<0||s.submergedHeightM>s.bodyHeightM+1e-12)throw new RangeError('Invalid body/liquid dimensions');
}
export function getBodyGeometry(snapshot) {
  validateSnapshot(snapshot);
  const x=C.bodyWidthM/2,z=C.bodyDepthM/2,y=snapshot.bodyBottomM,top=snapshot.bodyTopM;
  return {
    body:box([-x,y,-z],[x,top,z]),
    submerged:snapshot.submergedHeightM>0?box([-x,y,-z],[x,y+snapshot.submergedHeightM,z]):null,
  };
}
export function getFluidBoxes(snapshot) {
  validateSnapshot(snapshot);
  const X=C.tankWidthM/2,Z=C.tankDepthM/2,x=C.bodyWidthM/2,z=C.bodyDepthM/2,H=snapshot.waterLevelM;
  const beneath=Math.min(H,snapshot.bodyBottomM),above=Math.min(H,snapshot.bodyTopM);
  return [box([-X,0,-Z],[-x,H,Z]),box([x,0,-Z],[X,H,Z]),box([-x,0,-Z],[x,H,-z]),box([-x,0,z],[x,H,Z]),box([-x,0,-z],[x,beneath,z]),box([-x,above,-z],[x,H,z])].filter(shape=>volume(shape)>0);
}

// The union surface omits all internal partition faces. Rendering six closed
// transparent boxes would otherwise create false dark seams inside the water.
export function surfaceFromBoxes(boxes) {
  if(!Array.isArray(boxes))throw new TypeError('AABB array required');
  for(const b of boxes)if(!b||!['min','max'].every(key=>Array.isArray(b[key])&&b[key].length===3&&b[key].every(finite))||b.max.some((value,i)=>value<=b.min[i]))throw new RangeError('Positive finite AABB required');
  if(!boxes.length)return {positions:[],normals:[]};
  const axes=[0,1,2].map(axis=>[...new Set(boxes.flatMap(b=>[b.min[axis],b.max[axis]]))].sort((a,b)=>a-b));
  const [xs,ys,zs]=axes, occupied=new Set(),key=(x,y,z)=>`${x}/${y}/${z}`;
  for(let i=0;i<xs.length-1;i++)for(let j=0;j<ys.length-1;j++)for(let k=0;k<zs.length-1;k++){
    const center=[(xs[i]+xs[i+1])/2,(ys[j]+ys[j+1])/2,(zs[k]+zs[k+1])/2];
    if(boxes.some(b=>center.every((value,a)=>value>b.min[a]&&value<b.max[a])))occupied.add(key(i,j,k));
  }
  const positions=[],normals=[];
  const quad=(a,b,c,d,n)=>{positions.push(...a,...b,...c,...a,...c,...d);for(let q=0;q<6;q++)normals.push(...n);};
  for(let i=0;i<xs.length-1;i++)for(let j=0;j<ys.length-1;j++)for(let k=0;k<zs.length-1;k++){
    if(!occupied.has(key(i,j,k)))continue;
    const a=xs[i],b=xs[i+1],c=ys[j],d=ys[j+1],e=zs[k],f=zs[k+1];
    if(!occupied.has(key(i-1,j,k)))quad([a,c,e],[a,c,f],[a,d,f],[a,d,e],[-1,0,0]);
    if(!occupied.has(key(i+1,j,k)))quad([b,c,f],[b,c,e],[b,d,e],[b,d,f],[1,0,0]);
    if(!occupied.has(key(i,j-1,k)))quad([a,c,e],[b,c,e],[b,c,f],[a,c,f],[0,-1,0]);
    if(!occupied.has(key(i,j+1,k)))quad([a,d,f],[b,d,f],[b,d,e],[a,d,e],[0,1,0]);
    if(!occupied.has(key(i,j,k-1)))quad([b,c,e],[a,c,e],[a,d,e],[b,d,e],[0,0,-1]);
    if(!occupied.has(key(i,j,k+1)))quad([a,c,f],[b,c,f],[b,d,f],[a,d,f],[0,0,1]);
  }
  return {positions,normals};
}
