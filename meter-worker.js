/* Meter detection: separator/window rectangles and Fast-OCR digits. */
/* All meter inference and pixel processing runs outside the UI thread. */
let runtimeMode=null;
function ensureMeterRuntime(){
 if(runtimeMode)return;
 let gpuError;
 try{importScripts(new URL('ort/ort.webgpu.min.js',self.location.href).href);runtimeMode='webgpu';}
 catch(e){gpuError=e;try{importScripts(new URL('ort/ort.wasm.min.js',self.location.href).href);runtimeMode='wasm';}catch(w){throw new Error('Не загружен ONNX Runtime: WebGPU — '+gpuError.message+'; WASM — '+w.message+'. Проверьте папку ort на сайте.');}}
 if(typeof ort==='undefined'||!ort.InferenceSession){runtimeMode=null;throw new Error('Файл ONNX Runtime не содержит InferenceSession. Проверьте папку ort.');}
 ort.env.wasm.numThreads=1;
 ort.env.wasm.wasmPaths=new URL('ort/',self.location.href).href;
 ort.env.wasm.proxy=false;
}
let det,rec,config,backend,model,detBytes,recBytes,busy=false;
let detectorDiagnostics=null;
function canvas(w,h){return new OffscreenCanvas(Math.max(1,Math.round(w)),Math.max(1,Math.round(h)));}
async function sessions(provider){
 let d,r;try{d=await ort.InferenceSession.create(detBytes,{executionProviders:[provider]});r=await ort.InferenceSession.create(recBytes,{executionProviders:[provider]});
 const dummy=canvas(320,96);dummy.getContext('2d').fillRect(0,0,320,96);
 const feed=detectorInput(dummy);const test=await d.run({[d.inputNames[0]]:feed.tensor});
 detectorDiagnostics={provider,inputName:d.inputNames[0],inputShape:feed.tensor.dims,outputNames:d.outputNames,outputs:Object.entries(test).map(([name,t])=>({name,dims:t.dims,type:t.type,length:t.data?.length})),files:config.modelDiagnostics||[],detector:config.det};
 decodeDetector(test[d.outputNames[0]],feed,dummy);await r.run({[r.inputNames[0]]:recognizerInput(dummy)});
 
 det=d;rec=r;backend=provider;
 }catch(e){if(d)await d.release();if(r)await r.release();throw e;}
}
async function initialize(data){
 ensureMeterRuntime();
 if(model===data.model&&det&&rec)return;
 if(det)await det.release();if(rec)await rec.release();det=rec=null;
 config=data.config;model=data.model;detBytes=data.det;recBytes=data.rec;
 if(runtimeMode==='webgpu'&&data.gpu!=='no'&&self.navigator.gpu){try{await sessions('webgpu');return;}catch(e){detectorDiagnostics={...detectorDiagnostics,webgpuError:e.message};}}
 await sessions('wasm');
}
function crop(source,box){const c=canvas(box.right-box.left,box.bottom-box.top);c.getContext('2d').drawImage(source,box.left,box.top,box.right-box.left,box.bottom-box.top,0,0,c.width,c.height);return c;}
function photo(c){const image=c.getContext('2d').getImageData(0,0,c.width,c.height);return {width:c.width,height:c.height,data:image.data};}
function defaultMeterReading(text){
 const digits=text.replace(/\s/g,'');
 if(!/^\d+$/.test(digits))return {reading:'',displayDigits:[],decimalIndex:null,review:'Цифры не прочитаны. Проверьте снимок.'};
 const whole=(digits.length>1?digits.slice(0,-1):'0'),fraction=digits.slice(-1);
 return {reading:whole+','+fraction,displayDigits:Array.from(whole+fraction),decimalIndex:whole.length,review:'Последняя цифра принята за один дробный разряд. Проверьте показание.'};
}
function decodeDetector(output,feed,image){
 if(!output||output.dims.length!==3||output.dims[0]!==1||output.dims[1]!==6)throw new Error('Неверный выход детектора: получено '+JSON.stringify(output?.dims??null)+', ожидается [1,6,N].\nДиагностика: '+JSON.stringify(detectorDiagnostics));
 const n=output.dims[2],a=output.data,items=[];
 const px=x=>(x-feed.left)/feed.scaleX,py=y=>(y-feed.top)/feed.scaleY;
 for(let i=0;i<n;i++){
 const classId=a[4*n+i]>=a[5*n+i]?0:1,conf=a[(4+classId)*n+i];
 const cx=a[i],cy=a[n+i],w=a[2*n+i],h=a[3*n+i];
 if(conf<.25||![cx,cy,w,h,conf].every(Number.isFinite)||w<=0||h<=0)continue;
 const left=Math.max(0,px(cx-w/2)),right=Math.min(image.width,px(cx+w/2)),top=Math.max(0,py(cy-h/2)),bottom=Math.min(image.height,py(cy+h/2));
 if(right<=left||bottom<=top)continue;
 items.push({left,right,top,bottom,conf,classId});
 }
 const iou=(a,b)=>{const area=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));return area/((a.right-a.left)*(a.bottom-a.top)+(b.right-b.left)*(b.bottom-b.top)-area);};
 const kept=[];for(const item of items.sort((a,b)=>b.conf-a.conf))if(kept.every(k=>k.classId!==item.classId||iou(k,item)<.45))kept.push(item);return kept;
}
function sourceImage(im){const c=canvas(im.width,im.height);c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(im.data),im.width,im.height),0,0);return c;}
async function findMeterObjects(source){const feed=detectorInput(source),out=await det.run({[det.inputNames[0]]:feed.tensor});return decodeDetector(out[det.outputNames[0]],feed,source);}
function paddedWindow(box,source){const x=(box.right-box.left)*.06,y=(box.bottom-box.top)*.10;return {...box,left:Math.max(0,box.left-x),top:Math.max(0,box.top-y),right:Math.min(source.width,box.right+x),bottom:Math.min(source.height,box.bottom+y)};}
async function locateMeter(data){const source=sourceImage(data.image),win=(await findMeterObjects(source)).find(b=>b.classId===1);if(!win)return {found:false};const box=paddedWindow(win,source);return {found:true,box,bounds:{left:box.left,top:box.top,right:box.right,bottom:box.bottom}};}
async function annotateMeter(data){const boxes=await findMeterObjects(sourceImage(data.image)),win=boxes.find(b=>b.classId===1),sep=boxes.find(b=>b.classId===0),rect=b=>b?{x:b.left,y:b.top,w:b.right-b.left,h:b.bottom-b.top}:null;
 return {windowRect:rect(win),windowConfidence:win?.conf??null,separatorRect:rect(sep),separatorConfidence:sep?.conf??null,located:Boolean(win),text:'',backend};}
async function recognizeMeter(data){
 const started=performance.now(),source=sourceImage(data.image),dt=performance.now(),boxes=data.options.prelocated?[data.options.prelocated.box]:await findMeterObjects(source),detMs=performance.now()-dt;
 const windows=boxes.filter(b=>b.classId===1).slice(0,8).map(b=>data.options.prelocated?b:paddedWindow(b,source));let separators=[];
 if(!windows.length){const processed=photo(source),original=photo(source),identity={bounds:{left:0,top:0,right:source.width,bottom:source.height},processed:source};return {located:false,text:'',reading:'',displayDigits:[],decimalIndex:null,review:'Окошко моделью не найдено.',original,processed,overlayDetections:markerPreviewBoxes(identity,separators).map(b=>({...b,classId:0,label:'Разделитель'})),selected:0,candidates:[],geometry:'Сохранён исходный кадр.',backend,stats:{det:detMs,rec:0,total:performance.now()-started}};}
 const candidates=[];let recMs=0;
 for(const box of windows){
 const bounds={left:box.left,top:box.top,right:box.right,bottom:box.bottom},original=crop(source,bounds);
 const processed=original;
 const t=performance.now(),out=await rec.run({[rec.inputNames[0]]:recognizerInput(processed)}),decoded=decodeFastOCR(out);recMs+=performance.now()-t;
 candidates.push({...box,...decoded,bounds,original,processed,score:box.conf+decoded.conf+(/^\d+$/.test(decoded.text)?1:0)});
 }
 const selected=Number.isInteger(data.options.candidate)&&data.options.candidate>=0&&data.options.candidate<candidates.length?data.options.candidate:candidates.reduce((best,c,i)=>c.score>candidates[best].score?i:best,0),chosen=candidates[selected];
 const markerStart=performance.now();separators=(await findMeterObjects(chosen.original)).filter(b=>b.classId===0).map(b=>({...b,left:b.left+chosen.bounds.left,right:b.right+chosen.bounds.left,top:b.top+chosen.bounds.top,bottom:b.bottom+chosen.bounds.top}));
 const markerMs=performance.now()-markerStart;
 let parsed=defaultMeterReading(chosen.text);
 if(data.options.fractionModel){const match=separatorBoundary(chosen,separators),numeric=/^\d+$/.test(chosen.text);
 if(match&&numeric){const whole=chosen.text.slice(0,match.index),fraction=chosen.text.slice(match.index);parsed={reading:whole+','+fraction,displayDigits:Array.from(chosen.text),decimalIndex:match.index,review:'Разделитель: '+match.kind+'. Дробных разрядов: '+fraction.length+'. Проверьте показание.'};}
 else parsed={reading:numeric?chosen.text:'',displayDigits:numeric?Array.from(chosen.text):[],decimalIndex:null,review:separators.length?'Разделитель найден, но граница дробной части неоднозначна. Проверьте вручную.':'Разделитель не найден. Проверьте дробную часть вручную.'};}

 const overlayDetections=markerPreviewBoxes(chosen,[chosen,...separators]).map((b,i)=>({...b,classId:i===0?1:0,label:i===0?'Окошко':'Разделитель'}));
 return {...parsed,located:true,separatorRect:separators[0]?{x:separators[0].left,y:separators[0].top,w:separators[0].right-separators[0].left,h:separators[0].bottom-separators[0].top}:null,separatorConfidence:separators[0]?.conf??null,windowConfidence:chosen.conf,windowRect:{x:chosen.left,y:chosen.top,w:chosen.right-chosen.left,h:chosen.bottom-chosen.top},digitBoxes:chosen.digitBoxes||[],text:chosen.text,original:photo(chosen.original),processed:photo(chosen.processed),training:photo(source),overlayDetections,selected,candidates:candidates.map(c=>({text:c.text,conf:c.conf})),geometry:'Прямоугольная вырезка окошка.',backend,stats:{det:detMs,marker:markerMs,rec:recMs,total:performance.now()-started,input:'640 × 640 → 384 × 128'}};
}
self.onmessage=async({data})=>{
 if(busy){self.postMessage({id:data.id,error:'Обработка уже идёт'});return;}busy=true;
 try{
 let result;
 if(data.type==='init'){await initialize(data);result={backend,diagnostics:detectorDiagnostics};}
 else if(data.type==='recognize'||data.type==='annotate'||data.type==='locate'){
 const process=data.type==='locate'?locateMeter:data.type==='annotate'?annotateMeter:recognizeMeter;
 try{result=await process(data);}catch(e){if(backend!=='webgpu')throw e;await det.release();await rec.release();det=rec=null;await sessions('wasm');result=await process(data);result.fallback=true;}
 }else throw new Error('Неизвестная операция');
 const transfer=result.original?[result.original.data.buffer,result.processed.data.buffer]:[];if(result.training)transfer.push(result.training.data.buffer);self.postMessage({id:data.id,...result},transfer);
 }catch(e){self.postMessage({id:data.id,error:e.message});}finally{busy=false;}
};

function recognizerInput(image){
 const w=384,h=128,c=canvas(w,h),ctx=c.getContext('2d');ctx.drawImage(image,0,0,w,h);
 const rgba=ctx.getImageData(0,0,w,h).data,data=new Float32Array(3*w*h);
 for(let i=0;i<w*h;i++)for(let ch=0;ch<3;ch++)data[ch*w*h+i]=rgba[i*4+ch]/255;
 return new ort.Tensor('float32',data,[1,3,h,w]);
}
function decodeFastOCR(outputs){
 const digits=[],sigmoid=x=>1/(1+Math.exp(-Math.max(-80,Math.min(80,x))));
 for(const spec of config.recHeads){
  const out=outputs[spec.output];if(!out||out.dims[1]!==45)throw new Error('Неверный выход Fast-OCR');
  const gh=out.dims[2],gw=out.dims[3],n=gh*gw;
  for(let a=0;a<3;a++)for(let i=0;i<n;i++){
   const base=a*15*n,obj=sigmoid(out.data[base+4*n+i]);if(obj<.25)continue;
   let digit=0,prob=0;for(let j=0;j<10;j++){const v=sigmoid(out.data[base+(5+j)*n+i]);if(v>prob){prob=v;digit=j;}}
   const conf=obj*prob;if(conf<.25)continue;
   const x=(i%gw+sigmoid(out.data[base+i]))/gw*384,y=(Math.floor(i/gw)+sigmoid(out.data[base+n+i]))/gh*128;
   const w=Math.exp(Math.min(15,out.data[base+2*n+i]))*spec.anchors[a][0],h=Math.exp(Math.min(15,out.data[base+3*n+i]))*spec.anchors[a][1];
   if(!Number.isFinite(w)||!Number.isFinite(h))continue;digits.push({x,y,w,h,digit,conf});
  }
 }
 const overlap=(a,b)=>{const intersection=Math.max(0,Math.min(a.x+a.w/2,b.x+b.w/2)-Math.max(a.x-a.w/2,b.x-b.w/2))*Math.max(0,Math.min(a.y+a.h/2,b.y+b.h/2)-Math.max(a.y-a.h/2,b.y-b.h/2));return intersection/(a.w*a.h+b.w*b.h-intersection);};
 const kept=[];for(const d of digits.sort((a,b)=>b.conf-a.conf))if(kept.every(k=>overlap(k,d)<.45))kept.push(d);
 kept.sort((a,b)=>a.x-b.x);return {digitBoxes:kept.map(d=>({left:(d.x-d.w/2)/384,right:(d.x+d.w/2)/384,top:(d.y-d.h/2)/128,bottom:(d.y+d.h/2)/128})),text:kept.map(d=>d.digit).join(''),conf:kept.length?kept.reduce((s,d)=>s+d.conf,0)/kept.length:0};
}


function detectorInput(image){
 const size=config.size,c=canvas(size,size),ctx=c.getContext('2d'),scale=Math.min(size/image.width,size/image.height),w=Math.max(1,Math.round(image.width*scale)),h=Math.max(1,Math.round(image.height*scale)),left=Math.floor((size-w)/2),top=Math.floor((size-h)/2);
 ctx.fillStyle='rgb(114,114,114)';ctx.fillRect(0,0,size,size);ctx.drawImage(image,left,top,w,h);
 const rgba=ctx.getImageData(0,0,size,size).data,data=new Float32Array(3*size*size);for(let i=0;i<size*size;i++)for(let ch=0;ch<3;ch++)data[ch*size*size+i]=rgba[i*4+ch]/255;
 return {tensor:new ort.Tensor('float32',data,[1,3,size,size]),left,top,scaleX:w/image.width,scaleY:h/image.height};
}
function separatorBoundary(chosen,separators){
 const digits=(chosen.digitBoxes||[]).map(d=>({left:chosen.bounds.left+d.left*(chosen.bounds.right-chosen.bounds.left),right:chosen.bounds.left+d.right*(chosen.bounds.right-chosen.bounds.left),top:chosen.bounds.top+d.top*(chosen.bounds.bottom-chosen.bounds.top),bottom:chosen.bounds.top+d.bottom*(chosen.bounds.bottom-chosen.bounds.top)}));
 if(digits.length<2)return null;
 const median=values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)],dw=median(digits.map(d=>d.right-d.left)),dh=median(digits.map(d=>d.bottom-d.top));
 const matches=[];
 for(const sep of separators){
  const sx=(sep.left+sep.right)/2,sy=(sep.top+sep.bottom)/2,sw=sep.right-sep.left,sh=sep.bottom-sep.top;
  const rowTop=Math.min(...digits.map(d=>d.top)),rowBottom=Math.max(...digits.map(d=>d.bottom));
  if(sy<rowTop-dh*.25||sy>rowBottom+dh*.25)continue;
  if(sw<dw*.55&&sh<dh*.5){
   for(let i=1;i<digits.length;i++){
    const a=digits[i-1],b=digits[i],ac=(a.left+a.right)/2,bc=(b.left+b.right)/2;
    if(sx>ac&&sx<bc&&sx>=a.right-dw*.25&&sx<=b.left+dw*.25&&sy>=rowTop+dh*.45)matches.push({index:i,kind:'точка',conf:sep.conf});
   }
  }else{
   const i=digits.findIndex(d=>{const center=(d.left+d.right)/2,overlap=Math.max(0,Math.min(d.bottom,sep.bottom)-Math.max(d.top,sep.top));return center>=sep.left-dw*.1&&center<=sep.right+dw*.1&&overlap>=Math.min(dh,sh)*.3;});
   if(i>0)matches.push({index:i,kind:'метка вокруг разряда',conf:sep.conf});
  }
 }
 if(!matches.length||new Set(matches.map(m=>m.index)).size>1)return null;
 return matches.sort((a,b)=>b.conf-a.conf)[0];
}

function markerPreviewBoxes(chosen,boxes){
 const map=(x,y)=>({x:(x-chosen.bounds.left)*chosen.processed.width/(chosen.bounds.right-chosen.bounds.left),y:(y-chosen.bounds.top)*chosen.processed.height/(chosen.bounds.bottom-chosen.bounds.top)});
 return boxes.map(box=>({conf:box.conf,points:[[box.left,box.top],[box.right,box.top],[box.right,box.bottom],[box.left,box.bottom]].map(([x,y])=>map(x,y))}));
}
