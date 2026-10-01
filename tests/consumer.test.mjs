import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { Color, PerspectiveCamera, Vector3 } from 'three';

const root=path.resolve(import.meta.dirname,'..'),output=path.join(root,'output/consumer');
const hardware=process.env.BUOYANCY_BROWSER_HARDWARE==='1';
const checks=[],errors=[],externalRequests=[],forceEvidence=[];let browser,context,page,gpu,failure;
await fs.mkdir(output,{recursive:true});
const server=await createServer({root,server:{host:'127.0.0.1',port:5273,strictPort:true,hmr:false}});await server.listen();
const state=()=>page.evaluate(()=>window.buoyancyLab.getState());
const project=()=>page.evaluate(()=>window.buoyancyLab.project());
const debug=()=>page.evaluate(()=>window.buoyancyLab.sceneDebug());
const paint=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const near=(actual,expected,tolerance=1e-8)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} != ${expected}`);
const check=async(name,action)=>{await action();checks.push(name);console.log(`PASS ${name}`);};
const change=async(id,value)=>{await page.locator(`#${id}`).fill(String(value));await page.locator(`#${id}`).press('Tab');};
const mode=value=>page.locator(`[data-mode="${value}"]`).click();
async function conditions(mass,volume,density){await change('mass-number',mass);await change('volume-number',volume);await change('density-number',density);}
async function dismiss(){if(await page.locator('#toast').isVisible())await page.locator('#toast button').click();}
async function shot(name,fullPage=false){await paint();await page.screenshot({path:path.join(output,`${name}.png`),fullPage});}
async function sceneShot(name){await page.locator('#scene').scrollIntoViewIfNeeded();await paint();await page.locator('#scene').screenshot({path:path.join(output,`${name}.png`)});}
async function labelsInside(){const box=await page.locator('#scene').boundingBox(),data=await debug();assert.ok(data.labels.length>=1);for(const label of data.labels){assert.ok(label.x>=0&&label.y>=60&&label.x+label.width<=box.width+1&&label.y+label.height<=box.height-25,`clipped label ${label.id}`);assert.ok(label.anchor.x>=0&&label.anchor.x<=box.width&&label.anchor.y>=0&&label.anchor.y<=box.height);}}
async function forceLabel(id,expected){
  const data=await debug(),label=data.labels.find(item=>item.id===id),arrow=data.forces.find(item=>item.id===id);assert.ok(label,`force label missing: ${id}`);assert.equal(label.text,expected);
  label.anchor.worldM.forEach((value,index)=>near(value,arrow.endM[index],1e-10));
  const actual=await page.locator(`.buoyancy-force-label[data-part="${id}"]`).innerText();assert.equal(actual,expected);return label;
}
async function distinctForceLabels(){const labels=(await debug()).labels.filter(item=>item.id.startsWith('force-'));for(let i=0;i<labels.length;i++)for(let j=i+1;j<labels.length;j++){const a=labels[i],b=labels[j];assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y,`overlapping force labels ${a.id}/${b.id}`);}await labelsInside();}
async function bodyFits(){const data=await debug(),box=await page.locator('#scene').boundingBox(),camera=new PerspectiveCamera(37,box.width/box.height,.003,160);camera.position.fromArray(data.camera.position);camera.zoom=data.camera.zoom;camera.lookAt(new Vector3(...data.camera.target));camera.updateProjectionMatrix();camera.updateMatrixWorld();for(const x of [data.bodyBoundsM.min[0],data.bodyBoundsM.max[0]])for(const y of [data.bodyBoundsM.min[1],data.bodyBoundsM.max[1]])for(const z of [data.bodyBoundsM.min[2],data.bodyBoundsM.max[2]]){const p=new Vector3(x,y,z).project(camera);assert.ok(Math.abs(p.x)<.97&&Math.abs(p.y)<.97&&p.z> -1&&p.z<1);}}

try{
  browser=await chromium.launch({headless:true,...(hardware?{args:['--enable-gpu','--use-angle=d3d11','--ignore-gpu-blocklist']}:{})});
  context=await browser.newContext({viewport:{width:1600,height:1000}});page=await context.newPage();page.setDefaultTimeout(20000);
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});page.on('request',r=>{if(/^https?:/.test(r.url())&&new URL(r.url()).hostname!=='127.0.0.1')externalRequests.push(r.url());});
  await page.goto('http://127.0.0.1:5273/');await page.waitForFunction(()=>window.buoyancyLab?.sceneDebug()?.ready);
  gpu=await page.evaluate(()=>{const gl=document.querySelector('#scene canvas').getContext('webgl2'),ext=gl.getExtension('WEBGL_debug_renderer_info');return {webgl2:!!gl,renderer:gl.getParameter(ext?ext.UNMASKED_RENDERER_WEBGL:gl.RENDERER)};});if(hardware)assert.match(gpu.renderer,/RTX 5080.*D3D11|D3D11.*RTX 5080/);

  await check('1600, 1280 and 390 scenes retain the chosen camera on resize and expose upright associated labels',async()=>{
    let original=await project();
    for(const [width,height]of [[1600,1000],[1280,900],[390,844]]){
      await page.setViewportSize({width,height});await paint();assert.deepEqual((await project()).observation.camera,original.observation.camera);assert.deepEqual((await state()).experiment,original.experiment);
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)<=1);const bounds=await page.locator('#scene canvas').boundingBox();assert.ok(bounds.width>=300&&bounds.height>=360);
      await page.locator('[data-camera="iso"]').click();await bodyFits();await labelsInside();await page.evaluate(()=>scrollTo(0,0));await shot(`buoyancy-${width}`,true);await sceneShot(`scene-${width}`);original=await project();
    }
  });
  await check('actual force cone tips use one 3 mm per N scale including downward rigid-holder force',async()=>{
    await page.setViewportSize({width:1600,height:1000});await mode('held');await conditions(.4,1,1000);await change('height-number',6);
    for(const mass of [.4,1.2]){
      await change('mass-number',mass);const mesh=await debug();
      const expected={'force-buoyancy':9.80665,'force-weight':-mass*9.80665,'force-holder':mass*9.80665-9.80665};
      for(const arrow of mesh.forces){assert.equal(arrow.visible,true);near(arrow.endM[0],arrow.startM[0]);near(arrow.endM[2],arrow.startM[2]);near(arrow.endM[1]-arrow.startM[1],expected[arrow.id]*.003,1e-9);}
      assert.equal(mesh.holdingLinkVisible,true);
    }
    await page.locator('#part-select').selectOption('force-holder');await page.locator('#focus-part').click();await sceneShot('held-force-focus');
    await mode('equilibrium');assert.equal((await debug()).holdingLinkVisible,false);assert.equal((await debug()).forces.find(a=>a.id==='force-holder').visible,false);
  });
  await check('water and wet-body meshes retain exact physical volumes at boundaries and reference states are explicitly labeled',async()=>{
    await mode('held');
    for(const [volume,bottom]of [[.5,1.5],[2,1.5],[2,28],[1,18]]){
      await conditions(.4,volume,1000);await change('height-number',bottom);const actual=await debug(),s=(await state()).snapshot;
      near(actual.bodyMeshVolumeM3,volume/1000);near(actual.waterMeshVolumeM3,.0385);near(actual.submergedMeshVolumeM3,s.displacedVolumeM3);near(actual.waterSurfaceYM,s.waterLevelM,2e-8);near(actual.bodyBoundsM.min[1],bottom/100);
      if(actual.submergedBoundsM)near(actual.submergedBoundsM.max[1]-actual.submergedBoundsM.min[1],s.submergedHeightM);
    }
    await conditions(1,1,1000);await mode('equilibrium');let mesh=await debug();assert.match(mesh.poseLabel,/중성.*기준 위치/);assert.ok(mesh.bodyBoundsM.min[1]>.015);await page.locator('[data-camera="front"]').click();await sceneShot('neutral-reference');
    await change('mass-number',3);mesh=await debug();assert.match(mesh.poseLabel,/평형 없음.*기준 위치/);assert.equal(mesh.holdingLinkVisible,false);assert.ok(mesh.bodyBoundsM.min[1]>.015);await sceneShot('no-equilibrium-reference');
  });
  await check('deeper full immersion changes actual pressure material colors but retains buoyancy and fixed color scale',async()=>{
    await mode('held');await conditions(1.2,1,1000);await change('height-number',6);await page.locator('[data-view="pressures"]').check();
    const first=await debug(),firstForce=(await state()).snapshot.buoyancyN;
    await change('height-number',1.5);const deeper=await debug(),s=(await state()).snapshot;near(s.buoyancyN,firstForce);assert.notEqual(deeper.pressureDots[0].color,first.pressureDots[0].color);
    deeper.pressureDots.forEach((dot,i)=>{const height=.015+.1*i/8,pa=1000*9.80665*((.0385+.001)/.175-height);const color=new Color(0x58c8d9).lerp(new Color(0xe5a13d),pa/3000);near(dot.positionM[1],height);assert.equal(dot.color,`#${color.getHexString()}`);assert.equal(dot.visible,true);});
    await page.locator('#part-select').selectOption('pressure-bottom');await page.locator('#focus-part').click();await labelsInside();await sceneShot('pressure-depth-focus');
  });
  await check('observation toggles and idle time preserve conditions, frozen comparison, chosen camera and static renderer',async()=>{
    await page.locator('#pin-comparison').click();const before=await project();
    for(const key of ['cutaway','forces','pressures','labels']){const input=page.locator(`[data-view="${key}"]`);await input.setChecked(!(await input.isChecked()));const now=await project();assert.deepEqual(now.experiment,before.experiment);assert.deepEqual(now.comparison,before.comparison);assert.deepEqual(now.observation.camera,before.observation.camera);}
    const frame=(await debug()).renderFrame;await page.waitForTimeout(350);assert.equal((await debug()).renderFrame,frame,'static scene should not continuously render');
    const saved=await project();saved.observation.camera={position:[0,2,0],target:[0,0,0],zoom:1};await page.evaluate(value=>window.buoyancyLab.loadProject(JSON.stringify(value)),saved);
    await change('mass-number',.8);await page.locator('[data-view="labels"]').check();await page.locator('[data-view="cutaway"]').check();await page.setViewportSize({width:1280,height:900});await paint();assert.deepEqual((await project()).observation.camera,saved.observation.camera);assert.deepEqual((await state()).comparison,saved.comparison);
    await page.locator('[data-camera="front"]').click();await page.locator('#scene').scrollIntoViewIfNeeded();await paint();
    const canvas=await page.locator('#scene canvas').boundingBox(),start={x:canvas.x+canvas.width*.20,y:canvas.y+canvas.height*.72};
    assert.equal(await page.evaluate(p=>document.elementFromPoint(p.x,p.y)?.tagName,start),'CANVAS');
    await page.mouse.move(start.x,start.y);await page.mouse.wheel(0,24000);
    await page.waitForFunction(()=>{const c=window.buoyancyLab.sceneDebug().camera;return Math.hypot(...c.position.map((n,i)=>n-c.target[i]))>39;});
    await page.mouse.down({button:'right'});await page.mouse.move(start.x+canvas.width*.35,start.y-70,{steps:12});await page.mouse.up({button:'right'});await paint();
    const far=await project(),actual=(await debug()).camera;assert.notEqual(far.observation.camera,null);assert.deepEqual(far.observation.camera,actual);
    for(const vector of [actual.position,actual.target])for(const coordinate of vector)assert.ok(Math.abs(coordinate)<=30);
    near(Math.hypot(...actual.position.map((n,i)=>n-actual.target[i])),40,1e-8);
    await page.evaluate(value=>window.buoyancyLab.loadProject(JSON.stringify(value)),far);assert.deepEqual((await project()).observation.camera,actual);assert.deepEqual((await state()).experiment,far.experiment);
    await page.locator('[data-camera="iso"]').click();
  });
  await check('explicit part focus returns a readable scene on a small screen while ordinary selection preserves state',async()=>{
    await page.setViewportSize({width:390,height:844});await dismiss();await page.locator('[data-view="forces"]').check();await page.locator('[data-view="pressures"]').uncheck();
    for(const id of ['test-body','holding-carriage','submerged-volume']){
      const before=await project();await page.locator('#part-select').selectOption(id);assert.deepEqual((await project()).observation.camera,before.observation.camera);assert.deepEqual((await state()).experiment,before.experiment);
      await page.locator('#focus-part').click();await paint();assert.deepEqual((await state()).experiment,before.experiment);const box=await page.locator('#scene').boundingBox();assert.ok(box.y<844&&box.y+box.height>0);
      assert.ok((await debug()).labels.some(label=>label.id===id),`selected label missing: ${id}`);await labelsInside();await sceneShot(`mobile-focus-${id}`);
    }
  });
  await check('explicit force focus is accessible by click and keyboard at 1600 and 390 without changing the experiment, comparison or view',async()=>{
    for(const [width,height]of [[1600,1000],[390,844]]){
      await page.setViewportSize({width,height});await page.locator('#new-project').click();await dismiss();await page.locator('#pin-comparison').click();const before=await project();
      const button=page.locator('#focus-forces');await button.scrollIntoViewIfNeeded();assert.equal(await button.isEnabled(),true);
      if(width===1600){await button.focus();await button.press('Enter');}else await button.click();await paint();
      const after=await project();assert.deepEqual(after.experiment,before.experiment);assert.deepEqual(after.comparison,before.comparison);assert.deepEqual(after.observation.view,before.observation.view);assert.notDeepEqual(after.observation.camera,before.observation.camera);
      const sceneBox=await page.locator('#scene').boundingBox();assert.ok(sceneBox.y<height&&sceneBox.y+sceneBox.height>0);await bodyFits();
      await forceLabel('force-buoyancy','↑ 부력 3.92 N');await forceLabel('force-weight','↓ 무게 3.92 N');assert.match((await debug()).zeroForceText,/고정력 사용하지 않음/);await distinctForceLabels();await sceneShot(`force-default-${width}`);
      const chosen=after.observation.camera;await change('mass-number',.8);assert.deepEqual((await project()).observation.camera,chosen);assert.deepEqual((await state()).comparison,before.comparison);
      await page.locator('[data-view="forces"]').uncheck();assert.equal(await button.isDisabled(),true);assert.equal(await page.locator('#focus-forces-hint').isVisible(),true);assert.deepEqual((await project()).observation.camera,chosen);
      await page.locator('[data-view="forces"]').check();assert.equal(await button.isEnabled(),true);const stored=await project();await page.evaluate(value=>window.buoyancyLab.loadProject(JSON.stringify(value)),stored);assert.deepEqual(await project(),stored);
      await page.setViewportSize({width:width===390?1280:390,height:900});await paint();assert.deepEqual((await project()).observation.camera,chosen);assert.deepEqual((await state()).experiment,stored.experiment);
      forceEvidence.push({check:'explicit-focus',width,camera:chosen,view:after.observation.view});
    }
  });
  await check('force selection outlines only real arrow geometry and positive, negative, zero and tiny forces remain distinct on 390 pixels',async()=>{
    await page.setViewportSize({width:390,height:844});await mode('held');await conditions(.4,1,1000);await change('height-number',6);await page.locator('[data-view="labels"]').check();await page.locator('[data-view="pressures"]').uncheck();await page.locator('#part-select').selectOption('force-holder');
    for(const [mass,expectedText,name]of [[.4,'↓ 고정력 5.88 N','down'],[1.2,'↑ 고정력 1.96 N','up'],[1,'고정력 0.00 N · 방향 없음','zero'],[1.0000001,'↑ 고정력 <0.01 N','tiny-up'],[.9999999,'↓ 고정력 <0.01 N','tiny-down']]){
      const before=await project();await change('mass-number',mass);assert.deepEqual((await project()).observation.camera,before.observation.camera);assert.deepEqual((await state()).comparison,before.comparison);
      await page.locator('#focus-forces').click();await paint();const data=await debug(),holder=data.forces.find(item=>item.id==='force-holder'),force=(mass-1)*9.80665;
      if(mass===1){assert.equal(holder.visible,false);assert.equal(holder.leaderVisible,false);assert.equal(holder.boundsM,null);assert.equal(data.selectionBoundsM,null);assert.ok(data.zeroForceText.includes(expectedText));assert.equal(data.labels.some(label=>label.id==='force-holder'),false);}
      else{
        assert.equal(holder.visible,true);await forceLabel('force-holder',expectedText);near(holder.endM[1]-holder.startM[1],force*.003,1e-12);
        assert.ok(holder.boundsM.max[0]-holder.boundsM.min[0]<.01);assert.ok(data.selectionBoundsM.max[0]-data.selectionBoundsM.min[0]<.013,'Horizontal application leader must not be selected');
        for(let axis=0;axis<3;axis++){near(data.selectionBoundsM.min[axis],holder.boundsM.min[axis]-.001,1e-10);near(data.selectionBoundsM.max[axis],holder.boundsM.max[axis]+.001,1e-10);}
        near(holder.boundsM.max[1]-holder.boundsM.min[1],Math.abs(force)*.003,1e-10);
      }
      await distinctForceLabels();await sceneShot(`force-held-${name}-390`);forceEvidence.push({check:'held-direction',mass,holder,selectionBoundsM:data.selectionBoundsM,zeroForceText:data.zeroForceText});
    }
    await change('height-number',28);await page.locator('#part-select').selectOption('force-buoyancy');await page.locator('#focus-forces').click();await paint();const dry=await debug(),buoyancy=dry.forces.find(item=>item.id==='force-buoyancy');assert.equal(buoyancy.visible,false);assert.equal(buoyancy.leaderVisible,false);assert.equal(dry.selectionBoundsM,null);assert.match(dry.zeroForceText,/부력 0.00 N · 방향 없음/);await sceneShot('force-dry-zero-390');
    await mode('equilibrium');assert.equal((await debug()).forces.find(item=>item.id==='force-holder').visible,false);assert.match((await debug()).zeroForceText,/고정력 사용하지 않음/);
  });
  await page.setViewportSize({width:1600,height:1000});await page.locator('#new-project').click();await dismiss();await page.evaluate(()=>scrollTo(0,0));await shot('buoyancy-default-viewport');await shot('buoyancy-default-full',true);
  assert.deepEqual(errors,[]);assert.deepEqual(externalRequests,[]);
}catch(error){failure=error;console.error(error.stack);await page?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}
finally{await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:failure?'FAILED':'PASSED',failure:failure?.stack,checks,gpu,errors,externalRequests,forceEvidence},null,2));await context?.close();await browser?.close();await server.close();}
if(failure)process.exitCode=1;
