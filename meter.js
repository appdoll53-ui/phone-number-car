/* Meter experiment. Models are fetched only when this page is opened. */
const meterState={worker:null,pending:new Map(),sequence:0,source:null,original:null,processed:null,last:null,busy:false,buffers:{},model:'fastocr',engine:'fastocr',detector:null,queue:[],processing:false,collecting:false};
const meterApartments={number:Math.max(1,Number(localStorage.getItem('meter-apartment-number'))||1),snapshot:null,history:[],selection:0,ready:null};
try{const saved=JSON.parse(localStorage.getItem('meter-apartment-history')||'[]');if(Array.isArray(saved))meterApartments.history=saved.filter(r=>Number.isInteger(r.apartment)&&r.apartment>0&&typeof r.reading==='string');}catch(_){}
function renderMeterApartments(){
 $('meter-apartment-value').textContent=String(meterApartments.number);
 $('meter-camera').textContent=meterApartments.snapshot?.apartment===meterApartments.number||meterApartments.history.some(r=>r.apartment===meterApartments.number&&r.previewBlob)?'Переснять':'Снять';
 const list=$('meter-apartment-history');list.replaceChildren();
 for(const record of meterApartments.history.slice(0,4)){const row=document.createElement('div'),apartment=document.createElement('span'),reading=document.createElement('span');apartment.textContent='Квартира '+record.apartment;reading.className='meter-history-reading';reading.textContent=record.reading;row.append(apartment,reading);list.append(row);}
}
async function initMeterReadings(){
 const records=await meterReadingStore('getAll');
 for(const old of meterApartments.history)if(!records.some(r=>r.apartment===old.apartment)){await meterReadingStore('put',old);records.push(old);}
 meterApartments.history=records.sort((a,b)=>String(b.created||'').localeCompare(String(a.created||'')));renderMeterApartments();await selectMeterApartment(meterApartments.number,true);
}
async function selectMeterApartment(number,force=false){
 if(meterState.busy||state.shooting)return;const value=Number(number);if(!Number.isInteger(value)||value<1||value>999999)return;
 if(value===meterApartments.number&&!force)return;
 meterApartments.number=value;localStorage.setItem('meter-apartment-number',String(value));const token=++meterApartments.selection;
 meterState.source=null;meterState.result=null;meterState.training=null;meterState.savedId=null;
 const record=meterApartments.history.find(r=>r.apartment===value);
 meterApartments.snapshot=record?{id:record.snapshotId||crypto.randomUUID(),apartment:value}:null;
 $('meter-reading').value=record?.reading||'';renderMeterDigits(Array.from(record?.reading||''));$('meter-reading').disabled=false;
 $('meter-reading-field').classList.toggle('apartment-no-reading',!record);$('meter-photo').classList.add('apartment-no-photo');$('meter-preview').removeAttribute('src');
 $('meter-marker-confidence').textContent='';$('meter-fast-raw').textContent='';$('meter-review').textContent=record?'Сохранённое показание квартиры '+value+'.':'Квартира '+value+': показание ещё не снято.';$('meter-stats').textContent='';$('meter-count-warning').classList.add('hidden');renderMeterApartments();
 if(record?.previewBlob){const bitmap=await createImageBitmap(record.previewBlob);if(token!==meterApartments.selection){bitmap.close();return;}const c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;c.getContext('2d').drawImage(bitmap,0,0);bitmap.close();meterState.result={processed:meterImage(c),overlayDetections:record.overlayDetections||[],decimalIndex:record.decimalIndex};await setMeterPhoto(meterMarkedPreview(meterState.result));if(token===meterApartments.selection){$('meter-photo').classList.remove('apartment-no-photo');renderMeterDigits(Array.from(record.reading));}}
}
async function recordMeterApartment(reading){
 if(!/^\d+$/.test(reading))return;const shot=meterApartments.snapshot||(meterApartments.snapshot={id:crypto.randomUUID(),apartment:meterApartments.number});
 await meterApartments.ready;
 const previous=meterApartments.history.find(r=>r.apartment===shot.apartment);
 const record={...previous,apartment:shot.apartment,reading,snapshotId:shot.id,created:new Date().toISOString()};
 if(meterState.result?.processed){record.previewBlob=await meterBlob(meterCanvas(meterState.result.processed));record.overlayDetections=meterState.result.overlayDetections||[];record.decimalIndex=meterState.result.decimalIndex;}
 await meterReadingStore('put',record);
 meterApartments.history=[record,...meterApartments.history.filter(r=>r.apartment!==shot.apartment)];
 try{localStorage.setItem('meter-apartment-history',JSON.stringify(meterApartments.history.map(({apartment,reading,snapshotId,created})=>({apartment,reading,snapshotId,created}))));}catch(_){}renderMeterApartments();
}
function failMeterWorker(error){
 const worker=meterState.worker;meterState.worker=null;meterState.backend=null;meterState.markerMode=null;
 for(const p of meterState.pending.values())p.reject(error);meterState.pending.clear();if(worker)worker.terminate();
}
function meterRPC(type,data={},transfer=[]) {
  if(!meterState.worker) {
    meterState.worker=new Worker('meter-worker.js?v=83');
    meterState.worker.onmessage=({data:r})=>{
      if(r.fatalError){failMeterWorker(new Error(r.fatalError));return;}
      const p=meterState.pending.get(r.id); if(!p)return;
      meterState.pending.delete(r.id); r.error?p.reject(new Error(r.error)):p.resolve(r);
    };
    meterState.worker.onerror=event=>{event.preventDefault();const where=event.filename?' · '+event.filename.split('/').at(-1)+':'+event.lineno:'';failMeterWorker(new Error('Worker: '+(event.message||'не удалось загрузить скрипт')+where));};
    meterState.worker.onmessageerror=()=>failMeterWorker(new Error('Worker: не удалось передать результат обработки'));

  }
  const id=++meterState.sequence;
  return new Promise((resolve,reject)=>{meterState.pending.set(id,{resolve,reject});try{meterState.worker.postMessage({id,type,...data},transfer);}catch(e){meterState.pending.delete(id);reject(e);}});
}
async function meterManifest(){
 if(!meterState.manifest){const r=await fetch('meter-models.json');if(!r.ok)throw new Error('Нет описания моделей');meterState.manifest=await r.json();}
 return meterState.manifest;
}
async function validMeterFile(buf,meta){
 return meta.custom ? buf.byteLength>0 : buf.byteLength===meta.bytes && Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buf))).map(x=>x.toString(16).padStart(2,'0')).join('')===meta.sha256;
}
async function meterFile(name,meta){
 const cache=await caches.open('nomera-meter-models'),url=new URL('models/'+name,location.href),saved=await cache.match(url);
 if(saved){const buf=await saved.arrayBuffer();if(await validMeterFile(buf,meta))return buf;await cache.delete(url);}
 throw new Error('Выберите файл '+name+' с телефона в настройках кнопкой загрузки моделей счётчиков');
}
async function meterImportedFiles(){
 const manifest=await meterManifest(),cache=await caches.open('nomera-meter-models'),missing=[],loaded=[];let count=0;
 const activeDetector=localStorage.getItem('meter-detector-file')==='meter_detector.onnx'?'meter_detector.onnx':'meter_pose.onnx',required=['meter_fast_ocr.onnx',activeDetector];
 for(const name of required){const hit=await cache.match(new URL('models/'+name,location.href));if(hit&&await validMeterFile(await hit.arrayBuffer(),manifest.files[name])){count++;loaded.push(name);}else missing.push(name);}
 $('meter-import-status').textContent='Нужны: meter_fast_ocr.onnx и meter_pose.onnx (или meter_detector.onnx).\nЗагружены: '+(loaded.join(', ')||'нет')+'.\nОсталось: '+(missing.join(', ')||'все модели загружены')+'.';
 return missing;
}
async function importMeterModels(files){
 if(meterState.busy||!files.length)return;
 meterState.busy=true;meterButtons();let saved=0;const errors=[];
 try{
 const manifest=await meterManifest(),cache=await caches.open('nomera-meter-models');
 for(const file of files){
 const meta=manifest.files[file.name];
 if(!meta){errors.push(file.name+': неизвестное имя');continue;}
 if(!meta.custom&&file.size!==meta.bytes){errors.push(file.name+': неверный размер');continue;}
 setStatus('settings-meter-status','Проверка '+file.name+'…');
 try{const buf=await file.arrayBuffer();if(!await validMeterFile(buf,meta)){errors.push(file.name+': файл не соответствует модели');continue;}
 await cache.put(new URL('models/'+file.name,location.href),new Response(buf,{headers:{'Content-Type':'application/octet-stream'}}));
 // Keep only the active pair in RAM; both models remain in persistent cache.
 delete meterState.buffers[file.name];if(file.name==='meter_pose.onnx'||file.name==='meter_detector.onnx'){localStorage.setItem('meter-detector-file',file.name);failMeterWorker(new Error('Модель обновлена'));}saved++;
 }catch(e){errors.push(file.name+': '+e.message);}
 }
 await meterImportedFiles();
 setStatus('settings-meter-status','Сохранено файлов: '+saved+(errors.length?'. '+errors.join('; '):'. Можно фотографировать счётчик.'),errors.length?'bad':'ok');
 }catch(e){setStatus('settings-meter-status','Не удалось сохранить модели: '+e.message,'bad');}
 finally{meterState.busy=false;meterButtons();$('meter-model-files').value='';resumeMeterQueue().catch(e=>setStatus('meter-status',e.message,'bad'));}
}
async function loadMeter(markerMode=$('meter-fraction-model').checked) {
  if(meterState.loading)return meterState.loading;
  if(meterState.manifest && meterState.worker && meterState.model === 'fastocr' && meterState.detector === 'fast' && meterState.markerMode===markerMode && meterState.backend) return;
  meterState.loading=(async()=>{
    meterState.busy=true;meterButtons();
    try {
      const t=performance.now();
      await meterManifest();
      const model='fastocr',detector='fast',base=meterState.manifest.models[model],spec=meterState.manifest.detectors[detector],config={...base,...spec,marker:{...meterState.manifest.markerModel}};if(localStorage.getItem('meter-detector-file')==='meter_detector.onnx'){config.det='meter_detector.onnx';config.marker.file=config.det;}
      const names=[config.det,config.rec];
      for(const name of names)if(!meterState.buffers[name]){setStatus('meter-status','Чтение '+name+'…');meterState.buffers[name]=await meterFile(name,meterState.manifest.files[name]);}
      config.hash=(await Promise.all(names.map(async n=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',meterState.buffers[n]))).map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,16)))).join('');
      const key='nomera-meter-gpu-'+config.hash;
      const result=await meterRPC('init',{model:model+'/'+detector+'/'+markerMode,config,marker:markerMode?meterState.buffers[config.marker.file]:null,det:meterState.buffers[config.det],rec:meterState.buffers[config.rec],gpu:localStorage.getItem(key)});
      localStorage.setItem(key,result.backend==='webgpu'?'yes':'no');
      for(const name of Object.keys(meterState.buffers))if(!names.includes(name))delete meterState.buffers[name];
      meterState.markerMode=markerMode;meterState.model=model;meterState.detector=detector;meterState.backend=result.backend;meterState.gpuKey=key;meterState.loadMs=performance.now()-t;
      setStatus('meter-status','Модели готовы · '+result.backend.toUpperCase(),'ok');
    } finally {meterState.busy=false;meterButtons();}
  })().finally(()=>{meterState.loading=null;});
  return meterState.loading;
}
function meterButtons(){
 for(const id of ['meter-apartment-minus','meter-apartment-plus','meter-apartment-number','meter-upload-photos','load-meter-models','meter-camera','meter-fraction-model','meter-candidate'])$(id).disabled=meterState.busy;
 const labelLock=meterState.busy||Boolean(meterState.labelImporting);
 for(const id of ['meter-label-prev','meter-label-next','keep','meter-label-empty','meter-label-unclear','meter-label-delete','drop','meter-label-window','meter-label-separator','wipe','save','meter-label-export','meter-label-close'])$(id).disabled=labelLock||(['keep','meter-label-empty','meter-label-unclear','meter-label-delete','drop','meter-label-prev','meter-label-next'].includes(id)&&!meterLabels.rows[meterLabels.index]);
 for(const id of ['meter-export-readings','meter-clear-readings'])$(id).disabled=meterState.busy;
}
async function openMeter(){
 await meterApartments.ready;
 setAppSection('meter');layoutMeterPreview();
 try{await meterImportedFiles();await resumeMeterQueue();}catch(e){setStatus('meter-status',e.message,'bad');}
}
function closeMeter(){
 if(state.stream)closeCamera();$('cam').classList.remove('meter-camera');state.cameraMode='plate';meterState.collecting=false;
 $('meter-screen').classList.add('hidden');$('meter-label-screen').classList.add('hidden');setAppSection('car');$('plate-frame').querySelector('span').textContent='Держите номер целиком в рамке';
}
async function openMeterCamera(collect=false){
 try{await loadMeter();}catch(e){setStatus('meter-status',e.message,'bad');return;}
 meterState.collecting=false;state.cameraMode='meter';state.plateType='long';selectPlateType('long');$('cam').classList.add('meter-camera');$('plate-frame').querySelector('span').textContent='Держите окошко и красную метку в рамке';
 $('meter-collect-status').classList.add('hidden');await openCamera();
}
function meterImage(canvas){const im=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);return {width:im.width,height:im.height,data:im.data};}
function meterCanvas(im){const c=document.createElement('canvas');c.width=im.width;c.height=im.height;c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(im.data),im.width,im.height),0,0);return c;}
function meterBlob(c){return new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(new Error('Не удалось сохранить изображение')),'image/png'));}
async function shootMeter(){
 if(state.shooting||!$('video').videoWidth)return;state.shooting=true;$('shot').disabled=true;
 const apartmentAtShutter=meterApartments.number;
 try{
 await state.zoomMotion;await state.zoomQueue;await state.focusQueue;await state.torchQueue;
 const frame=$('plate-frame').getBoundingClientRect(),shot=$('shot').getBoundingClientRect();meterState.previewLayout={top:frame.top,width:frame.width,height:frame.height,shotY:shot.top+shot.height/2,viewportWidth:innerWidth,viewportHeight:innerHeight};
 const video=$('video'),region=frameRegion(),w=video.videoWidth,h=video.videoHeight,framed=framedCrop(await capturePhoto(video),region,w,h);
 meterApartments.snapshot={id:crypto.randomUUID(),apartment:apartmentAtShutter};meterState.result=null;renderMeterApartments();meterState.source=framed;meterState.savedId=null;meterState.candidate=null;meterState.training=null;
 showWait('Обрабатываем новый снимок…');
 try{await saveMeterPhoto();await repeatMeter();}finally{closeCamera();hideWait();}
 }catch(e){setStatus('meter-status','Ошибка съёмки: '+e.message,'bad');$('meter-collect-status').textContent='Снимок не сохранён: '+e.message;}
 finally{state.shooting=false;$('shot').disabled=false;meterButtons();}
}
function meterDefaultFraction(text){
 const digits=String(text||'').replace(/\s/g,'');
 if(!/^\d+$/.test(digits))return {reading:'',displayDigits:[],decimalIndex:null,review:'Цифры не прочитаны. Проверьте снимок.'};
 const whole=(digits.length>1?digits.slice(0,-1):'0'),fraction=digits.slice(-1);
 return {reading:whole+','+fraction,displayDigits:Array.from(whole+fraction),decimalIndex:whole.length,review:'Последняя цифра принята за один дробный разряд. Проверьте показание.'};
}
function boundedMeterRect(rect,width,height){
 if(!rect)return null;
 const w=Math.min(width,Math.max(Math.min(.001,width),Number(rect.w)||2)),h=Math.min(height,Math.max(Math.min(.001,height),Number(rect.h)||2));
 return {x:Math.max(0,Math.min(width-w,Number(rect.x)||0)),y:Math.max(0,Math.min(height-h,Number(rect.y)||0)),w,h};
}
async function runMeterImage(image,options){
 const r=await meterRPC('recognize',{image,options},[image.data.buffer]);
 if(r.fallback){localStorage.setItem(meterState.gpuKey,'no');meterState.backend='wasm';}if(r.text&&!options.fractionModel)Object.assign(r,meterDefaultFraction(r.text));return r;
}
async function setMeterPhoto(canvas){
 const image=$('meter-preview'),url=canvas.toDataURL('image/png');
 image.src=url;
 if(typeof image.decode==='function'){try{await image.decode();}catch(_){}}
 else if(!image.complete)await new Promise(resolve=>{image.addEventListener('load',resolve,{once:true});image.addEventListener('error',resolve,{once:true});});
 $('meter-photo').classList.remove('hidden','apartment-no-photo');
}
function meterMarkedPreview(result){
 const canvas=meterCanvas(result.processed),ctx=canvas.getContext('2d'),boxes=(result.overlayDetections||result.markerDetections||[]);
 const caption=$('meter-marker-confidence');
 caption.textContent=Array.isArray(boxes)?(boxes.length?boxes.map(b=>(b.label||'Разделитель')+' '+Math.round(b.conf*100)+'%').join(' · '):'Метка не найдена'):'';
 if(!boxes?.length)return canvas;
 ctx.save();ctx.strokeStyle='#ffd447';ctx.fillStyle='#ffd447';ctx.lineWidth=Math.max(2,canvas.width/250);ctx.font='bold '+Math.max(14,Math.round(canvas.height/10))+'px sans-serif';
 for(const box of boxes){ctx.strokeStyle=ctx.fillStyle=box.classId===1?'#69e4ab':'#ffd447';ctx.beginPath();box.points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.stroke();
 const x=Math.max(2,Math.min(canvas.width-50,Math.min(...box.points.map(p=>p.x)))),y=Math.max(18,Math.min(canvas.height-3,Math.min(...box.points.map(p=>p.y))-5));ctx.fillText((box.label||'Метка')+' '+Math.round(box.conf*100)+'%',x,y);}
 ctx.restore();return canvas;
}
async function repeatMeter(){
 if(!meterState.source||meterState.busy)return;
 try{
 await loadMeter();meterState.busy=true;meterButtons();setStatus('meter-status','Ищем окошко и читаем цифры…');
 const r=await runMeterImage(meterImage(meterState.source),{perspective:false,candidate:meterState.candidate,fractionModel:$('meter-fraction-model').checked});
 meterState.training=r.training||r.original;meterState.result=r;
 await setMeterPhoto(meterMarkedPreview(r));layoutMeterPreview();
 $('meter-photo').classList.remove('apartment-no-photo');$('meter-reading-field').classList.remove('apartment-no-reading');$('meter-reading').disabled=false;showMeterReading(r);await recordMeterApartment($('meter-reading').value);await updateAutoMeterPhoto(r);$('meter-fast-raw').textContent='Текст Fast-OCR до обработки: '+(r.text||'не прочитан');$('meter-review').textContent=r.review;
 const s=r.stats;$('meter-stats').textContent=r.backend.toUpperCase()+' · детекция: '+Math.round(s.det)+' мс · чтение: '+Math.round(s.rec)+' мс · всего: '+Math.round(s.total)+' мс'+(s.marker!=null?' · метка: '+Math.round(s.marker)+' мс':'')+'. '+r.geometry;
 const select=$('meter-candidate');select.replaceChildren();r.candidates.forEach((c,i)=>{const o=document.createElement('option');o.value=i;o.textContent=(i+1)+'. '+(c.text||'область');select.append(o);});select.value=r.selected;select.classList.toggle('hidden',r.candidates.length<2);$('meter-candidate-label').classList.toggle('hidden',r.candidates.length<2);
 setStatus('meter-status',r.located?'Снимок обработан. Проверьте показание.':'Окошко не найдено. Для разметки можно сохранить кадр зелёной рамки.');
 }catch(e){$('meter-marker-confidence').textContent='';meterState.training=meterImage(meterState.source);await setMeterPhoto(meterState.source);$('meter-reading').value='';renderMeterDigits([],null);$('meter-fast-raw').textContent='';$('meter-review').textContent='Обработка не завершена.';setStatus('meter-status',e.message,'bad');}
 finally{meterState.busy=false;meterButtons();drainMeterQueue();}
}
function layoutMeterPreview(){
 if($('meter-screen').classList.contains('hidden'))return;
 const screen=$('meter-screen'),photo=$('meter-photo');screen.scrollTop=0;photo.style.marginTop='0px';
 const saved=meterState.previewLayout,exact=saved&&saved.viewportWidth===innerWidth&&saved.viewportHeight===innerHeight;
 const width=exact?saved.width:Math.min(innerWidth*.88,720)+6,height=exact?saved.height:width/2.25,target=exact?saved.top:innerHeight*.37-height/2;
 photo.style.width=width+'px';photo.style.height=height+'px';photo.style.marginTop=Math.max(0,target-photo.getBoundingClientRect().top)+'px';
 // Apartment controls are in normal page flow and scroll with the content.
}
function meterWholeDigits(result){
 const digits=result.displayDigits||[];return Number.isInteger(result.decimalIndex)?digits.slice(0,result.decimalIndex):digits;
}
function showMeterReading(result){
 const digits=meterWholeDigits(result);$('meter-reading').value=digits.join('');renderMeterDigits(digits,result.displayDigits?.length);
 const expected=Number($('meter-expected-count').value||$('meter-expected-count').textContent);
 if(digits.length&&digits.length!==expected){$('meter-count-warning-text').textContent='Ожидалось '+expected+' цифр, распознано '+digits.length+'. Проверьте показание.';$('meter-count-warning').classList.remove('hidden');$('meter-count-warning-close').focus();}
 else $('meter-count-warning').classList.add('hidden');
}
function renderMeterDigits(digits,slots=digits.length){
 const row=$('meter-digit-row');row.replaceChildren();row.style.gridTemplateColumns='repeat('+Math.max(1,slots)+',minmax(0,1fr))';
 digits.forEach((d,i)=>{const cell=document.createElement('span');cell.textContent=d;if($('meter-show-separator').checked&&i===digits.length-1&&Number.isInteger(meterState.result?.decimalIndex)){const mark=document.createElement('small');mark.textContent=',';cell.append(mark);}row.append(cell);});$('meter-reading-field').classList.toggle('has-digits',digits.some(Boolean));
}
let meterDBPromise;
function meterDB(){if(!meterDBPromise)meterDBPromise=new Promise((resolve,reject)=>{const q=indexedDB.open('nomera-meter-labels',2);q.onupgradeneeded=()=>{if(!q.result.objectStoreNames.contains('photos'))q.result.createObjectStore('photos',{keyPath:'id'});if(!q.result.objectStoreNames.contains('readings'))q.result.createObjectStore('readings',{keyPath:'apartment'});};q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});return meterDBPromise;}
async function meterStore(method,value){const db=await meterDB();return new Promise((resolve,reject)=>{const tx=db.transaction('photos',method==='get'||method==='getAll'?'readonly':'readwrite'),store=tx.objectStore('photos'),q=value===undefined?store[method]():store[method](value);let result;q.onsuccess=()=>result=q.result;tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Сохранение прервано'));});}
async function updateMeterCollection(){const rows=await meterStore('getAll');const pending=rows.filter(r=>r.status==='pending').length;const text='Сохранено: '+rows.length+' · ожидают обработки: '+pending+(meterState.processing?' · обработка…':'');$('meter-collect-status').textContent=text;$('meter-annotations').textContent='Разметка ('+rows.length+')';}
async function resumeMeterQueue(){const rows=await meterStore('getAll');meterState.queue=rows.filter(r=>r.status==='pending').map(r=>r.id);await updateMeterCollection();if(meterState.queue.length)drainMeterQueue();}
async function drainMeterQueue(){
 if(meterState.processing||meterState.busy||!meterState.queue.length)return;
 meterState.processing=true;meterState.busy=true;meterButtons();
 try{
 await loadMeter(Boolean((await meterStore('get',meterState.queue[0]))?.fractionModel));meterState.busy=true;meterButtons();
 while(meterState.queue.length){
 const id=meterState.queue.shift(),entry=await meterStore('get',id);if(!entry)continue;await updateMeterCollection();
 try{
 const bitmap=await createImageBitmap(entry.raw),c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;c.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
 await loadMeter(Boolean(entry.fractionModel));meterState.busy=true;meterButtons();
 const r=await runMeterImage(meterImage(c),{perspective:entry.perspective,fractionModel:Boolean(entry.fractionModel)});const training=r.training||r.original;entry.blob=await meterBlob(meterCanvas(training));entry.width=training.width;entry.height=training.height;entry.located=r.located;entry.text=r.text;entry.reading=r.reading;entry.status='ready';
 }catch(e){entry.status='error';entry.error=e.message;}
 // A deleted photo must not reappear after its processing completes.
 if(await meterStore('get',id))await meterStore('put',entry);
 const labelIndex=meterLabels.rows.findIndex(r=>r.id===id);if(labelIndex>=0){meterLabels.rows[labelIndex]=entry;if(labelIndex===meterLabels.index&&!$('meter-label-screen').classList.contains('hidden'))await showMeterLabel();}
 await updateMeterCollection();
 }
 }catch(e){setStatus('meter-status','Снимки сохранены, обработка ожидает моделей: '+e.message,'bad');}
 finally{meterState.processing=false;meterState.busy=false;meterButtons();await updateMeterCollection();}
}
async function meterReadingStore(method,value){const db=await meterDB();return new Promise((resolve,reject)=>{const tx=db.transaction('readings',method==='getAll'||method==='get'?'readonly':'readwrite'),store=tx.objectStore('readings'),q=value===undefined?store[method]():store[method](value);let result;q.onsuccess=()=>result=q.result;tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error('Сохранение прервано'));});}
async function saveMeterPhoto(){
 if(!meterState.source||meterState.savedId)return;
 const id=meterApartments.snapshot?.id||crypto.randomUUID(),raw=await meterBlob(meterState.source);
 await meterStore('put',{id,created:new Date().toISOString(),raw,blob:raw,width:meterState.source.width,height:meterState.source.height,status:'ready',labelStatus:'unlabeled',windowStatus:'unlabeled',separatorStatus:'unlabeled',apartment:meterApartments.snapshot?.apartment??null,coordinateSpace:'source-frame'});meterState.savedId=id;await updateMeterCollection();
}
async function updateAutoMeterPhoto(result){if(!meterState.savedId)return;const item=await meterStore('get',meterState.savedId);if(!item)return;applyMeterAnnotation(item,{...result,separatorRect:result.separatorRect,separatorConfidence:result.separatorConfidence});item.reading=$('meter-reading').value;await meterStore('put',item);}
const meterLabels={rows:[],index:0,active:'window',draft:null};
function meterLabelDraft(item){return {windowConfidence:item.windowConfidence??null,separatorConfidence:item.separatorConfidence??null,windowRect:item.windowRect||null,separatorRect:item.separatorRect||item.rect||null,windowStatus:item.windowStatus||'unlabeled',separatorStatus:item.separatorStatus||(item.labelStatus==='marked'?'marked':item.labelStatus==='absent'?'absent':'unlabeled'),};}
function stashMeterLabel(){if(!meterLabels.draft)return;const rect=window.meterMarkup.getBox();const key=meterLabels.active+'Rect';meterLabels.draft[key]=rect;}
async function openMeterLabels(){meterLabels.rows=(await meterStore('getAll')).sort((a,b)=>a.created.localeCompare(b.created));meterLabels.index=0;$('meter-screen').classList.add('hidden');$('meter-label-screen').classList.remove('hidden');await showMeterLabel();}
async function showMeterLabel(){
 const item=meterLabels.rows[meterLabels.index];
 for(const id of ['meter-label-prev','meter-label-next','keep','meter-label-empty','meter-label-unclear','meter-label-delete','drop'])$(id).disabled=!item||(['keep','meter-label-empty','meter-label-unclear','drop'].includes(id)&&item.status==='pending');
 if(item&&(!item.annotationAttempted||item.annotationModel!=='pose79')&&item.status!=='pending'&&(item.windowStatus!=='marked'||item.separatorStatus!=='marked')){
 $('meter-label-status').textContent='Предлагаем рамки окошка и разделителя…';meterState.labelImporting=true;
 try{const bitmap=await createImageBitmap(item.blob),c=document.createElement('canvas');c.width=bitmap.width;c.height=bitmap.height;c.getContext('2d').drawImage(bitmap,0,0);bitmap.close();const r=await prepareMeterAnnotation(c);applyMeterAnnotation(item,r);await meterStore('put',item);}
 catch(e){item.annotationAttempted=true;item.error='Автопоиск недоступен: '+e.message;await meterStore('put',item);}
 finally{meterState.labelImporting=false;meterState.busy=false;meterButtons();}
 }
 meterLabels.draft=item?meterLabelDraft(item):null;
 if(!item){await window.meterMarkup.load(null,'');$('meter-label-status').textContent='Фото для разметки пока нет.';return;}
 await window.meterMarkup.load(item.blob,item.id+'.png',meterLabels.draft,meterLabels.active);
 updateMeterLabelClass();
}
function updateMeterLabelClass(){
 const active=meterLabels.active,item=meterLabels.rows[meterLabels.index],draft=meterLabels.draft;
 for(const name of ['window','separator']){$('meter-label-'+name).className=name===active?'secondary':'ghost';$('meter-label-'+name).setAttribute('aria-pressed',String(name===active));}
 $('meter-label-empty').textContent=active==='separator'?'Разделителя нет':'Окошка нет';$('drop').textContent='Убрать рамку';
 if(item)$('meter-label-status').textContent=(meterLabels.index+1)+' / '+meterLabels.rows.length+' · Окошко: '+labelStatusText(draft.windowStatus)+' · Разделитель: '+labelStatusText(draft.separatorStatus)+(item.separatorConfidence!=null?' · Разделитель: '+Math.round(item.separatorConfidence*100)+'%':'')+(item.windowConfidence!=null?' · Окошко: '+Math.round(item.windowConfidence*100)+'%':'')+(item.error?' · '+item.error:'');
}
function labelStatusText(status){return {unlabeled:'не подтверждено',marked:'размечено',absent:'нет',unclear:'неясно'}[status]||'не подтверждено';}
async function switchMeterLabel(name){stashMeterLabel();meterLabels.active=name;window.meterMarkup.setClass(name,meterLabels.draft);updateMeterLabelClass();}
async function advanceMeterLabel(){meterLabels.index=Math.min(meterLabels.index+1,meterLabels.rows.length-1);await showMeterLabel();}
async function persistMeterLabel(){
 const item=meterLabels.rows[meterLabels.index];if(!item)return;
 const current=await meterStore('get',item.id);if(!current)return;
 for(const name of ['window','separator']){const key=name+'Rect';current[key]=boundedMeterRect(meterLabels.draft[key],current.width,current.height);current[name+'Status']=meterLabels.draft[name+'Status'];}
 current.rect=current.separatorRect;current.labelStatus='annotated';await meterStore('put',current);meterLabels.rows[meterLabels.index]=current;
}
async function saveMeterLabel(status,rect=null,advance=true){
 const item=meterLabels.rows[meterLabels.index];if(!item||item.status==='pending')return;
 stashMeterLabel();const name=meterLabels.active;
 if(status==='marked'){
  for(const kind of ['window','separator'])if(meterLabels.draft[kind+'Rect']&&meterLabels.draft[kind+'Status']!=='absent')meterLabels.draft[kind+'Status']='marked';
  if(!meterLabels.draft[name+'Rect']&&meterLabels.draft[name+'Status']!=='absent')throw new Error('Установите рамку или отметьте отсутствие объекта.');
 }else if(status==='absent'){meterLabels.draft[name+'Rect']=null;meterLabels.draft[name+'Status']='absent';window.meterMarkup.clearBox();}
 else {for(const kind of ['window','separator'])meterLabels.draft[kind+'Status']='unclear';}
 await persistMeterLabel();updateMeterLabelClass();if(advance&&status!=='absent')await advanceMeterLabel();
}
async function clearMeterAnnotations(){
 const rows=await meterStore('getAll');for(const item of rows){item.rect=null;item.windowCorners=null;item.cornersStatus='unlabeled';item.windowRect=null;item.separatorRect=null;item.windowStatus=item.separatorStatus='unlabeled';item.labelStatus='unlabeled';await meterStore('put',item);}
 meterLabels.rows=rows.sort((a,b)=>a.created.localeCompare(b.created));await showMeterLabel();
}
async function deleteMeterLabel(){const item=meterLabels.rows[meterLabels.index];if(!item)return;await meterStore('delete',item.id);meterLabels.rows.splice(meterLabels.index,1);meterLabels.index=Math.max(0,Math.min(meterLabels.index,meterLabels.rows.length-1));await showMeterLabel();await updateMeterCollection();}
async function prepareMeterAnnotation(canvas){
 await loadMeter(true);
 meterState.busy=true;meterButtons();const image=meterImage(canvas),r=await meterRPC('annotate',{image},[image.data.buffer]);
 if(r.fallback){localStorage.setItem(meterState.gpuKey,'no');meterState.backend='wasm';}
 return r;
}
function applyMeterAnnotation(entry,result){
 const previous=meterLabelDraft(entry);
 if(previous.windowStatus==='unlabeled')entry.windowRect=result.windowRect||null;
 if(previous.separatorStatus==='unlabeled'){entry.separatorRect=result.separatorRect||null;entry.separatorConfidence=result.separatorConfidence??null;}
 entry.windowConfidence=result.windowConfidence??null;entry.located=result.located;entry.text=result.text;entry.annotationAttempted=true;entry.annotationModel='pose79';
 if(result.separatorError)entry.error='Разделитель: '+result.separatorError;else delete entry.error;
}
async function importMeterPhotos(files){
 if(meterState.busy||!files.length)return;
 meterState.labelImporting=true;meterState.busy=true;meterButtons();$('meter-upload-photos').disabled=true;let count=0;const errors=[];
 try{
 for(const file of files){let entry;
 try{const bitmap=await createImageBitmap(file),canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();const blob=await meterBlob(canvas);
 entry={id:crypto.randomUUID(),created:new Date().toISOString(),name:file.name,raw:blob,blob,width:canvas.width,height:canvas.height,status:'ready',labelStatus:'unlabeled',windowStatus:'unlabeled',separatorStatus:'unlabeled',coordinateSpace:'source-frame'};
 await meterStore('put',entry);count++;
 // Keep the full photo even when models are unavailable.
 try{const r=await prepareMeterAnnotation(canvas);applyMeterAnnotation(entry,r);await meterStore('put',entry);}catch(e){entry.annotationAttempted=true;entry.annotationModel='pose79';entry.error='Автопоиск недоступен: '+e.message;await meterStore('put',entry);}
 $('meter-label-status').textContent='Загружено фото: '+count+' / '+files.length;
 }catch(e){errors.push(file.name+': '+e.message);}
 }
 meterLabels.rows=(await meterStore('getAll')).sort((a,b)=>a.created.localeCompare(b.created));meterLabels.index=Math.max(0,meterLabels.rows.length-count);await showMeterLabel();await updateMeterCollection();if(errors.length)$('meter-label-status').textContent+=' · '+errors.join('; ');
 }finally{meterState.labelImporting=false;meterState.busy=false;meterButtons();$('meter-upload-photos').disabled=false;$('meter-photo-files').value='';}
}
// Standard ZIP STORE: PNG is already compressed; no extra runtime dependency.
function meterCRC(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function meterZip(files){const enc=new TextEncoder(),parts=[],central=[];let offset=0,centralSize=0;for(const f of files){const name=enc.encode(f.name),bytes=f.bytes,crc=meterCRC(bytes),local=new Uint8Array(30+name.length),lv=new DataView(local.buffer);lv.setUint32(0,0x04034b50,true);lv.setUint16(4,20,true);lv.setUint16(6,0x800,true);lv.setUint32(14,crc,true);lv.setUint32(18,bytes.length,true);lv.setUint32(22,bytes.length,true);lv.setUint16(26,name.length,true);local.set(name,30);parts.push(local,bytes);const head=new Uint8Array(46+name.length),v=new DataView(head.buffer);v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);v.setUint16(8,0x800,true);v.setUint32(16,crc,true);v.setUint32(20,bytes.length,true);v.setUint32(24,bytes.length,true);v.setUint16(28,name.length,true);v.setUint32(42,offset,true);head.set(name,46);central.push(head);centralSize+=head.length;offset+=local.length+bytes.length;}const end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,files.length,true);v.setUint16(10,files.length,true);v.setUint32(12,centralSize,true);v.setUint32(16,offset,true);return new Blob([...parts,...central,end],{type:'application/zip'});}
function meterDatasetItem(r){
 const draft=meterLabelDraft(r),labels=[];
 for(const [i,name] of ['separator','window'].entries()){const rect=boundedMeterRect(draft[name+'Rect'],r.width,r.height);if(draft[name+'Status']==='marked'&&rect)labels.push({class:i,rect});}
 const ready=r.status!=='pending'&&['window','separator'].every(name=>(draft[name+'Status']==='absent'||draft[name+'Status']==='marked'&&Boolean(draft[name+'Rect'])));
 return {apartment:r.apartment??null,id:r.id,file:'images/'+r.id+'.png',width:r.width,height:r.height,created:r.created,status:r.status,windowStatus:draft.windowStatus,separatorStatus:draft.separatorStatus,labels,ready};
}
async function exportMeterJSON(){const rows=await meterStore('getAll');downloadMeterFile(new Blob([JSON.stringify({schema:5,classes:['separator','window'],images:rows.map(meterDatasetItem)},null,2)],{type:'application/json'}),'meter-annotations.json');}
function downloadMeterFile(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
async function exportMeterLabels(){
 const button=$('meter-label-export');button.disabled=true;
 try{const rows=await meterStore('getAll');if(!rows.length)throw new Error('Нет снимков для выгрузки.');if(rows.length>2000)throw new Error('Выгружайте не более 2000 снимков за раз.');const files=[],items=[],enc=new TextEncoder();
 for(const r of rows){const item=meterDatasetItem(r);items.push(item);files.push({name:item.file,bytes:new Uint8Array(await r.blob.arrayBuffer())});if(item.ready){const line=item.labels.map(({class:cls,rect:q})=>`${cls} ${(q.x+q.w/2)/r.width} ${(q.y+q.h/2)/r.height} ${q.w/r.width} ${q.h/r.height}`).join('\n');files.push({name:'labels/'+r.id+'.txt',bytes:enc.encode(line+(line?'\n':''))});}}
 files.push({name:'meter-annotations.json',bytes:enc.encode(JSON.stringify({schema:5,classes:['separator','window'],coordinateSpace:'saved-image',images:items},null,2))});files.push({name:'README.txt',bytes:enc.encode('Класс 1: окошко показаний. Класс 0: разделитель (краска, точка дисплея, красный фон цифры). TXT только для фото с подтверждённым наличием или отсутствием обоих классов. Остальные фото не включать в обучение. Старые фото и их координаты остаются в прежней вырезке. Train/val разделять по физическим счётчикам.\n')});files.push({name:'data.yaml',bytes:enc.encode('path: .\ntrain: images/train\nval: images/val\nnames:\n  0: separator\n  1: window\n# Перед обучением разделите изображения и метки на train/val по счётчикам.\n')});
 downloadMeterFile(meterZip(files),'meter-window-separator-'+new Date().toISOString().slice(0,10)+'.zip');$('meter-label-status').textContent='Архив сформирован. Фото остаются на телефоне.';
 }catch(e){$('meter-label-status').textContent='Ошибка выгрузки: '+e.message;}finally{button.disabled=false;}
}
$('open-meter').addEventListener('click',openMeter);$('close-meter').addEventListener('click',closeMeter);
$('meter-camera').addEventListener('click',()=>openMeterCamera(false));$('meter-annotations').addEventListener('click',openMeterLabels);
$('meter-label-close').addEventListener('click',async()=>{stashMeterLabel();await persistMeterLabel();$('meter-label-screen').classList.add('hidden');$('meter-screen').classList.remove('hidden');});
$('meter-label-prev').addEventListener('click',async()=>{stashMeterLabel();await persistMeterLabel();meterLabels.index=Math.max(0,meterLabels.index-1);await showMeterLabel();});$('meter-label-next').addEventListener('click',async()=>{stashMeterLabel();await persistMeterLabel();meterLabels.index=Math.min(meterLabels.rows.length-1,meterLabels.index+1);await showMeterLabel();});
$('meter-label-empty').addEventListener('click',()=>saveMeterLabel('absent').catch(e=>$('meter-label-status').textContent=e.message));$('meter-label-unclear').addEventListener('click',()=>saveMeterLabel('unclear').catch(e=>$('meter-label-status').textContent=e.message));$('meter-label-delete').addEventListener('click',deleteMeterLabel);$('meter-label-export').addEventListener('click',exportMeterLabels);
$('meter-candidate').addEventListener('change',()=>{meterState.candidate=Number($('meter-candidate').value);repeatMeter();});
$('meter-model-files').addEventListener('change',()=>importMeterModels(Array.from($('meter-model-files').files||[])));
$('meter-reading').addEventListener('input',()=>{const text=$('meter-reading').value.split(/[,.]/)[0];renderMeterDigits(Array.from(text));});
$('meter-reading').addEventListener('change',()=>recordMeterApartment($('meter-reading').value.split(/[,.]/)[0]).catch(e=>setStatus('meter-status',e.message,'bad')));

$('meter-fraction-model').checked=localStorage.getItem('meter-fraction-model')==='true';
$('meter-fraction-model').addEventListener('change',()=>{localStorage.setItem('meter-fraction-model',String($('meter-fraction-model').checked));if(meterState.source&&!meterState.busy)repeatMeter();});

$('meter-label-window').addEventListener('click',()=>switchMeterLabel('window'));
$('meter-label-separator').addEventListener('click',()=>switchMeterLabel('separator'));
$('meter-upload-photos').addEventListener('click',()=>{if(!meterState.busy)$('meter-photo-files').click();});
$('meter-photo-files').addEventListener('change',()=>importMeterPhotos(Array.from($('meter-photo-files').files||[])).catch(e=>$('meter-label-status').textContent=e.message));
$('meter-count-warning-close').addEventListener('click',()=>$('meter-count-warning').classList.add('hidden'));
$('meter-count-warning').addEventListener('keydown',e=>{if(e.key==='Escape')$('meter-count-warning').classList.add('hidden');});
$('meter-expected-count').value=String(Math.max(1,Math.min(12,Number(localStorage.getItem('meter-expected-count'))||6)));
for(const [id,step] of [['meter-count-up',1],['meter-count-down',-1]])$(id).addEventListener('click',()=>{const value=Math.max(1,Math.min(12,Number($('meter-expected-count').value)+step));$('meter-expected-count').value=String(value);localStorage.setItem('meter-expected-count',String(value));});
window.addEventListener('resize',layoutMeterPreview);


$('meter-apartment-minus').addEventListener('click',()=>selectMeterApartment(meterApartments.number-1).catch(e=>setStatus('meter-status',e.message,'bad')));
$('meter-apartment-plus').addEventListener('click',()=>selectMeterApartment(meterApartments.number+1).catch(e=>setStatus('meter-status',e.message,'bad')));
$('meter-apartment-number').addEventListener('click',()=>{if(meterState.busy||state.shooting)return;const input=$('meter-apartment-input');input.value=String(meterApartments.number);$('meter-apartment-error').textContent='';$('meter-apartment-dialog').showModal();input.focus();input.select();});
$('meter-apartment-form').addEventListener('submit',async e=>{e.preventDefault();const value=Number($('meter-apartment-input').value);if(!Number.isInteger(value)||value<1||value>999999){$('meter-apartment-error').textContent='Введите номер от 1 до 999999';return;}try{await selectMeterApartment(value);$('meter-apartment-dialog').close();}catch(err){$('meter-apartment-error').textContent=err.message;}});
$('meter-apartment-cancel').addEventListener('click',()=>$('meter-apartment-dialog').close());
$('meter-show-separator').checked=localStorage.getItem('meter-show-separator')!=='false';
$('meter-show-separator').addEventListener('change',()=>{localStorage.setItem('meter-show-separator',String($('meter-show-separator').checked));renderMeterDigits(Array.from($('meter-reading').value));});
$('meter-export-readings').addEventListener('click',exportMeterReadings);
$('meter-clear-readings').addEventListener('click',()=>{if(!meterState.busy)$('meter-delete-dialog').showModal();});
$('meter-delete-cancel').addEventListener('click',()=>$('meter-delete-dialog').close());
$('meter-delete-confirm').addEventListener('click',async()=>{try{await meterApartments.ready;await meterReadingStore('clear');localStorage.removeItem('meter-apartment-history');meterApartments.history=[];meterApartments.snapshot=null;meterState.source=null;meterState.result=null;$('meter-reading').value='';$('meter-reading').disabled=false;renderMeterDigits([]);$('meter-photo').classList.add('apartment-no-photo');$('meter-preview').removeAttribute('src');$('meter-reading-field').classList.add('apartment-no-reading');renderMeterApartments();$('meter-delete-dialog').close();setStatus('meter-status','Показания удалены. Фото для разметки сохранены.');}catch(e){setStatus('meter-status',e.message,'bad');}});
renderMeterApartments();
meterApartments.ready=initMeterReadings();meterApartments.ready.catch(e=>setStatus('meter-status','Ошибка базы показаний: '+e.message,'bad'));

function meterXMLEscape(value){return String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));}
function meterReadingsXLSX(records){
 const enc=new TextEncoder(),cell=(ref,value)=>'<c r="'+ref+'" t="inlineStr"><is><t xml:space="preserve">'+meterXMLEscape(value)+'</t></is></c>';
 const rows=[['Квартира','Показание без дробной части','Дата и время']].concat(records.map(r=>[String(r.apartment),r.reading,r.created?new Date(r.created).toLocaleString('ru-RU'):'' ]));
 const sheet='<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="14" customWidth="1"/><col min="2" max="2" width="32" customWidth="1"/><col min="3" max="3" width="25" customWidth="1"/></cols><sheetData>'+rows.map((r,i)=>'<row r="'+(i+1)+'">'+r.map((v,k)=>cell(String.fromCharCode(65+k)+(i+1),v)).join('')+'</row>').join('')+'</sheetData></worksheet>';
 const files={
 '[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
 '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
 'xl/workbook.xml':'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Показания" sheetId="1" r:id="rId1"/></sheets></workbook>',
 'xl/_rels/workbook.xml.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
 'xl/worksheets/sheet1.xml':sheet};
 return new Blob([meterZip(Object.entries(files).map(([name,text])=>({name,bytes:enc.encode(text)})))],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
async function exportMeterReadings(){try{await meterApartments.ready;const rows=await meterReadingStore('getAll');if(!rows.length){setStatus('meter-status','Нет показаний для выгрузки.');return;}rows.sort((a,b)=>a.apartment-b.apartment);downloadMeterFile(meterReadingsXLSX(rows),'meter-readings-'+new Date().toISOString().slice(0,10)+'.xlsx');setStatus('meter-status','Файл Excel подготовлен: '+rows.length+' квартир. Проверьте, что файл сохранён.');}catch(e){setStatus('meter-status','Ошибка выгрузки: '+e.message,'bad');}}

$('load-meter-models').addEventListener('click',()=>{if(!meterState.busy)$('meter-model-files').click();});
meterImportedFiles().catch(e=>setStatus('settings-meter-status',e.message,'bad'));
