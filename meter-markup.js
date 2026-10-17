/* Labels remain in original image coordinates at every zoom level. */
(()=>{
 const canvas=document.getElementById('view'),ctx=canvas.getContext('2d');
 const topPad=110,bottomPad=30;
 let img=null,scale=1,zoom=1,offsetX=0,offsetY=0,box=null,drag=null,active='window',draft=null;
 const pointers=new Map();let pinch=null;
 const lastBoxes={window:{w:200,h:80},separator:{w:12,h:8}};
 const kind=()=>active==='separator'?'separator':'window';
 const point=(x,y)=>({x:x*scale*zoom+offsetX,y:y*scale*zoom+offsetY+topPad});
 const source=p=>({x:(p.x-offsetX)/(scale*zoom),y:(p.y-topPad-offsetY)/(scale*zoom)});
 function pos(ev){const r=canvas.getBoundingClientRect();return {x:(ev.clientX-r.left)*canvas.width/r.width,y:(ev.clientY-r.top)*canvas.height/r.height};}
 function constrain(){if(img&&box)box=boundedMeterRect(box,img.width,img.height);}
 function sync(){if(draft&&box){constrain();draft[kind()+'Rect']={...box};draft[kind()+'Status']='marked';updateMeterLabelReady();}}
 function handles(){return {move:{x:canvas.width/2-65,y:50},size:{x:canvas.width/2+65,y:50}};}
 function circle(p,label,color){ctx.fillStyle=color;ctx.beginPath();ctx.arc(p.x,p.y,42,0,Math.PI*2);ctx.fill();ctx.fillStyle='#17202b';ctx.font='bold 26px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,p.x,p.y);}
 function rect(r,color){const p=point(r.x,r.y);ctx.strokeStyle=color;ctx.lineWidth=2;ctx.strokeRect(p.x,p.y,r.w*scale*zoom,r.h*scale*zoom);}
 function redraw(){
  ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#303b48';ctx.fillRect(0,0,canvas.width,canvas.height);
  if(!img)return;constrain();ctx.save();ctx.beginPath();ctx.rect(0,topPad,canvas.width,canvas.height-topPad-bottomPad);ctx.clip();
  ctx.drawImage(img,offsetX,offsetY+topPad,img.width*scale*zoom,img.height*scale*zoom);
  for(const name of ['window','separator']){const r=name===kind()?box:draft?.[name+'Rect'];if(r)rect(r,name==='window'?'#4bd7bd':'#ffd166');}
  ctx.restore();
  if(box){const h=handles(),color=kind()==='window'?'#4bd7bd':'#ffd166',a=point(box.x,box.y),b=point(box.x+box.w,box.y+box.h);ctx.strokeStyle=color;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(h.move.x,h.move.y);ctx.lineTo(Math.max(0,Math.min(canvas.width,a.x)),Math.max(topPad,Math.min(canvas.height-bottomPad,a.y)));ctx.moveTo(h.size.x,h.size.y);ctx.lineTo(Math.max(0,Math.min(canvas.width,b.x)),Math.max(topPad,Math.min(canvas.height-bottomPad,b.y)));ctx.stroke();circle(h.move,'↔',color);circle(h.size,'↘',color);}
 }
 function setZoom(value,anchor){if(!img)return;const next=Math.max(1,Math.min(8,value)),p=anchor||point(box?box.x+box.w/2:img.width/2,box?box.y+box.h/2:img.height/2),s=source(p);zoom=next;const target=anchor||{x:canvas.width/2,y:topPad+(canvas.height-topPad-bottomPad)/2};offsetX=target.x-s.x*scale*zoom;offsetY=target.y-topPad-s.y*scale*zoom;if(zoom===1){offsetX=offsetY=0;}redraw();}
 canvas.addEventListener('pointerdown',ev=>{
  if(!img)return;ev.preventDefault();canvas.setPointerCapture(ev.pointerId);const p=pos(ev);pointers.set(ev.pointerId,p);
  if(pointers.size===2){const [a,b]=[...pointers.values()];pinch={distance:Math.hypot(a.x-b.x,a.y-b.y),zoom};drag=null;return;}
  const h=handles();if(box&&Math.hypot(p.x-h.move.x,p.y-h.move.y)<50)drag={mode:'move',p,box:{...box}};
  else if(box&&Math.hypot(p.x-h.size.x,p.y-h.size.y)<50)drag={mode:'size',p,box:{...box}};
  else if(p.y>=topPad&&p.y<canvas.height-bottomPad)drag={mode:'pan',p,ox:offsetX,oy:offsetY,create:!box,moved:false};
 });
 canvas.addEventListener('pointermove',ev=>{
  if(!pointers.has(ev.pointerId))return;const p=pos(ev);pointers.set(ev.pointerId,p);
  if(pinch&&pointers.size===2){const [a,b]=[...pointers.values()];setZoom(pinch.zoom*Math.hypot(a.x-b.x,a.y-b.y)/pinch.distance,{x:(a.x+b.x)/2,y:(a.y+b.y)/2});return;}
  if(!drag)return;const dx=p.x-drag.p.x,dy=p.y-drag.p.y;
  if(drag.mode==='pan'){drag.moved ||= Math.hypot(dx,dy)>5;offsetX=drag.ox+dx;offsetY=drag.oy+dy;}
  else {const factor=.35/(scale*zoom);if(drag.mode==='move'){box.x=drag.box.x+dx*factor;box.y=drag.box.y+dy*factor;}else{box.w=Math.max(.5,drag.box.w+dx*factor);box.h=Math.max(.5,drag.box.h+dy*factor);}sync();}
  redraw();
 });
 function finish(ev){
  if(drag?.create&&!drag.moved){const p=source(pos(ev)),last=lastBoxes[kind()];if(p.x>=0&&p.y>=0&&p.x<=img.width&&p.y<=img.height){box={x:p.x-last.w/2,y:p.y-last.h/2,w:last.w,h:last.h};sync();}}
  pointers.delete(ev.pointerId);drag=null;pinch=null;redraw();
 }
 canvas.addEventListener('pointerup',finish);canvas.addEventListener('pointercancel',ev=>{pointers.delete(ev.pointerId);drag=null;pinch=null;});
 canvas.addEventListener('wheel',ev=>{ev.preventDefault();setZoom(zoom*(ev.deltaY<0?1.25:.8),pos(ev));},{passive:false});
 const report=e=>document.getElementById('meter-label-status').textContent=e.message;
 document.getElementById('keep').onclick=()=>{if(box)lastBoxes[kind()]={w:box.w,h:box.h};saveMeterLabel('marked').catch(report);};
 document.getElementById('save').onclick=()=>exportMeterJSON().catch(report);
 window.meterMarkup={sync(){},forget(){},addBox(){
  if(!img||box)return;
  const center=source({x:canvas.width/2,y:topPad+(canvas.height-topPad-bottomPad)/2}),last=lastBoxes[kind()];
  box={x:center.x-last.w/2,y:center.y-last.h/2,w:last.w,h:last.h};
  if(draft)draft[kind()+'Confidence']=null;
  sync();redraw();
 },async load(blob,name,annotations,mode='window'){
  drag=null;pinch=null;pointers.clear();draft=annotations;active=mode;zoom=1;offsetX=offsetY=0;
  if(img?.close)img.close();img=blob?await createImageBitmap(blob):null;
  if(img){scale=Math.min(980/img.width,1);canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale)+topPad+bottomPad;}
  box=draft?.[kind()+'Rect']?{...draft[kind()+'Rect']}:null;redraw();
 },setClass(mode,annotations){draft=annotations;active=mode;drag=null;box=draft?.[kind()+'Rect']?{...draft[kind()+'Rect']}:null;redraw();},clearBox(){box=null;redraw();},getBox(){constrain();return box?{...box}:null;}};
})();
