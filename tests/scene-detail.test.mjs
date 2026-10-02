import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {readFile} from 'node:fs/promises';
import {APPARATUS_SI as A,GEOMETRY_SI as G,getApparatusGeometry} from '../src/geometry.js';
import {drilledPlateGeometry,sectionedDrilledPlateGeometry,annularGeometry,updateLinePoints,setExactArrowLength} from '../src/geometry-meshes.js';
const near=(a,b,t=1e-11)=>assert.ok(Math.abs(a-b)<=t,`${a} != ${b}`);
const intersection=(a,b)=>a.min.reduce((v,p,i)=>v*Math.max(0,Math.min(a.max[i],b.max[i])-Math.max(p,b.min[i])),1);
const box=b=>{const m=new THREE.Mesh(new THREE.BoxGeometry(...b.max.map((v,i)=>v-b.min[i])));m.position.set(...b.max.map((v,i)=>(v+b.min[i])/2));m.updateMatrixWorld();return new THREE.Box3().setFromObject(m);};
function signedVolume(g){const p=g.getAttribute('position'),indices=g.index;let volume=0;const a=new THREE.Vector3(),b=new THREE.Vector3(),c=new THREE.Vector3();for(let i=0;i<(indices?.count??p.count);i+=3){a.fromBufferAttribute(p,indices?indices.getX(i):i);b.fromBufferAttribute(p,indices?indices.getX(i+1):i+1);c.fromBufferAttribute(p,indices?indices.getX(i+2):i+2);volume+=a.dot(b.cross(c))/6;}return volume;}

test('rectangular carriage is a four-wall sleeve with 0.3 mm guide clearance, not solid rail penetration',()=>{
  const d=getApparatusGeometry();for(const wall of Object.values(d.walls))near(intersection(wall,d.rail),0);
  near(d.rail.min[1]-d.passage.min[1],.0003);near(d.passage.max[1]-d.rail.max[1],.0003);
  near(d.rail.min[2]-d.passage.min[2],.0003);near(d.passage.max[2]-d.rail.max[2],.0003);
  const rail=box(d.rail),lower=box(d.walls.lower),upper=box(d.walls.upper),rear=box(d.walls.rear);
  for(const value of [rail.min.y-lower.max.y,upper.min.y-rail.max.y,rail.min.z-rear.max.z])near(value,A.guideClearanceM,2e-9);
});

test('drilled face is watertight, outward-wound and admits a shaft through its real empty bore',()=>{
  const width=.07,height=.0246,thickness=.0067,r=A.clampBoreRadiusM,g=drilledPlateGeometry(width,height,thickness,r),p=g.getAttribute('position'),n=g.getAttribute('normal');
  const polygonArea=64/2*r*r*Math.sin(2*Math.PI/64);near(signedVolume(g),(width*height-polygonArea)*thickness,1e-12);
  for(let i=0;i<p.count;i+=3){const a=new THREE.Vector3().fromBufferAttribute(p,i),b=new THREE.Vector3().fromBufferAttribute(p,i+1),c=new THREE.Vector3().fromBufferAttribute(p,i+2),normal=new THREE.Vector3().fromBufferAttribute(n,i);assert.ok(b.sub(a).cross(c.sub(a)).dot(normal)>0);}
  const mesh=new THREE.Mesh(g,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.updateMatrixWorld();
  for(const [x,y]of [[0,0],[.0027,0],[0,-.0027]]){const ray=new THREE.Raycaster(new THREE.Vector3(x,y,-.01),new THREE.Vector3(0,0,1));assert.equal(ray.intersectObject(mesh).length,0);}
  const ray=new THREE.Raycaster(new THREE.Vector3(.009,0,-.01),new THREE.Vector3(0,0,1));assert.ok(ray.intersectObject(mesh).length>=2);
  g.dispose();mesh.material.dispose();
});

test('recessed pressure pad touches only the rail face and fits the stepped bore with positive margins',()=>{
  const d=getApparatusGeometry(),front=d.walls.front,g=drilledPlateGeometry(.07,front.max[1]-front.min[1],A.padPocketDepthM,A.padPocketRadiusM);
  near(d.pad.backZM,d.rail.max[2]);assert.ok(g.userData.boreMinimumRadiusM>A.padRadiusM);
  near(front.min[2]+A.padPocketDepthM-d.pad.frontZM,.0003);
  assert.ok(A.clampBoreRadiusM*Math.cos(Math.PI/64)>A.screwRadiusM);near(d.screw.minZM,d.pad.frontZM);
  near(d.screw.maxZM,A.knobCenterZM-A.knobLengthM/2);g.dispose();
});

test('inspection front plate is an exact closed half-section of the same physical bore, without enlarged clearances',()=>{
  for(const r of [A.clampBoreRadiusM,A.padPocketRadiusM]){
    const whole=drilledPlateGeometry(.07,.0246,.004,r),half=sectionedDrilledPlateGeometry(.07,.0246,.004,r);
    near(signedVolume(half),signedVolume(whole)/2,1e-13);near(half.boundingBox.max.x,0,1e-12);
    const mesh=new THREE.Mesh(half,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.updateMatrixWorld();
    assert.equal(new THREE.Raycaster(new THREE.Vector3(-r*.5,0,-.01),new THREE.Vector3(0,0,1)).intersectObject(mesh).length,0);
    assert.ok(new THREE.Raycaster(new THREE.Vector3(-.012,0,-.01),new THREE.Vector3(0,0,1)).intersectObject(mesh).length>=2);whole.dispose();half.dispose();mesh.material.dispose();
  }
});

test('support arm joins both sleeve and hollow head without blocking the ideal-constraint anchor bore',()=>{
  const d=getApparatusGeometry();near(d.arm.max[1],d.walls.lower.min[1]);near(d.arm.max[2],d.head.min[2]);
  assert.ok(d.arm.max[2]<-.004);assert.ok(G.holdingAnchorM[1]>d.head.min[1]&&G.holdingAnchorM[1]<d.head.max[1]);
  const g=drilledPlateGeometry(.041,.039,.025,.004);g.rotateX(-Math.PI/2);
  const mesh=new THREE.Mesh(g,new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.position.y=d.head.min[1];mesh.updateMatrixWorld();
  assert.equal(new THREE.Raycaster(new THREE.Vector3(0,.53,0),new THREE.Vector3(0,1,0)).intersectObject(mesh).length,0);g.dispose();mesh.material.dispose();
});

test('9 mm glass floor, deck, base, feet and ground form a touching support stack below the unchanged fluid domain',()=>{
  const d=getApparatusGeometry();near(d.floor.max[1],0);near(d.floor.max[1]-d.floor.min[1],.009);
  near(d.floor.min[1],d.deck.max[1]);near(d.deck.min[1],d.base.max[1]);near(d.base.min[1],d.footTopM);near(d.footBottomM,d.groundYM);
  for(const b of [d.floor,d.deck,d.base])assert.ok(b.max[1]<=0);
  const floor=box(d.floor),deck=box(d.deck),base=box(d.base);near(floor.min.y,deck.max.y,2e-9);near(deck.min.y,base.max.y,2e-9);
  near(d.framePadBottomM,d.deck.max[1]);
});

test('tiny positive pressure shafts do not extend through the surface or invent a minimum length',()=>{
  for(const length of [0,1e-11,1e-9,1e-7,1e-5,.00008,.045])for(const direction of [-1,1]){
    const arrow=new THREE.ArrowHelper(new THREE.Vector3(0,direction,0),new THREE.Vector3(0,-direction*length,0),length),head=Math.min(.007,length*.32);
    setExactArrowLength(arrow,length,head,Math.min(.004,length*.2));arrow.updateMatrixWorld();
    const shaft=arrow.line.localToWorld(new THREE.Vector3(0,1,0)),tip=arrow.cone.localToWorld(new THREE.Vector3(0,0,0));
    near(shaft.y,-direction*head,1e-15);near(tip.y,0,1e-15);assert.ok(shaft.y*direction<=1e-15);
  }
});

test('unchanged point counts preserve line geometry, position buffers and dashed-distance attributes',()=>{
  const geometry=new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3(1,0,0)]),material=new THREE.LineDashedMaterial(),mesh=new THREE.Line(geometry,material);mesh.computeLineDistances();
  const position=geometry.getAttribute('position'),distance=geometry.getAttribute('lineDistance'),storage=position.array;
  for(let i=0;i<64;i++)assert.equal(updateLinePoints(mesh,[[i,0,0],[i+3,4,0]]),true);
  assert.equal(mesh.geometry,geometry);assert.equal(geometry.getAttribute('position'),position);assert.equal(position.array,storage);assert.equal(geometry.getAttribute('lineDistance'),distance);near(distance.getX(1),5);
  assert.equal(updateLinePoints(mesh,[[0,0,0]]),false);geometry.dispose();material.dispose();
});

test('geometry constants stay Node-only and external machining does not enter project/model dependencies',async()=>{
  const source=await readFile(new URL('../src/geometry.js',import.meta.url),'utf8');assert.ok(!/from ['"]three/.test(source));
  const {createProject}=await import('../src/project.js');assert.equal(typeof createProject,'function');
  const washer=annularGeometry(.0031,.006,.001);assert.ok(signedVolume(washer)>0);washer.dispose();
  assert.throws(()=>drilledPlateGeometry(.001,.001,.001,.002));
});
