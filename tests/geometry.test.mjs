import test from 'node:test';
import assert from 'node:assert/strict';
import { createExperiment, getSnapshot, CONSTANTS_SI as C } from '../src/model.js';
import { COMPONENTS, DEFAULT_VIEW, GEOMETRY_SI, getBodyGeometry, getFluidBoxes, surfaceFromBoxes } from '../src/geometry.js';
const near=(actual,expected,tolerance=1e-12)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);
const volume=b=>b.max.reduce((product,x,i)=>product*(x-b.min[i]),1);
const intersection=(a,b)=>a.min.reduce((product,x,i)=>product*Math.max(0,Math.min(a.max[i],b.max[i])-Math.max(x,b.min[i])),1);
const snapshot=config=>getSnapshot(createExperiment(config));
function signedVolume(positions){let sum=0;for(let i=0;i<positions.length;i+=9){const[a,b,c,d,e,f,g,h,j]=positions.slice(i,i+9);sum+=(a*(e*j-f*h)+b*(f*g-d*j)+c*(d*h-e*g))/6;}return sum;}
const contains=(boxes,p)=>boxes.some(box=>p.every((value,i)=>value>box.min[i]&&value<box.max[i]));

test('fourteen stable IDs and the five observation fields are immutable Node-only data',()=>{
  assert.equal(COMPONENTS.length,14);assert.equal(new Set(COMPONENTS.map(x=>x.id)).size,14);
  assert.deepEqual(Object.keys(DEFAULT_VIEW).sort(),['cutaway','forces','labels','pressures','selectedPart']);
  assert.deepEqual(DEFAULT_VIEW,{cutaway:true,forces:true,pressures:false,labels:true,selectedPart:'test-body'});
  for(const item of COMPONENTS){assert.equal(typeof item.label,'string');assert.ok(item.description.length>10);assert.ok(Object.isFrozen(item));}
  assert.equal(GEOMETRY_SI.forceWorldPerN,.003);assert.equal(GEOMETRY_SI.pressureMaxPa,3000);
});

test('physical body box and submerged box retain independent SI cross-section and volume',()=>{
  for(const V of [.0005,.001,.002])for(const y of [.015,.18,.28]){
    const s=snapshot({bodyVolumeM3:V,mode:'held',heldBottomM:y}),b=getBodyGeometry(s);
    near(volume(b.body),V);near(b.body.max[0]-b.body.min[0],.1);near(b.body.max[2]-b.body.min[2],.1);near(b.body.min[1],y);
    const height=Math.max(0,Math.min(V/.01,s.waterLevelM-y));
    if(height===0)assert.equal(b.submerged,null);else{near(volume(b.submerged),height*.01);near(b.submerged.max[1],Math.min(s.waterLevelM,b.body.max[1]));}
  }
});

test('liquid boxes conserve 38.5 L and exclude the actual body across supported extremes',()=>{
  for(const V of [.0005,.001,.002])for(const m of [.1,1,3])for(const rho of [800,1000,1200])for(const mode of ['held','equilibrium'])for(const y of [.015,.18,.28]){
    const s=snapshot({bodyMassKg:m,bodyVolumeM3:V,fluidDensityKgM3:rho,mode,heldBottomM:y}),boxes=getFluidBoxes(s),body=getBodyGeometry(s).body;
    near(boxes.reduce((sum,b)=>sum+volume(b),0),.0385);
    for(let i=0;i<boxes.length;i++){
      assert.ok(volume(boxes[i])>0);near(intersection(boxes[i],body),0);assert.ok(boxes[i].min[1]>=0);assert.ok(boxes[i].max[1]<=s.waterLevelM);
      for(let j=i+1;j<boxes.length;j++)near(intersection(boxes[i],boxes[j]),0);
    }
  }
});

test('one union water mesh has the same signed volume after Float32 render conversion',()=>{
  for(const [V,y]of [[.0005,.015],[.001,.18],[.002,.015],[.002,.28]]){
    const s=snapshot({bodyVolumeM3:V,mode:'held',heldBottomM:y}),surface=surfaceFromBoxes(getFluidBoxes(s));
    assert.equal(surface.positions.length,surface.normals.length);assert.equal(surface.positions.length%9,0);
    near(signedVolume(surface.positions),.0385);near(signedVolume(Float32Array.from(surface.positions)),.0385,.0385*2e-6);
  }
});

test('union mesh normals face out of liquid and there are no internal transparent partitions',()=>{
  for(const y of [.015,.18,.28]){
    const boxes=getFluidBoxes(snapshot({mode:'held',heldBottomM:y})),surface=surfaceFromBoxes(boxes),p=surface.positions,n=surface.normals;
    for(let i=0;i<p.length;i+=9){
      const center=[0,1,2].map(axis=>(p[i+axis]+p[i+3+axis]+p[i+6+axis])/3),normal=n.slice(i,i+3);
      near(Math.hypot(...normal),1);
      const u=[0,1,2].map(a=>p[i+3+a]-p[i+a]),v=[0,1,2].map(a=>p[i+6+a]-p[i+a]),cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
      assert.ok(cross.reduce((sum,x,a)=>sum+x*normal[a],0)>0,'Nondegenerate outward winding');
      assert.ok(contains(boxes,center.map((x,a)=>x-normal[a]*1e-8)),'Inside side must contain liquid');
      assert.equal(contains(boxes,center.map((x,a)=>x+normal[a]*1e-8)),false,'Outside side must not contain liquid');
    }
  }
});

test('surface at the waterline leaves a real opening for a partly immersed body',()=>{
  const s=snapshot(),surface=surfaceFromBoxes(getFluidBoxes(s));let area=0;
  for(let i=0;i<surface.positions.length;i+=9){const p=surface.positions.slice(i,i+9);if(surface.normals[i+1]!==1||p[1]!==s.waterLevelM)continue;area+=Math.abs((p[3]-p[0])*(p[8]-p[2])-(p[5]-p[2])*(p[6]-p[0]))/2;}
  near(area,.175-.01);
});

test('neutral and no-free-equilibrium reference boxes stay fully wet and never touch the floor',()=>{
  for(const mass of [1,1.2]){
    const s=snapshot({bodyMassKg:mass,bodyVolumeM3:.001,fluidDensityKgM3:1000}),b=getBodyGeometry(s);
    assert.equal(s.equilibriumBottomM,null);assert.ok(b.body.min[1]>=.015);assert.ok(b.body.max[1]<s.waterLevelM);near(volume(b.body),volume(b.submerged));
  }
});

test('invalid geometry inputs and zero-size fluid boxes are rejected instead of emitting NaN',()=>{
  const s=snapshot();assert.throws(()=>getBodyGeometry({...s,bodyBottomM:NaN}));assert.throws(()=>getFluidBoxes({...s,waterLevelM:1}));
  assert.throws(()=>surfaceFromBoxes([{min:[0,0,0],max:[0,1,1]}]));assert.throws(()=>surfaceFromBoxes([{min:[0,0,0],max:[1,1,Infinity]}]));
  assert.deepEqual(surfaceFromBoxes([]),{positions:[],normals:[]});assert.equal(C.fluidVolumeM3,.0385);
});
