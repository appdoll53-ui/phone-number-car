/* Meter pipeline v81: optional trained red-marker detector. */
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
let det,rec,marker,config,backend,model,detBytes,recBytes,markerBytes,busy=false;
function canvas(w,h){return new OffscreenCanvas(Math.max(1,Math.round(w)),Math.max(1,Math.round(h)));}
async function sessions(provider){
 let d,r,m;try{d=await ort.InferenceSession.create(detBytes,{executionProviders:[provider]});r=await ort.InferenceSession.create(recBytes,{executionProviders:[provider]});
 const dummy=canvas(320,96);dummy.getContext('2d').fillRect(0,0,320,96);
 const test=await d.run({[d.inputNames[0]]:markerInput(dummy).tensor});decodePose(test[d.outputNames[0]],markerInput(dummy),dummy);await r.run({[r.inputNames[0]]:recognizerInput(dummy)});
 
 det=d;rec=r;marker=m;backend=provider;
 }catch(e){if(d)await d.release();if(r)await r.release();if(m)await m.release();throw e;}
}
async function initialize(data){
 ensureMeterRuntime();
 if(model===data.model&&det&&rec)return;
 if(det)await det.release();if(rec)await rec.release();if(marker)await marker.release();det=rec=marker=null;
 config=data.config;model=data.model;detBytes=data.det;recBytes=data.rec;markerBytes=data.marker;
 if(runtimeMode==='webgpu'&&data.gpu!=='no'&&self.navigator.gpu){try{await sessions('webgpu');return;}catch(_){}}
 await sessions('wasm');
}
function crop(source,box){const c=canvas(box.right-box.left,box.bottom-box.top);c.getContext('2d').drawImage(source,box.left,box.top,box.right-box.left,box.bottom-box.top,0,0,c.width,c.height);return c;}
function photo(c){const image=c.getContext('2d').getImageData(0,0,c.width,c.height);return {width:c.width,height:c.height,data:image.data};}
function safeQuad(q){
 if(!q)return false;const length=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),s=q.map((p,i)=>length(p,q[(i+1)%4]));
 if(Math.min(...s)<8||s[0]/s[2]>1.7||s[2]/s[0]>1.7||s[1]/s[3]>1.7||s[3]/s[1]>1.7)return false;
 const crosses=q.map((p,i)=>{const a=q[(i+1)%4],b=q[(i+2)%4];return(a.x-p.x)*(b.y-a.y)-(a.y-p.y)*(b.x-a.x);});
 return crosses.every(x=>x>0)||crosses.every(x=>x<0);
}
function defaultMeterReading(text){
 const digits=text.replace(/\s/g,'');
 if(!/^\d+$/.test(digits))return {reading:'',displayDigits:[],decimalIndex:null,review:'Цифры не прочитаны. Проверьте снимок.'};
 const whole=(digits.length>1?digits.slice(0,-1):'0'),fraction=digits.slice(-1);
 return {reading:whole+','+fraction,displayDigits:Array.from(whole+fraction),decimalIndex:whole.length,review:'Последняя цифра принята за один дробный разряд. Проверьте показание.'};
}
function decodePose(output,feed,image){
 if(!output||output.dims.length!==3||output.dims[0]!==1||![6,18].includes(output.dims[1]))throw new Error('meter_pose.onnx: ожидается [1,6,N] (два класса) или [1,18,N] (Pose). Экспортируйте без NMS, размер 640.');
 const n=output.dims[2],a=output.data,items=[];
 const px=x=>(x-feed.left)/feed.scaleX,py=y=>(y-feed.top)/feed.scaleY;
 for(let i=0;i<n;i++){
 const classId=a[4*n+i]>=a[5*n+i]?0:1,conf=a[(4+classId)*n+i];
 const cx=a[i],cy=a[n+i],w=a[2*n+i],h=a[3*n+i];
 if(conf<.25||![cx,cy,w,h,conf].every(Number.isFinite)||w<=0||h<=0)continue;
 const left=Math.max(0,px(cx-w/2)),right=Math.min(image.width,px(cx+w/2)),top=Math.max(0,py(cy-h/2)),bottom=Math.min(image.height,py(cy+h/2));
 if(right<=left||bottom<=top)continue;
 const quad=null; // Keypoints are ignored: only object detection is used.
 items.push({left,right,top,bottom,conf,classId,quad});
 }
 const iou=(a,b)=>{const area=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));return area/((a.right-a.left)*(a.bottom-a.top)+(b.right-b.left)*(b.bottom-b.top)-area);};
 const kept=[];for(const item of items.sort((a,b)=>b.conf-a.conf))if(kept.every(k=>k.classId!==item.classId||iou(k,item)<.45))kept.push(item);return kept;
}
function sourceImage(im){const c=canvas(im.width,im.height);c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(im.data),im.width,im.height),0,0);return c;}
async function poseFind(source){const feed=markerInput(source),out=await det.run({[det.inputNames[0]]:feed.tensor});return decodePose(out[det.outputNames[0]],feed,source);}
async function poseCorners(data){const boxes=await poseFind(sourceImage(data.image)),r=data.windowRect;
 const box=r?boxes.filter(b=>b.classId===1).sort((a,b)=>Math.hypot((a.left+a.right)/2-r.x-r.w/2,(a.top+a.bottom)/2-r.y-r.h/2)-Math.hypot((b.left+b.right)/2-r.x-r.w/2,(b.top+b.bottom)/2-r.y-r.h/2))[0]:boxes.find(b=>b.classId===1);
 return {windowCorners:box?.quad?.map(p=>({x:p.x,y:p.y,v:2}))||null};}
async function annotateMeter(data){const boxes=await poseFind(sourceImage(data.image)),win=boxes.find(b=>b.classId===1),sep=boxes.find(b=>b.classId===0),rect=b=>b?{x:b.left,y:b.top,w:b.right-b.left,h:b.bottom-b.top}:null;
 return {windowRect:rect(win),windowCorners:win?.quad?.map(p=>({x:p.x,y:p.y,v:2}))||null,windowConfidence:win?.conf??null,separatorRect:rect(sep),separatorConfidence:sep?.conf??null,located:Boolean(win),text:'',backend};}
async function recognizeMeter(data){
 const started=performance.now(),source=sourceImage(data.image),dt=performance.now(),boxes=await poseFind(source),detMs=performance.now()-dt;
 const windows=boxes.filter(b=>b.classId===1).slice(0,8),separators=boxes.filter(b=>b.classId===0);
 if(!windows.length){const processed=photo(source),original=photo(source),identity={bounds:{left:0,top:0,right:source.width,bottom:source.height},processed:source,contextRect:{left:0,top:0},rectified:false};return {located:false,text:'',reading:'',displayDigits:[],decimalIndex:null,review:'Окошко моделью не найдено.',original,processed,overlayDetections:markerPreviewBoxes(identity,separators).map(b=>({...b,classId:0,label:'Разделитель'})),selected:0,candidates:[],geometry:'Сохранён исходный кадр.',backend,stats:{det:detMs,rec:0,total:performance.now()-started}};}
 const candidates=[];let recMs=0;
 for(const box of windows){
 const quad=box.quad,bounds={left:box.left,top:box.top,right:box.right,bottom:box.bottom},original=crop(source,bounds);
 const rectified=false,processed=original;
 const t=performance.now(),out=await rec.run({[rec.inputNames[0]]:recognizerInput(processed)}),decoded=decodeFastOCR(out);recMs+=performance.now()-t;
 candidates.push({...box,...decoded,bounds,quad,original,processed,rectified,contextRect:{left:0,top:0},score:box.conf+decoded.conf+(/^\d+$/.test(decoded.text)?1:0)});
 }
 const selected=Number.isInteger(data.options.candidate)&&data.options.candidate>=0&&data.options.candidate<candidates.length?data.options.candidate:candidates.reduce((best,c,i)=>c.score>candidates[best].score?i:best,0),chosen=candidates[selected];
 let parsed=defaultMeterReading(chosen.text);
 if(data.options.fractionModel){const match=markerLastDigit(chosen,separators),numeric=/^\d+$/.test(chosen.text);
 if(match&&numeric)parsed={...parsed,review:'Модель нашла разделитель последнего разряда · '+Math.round(match.conf*100)+'%. Проверьте показание.'};
 else parsed={reading:numeric?chosen.text:'',displayDigits:numeric?Array.from(chosen.text):[],decimalIndex:null,review:separators.length?'Разделитель не сопоставлен с последней цифрой. Проверьте вручную.':'Разделитель не найден. Проверьте дробную часть вручную.'};}
 const overlayDetections=markerPreviewBoxes(chosen,[chosen,...separators]).map((b,i)=>({...b,classId:i===0?1:0,label:i===0?'Окошко':'Разделитель'}));
 return {...parsed,located:true,separatorRect:separators[0]?{x:separators[0].left,y:separators[0].top,w:separators[0].right-separators[0].left,h:separators[0].bottom-separators[0].top}:null,separatorConfidence:separators[0]?.conf??null,windowConfidence:chosen.conf,windowRect:{x:chosen.left,y:chosen.top,w:chosen.right-chosen.left,h:chosen.bottom-chosen.top},windowCorners:chosen.quad?.map(p=>({x:p.x,y:p.y,v:2}))||null,text:chosen.text,original:photo(chosen.original),processed:photo(chosen.processed),training:photo(source),overlayDetections,selected,candidates:candidates.map(c=>({text:c.text,conf:c.conf})),geometry:'Прямоугольная вырезка окошка без выравнивания перспективы.',backend,stats:{det:detMs,rec:recMs,total:performance.now()-started,input:'640 × 640 → 384 × 128'}};
}
self.onmessage=async({data})=>{
 if(busy){self.postMessage({id:data.id,error:'Обработка уже идёт'});return;}busy=true;
 try{
 let result;
 if(data.type==='init'){await initialize(data);result={backend};}
 else if(data.type==='corners'){result=await poseCorners(data);}
 else if(data.type==='recognize'||data.type==='annotate'){
 const process=data.type==='annotate'?annotateMeter:recognizeMeter;
 try{result=await process(data);}catch(e){if(backend!=='webgpu')throw e;await det.release();await rec.release();if(marker)await marker.release();det=rec=marker=null;await sessions('wasm');result=await process(data);result.fallback=true;}
 }else throw new Error('Неизвестная операция');
 const transfer=result.original?[result.original.data.buffer,result.processed.data.buffer]:[];if(result.training)transfer.push(result.training.data.buffer);self.postMessage({id:data.id,...result},transfer);
 }catch(e){self.postMessage({id:data.id,error:e.message});}finally{busy=false;}
};

function convexHull(points) {
  const cross=(o,a,b)=>(a.x-o.x)*(b.y-o.y)-(a.y-o.y)*(b.x-o.x);
  const sorted=points.slice().sort((a,b)=>a.x-b.x||a.y-b.y);
  const lower=[],upper=[];
  for(const p of sorted){while(lower.length>=2&&cross(lower.at(-2),lower.at(-1),p)<=0)lower.pop();lower.push(p);}
  for(const p of sorted.slice().reverse()){while(upper.length>=2&&cross(upper.at(-2),upper.at(-1),p)<=0)upper.pop();upper.push(p);}
  return lower.slice(0,-1).concat(upper.slice(0,-1));
}

function quadFromHull(hull) {
  const points=hull.slice();
  while(points.length>4){
    let smallest=Infinity,index=-1;
    points.forEach((b,i)=>{
      const a=points[(i+points.length-1)%points.length],c=points[(i+1)%points.length];
      const area=Math.abs((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x));
      if(area<smallest){smallest=area;index=i;}
    });
    points.splice(index,1);
  }
  if(points.length!==4)return null;
  const start=points.reduce((best,p,i)=>p.x+p.y<points[best].x+points[best].y?i:best,0);
  let ordered=points.slice(start).concat(points.slice(0,start));
  if(ordered[1].x<ordered[3].x)ordered=[ordered[0],ordered[3],ordered[2],ordered[1]];
  return ordered;
}

function projectiveMap(corners,width,height) {
  const dest=[[0,0],[width-1,0],[width-1,height-1],[0,height-1]],matrix=[];
  for(let i=0;i<4;i++){
    const [x,y]=dest[i],u=corners[i].x,v=corners[i].y;
    matrix.push([x,y,1,0,0,0,-u*x,-u*y,u]);matrix.push([0,0,0,x,y,1,-v*x,-v*y,v]);
  }
  for(let col=0;col<8;col++){
    let pivot=col;for(let row=col+1;row<8;row++)if(Math.abs(matrix[row][col])>Math.abs(matrix[pivot][col]))pivot=row;
    if(Math.abs(matrix[pivot][col])<1e-9)return null;
    [matrix[col],matrix[pivot]]=[matrix[pivot],matrix[col]];const divisor=matrix[col][col];
    for(let k=col;k<=8;k++)matrix[col][k]/=divisor;
    for(let row=0;row<8;row++)if(row!==col){const factor=matrix[row][col];for(let k=col;k<=8;k++)matrix[row][k]-=factor*matrix[col][k];}
  }
  return matrix.map(row=>row[8]);
}

function warpPlate(source,corners) {
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  let width=(distance(corners[0],corners[1])+distance(corners[3],corners[2]))/2;
  let height=(distance(corners[0],corners[3])+distance(corners[1],corners[2]))/2;
  const scale=Math.min(1,1200/Math.max(width,height));width=Math.max(2,Math.round(width*scale));height=Math.max(2,Math.round(height*scale));
  const coefficients=projectiveMap(corners,width,height);if(!coefficients)return source;
  const src=source.getContext("2d",{willReadFrequently:true}).getImageData(0,0,source.width,source.height).data;
  const canvas=new OffscreenCanvas(1,1);canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext("2d"),image=ctx.createImageData(width,height),out=image.data,c=coefficients;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const denominator=c[6]*x+c[7]*y+1;
    const u=(c[0]*x+c[1]*y+c[2])/denominator,v=(c[3]*x+c[4]*y+c[5])/denominator;
    const index=(y*width+x)*4;out[index+3]=255;
    if(!Number.isFinite(u)||!Number.isFinite(v)||u<0||v<0||u>source.width-1||v>source.height-1){out[index]=out[index+1]=out[index+2]=255;continue;}
    const x0=Math.floor(u),y0=Math.floor(v),x1=Math.min(x0+1,source.width-1),y1=Math.min(y0+1,source.height-1),fx=u-x0,fy=v-y0;
    for(let channel=0;channel<3;channel++)out[index+channel]=Math.round(src[(y0*source.width+x0)*4+channel]*(1-fx)*(1-fy)+src[(y0*source.width+x1)*4+channel]*fx*(1-fy)+src[(y1*source.width+x0)*4+channel]*(1-fx)*fy+src[(y1*source.width+x1)*4+channel]*fx*fy);
  }
  ctx.putImageData(image,0,0);return canvas;
}


function meterWindows(source,textBoxes,adaptive=false){
 const scale=Math.min(1,600/Math.max(source.width,source.height)),c=canvas(source.width*scale,source.height*scale),w=c.width,h=c.height,ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0,w,h);
 const pix=ctx.getImageData(0,0,w,h).data,gray=new Uint8Array(w*h);for(let i=0;i<gray.length;i++)gray[i]=pix[i*4]*.299+pix[i*4+1]*.587+pix[i*4+2]*.114;
 const results=[];
 for(const threshold of (adaptive?[otsuThreshold(gray)]:[55,75,95])){
 const values=adaptive?closeMask(gray,w,h,threshold):gray,cutoff=adaptive?127:threshold;
 const seen=new Uint8Array(w*h),q=new Int32Array(w*h);
 for(let seed=0;seed<gray.length;seed++){
 if(seen[seed]||values[seed]>cutoff)continue;let head=0,tail=1;seen[seed]=1;q[0]=seed;const boundary=[];
 while(head<tail){const i=q[head++],x=i%w,y=Math.floor(i/w);let edge=false;for(const j of [x?i-1:-1,x<w-1?i+1:-1,y?i-w:-1,y<h-1?i+w:-1]){if(j<0||values[j]>cutoff)edge=true;else if(!seen[j]){seen[j]=1;q[tail++]=j;}}if(edge)boundary.push({x:x/scale,y:y/scale});}
 if(tail<w*h*.012||tail>w*h*(adaptive?.8:.25))continue;
 const hull=convexHull(boundary),quad=quadFromHull(hull);if(!safeQuad(quad))continue;
 const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),width=(distance(quad[0],quad[1])+distance(quad[2],quad[3]))/2,height=(distance(quad[0],quad[3])+distance(quad[1],quad[2]))/2;
 const area=Math.abs(quad.reduce((s,p,i)=>s+p.x*quad[(i+1)%4].y-p.y*quad[(i+1)%4].x,0))/2,fill=tail/(area*scale*scale);
 if(width/height<2||width/height>12||fill<.5)continue;
 const left=Math.min(...quad.map(p=>p.x)),right=Math.max(...quad.map(p=>p.x)),top=Math.min(...quad.map(p=>p.y)),bottom=Math.max(...quad.map(p=>p.y));
 const hits=textBoxes.filter(b=>(b.left+b.right)/2>left&&(b.left+b.right)/2<right&&(b.top+b.bottom)/2>top&&(b.top+b.bottom)/2<bottom).length;
 if(!hits)continue;
 // Require rectangular support: a fragmented silhouette must not drive a warp.
 if(hull.length>4){const quadArea=area,hullArea=Math.abs(hull.reduce((s,p,i)=>s+p.x*hull[(i+1)%hull.length].y-p.y*hull[(i+1)%hull.length].x,0))/2;if(quadArea/hullArea<.85)continue;}
 const pad=height*.045;const cx=quad.reduce((s,p)=>s+p.x,0)/4,cy=quad.reduce((s,p)=>s+p.y,0)/4;
 results.push({left:Math.max(0,left-pad),right:Math.min(source.width,right+pad),top:Math.max(0,top-height*.20),bottom:Math.min(source.height,bottom+height*.20),quad:quad.map(p=>({x:Math.max(0,Math.min(source.width-1,cx+(p.x-cx)*1.025)),y:Math.max(0,Math.min(source.height-1,p.y+(p.y>cy?height*.20:-height*.04)))})),window:true,rank:area*fill*(1+hits*2)});
 }
 }
 return results.sort((a,b)=>b.rank-a.rank).slice(0,6);
}

// Red marks have priority. Contours are analysed on a separate grayscale mask;
// the colour image used for OCR is never thresholded.
function groupMeterRows(items,iw,ih){
 const groups=[];
 // Seed every region; extend along a line without joining vertically stacked rows.
 for(const seed of items){
 const sh=seed.bottom-seed.top,cy=(seed.top+seed.bottom)/2;
 const row=items.filter(b=>{const bh=b.bottom-b.top;return bh/sh>=.5&&bh/sh<=2&&Math.abs((b.top+b.bottom)/2-cy)<=Math.min(sh,bh)*.38+Math.abs((b.left+b.right-seed.left-seed.right)/2)*.08;}).sort((a,b)=>a.left-b.left);
 let segment=[];
 const flush=()=>{
 if(!segment.length)return;
 const left=Math.min(...segment.map(b=>b.left)),right=Math.max(...segment.map(b=>b.right)),top=Math.min(...segment.map(b=>b.top)),bottom=Math.max(...segment.map(b=>b.bottom)),height=bottom-top,width=right-left;
 if(width>=iw*.18&&width/height>=1.7&&(segment.length>=2||width/height>=2.5)){
 const pad=height*.12,group={left:Math.max(0,left-pad),right:Math.min(iw,right+pad),top:Math.max(0,top-height*.06),bottom:Math.min(ih,bottom+height*.24),count:segment.length};
 const dx=((left+right)/2/iw-.5),dy=((top+bottom)/2/ih-.5);
 group.rank=height/ih*4+Math.min(width/iw,.8)+Math.min(segment.length,6)*.08-Math.hypot(dx,dy)*1.4;
 const duplicate=groups.some(g=>Math.abs(g.left-group.left)<height*.3&&Math.abs(g.top-group.top)<height*.25&&Math.abs(g.right-group.right)<height*.3);
 if(!duplicate)groups.push(group);
 }
 segment=[];
 };
 for(const b of row){if(segment.length){const prev=segment.at(-1),gap=b.left-prev.right;if(gap>Math.min(sh,b.bottom-b.top)*1.8)flush();}segment.push(b);}flush();
 }
 return groups.sort((a,b)=>b.rank-a.rank);
}
function chooseMeterAreas(source,textBoxes){
 const groups=groupMeterRows(textBoxes,source.width,source.height),windows=meterWindows(source,textBoxes),areas=[];
 for(const group of groups){
 const gw=group.right-group.left,gh=group.bottom-group.top;
 const local=localMeterWindows(source,textBoxes,group);
 const win=[...local,...windows].find(b=>{const ww=b.right-b.left,hh=b.bottom-b.top,overlap=Math.max(0,Math.min(group.right,b.right)-Math.max(group.left,b.left));return overlap/gw>.7&&ww<gw*2.1&&ww>gw*.7&&hh<gh*2.1&&Math.abs((group.top+group.bottom-b.top-b.bottom)/2)<gh*.5;});
 const area=win?{...win,rank:group.rank+.3}:{...group};
 if(!areas.some(b=>Math.abs(b.left-area.left)<gh*.3&&Math.abs(b.top-area.top)<gh*.3&&Math.abs(b.right-area.right)<gh*.3))areas.push(area);
 }
 // A confirmed wide rectangular window can survive missed characters in the text detector.
 if(!areas.length&&windows.length)areas.push({...windows[0],rank:0});
 return areas.sort((a,b)=>b.rank-a.rank).slice(0,4);
}

function otsuThreshold(gray){const hist=new Uint32Array(256);let total=0;for(const v of gray){hist[v]++;total+=v;}let count=0,sum=0,best=-1,threshold=127;for(let i=0;i<255;i++){count+=hist[i];sum+=i*hist[i];if(!count||count===gray.length)continue;const diff=sum/count-(total-sum)/(gray.length-count),score=count*(gray.length-count)*diff*diff;if(score>best){best=score;threshold=i;}}return threshold;}
function closeMask(gray,w,h,threshold){
 const mask=Uint8Array.from(gray,v=>v<=threshold?1:0),dilated=new Uint8Array(w*h),out=new Uint8Array(w*h),radius=Math.max(1,Math.min(3,Math.round(w/200)));
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){let hit=0;for(let dy=-radius;dy<=radius&&!hit;dy++)for(let dx=-radius;dx<=radius;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&xx<w&&yy>=0&&yy<h&&mask[yy*w+xx]){hit=1;break;}}dilated[y*w+x]=hit;}
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){let hit=1;for(let dy=-radius;dy<=radius&&hit;dy++)for(let dx=-radius;dx<=radius;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&xx<w&&yy>=0&&yy<h&&!dilated[yy*w+xx]){hit=0;break;}}out[y*w+x]=hit?0:255;}
 return out;
}
function localMeterWindows(source,textBoxes,group){
 const gw=group.right-group.left,gh=group.bottom-group.top,roi={left:Math.max(0,group.left-gw*.22),right:Math.min(source.width,group.right+gw*.22),top:Math.max(0,group.top-gh*.55),bottom:Math.min(source.height,group.bottom+gh*.55)},image=crop(source,roi);
 const shifted=textBoxes.map(b=>({...b,left:b.left-roi.left,right:b.right-roi.left,top:b.top-roi.top,bottom:b.bottom-roi.top}));
 return meterWindows(image,shifted,true).map(b=>({...b,left:b.left+roi.left,right:b.right+roi.left,top:b.top+roi.top,bottom:b.bottom+roi.top,quad:b.quad?.map(p=>({x:p.x+roi.left,y:p.y+roi.top})),morph:true}));
}

function yoloInput(image){
 const size=config.size, c=canvas(size,size),ctx=c.getContext('2d',{willReadFrequently:true});let scaleX=size/image.width,scaleY=size/image.height,left=0,top=0;
 if(config.kind==='fast')ctx.drawImage(image,0,0,size,size);
 else{const scale=Math.min(size/image.width,size/image.height),w=Math.round(image.width*scale),h=Math.round(image.height*scale);left=Math.floor((size-w)/2);top=Math.floor((size-h)/2);ctx.fillStyle='rgb(114,114,114)';ctx.fillRect(0,0,size,size);ctx.drawImage(image,left,top,w,h);scaleX=w/image.width;scaleY=h/image.height;}
 const rgba=ctx.getImageData(0,0,size,size).data,data=new Float32Array(3*size*size);
 for(let i=0;i<size*size;i++)for(let ch=0;ch<3;ch++)data[ch*size*size+i]=rgba[i*4+ch]/255;
 return {tensor:new ort.Tensor('float32',data,[1,3,size,size]),scaleX,scaleY,left,top};
}
function decodeMeterDetector(result,transform,source){
 const boxes=[],sigmoid=x=>1/(1+Math.exp(-Math.max(-80,Math.min(80,x))));
 function add(cx,cy,w,h,conf){if(conf<.25||!Number.isFinite(w)||!Number.isFinite(h)||w<2||h<2)return;
 const left=Math.max(0,(cx-w/2-transform.left)/transform.scaleX),right=Math.min(source.width,(cx+w/2-transform.left)/transform.scaleX),top=Math.max(0,(cy-h/2-transform.top)/transform.scaleY),bottom=Math.min(source.height,(cy+h/2-transform.top)/transform.scaleY);
 if(right-left<12||bottom-top<6||(right-left)/(bottom-top)<1.3)return;
 boxes.push({left,right,top,bottom,conf,rank:conf});}
 if(config.kind==='fast'){
 for(const spec of config.heads){const out=result[spec.output],gw=out.dims.at(-1),gh=out.dims.at(-2),plane=gw*gh;
 for(let anchor=0;anchor<3;anchor++)for(let i=0;i<plane;i++){
 const base=anchor*6*plane,conf=sigmoid(out.data[base+4*plane+i])*sigmoid(out.data[base+5*plane+i]);if(conf<.25)continue;
 const cx=(i%gw+sigmoid(out.data[base+i])*spec.scale-(spec.scale-1)/2)/gw*config.size,cy=(Math.floor(i/gw)+sigmoid(out.data[base+plane+i])*spec.scale-(spec.scale-1)/2)/gh*config.size,w=Math.exp(Math.min(15,out.data[base+2*plane+i]))*spec.anchors[anchor][0],h=Math.exp(Math.min(15,out.data[base+3*plane+i]))*spec.anchors[anchor][1];add(cx,cy,w,h,conf);
 }
 }
 }else if(config.kind==='yolov5'){
 const out=result[det.outputNames[0]],stride=out.dims.at(-1);
 if(stride!==10)throw new Error('Неверный выход YOLOv5');
 for(let i=0;i<out.data.length;i+=stride){const conf=out.data[i+8]*out.data[i+9];if(conf<.25)continue;
 const quad=[];for(let j=0;j<4;j++)quad.push({x:(out.data[i+j*2]-transform.left)/transform.scaleX,y:(out.data[i+j*2+1]-transform.top)/transform.scaleY});
 if(!safeQuad(quad)||quad.some(p=>p.x<0||p.y<0||p.x>=source.width||p.y>=source.height))continue;
 const left=Math.min(...quad.map(p=>p.x)),right=Math.max(...quad.map(p=>p.x)),top=Math.min(...quad.map(p=>p.y)),bottom=Math.max(...quad.map(p=>p.y));
 if(right-left<12||bottom-top<6||(right-left)/(bottom-top)<1.3)continue;
 boxes.push({left,right,top,bottom,quad,conf,rank:conf});
 }
 }else{
 const out=result[det.outputNames[0]],rows=out.dims[1],count=out.dims[2];if(rows<5||count<1)throw new Error('Неизвестный формат выхода детектора');
 const cls=config.readingClass||0;if(4+cls>=rows)throw new Error('Нет класса показаний в модели');
 for(let i=0;i<count;i++)add(out.data[i],out.data[count+i],out.data[2*count+i],out.data[3*count+i],out.data[(4+cls)*count+i]);
 }
 const overlap=(a,b)=>{const area=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));return area/((a.right-a.left)*(a.bottom-a.top)+(b.right-b.left)*(b.bottom-b.top)-area);};
 const kept=[];for(const b of boxes.sort((a,b)=>b.conf-a.conf)){if(kept.every(a=>overlap(a,b)<.45)){kept.push(b);if(kept.length===3)break;}}
 return kept.map(b=>{const h=b.bottom-b.top,pad=h*.04;return {...b,left:Math.max(0,b.left-pad),right:Math.min(source.width,b.right+pad),top:Math.max(0,b.top-h*.14),bottom:Math.min(source.height,b.bottom+h*.22)};});
}

// Refine the neural detector's box on the unmodified camera crop.
function refineMeterWindow(source,box){
 const bw=box.right-box.left,bh=box.bottom-box.top;
 const roi={left:Math.max(0,box.left-bw*.12),right:Math.min(source.width,box.right+bw*.12),top:Math.max(0,box.top-bh*.4),bottom:Math.min(source.height,box.bottom+bh*.4)};
 const region=crop(source,roi),scale=Math.min(1,520/region.width),c=canvas(region.width*scale,region.height*scale);c.getContext('2d').drawImage(region,0,0,c.width,c.height);
 const w=c.width,h=c.height,d=c.getContext('2d').getImageData(0,0,w,h).data,gray=new Uint8Array(w*h);
 for(let i=0;i<gray.length;i++)gray[i]=d[i*4]*.299+d[i*4+1]*.587+d[i*4+2]*.114;
 const cutoff=otsuThreshold(gray),results=[];
 for(const light of [false,true]){
 const vals=light?gray.map(v=>255-v):gray,mask=closeMask(vals,w,h,light?255-cutoff:cutoff),seen=new Uint8Array(w*h),queue=new Int32Array(w*h);
 for(let seed=0;seed<mask.length;seed++){
 if(seen[seed]||mask[seed]>127)continue;
 let head=0,tail=1;queue[0]=seed;seen[seed]=1;const edge=[];
 while(head<tail){const i=queue[head++],x=i%w,y=Math.floor(i/w);let boundary=false;
 for(const j of [x?i-1:-1,x<w-1?i+1:-1,y?i-w:-1,y<h-1?i+w:-1]){if(j<0||mask[j]>127)boundary=true;else if(!seen[j]){seen[j]=1;queue[tail++]=j;}}
 if(boundary)edge.push({x,y});}
 if(tail<w*h*.06||tail>w*h*.85)continue;
 const hull=convexHull(edge),quad=quadFromHull(hull);if(!safeQuad(quad))continue;
 const length=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y),width=(length(quad[0],quad[1])+length(quad[2],quad[3]))/2,height=(length(quad[0],quad[3])+length(quad[1],quad[2]))/2;
 if(width/height<1.8||width/height>12)continue;
 const area=Math.abs(quad.reduce((s,p,i)=>s+p.x*quad[(i+1)%4].y-p.y*quad[(i+1)%4].x,0))/2;
 if(tail/area<.65)continue;
 // All four sides must have distributed support, not just four extreme pixels.
 const support=quad.map((a,i)=>{const b=quad[(i+1)%4],len=length(a,b),bins=new Set();for(const p of edge){const t=((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/(len*len),dist=Math.abs((b.x-a.x)*(p.y-a.y)-(b.y-a.y)*(p.x-a.x))/len;if(t>=0&&t<=1&&dist<Math.max(2,height*.045))bins.add(Math.min(7,Math.floor(t*8)));}return bins.size/8;});
 if(Math.min(...support)<.625)continue;
 const global=quad.map(p=>({x:roi.left+p.x/scale,y:roi.top+p.y/scale})),l=Math.min(...global.map(p=>p.x)),r=Math.max(...global.map(p=>p.x)),t=Math.min(...global.map(p=>p.y)),b=Math.max(...global.map(p=>p.y));
 const overlap=Math.max(0,Math.min(r,box.right)-Math.max(l,box.left))*Math.max(0,Math.min(b,box.bottom)-Math.max(t,box.top));
 if(overlap/(bw*bh)<.6||(r-l)<bw*.65||(r-l)>bw*1.25||(b-t)<bh*.45||(b-t)>bh*1.65)continue;
 results.push({quad:global,score:overlap/(bw*bh)+support.reduce((s,v)=>s+v,0)/4});
 }
 }
 return results.sort((a,b)=>b.score-a.score)[0]?.quad||null;
}
function expandedMeterQuad(q,vertical=.18){
 const out=q.map(p=>({...p}));
 for(const [a,b] of [[0,3],[1,2]]){const dx=q[b].x-q[a].x,dy=q[b].y-q[a].y;out[a]={x:q[a].x-dx*vertical,y:q[a].y-dy*vertical};out[b]={x:q[b].x+dx*vertical,y:q[b].y+dy*vertical};}
 return out;
}
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


function markerInput(image){
 const size=config.marker.size,c=canvas(size,size),ctx=c.getContext('2d'),scale=Math.min(size/image.width,size/image.height),w=Math.max(1,Math.round(image.width*scale)),h=Math.max(1,Math.round(image.height*scale)),left=Math.floor((size-w)/2),top=Math.floor((size-h)/2);
 ctx.fillStyle='rgb(114,114,114)';ctx.fillRect(0,0,size,size);ctx.drawImage(image,left,top,w,h);
 const rgba=ctx.getImageData(0,0,size,size).data,data=new Float32Array(3*size*size);for(let i=0;i<size*size;i++)for(let ch=0;ch<3;ch++)data[ch*size*size+i]=rgba[i*4+ch]/255;
 return {tensor:new ort.Tensor('float32',data,[1,3,size,size]),left,top,scaleX:w/image.width,scaleY:h/image.height};
}
function decodeMarker(output,feed,image){
 if(!output||output.dims.length!==3||output.dims[1]!==5)throw new Error('Неверный выход модели красной метки: ожидается [1,5,N]');
 const count=output.dims[2],a=output.data,items=[];
 for(let i=0;i<count;i++){const conf=a[4*count+i];if(conf<(config.marker.threshold||.25))continue;const cx=a[i],cy=a[count+i],w=a[2*count+i],h=a[3*count+i];if(![cx,cy,w,h,conf].every(Number.isFinite)||w<=0||h<=0)continue;
 const left=Math.max(0,(cx-w/2-feed.left)/feed.scaleX),right=Math.min(image.width,(cx+w/2-feed.left)/feed.scaleX),top=Math.max(0,(cy-h/2-feed.top)/feed.scaleY),bottom=Math.min(image.height,(cy+h/2-feed.top)/feed.scaleY);if(right>left&&bottom>top)items.push({left,right,top,bottom,conf});}
 const overlap=(a,b)=>{const area=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))*Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));return area/((a.right-a.left)*(a.bottom-a.top)+(b.right-b.left)*(b.bottom-b.top)-area);};
 const kept=[];for(const b of items.sort((a,b)=>b.conf-a.conf))if(kept.every(a=>overlap(a,b)<.45))kept.push(b);return kept;
}
function markerLastDigit(chosen,boxes){
 const last=chosen.digitBoxes?.at(-1);if(!last)return null;
 const project=chosen.rectified?projectiveMap(chosen.quad,chosen.processed.width,chosen.processed.height):null;
 const map=(x,y)=>{if(project){const z=project[6]*x+project[7]*y+1;return {x:(project[0]*x+project[1]*y+project[2])/z-chosen.contextRect.left,y:(project[3]*x+project[4]*y+project[5])/z-chosen.contextRect.top};}return {x:chosen.bounds.left+x/ chosen.processed.width*(chosen.bounds.right-chosen.bounds.left)-chosen.contextRect.left,y:chosen.bounds.top+y/chosen.processed.height*(chosen.bounds.bottom-chosen.bounds.top)-chosen.contextRect.top};};
 const y=(last.top+last.bottom)*chosen.processed.height/2,center=map((last.left+last.right)*chosen.processed.width/2,y),a=map(last.left*chosen.processed.width,y),b=map(last.right*chosen.processed.width,y),pad=Math.abs(b.x-a.x)*.15;
 return boxes.find(box=>center.x>=box.left-pad&&center.x<=box.right+pad)||null;
}
function markerPreviewBoxes(chosen,boxes){
 const p=chosen.rectified?projectiveMap(chosen.quad,chosen.processed.width,chosen.processed.height):null;
 const map=(x,y)=>{
  x+=chosen.contextRect.left;y+=chosen.contextRect.top;
  if(!p)return {x:(x-chosen.bounds.left)*chosen.processed.width/(chosen.bounds.right-chosen.bounds.left),y:(y-chosen.bounds.top)*chosen.processed.height/(chosen.bounds.bottom-chosen.bounds.top)};
  const a=p[0]-x*p[6],b=p[1]-x*p[7],c=x-p[2],d=p[3]-y*p[6],e=p[4]-y*p[7],f=y-p[5],det=a*e-b*d;
  if(Math.abs(det)<1e-10)return null;
  return {x:(c*e-b*f)/det,y:(a*f-c*d)/det};
 };
 return boxes.map(box=>({conf:box.conf,points:(box.classId===1&&box.quad?box.quad.map(p=>[p.x,p.y]):[[box.left,box.top],[box.right,box.top],[box.right,box.bottom],[box.left,box.bottom]]).map(([x,y])=>map(x,y))})).filter(box=>box.points.every(p=>p&&Number.isFinite(p.x)&&Number.isFinite(p.y)));
}
async function modelMeterReading(chosen){
 if(!marker)throw new Error('Загрузите best.onnx с телефона для поиска красной метки');
 const feed=markerInput(chosen.markerContext),out=await marker.run({[marker.inputNames[0]]:feed.tensor}),boxes=decodeMarker(out[config.marker.output],feed,chosen.markerContext),match=markerLastDigit(chosen,boxes),numeric=/^\d+$/.test(chosen.text);
 const markerDetections=markerPreviewBoxes(chosen,boxes);
 if(match&&numeric)return {markerDetections,...defaultMeterReading(chosen.text),review:'Модель нашла красную метку последнего разряда · уверенность '+Math.round(match.conf*100)+'%. Последняя цифра дробная. Проверьте показание.'};
 return {markerDetections,reading:numeric?chosen.text:'',displayDigits:numeric?Array.from(chosen.text):[],decimalIndex:null,review:!boxes.length?'Красная метка моделью не найдена. Цифры показаны без запятой — проверьте вручную.':!numeric?'Метка найдена, но цифры не прочитаны.':'Метка найдена, но не совпадает с последней прочитанной цифрой. Возможно, OCR пропустил дробный разряд. Проверьте вручную.'};
}

self.addEventListener('unhandledrejection',event=>{self.postMessage({fatalError:'Ошибка runtime в Worker: '+(event.reason?.message||String(event.reason))});event.preventDefault();});
