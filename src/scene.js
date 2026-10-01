import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { COMPONENTS, DEFAULT_VIEW, GEOMETRY_SI as G, getBodyGeometry, getFluidBoxes, surfaceFromBoxes } from './geometry.js';
import { CONSTANTS_SI as C } from './model.js';

const V = (x=0,y=0,z=0)=>new THREE.Vector3(x,y,z);
const clean = n=>Object.is(n,-0)?0:n;
const array = vector=>vector.toArray().map(clean);
const partIds = new Set(COMPONENTS.map(p=>p.id));
const copper = 0xc98857, teal = 0x178f94, weightColor = 0xb86d41, holderColor = 0x7656ac;
const forceNames={'force-buoyancy':'부력','force-weight':'무게','force-holder':'고정력'};
const forceZero=force=>Math.abs(force)*G.forceWorldPerN<=1e-10;
const forceMagnitude=force=>Math.abs(force)<.01?'<0.01':Math.abs(force).toFixed(2);
const forceText=(id,force)=>forceZero(force)?`${forceNames[id]} 0.00 N · 방향 없음`:`${force>0?'↑':'↓'} ${forceNames[id]} ${forceMagnitude(force)} N`;
const pressureColor = pa=>new THREE.Color(0x58c8d9).lerp(new THREE.Color(0xe5a13d),Math.max(0,Math.min(1,pa/G.pressureMaxPa)));

function boxGeometry(bounds) {
  return new THREE.BoxGeometry(...bounds.max.map((n,i)=>n-bounds.min[i]));
}
function placeBox(mesh,bounds) {
  mesh.geometry.dispose(); mesh.geometry=boxGeometry(bounds);
  mesh.position.set(...bounds.max.map((n,i)=>(n+bounds.min[i])/2));
}
function line(points,color,width=1,dashed=false) {
  const geometry=new THREE.BufferGeometry().setFromPoints(points.map(p=>Array.isArray(p)?V(...p):p));
  const material=dashed?new THREE.LineDashedMaterial({color,dashSize:.007,gapSize:.004,transparent:true,opacity:.8}):new THREE.LineBasicMaterial({color,linewidth:width,transparent:true,opacity:.85});
  const mesh=new THREE.Line(geometry,material); if(dashed)mesh.computeLineDistances(); return mesh;
}
function setLine(mesh,points) { mesh.geometry.dispose();mesh.geometry=new THREE.BufferGeometry().setFromPoints(points.map(p=>V(...p)));if(mesh.computeLineDistances)mesh.computeLineDistances(); }
function plateTexture(text,{color='#255c60',background='#e9efe6',size=128}={}) {
  const canvas=document.createElement('canvas');canvas.width=size*3;canvas.height=size;
  const context=canvas.getContext('2d');context.fillStyle=background;context.fillRect(0,0,canvas.width,canvas.height);
  context.fillStyle=color;context.font=`600 ${size*.38}px "Segoe UI", sans-serif`;context.textAlign='center';context.textBaseline='middle';context.fillText(text,canvas.width/2,canvas.height/2);
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;return texture;
}
function actualBounds(mesh) { const b=new THREE.Box3().setFromObject(mesh);return {min:array(b.min),max:array(b.max)}; }
function actualVolume(mesh) {
  if(!mesh?.visible)return 0;
  const positions=mesh.geometry.getAttribute('position'),indices=mesh.geometry.index;
  const a=V(),b=V(),c=V(),cross=V();let sum=0;mesh.updateWorldMatrix(true,false);
  for(let i=0;i<(indices?.count??positions.count);i+=3){
    a.fromBufferAttribute(positions,indices?indices.getX(i):i).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(positions,indices?indices.getX(i+1):i+1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(positions,indices?indices.getX(i+2):i+2).applyMatrix4(mesh.matrixWorld);
    sum+=a.dot(cross.crossVectors(b,c))/6;
  }
  return Math.abs(sum);
}
function actualArrowTip(arrow) {
  const positions=arrow.cone.geometry.getAttribute('position');let index=0;
  for(let i=1;i<positions.count;i++)if(positions.getY(i)>positions.getY(index))index=i;
  return V().fromBufferAttribute(positions,index).applyMatrix4(arrow.cone.matrixWorld);
}
function objectVisible(object) { for(let current=object;current;current=current.parent)if(!current.visible)return false;return true; }

/** Static SI apparatus. No integrator, settling animation, or independent force model. */
export class BuoyancyScene {
  constructor(container,{onSelect=()=>{},onCameraChange=()=>{}}={}) {
    this.container=container;this.onSelect=onSelect;this.onCameraChange=onCameraChange;
    this.view={...DEFAULT_VIEW};this.snapshot=null;this.disposed=false;this.suppressCamera=false;this.focusContext=null;this.materials=[];this.labels=new Map();
    this.scene=new THREE.Scene();this.scene.background=new THREE.Color(0xeff3ec);
    this.camera=new THREE.PerspectiveCamera(37,1,.003,160);this.camera.position.set(.85,.70,.96);this.camera.up.set(0,1,0);
    this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.7));this.renderer.outputColorSpace=THREE.SRGBColorSpace;
    this.renderer.toneMapping=THREE.ACESFilmicToneMapping;this.renderer.toneMappingExposure=1.16;
    this.renderer.shadowMap.enabled=true;this.renderer.shadowMap.type=THREE.PCFSoftShadowMap;
    this.renderer.domElement.className='buoyancy-canvas';this.renderer.domElement.setAttribute('aria-label','부력 실험대 3D 관찰. 드래그하여 회전, 휠로 확대할 수 있습니다.');
    container.classList.add('buoyancy-scene');container.appendChild(this.renderer.domElement);
    const pmrem=new THREE.PMREMGenerator(this.renderer),room=new RoomEnvironment();
    this.environment=pmrem.fromScene(room,.035);this.scene.environment=this.environment.texture;room.dispose();pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xffffff,0x94a49d,2.5));
    const key=new THREE.DirectionalLight(0xfff3dd,4.2);key.position.set(-.6,1.4,.9);key.castShadow=true;
    key.shadow.mapSize.set(1536,1536);Object.assign(key.shadow.camera,{left:-.8,right:.8,top:.9,bottom:-.7,near:.1,far:3});key.shadow.bias=-.00015;key.shadow.normalBias=.001;this.scene.add(key);
    const rim=new THREE.DirectionalLight(0xb7e9ec,2.5);rim.position.set(.8,.7,-.7);this.scene.add(rim);
    this.parts=new Map(COMPONENTS.map(p=>{const group=new THREE.Group();group.name=p.id;group.userData.partId=p.id;this.scene.add(group);return [p.id,group];}));
    this.buildApparatus();this.buildObservations();this.buildOverlay();
    this.controls=new OrbitControls(this.camera,this.renderer.domElement);this.controls.target.set(0,.265,0);
    this.controls.enableDamping=false;this.controls.autoRotate=false;this.controls.minDistance=G.cameraMinDistanceM;this.controls.maxDistance=G.cameraMaxDistanceM;
    this.controls.minPolarAngle=0;this.controls.maxPolarAngle=Math.PI;this.controls.enablePan=true;this.controls.screenSpacePanning=true;
    this.controls.update();
    this.controlChange=()=>{
      if(this.suppressCamera||this.disposed)return;
      // A long dolly or pan must still serialize. Translate eye and target by
      // exactly the same amount; preserve their distance and viewing direction.
      for(const axis of ['x','y','z']){
        const minimum=Math.min(this.camera.position[axis],this.controls.target[axis]),maximum=Math.max(this.camera.position[axis],this.controls.target[axis]);
        const shift=maximum>30?30-maximum:minimum< -30?-30-minimum:0;
        this.camera.position[axis]+=shift;this.controls.target[axis]+=shift;
      }
      this.render();this.onCameraChange(this.getCameraState());
    };
    this.controls.addEventListener('change',this.controlChange);
    this.raycaster=new THREE.Raycaster();this.raycaster.params.Line.threshold=.004;
    this.pointerDown=event=>{this.pointerStart={x:event.clientX,y:event.clientY,pointerId:event.pointerId};};
    this.pointerUp=event=>{const start=this.pointerStart;this.pointerStart=null;if(!start||start.pointerId!==event.pointerId||Math.hypot(event.clientX-start.x,event.clientY-start.y)>5)return;this.pick(event);};
    this.pointerCancel=()=>{this.pointerStart=null;};
    this.renderer.domElement.addEventListener('pointerdown',this.pointerDown);this.renderer.domElement.addEventListener('pointerup',this.pointerUp);this.renderer.domElement.addEventListener('pointercancel',this.pointerCancel);
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(container);this.resize();
  }
  material(options) { const m=new THREE.MeshStandardMaterial(options);this.materials.push(m);return m; }
  mesh(part,geometry,material,position=[0,0,0],cast=true) {
    const mesh=new THREE.Mesh(geometry,material);mesh.position.set(...position);mesh.castShadow=cast;mesh.receiveShadow=true;this.parts.get(part).add(mesh);return mesh;
  }
  cuboid(part,size,position,material,cast=true) { return this.mesh(part,new THREE.BoxGeometry(...size),material,position,cast); }
  cylinder(part,radius,length,position,material,axis='y') {
    const mesh=this.mesh(part,new THREE.CylinderGeometry(radius,radius,length,32),material,position);
    if(axis==='x')mesh.rotation.z=Math.PI/2;if(axis==='z')mesh.rotation.x=Math.PI/2;return mesh;
  }
  buildApparatus() {
    const steel=this.material({color:0xb8c6c2,metalness:.87,roughness:.27});
    const brushed=this.material({color:0x7e9494,metalness:.84,roughness:.34});
    const dark=this.material({color:0x324b4b,metalness:.45,roughness:.47});
    const rubber=this.material({color:0x243537,metalness:.03,roughness:.91});
    const ivory=this.material({color:0xe5eade,metalness:.13,roughness:.46});
    const accent=this.material({color:teal,metalness:.36,roughness:.37});
    const glass=new THREE.MeshPhysicalMaterial({color:0xb7e4df,metalness:0,roughness:.10,transparent:true,opacity:.19,depthWrite:false,side:THREE.DoubleSide,clearcoat:1,clearcoatRoughness:.05});this.materials.push(glass);
    this.cuboid('tank-shell',[G.baseWidthM,.035,G.baseDepthM],[0,-.028,0],ivory);
    this.cuboid('tank-shell',[G.baseWidthM,.007,G.baseDepthM],[0,-.007,0],brushed);
    for(const x of [-.262,.262])for(const z of [-.19,.19]){
      this.cylinder('tank-shell',.021,.020,[x,-.055,z],rubber);
      this.cylinder('tank-shell',.013,.012,[x,-.038,z],steel);
      this.cylinder('tank-shell',.004,.003,[x,-.001,z],steel);
    }
    const X=C.tankWidthM/2,Z=C.tankDepthM/2,H=C.tankHeightM,t=G.wallThicknessM;
    this.cuboid('tank-shell',[C.tankWidthM,t,C.tankDepthM],[0,-t/2,0],glass,false);
    this.frontWall=this.cuboid('tank-shell',[C.tankWidthM+2*t,H,t],[0,H/2,Z+t/2],glass,false);
    this.cuboid('tank-shell',[C.tankWidthM+2*t,H,t],[0,H/2,-Z-t/2],glass,false);
    for(const x of [-X-t/2,X+t/2])this.cuboid('tank-shell',[t,H,C.tankDepthM],[x,H/2,0],glass,false);
    for(const x of [-X-t,X+t])for(const z of [-Z-t,Z+t]){
      this.cuboid('tank-shell',[.011,H+.015,.011],[x,H/2,z],steel);
      for(const y of [.013,.483])this.cylinder('tank-shell',.0032,.015,[x,y,z],dark,'z');
    }
    for(const z of [-Z-t,Z+t]){
      this.cuboid('tank-shell',[C.tankWidthM+.027,.008,.012],[0,H+.003,z],brushed);
      this.cuboid('tank-shell',[C.tankWidthM+.027,.009,.012],[0,.003,z],steel);
    }
    for(const x of [-X-t,X+t])this.cuboid('tank-shell',[.012,.008,C.tankDepthM+.02],[x,H+.003,0],brushed);
    this.cutEdges=new THREE.Group();this.parts.get('tank-shell').add(this.cutEdges);
    for(const x of [-X,X])this.cutEdges.add(line([[x,0,Z],[x,H,Z]],0x4d9690));
    const nameMaterial=new THREE.MeshStandardMaterial({map:plateTexture('BUOYANCY / 38.5 L'),roughness:.64,metalness:.08});this.materials.push(nameMaterial);
    const namePlate=this.mesh('tank-shell',new THREE.PlaneGeometry(.17,.022),nameMaterial,[0,-.027,.2356],false);namePlate.rotation.x=0;
    for(const x of [-G.framePostXM,G.framePostXM]){
      this.cuboid('holding-frame',[.025,.025,.067],[x,-.001,G.frameBackZM],dark);
      this.cuboid('holding-frame',[.017,G.frameHeightM,.018],[x,G.frameHeightM/2,G.frameBackZM],steel);
      this.cuboid('holding-frame',[.006,G.frameHeightM-.035,.003],[x,.31,G.frameBackZM+.010],dark);
      for(const y of [.035,.595])this.cylinder('holding-frame',.004,.020,[x,y,G.frameBackZM+.009],dark,'z');
    }
    this.cuboid('holding-frame',[.604,.024,.027],[0,.604,G.frameBackZM],brushed);
    this.cuboid('holding-carriage',[.070,.045,.043],[0,.579,G.frameBackZM+.008],accent);
    this.cuboid('holding-carriage',[.022,.016,.219],[0,.569,-.105],steel);
    this.cuboid('holding-carriage',[.041,.025,.039],[0,.566,0],dark);
    this.cylinder('holding-carriage',.019,.014,[0,.579,G.frameBackZM+.038],dark,'z');
    for(let n=0;n<16;n++){const a=n*Math.PI/8;this.cylinder('holding-carriage',.0018,.015,[Math.cos(a)*.018,.579+Math.sin(a)*.018,G.frameBackZM+.038],steel,'z');}
    this.holdingLink=line([[...G.holdingAnchorM],[0,.3,0]],0x795cb0,1,true);this.parts.get('holding-link').add(this.holdingLink);
    this.linkContact=this.mesh('holding-link',new THREE.SphereGeometry(.0038,16,8),this.material({color:holderColor,metalness:.1,roughness:.4}),[0,.3,0],false);
    const bodyMat=this.material({color:copper,metalness:.72,roughness:.32});
    this.body=this.mesh('test-body',new THREE.BoxGeometry(.1,.1,.1),bodyMat,[0,.2,0]);
    this.bodyEdges=new THREE.LineSegments(new THREE.EdgesGeometry(this.body.geometry),new THREE.LineBasicMaterial({color:0x77492e,transparent:true,opacity:.75}));this.parts.get('test-body').add(this.bodyEdges);
    const wetMat=new THREE.MeshStandardMaterial({color:0x339a98,metalness:.37,roughness:.32,transparent:true,opacity:.28,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1});this.materials.push(wetMat);
    this.submerged=this.mesh('submerged-volume',new THREE.BoxGeometry(.1,.04,.1),wetMat,[0,.2,0],false);
    const waterMat=new THREE.MeshPhysicalMaterial({color:0x41bebd,metalness:.03,roughness:.15,transparent:true,opacity:.17,depthWrite:false,side:THREE.DoubleSide,clearcoat:.6,polygonOffset:true,polygonOffsetFactor:1,polygonOffsetUnits:1});this.materials.push(waterMat);
    this.water=this.mesh('fluid-volume',new THREE.BufferGeometry(),waterMat,[0,0,0],false);this.water.renderOrder=4;this.submerged.renderOrder=2;
    this.waterline=line([[-X,.22,-Z],[X,.22,-Z],[X,.22,Z],[-X,.22,Z],[-X,.22,-Z]],0x188b90);this.parts.get('free-surface').add(this.waterline);
    this.surfaceOpening=line([[-.05,.22,-.05],[.05,.22,-.05],[.05,.22,.05],[-.05,.22,.05],[-.05,.22,-.05]],0x228e89);this.parts.get('free-surface').add(this.surfaceOpening);
    this.cuboid('level-scale',[.030,.505,.004],[.229,.25,.184],ivory,false);
    for(let cm=0;cm<=50;cm++){
      const y=cm/100,major=cm%5===0;
      this.parts.get('level-scale').add(line([[.214,y,.187],[major?.228:.222,y,.187]],major?0x53716f:0x9eafa4));
      if(major){const map=plateTexture(String(cm),{size:48,background:'#e5eade'});const m=new THREE.MeshBasicMaterial({map,transparent:false});this.materials.push(m);this.mesh('level-scale',new THREE.PlaneGeometry(.014,.008),m,[.235,y,.1871],false);}
    }
    this.emptyLevel=line([[-.244,C.emptyWaterLevelM,.182],[.207,C.emptyWaterLevelM,.182]],0x78938f,1,true);this.parts.get('level-scale').add(this.emptyLevel);
    this.levelMarker=this.mesh('level-scale',new THREE.ConeGeometry(.006,.014,3),accent,[.205,.22,.189],false);this.levelMarker.rotation.z=-Math.PI/2;
    const ground=new THREE.Mesh(new THREE.PlaneGeometry(20,20),this.material({color:0xe8eee6,roughness:.92,metalness:0}));ground.rotation.x=-Math.PI/2;ground.position.y=-.068;ground.receiveShadow=true;this.scene.add(ground);this.ground=ground;
    this.selection=new THREE.Box3Helper(new THREE.Box3(),0xdfad59);this.selection.material.depthTest=false;this.selection.material.transparent=true;this.selection.material.opacity=.83;this.selection.renderOrder=20;this.scene.add(this.selection);this.selection.visible=false;
  }
  makeArrow(id,color) {
    const arrow=new THREE.ArrowHelper(V(0,1,0),V(),.01,color,.004,.003);arrow.line.material.linewidth=2;arrow.line.material.depthTest=false;arrow.cone.material.depthTest=false;arrow.renderOrder=15;
    this.parts.get(id).add(arrow);return arrow;
  }
  buildObservations() {
    this.forceArrows=new Map([['force-buoyancy',teal],['force-weight',weightColor],['force-holder',holderColor]].map(([id,color])=>[id,this.makeArrow(id,color)]));
    this.forceLeaders=new Map([...this.forceArrows].map(([id,arrow])=>{const l=line([[0,0,0],[.1,0,0]],arrow.line.material.color,1,true);this.parts.get(id).add(l);return [id,l];}));
    this.pressureArrows=new Map(['pressure-bottom','pressure-top'].map(id=>[id,[-.025,0,.025].map(x=>{const a=this.makeArrow(id,0x58c8d9);a.userData.localX=x;return a;})]));
    this.pressureDots=[];for(let n=0;n<9;n++)this.pressureDots.push(this.mesh('pressure-bottom',new THREE.SphereGeometry(.0028,12,8),this.material({color:0x58c8d9,metalness:.1,roughness:.5}),[.054,.2,0],false));
  }
  buildOverlay() {
    this.overlay=document.createElement('div');this.overlay.className='buoyancy-overlay';
    this.poseNote=document.createElement('div');this.poseNote.className='buoyancy-pose-note';this.poseNote.setAttribute('role','status');
    this.forceLegend=document.createElement('div');this.forceLegend.className='buoyancy-force-legend';
    this.forceZeroNote=document.createElement('div');this.forceZeroNote.className='buoyancy-force-zero';
    this.pressureLegend=document.createElement('div');this.pressureLegend.className='buoyancy-pressure-legend';this.pressureLegend.textContent='압력색 0 — 3,000 Pa · 부력을 만드는 표면 압력';
    this.help=document.createElement('div');this.help.className='buoyancy-scene-help';this.help.textContent='드래그 회전 · 휠 확대 · 1 m = 세계 좌표 1';
    this.labelLayer=document.createElement('div');this.labelLayer.className='buoyancy-label-layer';
    this.svg=document.createElementNS('http://www.w3.org/2000/svg','svg');this.svg.classList.add('buoyancy-label-leaders');
    this.overlay.append(this.svg,this.labelLayer,this.poseNote,this.forceLegend,this.forceZeroNote,this.pressureLegend,this.help);this.container.appendChild(this.overlay);
    for(const p of COMPONENTS){
      const button=document.createElement('button');button.type='button';button.className='buoyancy-label';button.textContent=p.label;button.dataset.part=p.id;button.addEventListener('click',()=>this.onSelect(p.id));
      if(Object.hasOwn(forceNames,p.id))button.classList.add('buoyancy-force-label');
      const leader=document.createElementNS('http://www.w3.org/2000/svg','path');const dot=document.createElementNS('http://www.w3.org/2000/svg','circle');dot.setAttribute('r','2.7');
      this.labelLayer.appendChild(button);this.svg.append(leader,dot);this.labels.set(p.id,{button,leader,dot,anchor:null});
    }
  }
  update(snapshot,view=DEFAULT_VIEW) {
    if(this.disposed)return;this.snapshot=snapshot;this.view={...DEFAULT_VIEW,...view};
    const {body,submerged}=getBodyGeometry(snapshot);placeBox(this.body,body);
    this.bodyEdges.geometry.dispose();this.bodyEdges.geometry=new THREE.EdgesGeometry(this.body.geometry);this.bodyEdges.position.copy(this.body.position);
    this.submerged.visible=!!submerged;if(submerged)placeBox(this.submerged,submerged);
    const surface=surfaceFromBoxes(getFluidBoxes(snapshot));this.water.geometry.dispose();this.water.geometry=new THREE.BufferGeometry();
    this.water.geometry.setAttribute('position',new THREE.Float32BufferAttribute(surface.positions,3));this.water.geometry.setAttribute('normal',new THREE.Float32BufferAttribute(surface.normals,3));this.water.geometry.computeBoundingBox();this.water.geometry.computeBoundingSphere();
    const H=snapshot.waterLevelM,X=C.tankWidthM/2,Z=C.tankDepthM/2;
    setLine(this.waterline,[[-X,H,-Z],[X,H,-Z],[X,H,Z],[-X,H,Z],[-X,H,-Z]]);
    this.surfaceOpening.visible=snapshot.immersion==='partial';setLine(this.surfaceOpening,[[-.05,H,-.05],[.05,H,-.05],[.05,H,.05],[-.05,H,.05],[-.05,H,-.05]]);
    this.levelMarker.position.y=H;this.frontWall.visible=!this.view.cutaway;this.cutEdges.visible=this.view.cutaway;
    const held=snapshot.poseKind==='held';this.parts.get('holding-link').visible=held;setLine(this.holdingLink,[[...G.holdingAnchorM],[0,snapshot.bodyTopM,0]]);this.linkContact.position.set(0,snapshot.bodyTopM,0);
    this.setForce('force-buoyancy',snapshot.buoyancyN,[-G.forceColumnXM,snapshot.centerOfBuoyancyM??snapshot.bodyCenterM,.061],[0,snapshot.centerOfBuoyancyM??snapshot.bodyCenterM,.051]);
    this.setForce('force-weight',-snapshot.weightN,[G.forceColumnXM,snapshot.bodyCenterM,.061],[0,snapshot.bodyCenterM,.051]);
    this.setForce('force-holder',snapshot.holdingForceYN,[.138,snapshot.bodyTopM,.061],[0,snapshot.bodyTopM,.051]);
    for(const [id,arrows] of this.pressureArrows){
      const bottom=id==='pressure-bottom',pressure=bottom?snapshot.bottomGaugePressurePa:snapshot.topGaugePressurePa;
      const length=pressure*.000015,direction=bottom?1:-1,y=bottom?snapshot.bodyBottomM:snapshot.bodyTopM;
      this.parts.get(id).visible=this.view.pressures;
      for(const arrow of arrows){arrow.visible=length>1e-10;arrow.setDirection(V(0,direction,0));arrow.setColor(pressureColor(pressure));arrow.setLength(Math.max(length,.000001),Math.min(.007,length*.32),Math.min(.004,length*.2));arrow.position.set(arrow.userData.localX,y-direction*length,.053);}
    }
    snapshot.pressureSamples.forEach((sample,i)=>{const dot=this.pressureDots[i];dot.position.set(.053,sample.heightM,.052);dot.material.color.copy(pressureColor(sample.gaugePressurePa));dot.userData.pressurePa=sample.gaugePressurePa;});
    const notes={equilibrium:'자유부유 평형 · 부력과 무게가 같음',held:'높이 고정 · 강체 기호가 당김과 누름을 전달', 'neutral-reference':'중성부력 · 여러 잠긴 높이가 평형 · 현재 그림은 기준 위치', 'submerged-reference':'자유부유 평형 없음 · 완전잠김 기준 위치 · 침강 시간은 계산하지 않음'};
    if(this.poseNote.textContent!==notes[snapshot.poseKind])this.poseNote.textContent=notes[snapshot.poseKind];this.poseNote.dataset.kind=snapshot.poseKind;
    const forces=[['force-buoyancy',snapshot.buoyancyN],['force-weight',-snapshot.weightN],...(held?[['force-holder',snapshot.holdingForceYN]]:[])];
    const nonzero=forces.filter(([,force])=>!forceZero(force)),zero=forces.filter(([,force])=>forceZero(force));
    this.forceLegend.textContent=`${nonzero.map(([id,force])=>forceText(id,force)).join(' · ')} | 화살표 3 mm/N`;
    this.forceZeroNote.textContent=[...zero.map(([id,force])=>forceText(id,force)),...(!held?['고정력 사용하지 않음']:[])].join(' · ');
    this.forceZeroNote.hidden=!this.view.forces||!this.forceZeroNote.textContent;
    for(const [id,force]of forces)this.labels.get(id).button.textContent=forceText(id,force);
    this.forceLegend.hidden=!this.view.forces;this.pressureLegend.hidden=!this.view.pressures;
    this.scene.updateMatrixWorld(true);this.updateSelection();
    // OrbitControls has no damping or autorotation. Calling update here would
    // perturb a valid imported pole camera on unrelated condition/label changes.
    this.render();
  }
  setForce(id,force,position,application) {
    const group=this.parts.get(id),arrow=this.forceArrows.get(id),leader=this.forceLeaders.get(id),length=Math.abs(force)*G.forceWorldPerN;
    group.visible=this.view.forces&&(id!=='force-holder'||this.snapshot.poseKind==='held');arrow.visible=length>1e-10;leader.visible=arrow.visible;
    const headLength=Math.min(.007,length*.38);
    arrow.position.set(...position);arrow.setDirection(V(0,force>=0?1:-1,0));arrow.setLength(length,headLength,Math.min(.004,length*.23));
    // ArrowHelper itself gives the shaft a 0.1 mm minimum. Remove that visual
    // floor for tiny forces so neither shaft nor tip invents a minimum force.
    arrow.line.scale.y=Math.max(0,length-headLength);arrow.line.updateMatrix();
    setLine(leader,[application,position]);arrow.userData.signedForceN=force;arrow.userData.applicationM=[...application];
  }
  updateSelection() {
    const arrow=this.forceArrows.get(this.view.selectedPart),part=arrow??this.parts.get(this.view.selectedPart);
    this.selection.visible=!!part&&objectVisible(part);
    if(this.selection.visible){const b=new THREE.Box3().setFromObject(part);if(b.isEmpty())this.selection.visible=false;else this.selection.box.copy(b).expandByScalar(arrow?.001:.002);}
  }
  pick(event) {
    const bounds=this.renderer.domElement.getBoundingClientRect();if(!bounds.width||!bounds.height)return;
    this.raycaster.setFromCamera(new THREE.Vector2(2*(event.clientX-bounds.left)/bounds.width-1,1-2*(event.clientY-bounds.top)/bounds.height),this.camera);
    const hits=this.raycaster.intersectObjects([...this.parts.values()],true).filter(hit=>objectVisible(hit.object));
    // Clear glass is deliberately click-through; the apparatus still has its
    // own entry in the accessible part list and its metal edges are selectable.
    const useful=hits.find(hit=>hit.object.material?.transparent!==true)??hits[0];if(!useful)return;
    for(let object=useful.object;object;object=object.parent)if(object.userData.partId){this.onSelect(object.userData.partId);break;}
  }
  anchorFor(id) {
    const s=this.snapshot;if(!s)return V();
    const fixed={'tank-shell':[.25,.40,.18],'fluid-volume':[-.18,s.waterLevelM*.55,.04],'test-body':[0,s.bodyCenterM,.051],'submerged-volume':[0,s.bodyBottomM+s.submergedHeightM/2,.052],'free-surface':[-.13,s.waterLevelM,.175],'holding-frame':[-.294,.53,-.218],'holding-carriage':[0,.58,-.13],'holding-link':[0,(s.bodyTopM+.554)/2,0],'level-scale':[.235,.35,.189],'pressure-bottom':[0,s.bodyBottomM,.055],'pressure-top':[0,s.bodyTopM,.055]};
    const arrow=this.forceArrows.get(id);if(arrow)return actualArrowTip(arrow);return V(...(fixed[id]??[0,.25,0]));
  }
  labelIds() {
    const selected=this.view.selectedPart,forceIds=this.view.forces?[...this.forceArrows].filter(([,arrow])=>objectVisible(arrow)).map(([id])=>id):[];
    const related=this.focusContext==='holder'?['holding-carriage','holding-link']:this.focusContext?['test-body','free-surface']:['test-body','free-surface','holding-frame'];
    const forcePriority=forceIds.includes(selected)?[selected,...forceIds]:forceIds;
    return [...new Set([...forcePriority,selected,...related])].slice(0,this.width<500?5:6);
  }
  layoutLabels() {
    const width=this.width,height=this.height;if(!width||!height)return;
    const active=this.view.labels?this.labelIds():[],occupied=[],top=Math.max(70,this.poseNote.offsetTop+this.poseNote.offsetHeight+13);
    let footerBottom=31;
    for(const element of [this.forceLegend,this.forceZeroNote,this.pressureLegend])if(!element.hidden){element.style.bottom=`${footerBottom}px`;footerBottom+=element.offsetHeight+5;}
    const bottom=height-footerBottom-6;
    this.svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
    for(const item of this.labels.values()){item.button.hidden=true;item.leader.style.display='none';item.dot.style.display='none';item.anchor=null;}
    for(const id of active){const item=this.labels.get(id);
      const part=this.parts.get(id);if(!objectVisible(part)||(id==='submerged-volume'&&!this.submerged.visible))continue;
      if(this.forceArrows.has(id)&&!this.forceArrows.get(id).visible)continue;
      const world=this.anchorFor(id),projected=world.clone().project(this.camera);
      if(projected.z< -1||projected.z>1||Math.abs(projected.x)>1||Math.abs(projected.y)>1)continue;
      const ax=(projected.x+1)*width/2,ay=(1-projected.y)*height/2;
      item.button.hidden=false;item.button.classList.toggle('selected',id===this.view.selectedPart);
      const bw=Math.min(item.button.offsetWidth||110,width-20),bh=item.button.offsetHeight||30;
      const preferred=id==='force-buoyancy'?[-bw-18,-bh-9]:id==='force-weight'?[18,15]:id==='force-holder'?[18,-bh-19]:id==='holding-frame'?[-bw-20,-20]:id==='free-surface'?[-bw/2,21]:[21,-bh-10];
      const candidates=[preferred,[-bw-22,-bh-10],[20,18],[-bw-22,18],[-bw/2,-bh-34],[-bw/2,35],[-bw/2,-bh-66],[-bw/2,68]];
      let chosen=null;
      for(const [dx,dy]of candidates){const x=Math.max(10,Math.min(width-bw-10,ax+dx)),y=Math.max(top,Math.min(bottom-bh,ay+dy));const r={x,y,w:bw,h:bh};if(!occupied.some(o=>x<o.x+o.w+9&&x+bw+9>o.x&&y<o.y+o.h+7&&y+bh+7>o.y)){chosen=r;break;}}
      if(!chosen){item.button.hidden=true;continue;}
      occupied.push(chosen);item.button.style.left=`${chosen.x}px`;item.button.style.top=`${chosen.y}px`;
      const tx=Math.max(chosen.x,Math.min(chosen.x+chosen.w,ax)),ty=Math.max(chosen.y,Math.min(chosen.y+chosen.h,ay));
      item.leader.setAttribute('d',`M ${ax} ${ay} L ${tx} ${ty}`);item.leader.style.display='';item.dot.setAttribute('cx',ax);item.dot.setAttribute('cy',ay);item.dot.style.display='';item.anchor={worldM:array(world),x:ax,y:ay};
      const arrow=this.forceArrows.get(id);if(arrow){const color=`#${arrow.line.material.color.getHexString()}`;item.leader.style.stroke=color;item.dot.style.fill=color;}
    }
  }
  getCameraState() { return {position:array(this.camera.position),target:array(this.controls.target),zoom:this.camera.zoom}; }
  setCameraState(state) {
    if(!state||!['position','target'].every(key=>Array.isArray(state[key])&&state[key].length===3&&state[key].every(n=>typeof n==='number'&&Number.isFinite(n)&&Math.abs(n)<=30)))return false;
    const position=V(...state.position),target=V(...state.target),distance=position.distanceTo(target),zoom=state.zoom??1;
    if(distance<G.cameraMinDistanceM-1e-10||distance>G.cameraMaxDistanceM+1e-10||!Number.isFinite(zoom)||zoom<.25||zoom>4)return false;
    this.suppressCamera=true;this.camera.position.copy(position);this.controls.target.copy(target);this.camera.zoom=zoom;this.camera.updateProjectionMatrix();this.controls.update();
    // Restore exact coordinates after OrbitControls' pole-safety normalization.
    this.camera.position.copy(position);this.controls.target.copy(target);this.camera.lookAt(target);this.camera.updateMatrixWorld(true);this.suppressCamera=false;this.render();return true;
  }
  fit(bounds,direction,margin=1.18) {
    const center=bounds.getCenter(V()),dir=V(...direction).normalize();
    const orientation=new THREE.Matrix4().lookAt(dir,V(),this.camera.up),right=V().setFromMatrixColumn(orientation,0),up=V().setFromMatrixColumn(orientation,1);
    const tanY=Math.tan(THREE.MathUtils.degToRad(this.camera.fov/2))/this.camera.zoom,tanX=tanY*this.camera.aspect;let distance=.1;
    for(const x of [bounds.min.x,bounds.max.x])for(const y of [bounds.min.y,bounds.max.y])for(const z of [bounds.min.z,bounds.max.z]){const d=V(x,y,z).sub(center);distance=Math.max(distance,d.dot(dir)+Math.max(Math.abs(d.dot(right))/tanX,Math.abs(d.dot(up))/tanY)*margin);}
    distance=Math.max(.08,Math.min(40,distance));this.suppressCamera=true;this.controls.target.copy(center);this.camera.position.copy(center).addScaledVector(dir,distance);this.controls.update();this.suppressCamera=false;this.render();this.onCameraChange(this.getCameraState());
  }
  resetCamera(preset='iso') {
    this.focusContext=null;this.camera.zoom=1;this.camera.updateProjectionMatrix();
    const bounds=new THREE.Box3(V(-.323,-.065,-.25),V(.323,.636,.245));
    this.fit(bounds,preset==='front'?[.015,.1,1]:preset==='top'?[.03,1,.06]:[.88,.61,1.1],1.22);
  }
  focusPart(id) {
    if(!partIds.has(id)||!this.snapshot)return false;
    if(this.forceArrows.has(id)&&this.view.forces)return this.focusForces();
    const s=this.snapshot;let bounds,direction=[.40,.30,1];
    if(id.startsWith('holding-')){this.focusContext='holder';bounds=new THREE.Box3(V(-.12,Math.max(.25,s.bodyTopM-.03),-.25),V(.12,.635,.095));direction=[.5,.25,1];}
    else if(['test-body','submerged-volume','force-buoyancy','force-weight','force-holder','pressure-bottom','pressure-top'].includes(id)){
      this.focusContext='body';bounds=new THREE.Box3(V(-.145,Math.max(0,s.bodyBottomM-.085),-.095),V(.17,Math.max(s.waterLevelM,s.bodyTopM)+.065,.12));direction=[.40,.28,1];
    } else {this.focusContext=null;this.resetCamera(id==='free-surface'?'top':'iso');return true;}
    this.camera.zoom=1;this.camera.updateProjectionMatrix();this.fit(bounds,direction,1.32);return true;
  }
  focusForces() {
    if(!this.snapshot||!this.view.forces)return false;
    this.scene.updateMatrixWorld(true);const bounds=new THREE.Box3().setFromObject(this.body);
    for(const arrow of this.forceArrows.values())if(objectVisible(arrow))bounds.union(new THREE.Box3().setFromObject(arrow));
    bounds.expandByScalar(.025);this.focusContext='forces';this.camera.zoom=1;this.camera.updateProjectionMatrix();this.fit(bounds,[.23,.18,1],1.38);return true;
  }
  resize() {
    if(this.disposed)return;const width=Math.max(1,this.container.clientWidth),height=Math.max(1,this.container.clientHeight);this.width=width;this.height=height;this.camera.aspect=width/height;this.camera.updateProjectionMatrix();this.renderer.setSize(width,height,false);this.render();
  }
  render() { if(this.disposed)return;this.scene.updateMatrixWorld(true);this.renderer.render(this.scene,this.camera);this.layoutLabels(); }
  getComponents() { return COMPONENTS.map(p=>({...p})); }
  getDebug() {
    this.scene.updateMatrixWorld(true);const waterPositions=this.water.geometry.getAttribute('position');let waterTop=null;
    if(waterPositions){waterTop=-Infinity;for(let i=0;i<waterPositions.count;i++)waterTop=Math.max(waterTop,waterPositions.getY(i));}
    return {ready:!!this.snapshot,componentCount:this.parts.size,renderFrame:this.renderer.info.render.frame,drawCalls:this.renderer.info.render.calls,triangles:this.renderer.info.render.triangles,
      camera:this.getCameraState(),bodyBoundsM:actualBounds(this.body),submergedBoundsM:this.submerged.visible?actualBounds(this.submerged):null,
      bodyMeshVolumeM3:actualVolume(this.body),submergedMeshVolumeM3:actualVolume(this.submerged),waterMeshVolumeM3:waterPositions?actualVolume(this.water):0,waterSurfaceYM:waterTop,
      waterVertexCount:waterPositions?.count??0,frontWallVisible:this.frontWall.visible,holdingLinkVisible:objectVisible(this.holdingLink),
      forces:[...this.forceArrows].map(([id,a])=>{const start=a.getWorldPosition(V()),end=actualArrowTip(a);return {id,visible:objectVisible(a),startM:array(start),endM:array(end),boundsM:objectVisible(a)?actualBounds(a):null,leaderVisible:objectVisible(this.forceLeaders.get(id)),signedForceN:a.userData.signedForceN,applicationM:a.userData.applicationM,color:`#${a.line.material.color.getHexString()}`};}),
      selectionBoundsM:this.selection.visible?{min:array(this.selection.box.min),max:array(this.selection.box.max)}:null,
      zeroForceText:this.forceZeroNote.hidden?'':this.forceZeroNote.textContent,
      pressureDots:this.pressureDots.map(d=>({positionM:array(d.getWorldPosition(V())),color:`#${d.material.color.getHexString()}`,visible:objectVisible(d)})),
      poseLabel:this.poseNote.textContent,labels:[...this.labels].filter(([,v])=>!v.button.hidden).map(([id,v])=>({id,text:v.button.textContent,anchor:v.anchor,x:parseFloat(v.button.style.left),y:parseFloat(v.button.style.top),width:v.button.offsetWidth,height:v.button.offsetHeight})),
    };
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;this.resizeObserver.disconnect();this.controls.removeEventListener('change',this.controlChange);this.controls.dispose();
    this.renderer.domElement.removeEventListener('pointerdown',this.pointerDown);this.renderer.domElement.removeEventListener('pointerup',this.pointerUp);this.renderer.domElement.removeEventListener('pointercancel',this.pointerCancel);
    const geometries=new Set(),materials=new Set(this.materials),textures=new Set();this.scene.traverse(o=>{if(o.geometry)geometries.add(o.geometry);if(o.material)for(const m of Array.isArray(o.material)?o.material:[o.material])materials.add(m);});
    for(const g of geometries)g.dispose();for(const m of materials){for(const value of Object.values(m))if(value?.isTexture)textures.add(value);m.dispose();}for(const t of textures)t.dispose();this.environment.dispose();this.renderer.dispose();this.renderer.domElement.remove();this.overlay.remove();
  }
}
