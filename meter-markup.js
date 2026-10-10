/* Meter markup: rectangular window and separator labels. */
(()=>{
 const canvas=document.getElementById('view'),ctx=canvas.getContext('2d'),out=document.getElementById('out');
 const topPad=110,bottomPad=110;
 let img=null,scale=1,box=null,drag=null,fileName='',active='window',draft=null,trail=[];
 const lastBoxes={window:{w:200,h:80},separator:{w:70,h:80}};
 const kind=()=>active==='separator'?'separator':'window';
 function handlesOf(b){
  const mid=img.width/2,x=Math.max(45/scale,Math.min(img.width-45/scale,Math.min(b.x-40,mid)));
  if(active==='window')return {move:{x:Math.max(45/scale,Math.min(img.width-45/scale,mid-65/scale)),y:-50/scale},size:{x:Math.max(45/scale,Math.min(img.width-45/scale,mid+65/scale)),y:-50/scale}};
  return {move:{x,y:Math.max(45/scale,Math.min(img.height-130/scale,b.y+b.h/2))},size:{x,y:Math.max(135/scale,Math.min(img.height-45/scale,b.y+b.h))}};
 }
 function constrainBox(){if(img&&box)box=boundedMeterRect(box,img.width,img.height);}
 function circle(p,label,color){ctx.fillStyle=color;ctx.beginPath();ctx.arc(p.x*scale,p.y*scale,42,0,Math.PI*2);ctx.fill();if(label){ctx.fillStyle='#17202b';ctx.font='bold 26px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,p.x*scale,p.y*scale);}}
 function redraw(){
  if(!img)return;constrainBox();
  ctx.setTransform(1,0,0,1,0,0);ctx.clearRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#202630';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.save();ctx.translate(0,topPad);ctx.drawImage(img,0,0,img.width*scale,img.height*scale);
  const other=kind()==='window'?'separator':'window',otherBox=draft?.[other+'Rect'];
  if(otherBox){ctx.strokeStyle=other==='window'?'#4bd7bd':'#ffd166';ctx.lineWidth=2;ctx.strokeRect(otherBox.x*scale,otherBox.y*scale,otherBox.w*scale,otherBox.h*scale);}
  if(box){ctx.strokeStyle=kind()==='window'?'#4bd7bd':'#ffd166';ctx.lineWidth=3;ctx.strokeRect(box.x*scale,box.y*scale,box.w*scale,box.h*scale);
   if(true){const h=handlesOf(box);ctx.beginPath();ctx.moveTo(box.x*scale,(active==='window'?box.y:box.y+box.h/2)*scale);ctx.lineTo(h.move.x*scale,h.move.y*scale);ctx.moveTo((box.x+box.w)*scale,(active==='window'?box.y:box.y+box.h)*scale);ctx.lineTo(h.size.x*scale,h.size.y*scale);ctx.stroke();circle(h.move,'↔',ctx.strokeStyle);circle(h.size,'↘',ctx.strokeStyle);}
  }
  for(const name of ['window','separator']){const r=draft?.[name+'Rect'],confidence=draft?.[name+'Confidence'];if(r&&confidence!=null){ctx.fillStyle=name==='window'?'#4bd7bd':'#ffd166';ctx.font='bold 16px sans-serif';ctx.textAlign='left';ctx.textBaseline='top';ctx.fillText((name==='window'?'Окошко':'Разделитель')+' '+Math.round(confidence*100)+'%',Math.max(2,r.x*scale),Math.max(2,r.y*scale));}}
  ctx.restore();
  out.textContent=JSON.stringify({file:fileName,box,mode:active,annotations:draft},null,2);
 }
 function pos(ev){const r=canvas.getBoundingClientRect(),src=ev.touches?ev.touches[0]:ev;return {x:(src.clientX-r.left)*(canvas.width/r.width)/scale,y:((src.clientY-r.top)*(canvas.height/r.height)-topPad)/scale};}
 canvas.addEventListener('pointerdown',ev=>{
  if(!img)return;const p=pos(ev);trail=[];
  if(!box){if(p.y<0||p.y>img.height||p.x<0||p.x>img.width)return;const last=lastBoxes[kind()];box={x:Math.round(p.x-last.w/2),y:Math.round(p.y-last.h/2),w:last.w,h:last.h};redraw();return;}
  canvas.setPointerCapture(ev.pointerId);const h=handlesOf(box);
  if(Math.hypot(p.x-h.move.x,p.y-h.move.y)<50/scale)drag={mode:'move',x:p.x,y:p.y,bx:box.x,by:box.y};
  else if(Math.hypot(p.x-h.size.x,p.y-h.size.y)<50/scale)drag={mode:'size',x:p.x,y:p.y,bw:box.w,bh:box.h};
 });
 canvas.addEventListener('pointermove',ev=>{
  if(!drag)return;const p=pos(ev),slow=.35,dead=14;if(Math.abs(p.x-drag.x)+Math.abs(p.y-drag.y)<dead)return;
  if(!box)return;if(Date.now()-(trail.at||0)>40)trail={...box,at:Date.now()};
  if(drag.mode==='move'){box.x=Math.round(drag.bx+(p.x-drag.x)*slow);box.y=Math.round(drag.by+(p.y-drag.y)*slow);}
  else {box.w=Math.max(2,Math.round(drag.bw+(p.x-drag.x)*slow));box.h=Math.max(2,Math.round(drag.bh+(p.y-drag.y)*slow));}
  redraw();
 });
 canvas.addEventListener('pointerup',()=>{if(trail&&box){const jump=Math.abs(box.x-trail.x)+Math.abs(box.y-trail.y)+Math.abs(box.w-trail.w)+Math.abs(box.h-trail.h);if(jump>6)box={x:trail.x,y:trail.y,w:trail.w,h:trail.h};}drag=null;trail=[];redraw();});
 canvas.addEventListener('pointercancel',()=>{drag=null;trail=[];});
 document.getElementById('keep').onclick=()=>{if(box)lastBoxes[kind()]={w:box.w,h:box.h};saveMeterLabel('marked').catch(e=>out.textContent=e.message);};
 document.getElementById('wipe').onclick=async()=>{if(confirm('Очистить всю разметку? Фотографии останутся.'))try{await clearMeterAnnotations();}catch(e){out.textContent=e.message;}};
 document.getElementById('save').onclick=()=>exportMeterJSON().catch(e=>out.textContent=e.message);
 document.getElementById('drop').onclick=()=>{{box=null;if(draft){draft[kind()+'Rect']=null;draft[kind()+'Status']='unlabeled';}}redraw();};
 window.meterMarkup={
  sync(){},forget(){},
  async load(blob,name,annotations,mode='window'){
   drag=null;trail=[];fileName=name;draft=annotations;active=mode;
   if(!blob){img=null;box=null;ctx.clearRect(0,0,canvas.width,canvas.height);out.textContent='Загрузите фото.';return;}
   const next=await createImageBitmap(blob);if(img?.close)img.close();img=next;scale=Math.min(980/img.width,1);canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale)+topPad+bottomPad;box=draft[kind()+'Rect']?{...draft[kind()+'Rect']}:null;redraw();
  },
  setClass(mode,annotations){draft=annotations;active=mode;drag=null;trail=[];box=draft?.[kind()+'Rect']?{...draft[kind()+'Rect']}:null;redraw();},
  clearBox(){box=null;redraw();},getBox(){constrainBox();return box?{...box}:null;},
 };
})();
