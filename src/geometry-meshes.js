import * as THREE from 'three';

/** A drilled plate, local XY face, extruded from Z=0 to thickness. */
export function drilledPlateGeometry(width,height,thickness,boreRadius,segments=64) {
  if(![width,height,thickness,boreRadius].every(Number.isFinite)||Math.min(width,height,thickness,boreRadius)<=0||2*boreRadius>=Math.min(width,height))throw new RangeError('A positive bore must fit inside the plate');
  const shape=new THREE.Shape();shape.moveTo(-width/2,-height/2);shape.lineTo(width/2,-height/2);shape.lineTo(width/2,height/2);shape.lineTo(-width/2,height/2);shape.closePath();
  const hole=new THREE.Path();
  for(let i=0;i<=segments;i++){const a=-i/segments*Math.PI*2,x=boreRadius*Math.cos(a),y=boreRadius*Math.sin(a);if(i===0)hole.moveTo(x,y);else hole.lineTo(x,y);}hole.closePath();shape.holes.push(hole);
  const geometry=new THREE.ExtrudeGeometry(shape,{depth:thickness,bevelEnabled:false,steps:1,curveSegments:1});
  geometry.userData.boreRadiusM=boreRadius;geometry.userData.boreMinimumRadiusM=boreRadius*Math.cos(Math.PI/segments);geometry.computeBoundingBox();return geometry;
}

export function annularGeometry(inner,outer,thickness,segments=64) {
  const shape=new THREE.Shape();shape.absarc(0,0,outer,0,2*Math.PI,false);
  const hole=new THREE.Path();hole.absarc(0,0,inner,0,2*Math.PI,true);shape.holes.push(hole);
  return new THREE.ExtrudeGeometry(shape,{depth:thickness,bevelEnabled:false,steps:1,curveSegments:segments/2});
}

/** Exact negative-X half of a drilled plate, with a closed machined cut face. */
export function sectionedDrilledPlateGeometry(width,height,thickness,boreRadius,segments=64) {
  const shape=new THREE.Shape();shape.moveTo(-width/2,-height/2);shape.lineTo(0,-height/2);shape.lineTo(0,-boreRadius);
  for(let i=1;i<=segments/2;i++){const angle=-Math.PI/2-i/segments*2*Math.PI;shape.lineTo(boreRadius*Math.cos(angle),boreRadius*Math.sin(angle));}
  shape.lineTo(0,height/2);shape.lineTo(-width/2,height/2);shape.closePath();
  const geometry=new THREE.ExtrudeGeometry(shape,{depth:thickness,bevelEnabled:false,steps:1,curveSegments:1});geometry.computeBoundingBox();return geometry;
}

/** Keep GPU attributes when only endpoints change. */
export function updateLinePoints(mesh,points) {
  const position=mesh.geometry.getAttribute('position');if(!position||position.count!==points.length)return false;
  points.forEach((p,i)=>position.setXYZ(i,...p));position.needsUpdate=true;
  mesh.geometry.computeBoundingBox();mesh.geometry.computeBoundingSphere();
  if(mesh.material.isLineDashedMaterial){let distance=mesh.geometry.getAttribute('lineDistance');if(!distance||distance.count!==points.length){mesh.computeLineDistances();return true;}let total=0;for(let i=0;i<points.length;i++){if(i)total+=Math.hypot(...points[i].map((v,a)=>v-points[i-1][a]));distance.setX(i,total);}distance.needsUpdate=true;}
  return true;
}

// ArrowHelper otherwise clamps its shaft to 0.1 mm, including tiny pressures.
export function setExactArrowLength(arrow,length,headLength,headWidth) {
  arrow.setLength(length,headLength,headWidth);arrow.line.scale.y=Math.max(0,length-headLength);arrow.line.updateMatrix();
}
