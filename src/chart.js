const NS='http://www.w3.org/2000/svg';
const el=(name,attrs={},text)=>{const n=document.createElementNS(NS,name);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));if(text!==undefined)n.textContent=text;return n;};
const colors={current:'#197773',saved:'#b66a2e',grid:'#d8e2da',text:'#607873'};
export class BuoyancyChart{
  constructor(forceContainer,immersionContainer){this.forceContainer=forceContainer;this.immersionContainer=immersionContainer;this.debug=null;}
  update(current,saved=null,mode='both'){
    const w=Math.max(290,this.forceContainer.clientWidth),h=194,left=58,right=32,top=28,bottom=29;
    const x=v=>left+(v+30)/60*(w-left-right),svg=el('svg',{viewBox:`0 0 ${w} ${h}`,'aria-hidden':true});
    for(const v of[-30,-15,0,15,30]){svg.append(el('line',{x1:x(v),x2:x(v),y1:top-8,y2:h-bottom,stroke:v===0?'#7d9e95':colors.grid,'stroke-width':v===0?1.5:1}),el('text',{x:x(v),y:h-10,fill:colors.text,'font-size':10,'text-anchor':'middle'},v));}
    svg.append(el('text',{x:left,y:12,fill:colors.text,'font-size':10},'아래 방향 −   /   위 방향 +  (N)'));
    const records=[];
    for(const[key,label,index]of[['buoyancyN','부력',0],['weightN','무게',1],['holdingForceYN','고정 힘',2]]){
      const y=top+index*43;svg.append(el('text',{x:left-8,y:y+13,fill:colors.text,'font-size':11,'text-anchor':'end'},label));
      for(const[kind,s,offset]of[['current',current,0],['saved',saved,15]]){
        if(!s||(mode!=='both'&&mode!==kind))continue;
        const v=key==='weightN'?-s[key]:s[key],end=x(v),zero=x(0),yy=y+offset;
        svg.append(el('line',{x1:zero,x2:end,y1:yy,y2:yy,stroke:colors[kind],'stroke-width':7,...(kind==='saved'?{'stroke-dasharray':'4 3'}:{})}),el('circle',{cx:end,cy:yy,r:3,fill:colors[kind]}));
        records.push({kind,key,valueN:v,startX:zero,endX:end,axisWidth:w-left-right});
      }
    }
    this.forceContainer.replaceChildren(svg);
    const iw=Math.max(290,this.immersionContainer.clientWidth),il=48,ir=56,aw=iw-il-ir,isvg=el('svg',{viewBox:`0 0 ${iw} 96`,'aria-hidden':true}),fractions=[];
    for(const v of[0,.5,1]){const xx=il+v*aw;isvg.append(el('line',{x1:xx,x2:xx,y1:12,y2:65,stroke:colors.grid}),el('text',{x:xx,y:87,fill:colors.text,'font-size':10,'text-anchor':'middle'},`${v*100}%`));}
    for(const[kind,s,y,label]of[['current',current,18,'현재'],['saved',saved,46,'보관']]){
      if(!s||(mode!=='both'&&mode!==kind))continue;
      const width=s.submergedFraction*aw;
      isvg.append(el('text',{x:il-8,y:y+11,fill:colors[kind],'font-size':11,'text-anchor':'end'},label),el('rect',{x:il,y,width,height:13,rx:2,fill:kind==='saved'?'none':colors[kind],stroke:colors[kind],...(kind==='saved'?{'stroke-dasharray':'4 3'}:{})}),el('text',{x:il+width+5,y:y+11,fill:colors[kind],'font-size':10},`${(s.submergedFraction*100).toFixed(1)}%`));
      fractions.push({kind,fraction:s.submergedFraction,width,axisWidth:aw});
    }
    this.immersionContainer.replaceChildren(isvg);this.debug={mode,forceAxisN:[-30,30],immersionAxis:[0,1],forces:records,fractions};
  }
}
