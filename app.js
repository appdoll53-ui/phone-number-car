const APP_VERSION = "100";
const MODEL_FILES = {"plate_det.onnx": {"bytes": 12238119, "sha256": "85d236280a1301ad98907947d284951dd2b20c23a6786ff50f7e6a8ec515bd50"}, "paddle_det.onnx": {"bytes": 4826518, "sha256": "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d"}, "paddle_rec.onnx": {"bytes": 7848423, "sha256": "b5f833dfc5d0eb71da397b4efa06ebeee9b431b690a47d6af40d77d8eabc557f"}};

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_";
const LAT_TO_CYR = { A: "А", B: "В", E: "Е", K: "К", M: "М", H: "Н", O: "О", P: "Р", C: "С", T: "Т", Y: "У", X: "Х" };
const CYR_TO_LAT = { А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", У: "Y", Х: "X" };
const PLATE_RE = /^[ABEKMHOPCTYX]\d{3}[ABEKMHOPCTYX]{2}\d{2,3}$/;

const $ = (id) => document.getElementById(id);
const state = { det: null, ocr: {}, stream: null, token: null, installEvent: null, zoom: 1, lastCrop: null };

function showWait(text) {
  $("wait-text").textContent = text;
  $("wait-actions").classList.add("hidden");
  $("wait-spinner").classList.remove("hidden");
  $("wait").classList.remove("hidden");
}

function hideWait() {
  $("wait").classList.add("hidden");
}

function setStatus(id, text, kind) {
  if(state.silentUpdating&&["update-status","offline-status"].includes(id))return;
  const el = $(id);
  el.textContent = text || "";
  el.className = "status" + (kind ? " " + kind : "");
  if (id === "offline-status") el.classList.toggle("hidden", !text);
  if (id === "model-status" && !state.loadingModels && $("recognition-status")) {
    $("recognition-status").textContent = text || "";
    $("recognition-status").className = el.className;
  }
}

function normalizePlate(raw) {
  const upper = String(raw || "").toUpperCase().replace(/[\s-]+/g, "");
  let out = "";
  for (const ch of upper) out += CYR_TO_LAT[ch] || ch;
  out = out.replace(/[^A-Z0-9]/g, "");
  if (/^[A-Z0]\d{3}[A-Z0]{2}\d{2,3}$/.test(out)) {
    const chars = [...out];
    for (const i of [0, 4, 5]) if (chars[i] === "0") chars[i] = "O";
    out = chars.join("");
  }
  return out;
}

function toCyrPlate(lat) {
  return [...lat].map((ch) => LAT_TO_CYR[ch] || ch).join("");
}

function paintPlate() {
  const clean = toCyrPlate(normalizePlate($("plate").value));
  const mask = $("plate-mask");
  mask.classList.toggle("empty", !clean);
  if (!clean) {
    mask.innerHTML = "Введите номер машины<br>или сфотографируйте";
    return;
  }
  if (PLATE_RE.test(normalizePlate(clean))) {
    mask.innerHTML = [...clean].map((ch, i) => {
      const kind = [0, 4, 5].includes(i) ? "letter" : i >= 6 ? "region" : "digit";
      return `<span class="${kind}">${ch}</span>`;
    }).join("");
  } else {
    mask.textContent = clean;
  }
}

function editPlate() {
  $("plate-mask").classList.add("hidden");
  $("plate").classList.remove("hidden");
  $("plate").focus();
}

function finishPlateEdit() {
  $("plate").value = formatPlate($("plate").value);
  $("plate").classList.add("hidden");
  $("plate-mask").classList.remove("hidden");
  paintPlate();
}

function formatPlate(raw) {
  const clean = toCyrPlate(normalizePlate(raw));
  if (!clean) return "";
  return [clean.slice(0, 1), clean.slice(1, 4), clean.slice(4, 6), clean.slice(6, 9)].filter(Boolean).join(" ");
}

function enhancePlate(source) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.filter = "contrast(1.5) brightness(1.15)";
  ctx.drawImage(source, 0, 0);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const src = new Uint8ClampedArray(img.data);
  const w = canvas.width;
  const h = canvas.height;
  const out = img.data;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const center = src[i + c];
        const blur = (src[i - 4 + c] + src[i + 4 + c] + src[i - w * 4 + c] + src[i + w * 4 + c]) / 4;
        out[i + c] = Math.max(0, Math.min(255, center + (center - blur) * 0.85));
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function phoneHref(raw) {
  const digits = String(raw || "").replace(/[^\d+]/g, "");
  if (/^8\d{10}$/.test(digits)) return "+7" + digits.slice(1);
  if (/^7\d{10}$/.test(digits)) return "+" + digits;
  return digits;
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("nomera", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("directory")) db.createObjectStore("directory", { keyPath: "key" });
      if (!db.objectStoreNames.contains("pending")) db.createObjectStore("pending", { keyPath: "id" });
      if (!db.objectStoreNames.contains("models")) db.createObjectStore("models", { keyPath: "name" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(store, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readwrite").objectStore(store).put(value);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbGet(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(store, key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, "readwrite").objectStore(store).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// Read and commit directory plus outbox together. Concurrent saves cannot be erased by sync.
async function mutateContacts(change) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["directory", "pending"], "readwrite");
    const directoryStore = tx.objectStore("directory"), pendingStore = tx.objectStore("pending");
    const a = directoryStore.getAll(), b = pendingStore.getAll();
    let directory, pending, result;
    const apply = () => {
      if (!directory || !pending) return;
      try {
        const data = { directory, pending };
        result = change(data);
        directoryStore.clear(); pendingStore.clear();
        data.directory.forEach(row => directoryStore.put(row));
        data.pending.forEach(row => pendingStore.put(row));
      } catch (err) { reject(err); tx.abort(); }
    };
    a.onsuccess = () => { directory = a.result; apply(); };
    b.onsuccess = () => { pending = b.result; apply(); };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error("Изменения не сохранены"));
  });
}

function directoryFromContacts(contacts, deferred = []) {
  const rows = new Map(deferred.map(row => [row.key, { ...row, contacts: [] }]));
  for (const contact of contacts) {
    if (contact.deleted) continue;
    const key = normalizePlate(contact.plate);
    if (!key) continue;
    if (!rows.has(key)) rows.set(key, { key, plate: toCyrPlate(key), contacts: [] });
    const row = rows.get(key);
    row.contacts.push({ ...contact }); row.name = row.contacts[0].name; row.phone = row.contacts[0].phone;
  }
  return [...rows.values()];
}

function overlayPending(remote, pending, deferred) {
  let contacts = remote.filter(c => !c.deleted).map(c => ({ ...c }));
  for (const op of pending) {
    const key = op.key || normalizePlate(op.plate);
    contacts = contacts.filter(c => c.id !== op.id && !(op.previousPhone && normalizePlate(c.plate) === key && phoneHref(c.phone) === phoneHref(op.previousPhone)));
    if (op.type !== "delete") contacts.push({ id: op.id, plate: op.plate, name: op.name, phone: op.phone, rev: op.baseRev || "" });
  }
  return directoryFromContacts(contacts, deferred);
}

function makeOperation(edit, previous, queued, contact, type = "upsert") {
  return { ...contact, key: edit.key, plate: toCyrPlate(edit.key), type,
    opId: crypto.randomUUID(), originOpId: queued?.originOpId || queued?.opId || "", baseRev: queued ? queued.baseRev || "" : previous?.rev || "",
    base: queued ? queued.base : previous ? { name: previous.name, phone: previous.phone } : null,
    previousPhone: queued ? queued.previousPhone || "" : previous?.phone || "",
    createdAt: queued?.createdAt || new Date().toISOString() };
}

function actionIcon(name){
 const paths={sms:'<path d="M4 3h16v13H8l-4 4V3Z"/><path d="M7 7h10M7 11h7"/>',telegram:'<path d="m3 10 18-7-5 18-5-7-8-4Z"/><path d="m11 14 10-11"/>',copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',edit:'<path d="m4 16 12-12 4 4L8 20H4v-4Z"/><path d="m13 7 4 4"/>'};
 return '<svg class="action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">'+(paths[name]||'')+'</svg>';
}
function settings() {
  return {
    scriptUrl: localStorage.getItem("scriptUrl") || "",
    secret: localStorage.getItem("scriptSecret") || "",
    messageText: localStorage.getItem("messageText") || "",
    sharpFrames: true,
    perspective: false
  };
}

function saveSettings() {
  localStorage.setItem("scriptUrl", $("script-url").value.trim());
  localStorage.setItem("scriptSecret", $("script-secret").value.trim());
  localStorage.setItem("messageText", $("message-text").value);
  localStorage.removeItem("perspective");
  setStatus("settings-status", "Настройки сохранены.", "ok");

}

async function validateDownloadedModel(buf, name) {
  const expected = MODEL_FILES[name];
  if (!expected) throw new Error("Неизвестный файл модели: " + name);
  if (buf.byteLength !== expected.bytes) {
    throw new Error(name + ": неверный размер — " + buf.byteLength + " байт, ожидается " + expected.bytes + ". Вместо модели могла загрузиться страница сайта или неполный файл.");
  }
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== expected.sha256) throw new Error(name + ": файл повреждён или отличается от опубликованной модели.");
}

async function fetchModel(url, label, force = false) {
  const name = url.split("/").pop();
  const cache = await caches.open("nomera-models");
  if (!force) {
    const hit = await cache.match(url);
    if (hit) {
      const buf = await hit.arrayBuffer();
      try { await validateDownloadedModel(buf, name); return buf; }
      catch (_) { await cache.delete(url); }
    }
  }
  const requestUrl = new URL(url, location.href);
  requestUrl.searchParams.set("modelVersion", APP_VERSION);
  requestUrl.searchParams.set("download", Date.now());
  const res = await fetch(requestUrl.href, { cache: "no-store" });
  if (!res.ok) throw new Error(name + ": сервер вернул HTTP " + res.status + ". Проверьте файл в папке models на сайте.");
  if ((res.headers.get("content-type") || "").includes("text/html")) {
    throw new Error(name + ": сайт вернул HTML-страницу вместо модели. Проверьте папку models.");
  }
  const total = MODEL_FILES[name] && MODEL_FILES[name].bytes;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
    got += step.value.length;
    const pct = total ? Math.round(got / total * 100) + "%" : Math.round(got / 1e6) + " МБ";
    showWait(label + ": " + pct);
    setStatus("model-status", label + ": " + pct);
  }
  const buf = new Uint8Array(got);
  let offset = 0;
  for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }
  await validateDownloadedModel(buf.buffer, name);
  await cache.put(url, new Response(buf.slice(), { headers: { "Content-Type": "application/octet-stream" } }));
  return buf.buffer;
}

async function createModelSession(buf, name) {
  try {
    return await ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
  } catch (err) {
    if (/protobuf|INVALID_PROTOBUF/i.test(String(err.message || err))) {
      await Promise.allSettled([
        dbDelete("models", name),
        caches.open("nomera-models").then(cache => cache.delete("models/" + name))
      ]);
    }
    throw new Error(name + " (" + buf.byteLength + " байт): " + (err.message || err) + ". Повторите загрузку моделей через сообщение об ошибке или в настройках.");
  }
}

async function prepareOrt() {
  if (!window.ort) throw new Error("Движок распознавания не загрузился");
  ort.env.wasm.wasmPaths = new URL("ort/", window.location.href).href;
  ort.env.wasm.numThreads = 1;
}

function modelProgress(name,text) {}

async function activateModels(detBuf, paddleDetBuf, paddleRecBuf) {
  await prepareOrt();
  const created = [];
  try {
    for (const [name, buf, label] of [
      ["plate_det.onnx", detBuf, "поиска номера"],
      ["paddle_det.onnx", paddleDetBuf, "поиска текста PaddleOCR"],
      ["paddle_rec.onnx", paddleRecBuf, "чтения текста PaddleOCR"]
    ]) {
      modelProgress(name, "Подготовка…");
      showWait("Подготавливаем модель " + label + "…");
      created.push(await createModelSession(buf, name));
      modelProgress(name, "Готова");
    }
  } catch (err) {
    await Promise.allSettled(created.map(session => session.release()));
    throw err;
  }
  const old = [state.det, ...Object.values(state.ocr)].filter(Boolean);
  state.det = created[0];
  state.ocr = { paddleDet: created[1], paddleRec: created[2] };
  await Promise.allSettled(old.map(session => session.release()));
  $("open-cam").disabled = false;
  
  setStatus("model-status", "Все модели готовы. Распознавание работает без интернета.", "ok");
}

async function loadAllModels() {
  localStorage.removeItem("ocrModel");
  localStorage.removeItem("perspective");
  await dbDelete("models", "plate_ocr.onnx");
  await (await caches.open("nomera-models")).delete("models/plate_ocr.onnx");
  await dbDelete("models", "plate_ocr_eu.onnx");
  await (await caches.open("nomera-models")).delete("models/plate_ocr_eu.onnx");
  state.loadingModels = true;
  $("open-cam").disabled = true;
  setStatus("model-status", "Проверяем сохранённые модели…");
  showWait("Проверяем модели на телефоне…");
  try {
    const buffers = [];
    for (const [name, label] of [
      ["plate_det.onnx", "поиска номера"],
      ["paddle_det.onnx", "поиска текста PaddleOCR"],
      ["paddle_rec.onnx", "чтения текста PaddleOCR"]
    ]) {
      let buf = null;
      const saved = await dbGet("models", name);
      if (saved) {
        modelProgress(name, "Проверка…");
        try { await validateDownloadedModel(saved.buf, name); buf = saved.buf; }
        catch (_) { await dbDelete("models", name); }
      }
      if(buf&&saved?.version!==APP_VERSION){
        try{const updated=await fetchModel('models/'+name,'распознавания',true);const check=await ort.InferenceSession.create(updated,{executionProviders:["wasm"]});await check.release();await dbPut('models',{name,buf:updated,version:APP_VERSION});buf=updated;}catch(error){state.modelUpdateNote=error.message;}
      }
      if (!buf) {
        buf=await fetchModel('models/'+name,'распознавания');await dbPut('models',{name,buf,version:APP_VERSION});
      }
      modelProgress(name, "Сохранена на телефоне");
      buffers.push(buf);
    }
    await activateModels(...buffers);
  } finally {
    state.loadingModels = false;
    hideWait();
  }
}

function ensureModels() {
  if (state.det && state.ocr.paddleDet && state.ocr.paddleRec) return Promise.resolve();
  if (!state.modelsPromise) {
    state.modelsPromise = loadAllModels().finally(() => { state.modelsPromise = null; });
  }
  return state.modelsPromise;
}

async function startModels() {
  try {
    await ensureModels();
  } catch (err) {
    setStatus("model-status", "Модели не готовы: " + err.message, "bad");
    
    showWait("Не удалось подготовить распознавание. " + err.message);
    $("wait-spinner").classList.add("hidden");
    $("wait-actions").classList.remove("hidden");
  }
}

function setAppSection(section) {
  try{localStorage.setItem("lastAppSection",section);}catch(_){}
  if(state.stream) closeCamera();
  if(section!=='meter' && typeof meterState!=='undefined'){state.cameraMode='plate';meterState.collecting=false;$('cam').classList.remove('meter-camera');}
  for(const [id,name] of [['main-screen','car'],['settings','settings'],['meter-screen','meter']]) $(id).classList.toggle('hidden',section!==name);
  $('search-history').classList.remove('hidden');$('meter-label-screen').classList.add('hidden');
  $('car-subnav').classList.add('hidden');
  if(section==='car')renderSearchHistory().catch(()=>{});
  $('open-history').textContent='История';$('open-history').setAttribute('aria-expanded','false');$('open-history').classList.remove('active');
  for(const [id,name] of [['open-car','car'],['open-meter','meter'],['open-settings','settings']]) {$(id).classList.toggle('active',section===name);$(id).setAttribute('aria-pressed',String(section===name));}
  window.scrollTo(0,0);
}
function toggleSettings(){setAppSection('settings');}

function letterbox(source, size = 640) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "rgb(114,114,114)";
  ctx.fillRect(0, 0, size, size);
  const scale = Math.min(size / source.width, size / source.height);
  const nw = source.width * scale;
  const nh = source.height * scale;
  const dx = (size - nw) / 2;
  const dy = (size - nh) / 2;
  ctx.drawImage(source, dx, dy, nw, nh);
  return { canvas, scale, dx, dy };
}

function nms(boxes, iouLimit = 0.45) {
  boxes.sort((a, b) => b.conf - a.conf);
  const kept = [];
  for (const box of boxes) {
    if (kept.every((k) => iou(k, box) < iouLimit)) kept.push(box);
  }
  return kept;
}

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1);
  const y1 = Math.max(a.y1, b.y1);
  const x2 = Math.min(a.x2, b.x2);
  const y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const area = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return area ? inter / area : 0;
}

async function detectPlate(source) {
  const { canvas, scale, dx, dy } = letterbox(source, 640);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, 640, 640).data;
  const input = new Float32Array(1 * 3 * 640 * 640);
  for (let i = 0; i < 640 * 640; i++) {
    input[i] = img[i * 4] / 255;
    input[640 * 640 + i] = img[i * 4 + 1] / 255;
    input[640 * 640 * 2 + i] = img[i * 4 + 2] / 255;
  }
  const tensor = new ort.Tensor("float32", input, [1, 3, 640, 640]);
  const out = await state.det.run({ images: tensor });
  const data = out.output0.data;
  const n = 8400;
  const boxes = [];
  let maxConf = 0;
  for (let i = 0; i < n; i++) {
    let conf = data[4 * n + i];
    if (conf > 1 || conf < 0) conf = 1 / (1 + Math.exp(-conf));
    if (conf > maxConf) maxConf = conf;
    if (conf < 0.35) continue;
    const cx = data[i];
    const cy = data[n + i];
    const w = data[2 * n + i];
    const h = data[3 * n + i];
    const x1 = (cx - w / 2 - dx) / scale;
    const y1 = (cy - h / 2 - dy) / scale;
    const x2 = (cx + w / 2 - dx) / scale;
    const y2 = (cy + h / 2 - dy) / scale;
    boxes.push({ x1, y1, x2, y2, conf });
  }
  const best = nms(boxes)[0];
  if (!best) return { crop: source, conf: maxConf, found: false };
  const boxW = best.x2 - best.x1;
  const boxH = best.y2 - best.y1;
  if (boxW < source.width * 0.15 || boxH < source.height * 0.12) {
    return { crop: source, conf: best.conf, found: false };
  }
  const padX = (best.x2 - best.x1) * 0.06;
  const padY = (best.y2 - best.y1) * 0.08;
  const crop = cropImage(source, best.x1 - padX, best.y1 - padY, best.x2 + padX, best.y2 + padY);
  return { crop, conf: best.conf, found: true, bounds:{left:best.x1-padX,top:best.y1-padY,right:best.x2+padX,bottom:best.y2+padY} };
}

function cropImage(source, x1, y1, x2, y2) {
  const left = Math.max(0, Math.floor(x1));
  const top = Math.max(0, Math.floor(y1));
  const right = Math.min(source.width, Math.ceil(x2));
  const bottom = Math.min(source.height, Math.ceil(y2));
  const w = Math.max(1, right - left);
  const h = Math.max(1, bottom - top);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(source, left, top, w, h, 0, 0, w, h);
  return canvas;
}

function softmaxPick(logits, classes) {
  let max = -Infinity;
  for (let i = 0; i < classes; i++) if (logits[i] > max) max = logits[i];
  let sum = 0;
  const exps = new Array(classes);
  for (let i = 0; i < classes; i++) {
    exps[i] = Math.exp(logits[i] - max);
    sum += exps[i];
  }
  let best = 0;
  for (let i = 1; i < classes; i++) if (exps[i] > exps[best]) best = i;
  return { index: best, prob: exps[best] / sum };
}

async function readPlate(crop) {
  return readPaddlePlate(crop);
}

function extractRuPlate(text) {
  const clean = normalizePlate(text);
  let best = "";
  for (let i = 0; i < clean.length; i++) {
    for (const len of [9, 8]) {
      const slice = normalizePlate(clean.slice(i, i + len));
      if (PLATE_RE.test(slice) && slice.length > best.length) best = slice;
    }
  }
  if (best) return best;
  return PLATE_RE.test(clean) ? clean : "";
}

async function recognize(canvas, skipDet, preparedDet=null) {
  await ensureModels();
  const attempts=[];
  async function read(source, method, foundBox=false) {
    const ocr=await readPlate(source);
    const result={plate:ocr.text,rawText:ocr.rawText,conf:ocr.conf,foundBox,crop:canvas,detectedCrop:source,plateType:state.photoPlateType||state.plateType||"long",method};
    attempts.push(result);return result;
  }
  if(skipDet)return read(canvas,"экранная рамка");
  const det=preparedDet||await detectPlate(canvas),square=(state.photoPlateType||state.plateType)==="square",ratio=det.crop.width/det.crop.height;
  const target=det.found&&(!square||(ratio>=1.15&&ratio<=2.5))?det.crop:canvas;
  let result=await read(target,target===canvas?"экранная рамка":"табличка",target!==canvas);
  if(target!==canvas){
    const full=await read(canvas,"экранная рамка");
    if(result.plate&&full.plate&&result.plate!==full.plate){
      const chosen=result.conf>=full.conf?result:full;
      return {...chosen,disagreement:true,alternatives:[result.plate,full.plate]};
    }
    if(result.plate)return result;
    if(full.plate)return full;
  }else if(result.plate)return result;
  // Try perspective correction only after the untouched crops failed.
  const corrected=rectifyPlate(target);
  if(corrected!==target){result=await read(corrected,"выравнивание перспективы",target!==canvas);if(result.plate)return result;}
  return attempts[0];
}

async function openCamera() {
  setStatus("search-status", "");
  hideMissingOffer();
  $("zoom-control").style.visibility = "hidden";
  $("cam").classList.add("camera-opening");
  $("cam").classList.remove("hidden");
  layoutZoomSlider();
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });
    const hint = document.querySelector(".cam-hint");
    if (hint) hint.textContent = state.cameraMode === "meter" ? "Держите счётчик целиком в рамке. Нажмите для фокусировки." : "Держите номер целиком в рамке. Нажмите на номер для фокусировки.";
    const video = $("video");
    video.srcObject = state.stream;
    await video.play();
    const track = state.stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    state.cameraCaps = caps;
    state.hardwareZoom = Boolean(caps.zoom && caps.zoom.max > 1);
    state.zoomMin = state.hardwareZoom ? (caps.zoom.min || 1) : 1;
    state.hardwareZoomMax = state.hardwareZoom ? Math.max(state.zoomMin, Math.min(2.5, caps.zoom.max)) : 1;
    if (state.hardwareZoom && caps.zoom.step) {
      state.hardwareZoomMax = Number((state.zoomMin + Math.floor((state.hardwareZoomMax - state.zoomMin + 1e-8) / caps.zoom.step) * caps.zoom.step).toFixed(6));
    }
    state.appliedHardwareZoom = track.getSettings().zoom || state.zoomMin;
    state.digitalZoom = 1;
    state.acceptedHardwareZoom = null;
    state.zoomMax = Number((state.hardwareZoomMax * (state.cameraMode === "meter" ? 1 : 4)).toFixed(6));
    state.zoomQueue = Promise.resolve();
    state.zoomTarget = state.zoomMin;
    state.zoomMotion = null;
    state.torchOn = false;
    state.torchQueue = Promise.resolve();
    $("torch").classList.toggle("hidden", !caps.torch);
    $("torch").textContent = "Фонарик";
    $("torch").setAttribute("aria-pressed", "false");
    state.focusQueue = Promise.resolve();
    state.photoCapture = null;
    state.photoCaptureError = null;
    if (typeof ImageCapture !== "undefined") {
      try { state.photoCapture = new ImageCapture(track); } catch (error) { state.photoCaptureError = error.name+": "+error.message; }
    }
    if (caps.focusMode && caps.focusMode.includes("continuous")) {
      try { await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch (_) {}
    }
    initZoomSlider();
    await setZoom(state.cameraMode === "meter" ? Math.min(state.zoomMax, Number(localStorage.getItem('meter-camera-zoom')) || state.zoomMin) : state.zoomMin);
    if(state.cameraMode === "meter" && caps.torch && localStorage.getItem('meter-camera-torch') === 'true') await toggleTorch();
    layoutZoomSlider();
    $("zoom-control").style.visibility = "visible";
    $("cam").classList.remove("camera-opening");
  } catch (err) {
    closeCamera();
    setStatus(state.cameraMode === "meter" ? "meter-status" : "model-status", "Камера не открылась: " + err.message, "bad");
  }
}

function closeCamera() {
  if(state.cameraMode === 'meter' && state.stream){localStorage.setItem('meter-camera-zoom',String(state.zoomTarget ?? state.zoom));localStorage.setItem('meter-camera-torch',String(Boolean(state.torchOn)));}
  $("meter-collect-status").classList.add("hidden");
  state.zoomMotionToken = (state.zoomMotionToken || 0) + 1;
  state.torchOn = false;
  $("torch").classList.add("hidden");
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  state.photoCapture = null;
  $("cam").classList.add("hidden");
}

function applyZoom(value) {
  state.zoom = Math.max(state.zoomMin || 1, Math.min(state.zoomMax || 4, value));
  const target = state.zoom;
  const sequence = state.zoomSequence = (state.zoomSequence || 0) + 1;
  const stream = state.stream;
  const focusReady = state.focusQueue;
  const torchReady = state.torchQueue;
  state.zoomQueue = (state.zoomQueue || Promise.resolve()).then(async () => {
    await focusReady;
    await torchReady;
    if (!stream || stream !== state.stream || sequence !== state.zoomSequence) return;
    state.zoomBusy = true;
    const track = stream.getVideoTracks()[0];
    let cameraZoom = state.appliedHardwareZoom || 1;
    if (state.hardwareZoom) {
      const range = state.cameraCaps.zoom;
      let desired = Math.min(target, state.hardwareZoomMax);
      if (range.step) desired = range.min + Math.floor((desired - range.min + 1e-8) / range.step) * range.step;
      desired = Math.max(range.min, Math.min(state.hardwareZoomMax, desired));
      try {
        if (Math.abs(desired - (state.acceptedHardwareZoom ?? cameraZoom)) > 1e-6) {
          await track.applyConstraints({ advanced: [{ zoom: desired, ...(state.cameraCaps.torch ? {torch:Boolean(state.torchOn)} : {}) }] });
        }
        state.acceptedHardwareZoom = desired;
        cameraZoom = track.getSettings().zoom || desired;
      } catch (_) {
        cameraZoom = track.getSettings().zoom || cameraZoom;
        state.hardwareZoom = false;
        state.hardwareZoomMax = Math.max(1, cameraZoom);
        state.zoomMax = Math.max(1, cameraZoom) * (state.cameraMode === "meter" ? 1 : 4);
        initZoomSlider();
      }
    }
    if (stream !== state.stream) { state.zoomBusy = false; return; }
    state.appliedHardwareZoom = cameraZoom;
    // Never compensate for hardware rounding with digital scaling.
    // Start the digital phase after the final hardware command succeeds.
    // getSettings() can lag or round down; it must not permanently block zoom.
    const limit = state.hardwareZoomMax || 1;
    const reachedLimit = !state.hardwareZoom || (state.acceptedHardwareZoom ?? cameraZoom) >= limit - 1e-6;
    state.digitalZoom = state.cameraMode !== "meter" && target > limit && reachedLimit ? Math.min(4, target / limit) : 1;
    paintCameraTransform();
    const effectiveZoom = cameraZoom * state.digitalZoom;
    if (sequence === state.zoomSequence) { state.zoom = target; if(state.cameraMode==='meter')localStorage.setItem('meter-camera-zoom',String(target)); }
    $("zoom-slider").value = zoomToSlider(target);
    $("zoom-slider").setAttribute("aria-valuetext", effectiveZoom.toFixed(1) + " крат");
    $("zoom-label").textContent = effectiveZoom.toFixed(1).replace(/\.0$/, "") + "×";
    const info = $("zoom-info");
    state.zoomBusy = false;
    if (info) info.textContent = state.cameraMode === "meter" ? "Камера: " + cameraZoom.toFixed(1) + "× · предел: " + state.hardwareZoomMax + "×" : "Камера: " + cameraZoom.toFixed(1) + "× · цифровой: " + state.digitalZoom.toFixed(1) + "× · предел: " + state.zoomMax + "×";
  }).catch(() => { state.zoomBusy = false; });
  return state.zoomQueue;
}

// Map the displayed preview back to the untransformed video pixels.
function previewPoint(screenX, screenY) {
  const video = $("video");
  const view = $("cam-view").getBoundingClientRect();
  const contain = getComputedStyle(video).objectFit === "contain";
  const scale = (contain ? Math.min : Math.max)(view.width / video.videoWidth, view.height / video.videoHeight);
  const offsetX = (view.width - video.videoWidth * scale) / 2;
  const offsetY = (view.height - video.videoHeight * scale) / 2;
  const z = state.digitalZoom || 1;
  return {
    x: ((screenX - view.left - view.width / 2) / z + view.width / 2 - offsetX) / scale,
    y: ((screenY - view.top - view.height / 2) / z + view.height / 2 - offsetY) / scale
  };
}

// Reserve the first half for hardware zoom when photographing a plate.
function sliderToZoom(position){
 const p=Math.max(0,Math.min(1,position)),min=state.zoomMin||1,max=state.zoomMax||1,limit=state.hardwareZoomMax||min;
 if(state.cameraMode==='meter'||limit<=min||max<=limit)return min+p*(max-min);
 return p<=.5?min+p*2*(limit-min):limit+(p-.5)*2*(max-limit);
}
function zoomToSlider(value){
 const min=state.zoomMin||1,max=state.zoomMax||1,limit=state.hardwareZoomMax||min,v=Math.max(min,Math.min(max,value));
 if(max<=min)return 0;
 if(state.cameraMode==='meter'||limit<=min||max<=limit)return (v-min)/(max-min);
 return v<=limit?(v-min)/(limit-min)*.5:.5+(v-limit)/(max-limit)*.5;
}
function initZoomSlider(){
 const slider=$('zoom-slider');slider.min=0;slider.max=1;slider.step=.001;
 slider.value=zoomToSlider(state.zoomTarget??state.zoom??state.zoomMin??1);
 slider.disabled=(state.zoomMax||1)<=(state.zoomMin||1);
}

function selectPlateType(type) {
  if (state.shooting) return;
  state.plateType = type;
  for (const [id, kind] of [["plate-frame", "long"], ["square-frame", "square"]]) {
    $(id).classList.toggle("inactive", kind !== type);
    $(id).setAttribute("aria-pressed", String(kind === type));
  }
  paintCameraShade();
}

function layoutZoomSlider() {
  const frame = $("plate-frame").getBoundingClientRect();
  const cam = $("cam").getBoundingClientRect();
  if (!frame.width || !cam.height) return;
  const square = $("square-frame"),isMeter=state.cameraMode==='meter';
  const oldWidth=frame.width,oldHeight=oldWidth/4.1;
  const squareWidth=Math.min(oldWidth*.56,cam.height*.42),squareHeight=squareWidth/(290/170);
  const factor=squareHeight/oldHeight;
  if(!isMeter){$('plate-frame').style.height=squareHeight+'px';$('plate-frame').style.aspectRatio='auto';}
  else{$('plate-frame').style.height='';$('plate-frame').style.aspectRatio='';}
  const current=$('plate-frame').getBoundingClientRect();
  square.style.width=(squareWidth*factor)+'px';square.style.height=(squareHeight*factor)+'px';
  square.style.top=(current.bottom-cam.top-squareHeight*factor)+'px';
  const controls=document.querySelector('.cam-controls');controls.style.top='';
  const side=$('zoom-control');
  // Same slider position/length in both modes, independent of the meter frame height.
  const carWidth=Math.min(cam.width*.88,536),carBaseHeight=carWidth/4.1;
  const carSquareHeight=Math.min(carWidth*.56,cam.height*.42)/(290/170);
  const sliderTop=cam.height*.5+carSquareHeight/2;
  side.style.top=sliderTop+'px';side.style.height=Math.max(52,cam.height-64-sliderTop)+'px';
  side.style.left=(cam.width-112)+'px';
  paintCameraShade();
}

function paintCameraTransform() {
  const video = $("video");
  const view = $("cam-view").getBoundingClientRect();
  if (video.videoWidth && video.videoHeight) {
    const scale = (getComputedStyle(video).objectFit === "contain" ? Math.min : Math.max)(view.width / video.videoWidth, view.height / video.videoHeight);
    video.style.position = "absolute";
    video.style.width = video.videoWidth * scale + "px";
    video.style.height = video.videoHeight * scale + "px";
    video.style.left = (view.width - video.videoWidth * scale) / 2 + "px";
    video.style.top = (view.height - video.videoHeight * scale) / 2 + "px";
  }
  video.style.transform = "scale(" + (state.digitalZoom || 1) + ")";
  layoutZoomSlider();
}

function focusAt(screenX, screenY) {
  if (state.shooting) return state.focusQueue || Promise.resolve();
  const stream = state.stream;
  const zoomReady = state.zoomQueue;
  state.focusQueue = (state.focusQueue || Promise.resolve()).then(async () => {
    await zoomReady;
    if (!stream || stream !== state.stream) return;
    const video = $("video");
    const point = previewPoint(screenX, screenY);
    if (point.x < 0 || point.y < 0 || point.x > video.videoWidth || point.y > video.videoHeight) return;
    const caps = state.cameraCaps || {};
    if (!navigator.mediaDevices.getSupportedConstraints?.().pointsOfInterest) {
      const hint = document.querySelector(".cam-hint");
      if (hint) hint.textContent = "Фокусировка по нажатию недоступна. Камера использует автофокус.";
      return;
    }
    const config = { ...(caps.torch ? {torch:Boolean(state.torchOn)} : {}), pointsOfInterest: [{ x: point.x / video.videoWidth, y: point.y / video.videoHeight }] };
    if (caps.focusMode && caps.focusMode.includes("single-shot")) config.focusMode = "single-shot";
    else if (caps.focusMode && caps.focusMode.includes("continuous")) config.focusMode = "continuous";
    if (state.hardwareZoom) config.zoom = state.acceptedHardwareZoom ?? state.appliedHardwareZoom;
    const hint = document.querySelector(".cam-hint");
    try {
      await stream.getVideoTracks()[0].applyConstraints({ advanced: [config] });
      if (hint) hint.textContent = "Запрос фокусировки отправлен. Дождитесь резкости и нажмите «Снять».";
      await new Promise(resolve => setTimeout(resolve, 450));
    } catch (_) {
      if (hint) hint.textContent = "Камера использует автофокус. Дождитесь резкого изображения.";
    }
  }).catch(() => {});
  return state.focusQueue;
}

function bindFocus() {
  const view = $("cam-view");
  let tap = null;
  view.addEventListener("pointerdown", e => {
    if (!e.isPrimary) { tap = null; return; }
    tap = { x: e.clientX, y: e.clientY, time: Date.now() };
  });
  view.addEventListener("pointermove", e => {
    if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 12) tap = null;
  });
  view.addEventListener("pointercancel", () => { tap = null; });
  view.addEventListener("touchstart", e => { if (e.touches.length > 1) tap = null; }, { passive: true });
  view.addEventListener("pointerup", e => {
    if (tap && Date.now() - tap.time < 600) focusAt(e.clientX, e.clientY);
    tap = null;
  });
}

function bindPinchZoom() {
  const view = $("cam-view");
  let startDist = 0;
  let startZoom = 1;
  view.addEventListener("touchstart", (e) => {
    if (e.touches.length === 2) {
      startDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      startZoom = state.zoom;
    }
  }, { passive: true });
  view.addEventListener("touchmove", (e) => {
    if (e.touches.length !== 2 || !startDist) return;
    e.preventDefault();
    const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    setZoom(startZoom * dist / startDist);
  }, { passive: false });
}

function frameRegion() {
  const frame = $(state.plateType === "square" ? "square-frame" : "plate-frame").getBoundingClientRect();
  const a = previewPoint(frame.left + 3, frame.top + 3);
  const b = previewPoint(frame.right - 3, frame.bottom - 3);
  return { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
}

function framedCrop(source, region, videoWidth, videoHeight) {
  const view=source.captureViewport||{left:0,top:0,width:source.width,height:source.height};
  const sx=view.width/videoWidth,sy=view.height/videoHeight,padX=(region.x2-region.x1)*.04,padY=(region.y2-region.y1)*.08;
  const result=cropImage(source,view.left+(region.x1-padX)*sx,view.top+(region.y1-padY)*sy,view.left+(region.x2+padX)*sx,view.top+(region.y2+padY)*sy);
  // The full capture is temporary: keep only the screen-frame crop.
  source.width=source.height=1;
  return result;
}
function photoViewport(photo,video){
  const ratio=video.width/video.height;
  const width=Math.min(photo.width,photo.height*ratio),height=width/ratio;
  return {left:(photo.width-width)/2,top:(photo.height-height)/2,width,height};
}
function matchPhotoViewport(photo,video){
  // Match the live view against the photo at low resolution; different aspect ratios
  // alone do not tell us which sensor crop the browser used.
  function gray(source,w,h){const c=document.createElement('canvas');c.width=w;c.height=h;const ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(source,0,0,w,h);const rgba=ctx.getImageData(0,0,w,h).data,g=new Float32Array(w*h);for(let i=0;i<g.length;i++)g[i]=rgba[i*4]*.299+rgba[i*4+1]*.587+rgba[i*4+2]*.114;return g;}
  const size=32,small=160,v=gray(video,size,size),p=gray(photo,small,small),initial=photoViewport(photo,video);
  let best=null;
  for(const factor of [.5,.6,.7,.8,.9,1])for(const dx of [-.08,0,.08])for(const dy of [-.08,0,.08]){
    const width=initial.width*factor,height=initial.height*factor,left=Math.max(0,Math.min(photo.width-width,(photo.width-width)/2+dx*photo.width)),top=Math.max(0,Math.min(photo.height-height,(photo.height-height)/2+dy*photo.height));
    let av=0,ap=0,vv=0,pp=0,vp=0;
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){
      const a=v[y*size+x],px=Math.min(small-1,Math.max(0,Math.floor((left+(x+.5)/size*width)/photo.width*small))),py=Math.min(small-1,Math.max(0,Math.floor((top+(y+.5)/size*height)/photo.height*small))),b=p[py*small+px];av+=a;ap+=b;vv+=a*a;pp+=b*b;vp+=a*b;
    }
    const n=size*size,varianceV=vv-av*av/n,varianceP=pp-ap*ap/n,score=varianceV>n*20&&varianceP>n*20?(vp-av*ap/n)/Math.sqrt(varianceV*varianceP):0;
    if(!best||score>best.score)best={left,top,width,height,score};
  }
  return best;
}

async function capturePhoto(video) {
  const fallback=grabFrame(video);state.captureKind="кадр видео";
  const track=state.stream?.getVideoTracks()[0];
  state.captureDebug={requestedVideo:[1920,1080],video:[video.videoWidth,video.videoHeight],track:track?.getSettings?.()||{},imageCaptureAvailable:typeof ImageCapture!=="undefined",imageCaptureCreated:Boolean(state.photoCapture),stage:"начало",reason:""};
  const debug=state.captureDebug,capture=state.photoCapture;
  if(!capture){debug.reason=state.photoCaptureError?"Создание ImageCapture: "+state.photoCaptureError:"ImageCapture недоступен";return fallback;}
  let bitmap,photo,timer;
  try {
    debug.stage="getPhotoCapabilities";
    try{const caps=await capture.getPhotoCapabilities();debug.photoCapabilities={imageWidth:caps.imageWidth,imageHeight:caps.imageHeight};}catch(error){debug.capabilitiesError=error.name+": "+error.message;}
    // Let the camera choose its native still-photo dimensions.
    debug.requestedPhoto={};debug.stage="takePhoto";
    const blob=await Promise.race([capture.takePhoto(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Камера не вернула фото за 12 секунд")),12000);})]);clearTimeout(timer);debug.photoBytes=blob.size;
    debug.stage="createImageBitmap";bitmap=await createImageBitmap(blob);debug.photo=[bitmap.width,bitmap.height];
    debug.aspectDifferencePercent=Number((Math.abs(bitmap.width/bitmap.height/(video.videoWidth/video.videoHeight)-1)*100).toFixed(2));
    photo=document.createElement("canvas");photo.width=bitmap.width;photo.height=bitmap.height;photo.getContext("2d").drawImage(bitmap,0,0);
    debug.stage="сопоставление фото и видео";
    const view=matchPhotoViewport(photo,fallback);debug.viewport=view;
    if(!view||view.score<.6){debug.reason="Не удалось уверенно сопоставить фото с экранной рамкой; использован видеокадр";return fallback;}
    if(view.width<fallback.width||view.height<fallback.height){debug.reason="Область фото содержит меньше пикселей, чем видеокадр";return fallback;}
    photo.captureViewport=view;state.captureKind="фотография";debug.stage="готово";debug.reason="Использована полноценная фотография; экранная рамка сопоставлена по изображению";
    fallback.width=fallback.height=1;const result=photo;photo=null;return result;
  }catch(error){debug.reason="Ошибка на этапе "+debug.stage+": "+(error.name||"Error")+" — "+error.message;return fallback;}
  finally{clearTimeout(timer);if(bitmap)bitmap.close();if(photo)photo.width=photo.height=1;}
}

function captureSummary(width,height){return 'Кадр видео: '+width+' × '+height+(state.sharpTiming?'\n'+state.sharpTiming:'');}
function captureDebugText(){
 const d=state.captureDebug;if(!d)return "";
 const lines=["Съёмка: "+d.reason,"Видео: "+d.video.join(" × ")+"; запрошено: "+d.requestedVideo.join(" × "),"Параметры камеры: "+JSON.stringify(d.track),"ImageCapture: доступен="+d.imageCaptureAvailable+", создан="+d.imageCaptureCreated];
 if(d.capabilitiesError)lines.push("Параметры фото недоступны: "+d.capabilitiesError);
 if(d.viewport)lines.push("Сопоставление с видео: "+JSON.stringify(d.viewport));
 if(d.photoCapabilities)lines.push("Возможности фото: "+JSON.stringify(d.photoCapabilities));
 if(d.requestedPhoto)lines.push("Запрос фото: "+JSON.stringify(d.requestedPhoto));
 if(d.photo)lines.push("Получено фото: "+d.photo.join(" × ")+"; отличие пропорций: "+d.aspectDifferencePercent+"%");
 if(state.sharpTiming)lines.push(state.sharpTiming);
 return lines.join("\n");
}

function grabFrame(video) {
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0);
  return canvas;
}

function sharpnessScore(source,bounds){
 const c=bounds?cropImage(source,bounds.left,bounds.top,bounds.right,bounds.bottom):source;
 const small=document.createElement('canvas'),scale=Math.min(1,320/c.width,160/c.height);small.width=Math.max(3,Math.round(c.width*scale));small.height=Math.max(3,Math.round(c.height*scale));
 const ctx=small.getContext('2d',{willReadFrequently:true});ctx.drawImage(c,0,0,small.width,small.height);const d=ctx.getImageData(0,0,small.width,small.height).data,w=small.width,h=small.height;
 const gray=i=>.299*d[i*4]+.587*d[i*4+1]+.114*d[i*4+2];let sum=0,sq=0,n=0;
 for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i=y*w+x,v=4*gray(i)-gray(i-1)-gray(i+1)-gray(i-w)-gray(i+w);sum+=v;sq+=v*v;n++;}
 if(bounds)c.width=c.height=1;return n?sq/n-(sum/n)**2:0;
}
async function nextVideoFrame(video){
 if(video.requestVideoFrameCallback)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{video.cancelVideoFrameCallback(id);reject(new Error('Не поступил новый видеокадр'));},1500);const id=video.requestVideoFrameCallback(()=>{clearTimeout(timer);resolve();});});
 else await new Promise(resolve=>setTimeout(resolve,70));
}
async function captureSharpFrames(video,region,locate){
 const started=performance.now(),enabled=true,frames=[];let detection,selected=0;
 state.captureKind='кадр видео';state.captureDebug={reason:'Съёмка из видеопотока',video:[video.videoWidth,video.videoHeight],requestedVideo:[1920,1080],track:state.stream?.getVideoTracks()[0]?.getSettings?.()||{}};
 try{
 for(let i=0;i<(enabled?5:1);i++){await nextVideoFrame(video);frames.push(framedCrop(grabFrame(video),region,video.videoWidth,video.videoHeight));}
 const collected=performance.now();
 if(enabled)detection=await locate(frames[0]);const located=performance.now();
 const bounds=detection?.bounds;
 if(enabled&&bounds){const scores=frames.map(c=>sharpnessScore(c,bounds));selected=scores.indexOf(Math.max(...scores));}
 const frame=frames[selected];if(detection?.crop&&detection.crop!==frames[0])detection.crop.width=detection.crop.height=1;if(detection?.crop&&detection.found&&bounds)detection={...detection,crop:cropImage(frame,bounds.left,bounds.top,bounds.right,bounds.bottom)};
 state.sharpTiming=enabled?'Выбор резкого кадра: '+(selected+1)+'/5 · сбор: '+Math.round(collected-started)+' мс · поиск области: '+Math.round(located-collected)+' мс · выбор: '+Math.round(performance.now()-located)+' мс · всего: '+Math.round(performance.now()-started)+' мс'+(!bounds?' · область не найдена, использован первый кадр':''):'Выбор резкого кадра выключен · съёмка: '+Math.round(performance.now()-started)+' мс';
 frames.forEach((c,i)=>{if(i!==selected)c.width=c.height=1;});return {frame,detection};
 }catch(e){frames.forEach(c=>c.width=c.height=1);throw e;}
}

async function shoot() {
  const video = $("video");
  if (!video.videoWidth) return;
  if (state.shooting) return;
  state.shooting = true;
  $("shot").disabled = true;
  let framed, preparedDet;
  try {
    showWait("Снимаем фото…");
    await state.zoomMotion;
    await state.focusQueue;
    await state.zoomQueue;
    await state.torchQueue;
    if (!state.stream) return;
    state.photoPlateType = state.plateType || "long";
    const region = frameRegion();
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    const burst=await captureSharpFrames(video,region,async c=>{await ensureModels();return detectPlate(c);});
    framed=burst.frame;preparedDet=burst.detection;
    closeCamera();
  } catch (err) {
    setStatus("model-status", "Ошибка съёмки: " + err.message, "bad");
    return;
  } finally {
    state.shooting = false;
    $("shot").disabled = false;
    hideWait();
  }
  let best=null;
  try {
    showWait("Читаем номер…");
    best=await recognize(framed,false,preparedDet);
    showCrop(best ? { ...best, crop: framed } : {crop:framed, detectedCrop:framed, plateType:state.photoPlateType});
    $("result").classList.add("hidden");
    $("add-card").classList.add("hidden");
    $("plate").value = formatPlate(best && best.plate || "");
    paintPlate();
    if (!best || !best.plate) {
      setStatus("model-status", "Номер не прочитался. Можно ввести его вручную.", "bad");
      return;
    }
    $("plate").value = formatPlate(best.plate);
    paintPlate();
    const formatOk = PLATE_RE.test(best.plate);
    if(best.disagreement){setStatus("model-status","Чтение таблички и всей рамки расходится: "+best.alternatives.map(formatPlate).join(" / ")+". Проверьте номер на фото.","bad");return;}
    setStatus("model-status", formatOk
      ? "Номер в рамке прочитан (" + best.method + "). Проверьте символы номера."
      : "Прочитано неуверенно (" + best.method + "). Проверьте номер.",
      formatOk ? "ok" : "");
    await search();
  } catch (err) {
    setStatus("model-status", "Ошибка распознавания: " + err.message, "bad");
  } finally {
    hideWait();
  }
}

function showCrop(result) {
  hideMissingOffer();
  const available=Boolean(result && result.crop);
  $("crop-card").classList.remove("hidden");
  $("crop-card").classList.toggle("has-photo",available);
  $("crop-actions").classList.add("hidden");
  if(!available) return;
  state.hasPhoto=true;
  state.photoPlateType=result.plateType || state.photoPlateType || "long";
  const preview=result.detectedCrop || result.crop;
  state.lastCrop=preview;
  $("crop-preview").src=preview.toDataURL("image/jpeg",.9);
  $("ocr-raw-text").textContent=result.rawText||"";
  $("car-capture-summary").textContent=captureSummary(result.crop.width,result.crop.height);
  paintPlate();
}

function contactsFor(row) {
  return row?.contacts || (row?.phone ? [{ id: row.id || "", name: row.name || "", phone: row.phone }] : []);
}

async function openContactEditor(key, index = -1) {
  const request = state.contactRequest = (state.contactRequest || 0) + 1;
  const row = (await dbAll("directory")).find(r => r.key === key);
  if (request !== state.contactRequest) return;
  const contact = contactsFor(row)[index];
  state.contactEdit = { key, index, fromHistory: !$("search-history").classList.contains("hidden"), id: contact?.id || "", original: contact ? JSON.stringify(contact) : "" };
  paintWaitingSelection();
  $("add-phone").value = contact?.phone || "";
  $("add-name").value = contact?.name || "";
  setStatus("contact-status", "");
  placeContactEditor(key);
  $("add-target").textContent = formatPlate(key);
  $("add-card").classList.remove("hidden");
  if (!$("contact-dialog").open) $("contact-dialog").showModal();
  $("add-phone").focus();
}

async function search(record = true) {
  const request = state.searchRequest = (state.searchRequest || 0) + 1;
  hideMissingOffer();
  $("result").classList.add("hidden");
  setStatus("search-status", "");
  try {
    finishPlateEdit();
    setStatus("recognition-status", "");
    const key = normalizePlate($("plate").value);
    $("add-card").classList.add("hidden");
    state.contactRequest = (state.contactRequest || 0) + 1;
    state.contactEdit = null;
    paintWaitingSelection();
    if (!key) { setStatus("search-status", "Введите номер.", "bad"); return; }
    const rows = await dbAll("directory");
    if (request !== state.searchRequest || key !== normalizePlate($("plate").value)) return;
    if (record) recordSearch(key);
    const row = rows.find(r => r.key === key);
    const contacts = contactsFor(row);
    const result = $("result");
    if (!contacts.length) {
      result.classList.add("hidden");
      state.missingKey = key;
      $("missing-question").textContent = "Добавить номер " + formatPlate(key) + " в отложенные?";
      $("missing-offer").classList.remove("hidden");
      setStatus("search-status", "Телефон не найден.", "not-found");
      return;
    }
    result.classList.remove("hidden");
    result.innerHTML = `<div class="found-plate">${escapeHtml(formatPlate(key))}</div>` + contacts.map((hit, i) => {
      const tel = phoneHref(hit.phone);
      return `<div class="match"><button class="delete-contact" type="button" data-index="${i}" aria-label="Удалить контакт">×</button>
        <div class="person">${escapeHtml(hit.name || "Без имени")}</div>
        <div class="found-phone-row"><div class="phone">${escapeHtml(hit.phone)}</div></div>
        ${tel ? `<button class="call found-call" type="button" data-tel="${escapeHtml(tel)}">Позвонить</button><div class="contact-actions"><button aria-label="Отправить SMS" class="ghost message-button write-sms" type="button" data-tel="${escapeHtml(tel)}">${actionIcon("sms")}</button><button aria-label="Написать в Telegram" class="ghost message-button write-telegram" type="button" data-tel="${escapeHtml(tel)}">${actionIcon("telegram")}</button><button aria-label="Скопировать телефон" class="ghost message-button copy-phone" type="button" data-phone="${escapeHtml(hit.phone)}">${actionIcon("copy")}</button><button class="ghost add-contact-chip" type="button">+ телефон</button><button class="ghost edit-contact" type="button" data-index="${i}" aria-label="Редактировать контакт">${actionIcon("edit")}</button></div>` : ""}</div>`;
    }).join("");
    result.querySelectorAll(".call").forEach(btn => btn.addEventListener("click", () => { window.location.href = "tel:" + btn.dataset.tel; }));
    result.querySelectorAll(".write-sms").forEach(btn => btn.addEventListener("click", () => { window.location.href = messageLink("sms", btn.dataset.tel, settings().messageText); }));
    result.querySelectorAll(".write-telegram").forEach(btn => btn.addEventListener("click", () => { window.location.href = messageLink("telegram", btn.dataset.tel, settings().messageText); }));
    result.querySelectorAll(".copy-phone").forEach(btn => btn.addEventListener("click", () => copyPhone(btn.dataset.phone, btn)));
    fitMessageButtons();
    result.querySelectorAll(".edit-contact").forEach(btn => btn.addEventListener("click", () => openContactEditor(key, Number(btn.dataset.index))));
    result.querySelectorAll(".delete-contact").forEach(btn => btn.addEventListener("click", () => askDeleteContact(key, contacts[Number(btn.dataset.index)])));
    result.querySelectorAll(".add-contact-chip").forEach(btn => btn.addEventListener("click", () => openContactEditor(key)));
    setStatus("search-status", "");
  } catch (err) { setStatus("search-status", err.message, "bad"); }
}

function messageLink(kind, phone, text = "") {
  const tel = phoneHref(phone);
  const message = String(text || "");
  if (kind === "telegram") {
    const digits = tel.replace(/\D/g, "");
    return "https://t.me/+" + digits + (message ? "?text=" + encodeURIComponent(message) : "");
  }
  return "sms:" + tel + (message ? "?body=" + encodeURIComponent(message) : "");
}

function fitMessageButtons() {
  $("result").querySelectorAll(".contact-actions").forEach(row => {

    row.querySelectorAll(".message-button").forEach(button => {
      const label = button.querySelector("span");
      if (!label || !button.clientWidth) return;
      let size = 16;
      button.style.fontSize = size + "px";
      while (size > 8 && (label.scrollWidth > label.clientWidth || label.scrollHeight > button.clientHeight - 4)) {
        size -= 0.5; button.style.fontSize = size + "px";
      }
    });
  });
}

function hideMissingOffer() {
  state.missingKey = null;
  $("missing-offer").classList.add("hidden");
}

async function deferMissingPlate() {
  const key = state.missingKey;
  if (!key || key !== normalizePlate($("plate").value)) return;
  $("defer-yes").disabled = true;
  try {
    const row = (await dbAll("directory")).find(r => r.key === key);
    if (contactsFor(row).length) { await search(); return; }
    if (!row) await dbPut("directory", { key, plate: toCyrPlate(key), name: "", phone: "" });
    await renderWaiting();
    if (state.missingKey === key) {
      hideMissingOffer();
      setStatus("search-status", "Телефон не найден. Номер " + formatPlate(key) + " добавлен в отложенные.", "not-found");
    }
  } catch (err) { setStatus("search-status", err.message, "bad"); }
  finally { $("defer-yes").disabled = false; }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function saveLocal() {
  if (state.savingContact || !state.contactEdit) return;
  const edit = { ...state.contactEdit };
  const name = $("add-name").value.trim(), phone = $("add-phone").value.trim();
  if (!phoneHref(phone)) { setStatus("contact-status", "Введите номер телефона.", "bad"); return; }
  state.savingContact = true;
  $("save-local").disabled = true;
  try {
    await mutateContacts(data => {
      const existing = data.directory.find(row => row.key === edit.key);
      const contacts = contactsFor(existing).map(c => ({ ...c }));
      const index = edit.id ? contacts.findIndex(c => c.id === edit.id) : edit.index;
      const previous = index >= 0 ? contacts[index] : null;
      if (edit.index >= 0 && (!previous || JSON.stringify(previous) !== edit.original))
        throw new Error("Контакт изменился. Откройте редактирование заново.");
      if (contacts.some((c,i) => i !== index && phoneHref(c.phone) === phoneHref(phone)))
        throw new Error("Этот телефон уже есть у номера машины.");
      const id = edit.id || crypto.randomUUID();
      const queued = data.pending.find(op => op.id === id);
      const contact = { id, name, phone, rev: previous?.rev || "" };
      const operation = makeOperation(edit, previous, queued, contact);
      if (index >= 0) contacts[index] = contact; else contacts.push(contact);
      data.directory = data.directory.filter(row => row.key !== edit.key);
      data.directory.push({ key: edit.key, plate: toCyrPlate(edit.key), contacts, name: contacts[0].name, phone: contacts[0].phone });
      data.pending = data.pending.filter(op => op.id !== id); data.pending.push(operation);
    });
    $("add-card").classList.add("hidden");
    $("contact-dialog").close();
    state.contactEdit = null;
    await renderWaiting(); await renderPending();
    if (edit.fromHistory) { await renderSearchHistory(); highlightHistory(edit.key); }
    else { $("plate").value = formatPlate(edit.key); await search(false); }
  } catch (err) { setStatus("contact-status", err.message, "bad"); }
  finally { state.savingContact = false; $("save-local").disabled = false; }
}

function paintWaitingSelection() {
  $("waiting-list").querySelectorAll(".wait-plate").forEach(button => {
    const selected = button.dataset.key === state.contactEdit?.key;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
}

function placeContactEditor(key) {
  $("add-target").classList.remove("hidden");
}

function cancelContactEditor() {
  if (state.savingContact) return;
  state.contactRequest = (state.contactRequest || 0) + 1;
  state.contactEdit = null;
  $("contact-dialog").close();
  $("add-card").classList.add("hidden");
  paintWaitingSelection();
}

function askDeleteWaiting(key) {
  if (state.deletingWaiting) return;
  state.deleteContact = null;
  $("delete-title").textContent = "Удалить из отложенных?";
  state.deleteWaitingKey = key;
  $("delete-plate").textContent = formatPlate(key);
  setStatus("delete-status", "");
  $("delete-dialog").showModal();
  $("delete-no").focus();
}

function cancelDeleteWaiting() {
  if (state.deletingWaiting) return;
  state.deleteWaitingKey = null;
  state.deleteContact = null;
  $("delete-dialog").close();
}

async function confirmDeleteWaiting() {
  if (state.deleteContact) return confirmDeleteContact();
  if (state.deletingWaiting || !state.deleteWaitingKey) return;
  const key = state.deleteWaitingKey;
  state.deletingWaiting = true;
  $("delete-yes").disabled = $("delete-no").disabled = true;
  try {
    const row = (await dbAll("directory")).find(item => item.key === key);
    if (row && contactsFor(row).length) throw new Error("У этого номера уже есть телефон. Запись не удалена.");
    if (row) await dbDelete("directory", key);
    if (state.contactEdit?.key === key) {
      state.contactRequest = (state.contactRequest || 0) + 1;
      state.contactEdit = null;
      $("add-card").classList.add("hidden");
    }
    await renderWaiting();
    state.deleteWaitingKey = null;
    $("delete-dialog").close();
    setStatus("search-status", "Номер машины удалён из отложенных.");
  } catch (error) { setStatus("delete-status", error.message, "bad"); }
  finally {
    state.deletingWaiting = false;
    $("delete-yes").disabled = $("delete-no").disabled = false;
  }
}

async function renderWaiting() {
  const rows = (await dbAll("directory")).filter((row) => !contactsFor(row).length);
  const box = $("waiting-list");
  // The editor lives in its own dialog; refreshing the list preserves its input.

  $("waiting-card").classList.toggle("hidden", !rows.length);
  if (!rows.length) {
    box.textContent = "Пока пусто.";
    if (state.contactEdit) placeContactEditor(state.contactEdit.key);
    return;
  }
  box.innerHTML = rows.map(row => `<div class="wait-item" data-key="${escapeHtml(row.key)}">
    <button class="ghost wait-plate${state.contactEdit?.key === row.key ? " selected" : ""}" type="button" aria-pressed="${state.contactEdit?.key === row.key}" data-key="${escapeHtml(row.key)}">${escapeHtml(formatPlate(row.key))}</button>
    <button class="delete-waiting" type="button" data-key="${escapeHtml(row.key)}" aria-label="Удалить ${escapeHtml(formatPlate(row.key))} из отложенных">×</button>
  </div>`).join("");
  box.querySelectorAll(".wait-plate").forEach(btn => btn.addEventListener("click", () => {
    $("plate").value = formatPlate(btn.dataset.key);
    finishPlateEdit();
    $("result").classList.add("hidden");
    setStatus("search-status", "Введите телефон для выбранного номера машины.");
    openContactEditor(btn.dataset.key);
  }));
  box.querySelectorAll(".delete-waiting").forEach(btn => btn.addEventListener("click", () => askDeleteWaiting(btn.dataset.key)));
  if (state.contactEdit) placeContactEditor(state.contactEdit.key);
}

async function renderPending() {
  const rows = await dbAll("pending");
  setStatus("pending-status", rows.length ? "Изменения пока только на этом телефоне: " + rows.length + ". Синхронизируйте локальную базу с Google Таблицей." : "");
  const conflicts = rows.filter(row => row.conflict);
  $("conflict-card").classList.toggle("hidden", !conflicts.length);
  $("conflict-list").innerHTML = conflicts.map((op,i) => `<div class="sync-conflict"><h3>На другом телефоне или в Google Таблице этот контакт изменён</h3><strong>${escapeHtml(formatPlate(op.key))}</strong><p>Ваш вариант: ${op.type === "delete" ? "Удалить контакт" : escapeHtml(op.phone + " · " + (op.name || "Без имени"))}</p><p>Вариант Google Таблицы: ${op.conflict.current && !op.conflict.current.deleted ? escapeHtml(op.conflict.current.phone + " · " + (op.conflict.current.name || "Без имени")) : op.conflict.current?.deleted ? "Контакт удалён" : "Контакт не найден"}</p>${op.conflict.current && !op.conflict.current.deleted && !op.conflict.duplicate ? `<button type="button" class="ghost keep-local" data-index="${i}">Принять мой вариант</button>` : ""}<button type="button" class="secondary accept-remote" data-index="${i}">Принять вариант Google Таблицы</button></div>`).join("");
  $("conflict-list").querySelectorAll(".accept-remote").forEach(button => button.addEventListener("click", () => resolveContactConflict(conflicts[Number(button.dataset.index)], false)));
  $("conflict-list").querySelectorAll(".keep-local").forEach(button => button.addEventListener("click", () => resolveContactConflict(conflicts[Number(button.dataset.index)], true)));
}

function askDeleteContact(key, contact) {
  if (state.deletingWaiting) return;
  state.deleteWaitingKey = null;
  state.deleteContact = { key, contact: { ...contact } };
  $("delete-title").textContent = "Удалить из базы?";
  $("delete-plate").textContent = formatPlate(key) + " · " + contact.phone;
  setStatus("delete-status", "Контакт удалится на этом телефоне, а после синхронизации — в общей базе.");
  $("delete-dialog").showModal(); $("delete-no").focus();
}

async function confirmDeleteContact() {
  if (state.deletingWaiting || !state.deleteContact) return;
  const edit = state.deleteContact;
  state.deletingWaiting = true;
  $("delete-yes").disabled = $("delete-no").disabled = true;
  try {
    await mutateContacts(data => {
      const row = data.directory.find(r => r.key === edit.key);
      const contacts = contactsFor(row);
      const contact = contacts.find(c => edit.contact.id ? c.id === edit.contact.id : c.phone === edit.contact.phone);
      if (!contact || JSON.stringify(contact) !== JSON.stringify(edit.contact)) throw new Error("Контакт изменился. Повторите удаление.");
      const id = contact.id || crypto.randomUUID();
      const queued = data.pending.find(op => op.id === id);
      data.directory = data.directory.filter(r => r.key !== edit.key);
      const rest = contacts.filter(c => c !== contact);
      if (rest.length) data.directory.push({ key:edit.key, plate:toCyrPlate(edit.key), contacts:rest, name:rest[0].name, phone:rest[0].phone });
      data.pending = data.pending.filter(op => op.id !== id);
      // Queue even an unsynced deletion: the server may already have accepted an earlier request whose reply was lost.
      data.pending.push(makeOperation(edit, contact, queued, { ...contact, id }, "delete"));
    });
    state.deleteContact = null; $("delete-dialog").close();
    await renderPending(); await renderWaiting();
    if (!$("search-history").classList.contains("hidden")) { await renderSearchHistory(); highlightHistory(edit.key); }
    else await search(false);
  } catch (err) { setStatus("delete-status", err.message, "bad"); }
  finally { state.deletingWaiting = false; $("delete-yes").disabled = $("delete-no").disabled = false; }
}

async function resolveContactConflict(op, keepLocal) {
  if (state.syncBusy) return;
  try {
    await mutateContacts(data => {
      const queued = data.pending.find(r => r.id === op.id && r.opId === op.opId);
      if (!queued) return;
      const current = queued.conflict.current;
      if (keepLocal && current && !current.deleted && !queued.conflict.duplicate) {
        queued.baseRev = current.rev; queued.id = current.id; queued.opId = crypto.randomUUID();
        queued.base = { name:current.name, phone:current.phone }; queued.previousPhone = current.phone;
        delete queued.conflict;
        const contacts = data.directory.flatMap(row => contactsFor(row).map(c => ({ ...c, plate:row.plate })))
          .filter(c => c.id !== op.id && c.id !== current.id);
        contacts.push(current);
        data.directory = overlayPending(contacts, data.pending, data.directory.filter(r => !contactsFor(r).length));
      } else {
        data.pending = data.pending.filter(r => r !== queued);
        let contacts = data.directory.flatMap(row => contactsFor(row).map(c => ({ ...c, plate:row.plate })));
        contacts = contacts.filter(c => c.id !== op.id && c.id !== current?.id && !(op.previousPhone && normalizePlate(c.plate) === op.key && phoneHref(c.phone) === phoneHref(op.previousPhone)));
        if (current && !current.deleted) contacts.push(current);
        data.directory = overlayPending(contacts, data.pending, data.directory.filter(r => !contactsFor(r).length));
      }
    });
    await renderPending(); await renderWaiting();
    if (normalizePlate($("plate").value)) await search();
    setStatus("sync-status", keepLocal ? "Ваш вариант подготовлен. Выполните синхронизацию." : "Принят общий вариант.");
  } catch (err) { setStatus("sync-status", err.message, "bad"); }
}

function parseRows(values) {
  if (!values || !values.length) return [];
  const head = values[0].map((c) => String(c || "").toLowerCase());
  const plateIdx = head.findIndex((h) => /номер|plate|гос/.test(h));
  const nameIdx = head.findIndex((h) => /имя|фио|name/.test(h));
  const phoneIdx = head.findIndex((h) => /тел|phone/.test(h));
  const hasHead = plateIdx >= 0;
  const start = hasHead ? 1 : 0;
  const pi = hasHead ? plateIdx : 0;
  const ni = hasHead ? (nameIdx >= 0 ? nameIdx : 1) : 1;
  const hi = hasHead ? (phoneIdx >= 0 ? phoneIdx : 2) : 2;
  const rows = [];
  for (let i = start; i < values.length; i++) {
    const raw = values[i][pi];
    const key = normalizePlate(raw);
    if (!key) continue;
    rows.push({
      key,
      id: String(values[i][3] || ""),
      plate: toCyrPlate(key),
      name: String(values[i][ni] || ""),
      phone: String(values[i][hi] || "")
    });
  }
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.key)) grouped.set(row.key, { ...row, contacts: [] });
    if (row.phone) grouped.get(row.key).contacts.push({ id: row.id, name: row.name, phone: row.phone });
  }
  return [...grouped.values()];
}

async function scriptCall(action, extra) {
  const cfg = settings();
  if (!cfg.scriptUrl) throw new Error("В настройках нет ссылки Apps Script");
  const res = await fetch(cfg.scriptUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(Object.assign({ action, secret: cfg.secret }, extra || {}))
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Скрипт вернул ошибку");
  return data;
}

function paintLastSync() {
  const value = localStorage.getItem("lastSyncAt");
  const date = value ? new Date(value) : null;
  $("last-sync").textContent = date && Number.isFinite(date.getTime())
    ? "Последняя синхронизация: " + date.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "Синхронизация ещё не выполнялась";
}

async function sync() {
  if (state.syncBusy) return;
  if (!settings().scriptUrl) {
    setStatus("sync-status", "Укажите ссылку Apps Script в настройках.", "bad");
    return;
  }
  if (!navigator.onLine) {
    setStatus("sync-status", "Нет сети. Локальные записи останутся в очереди.", "bad");
    return;
  }
  setStatus("sync-status", "Обмен с таблицей…");
  state.syncBusy = true;
  $("sync").disabled = true;
  showWait("Синхронизация с таблицей…");
  try {
    const check = await scriptCall("list");
    if (check.protocol !== 3 || !Array.isArray(check.contacts))
      throw new Error("Обновите Code.gs и развертывание Apps Script для нескольких телефонов. Очередь сохранена.");
    // Persist command IDs before sending, including queues created by older versions.
    const sent = await mutateContacts(data => {
      data.pending.forEach(op => { if (!op.opId) op.opId = crypto.randomUUID(); if (!op.type) op.type = "upsert"; });
      return data.pending.filter(op => !op.conflict).slice(0,500).map(op => ({ ...op }));
    });
    const response = await scriptCall("sync", { protocol:3, operations:sent });
    if (response.protocol !== 3 || !Array.isArray(response.contacts) || !Array.isArray(response.results))
      throw new Error("Не получено подтверждение обмена. Очередь сохранена.");
    for (const op of sent) if (!response.results.some(r => r.opId === op.opId && ["ok","conflict"].includes(r.status)))
      throw new Error("Не все изменения подтверждены. Очередь сохранена.");
    await mutateContacts(data => {
      for (const result of response.results) {
        const original = sent.find(op => op.opId === result.opId);
        if (!original) continue;
        const queued = data.pending.find(op => op.id === original.id);
        if (!queued) continue;
        if (result.status === "ok") {
          if (queued.opId === original.opId) data.pending = data.pending.filter(op => op !== queued);
          else {
            const canonical = response.contacts.find(c => c.id === result.id);
            if (canonical) { queued.id = canonical.id; queued.baseRev = canonical.rev; queued.previousPhone = canonical.phone; queued.base = { name:canonical.name, phone:canonical.phone }; }
          }
        } else if (queued.opId === original.opId) queued.conflict = { current:result.current || null, duplicate:Boolean(result.duplicate) };
      }
      // Full authoritative snapshot removes obsolete synced contacts but retains local outbox and deferred plates.
      const deferred = data.directory.filter(row => !contactsFor(row).length);
      data.directory = overlayPending(response.contacts, data.pending, deferred);
    });
    localStorage.setItem("lastSyncAt", new Date().toISOString());
    paintLastSync();
    const left = await dbAll("pending");
    const conflicts = left.filter(op => op.conflict).length;
    setStatus("sync-status", conflicts ? "Есть несовпадающие изменения: " + conflicts + ". Выберите вариант ниже." : left.length ? "Обмен выполнен. Осталось изменений: " + left.length + ". Повторите синхронизацию." : "Синхронизация завершена. База обновлена.", conflicts ? "bad" : "ok");
    if (normalizePlate($("plate").value)) await search();
  } catch (err) {
    setStatus("sync-status", err.message, "bad");
  } finally {
    state.syncBusy = false;
    $("sync").disabled = false;
    hideWait();
    await renderPending();
    await renderWaiting();
  }
}

function workerRequest(worker, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    if (!worker) { resolve(null); return; }
    const channel = new MessageChannel();
    const cleanup = () => { clearTimeout(timer); channel.port1.close(); channel.port2.close(); };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeout);
    channel.port1.onmessage = event => { cleanup(); resolve(event.data); };
    try { worker.postMessage({ type }, [channel.port2]); }
    catch (error) { cleanup(); reject(error); }
  });
}

async function checkOfflineReady() {
  const check = state.offlineCheck = (state.offlineCheck || 0) + 1;
  if (!("serviceWorker" in navigator) || !("caches" in window)) {
    setStatus("offline-status", "Браузер не поддерживает сохранение приложения для офлайн-запуска.", "bad");
    return false;
  }
  const controller = navigator.serviceWorker.controller;
  const status = await workerRequest(controller, "STATUS");
  if (check !== state.offlineCheck) return state.offlineReady || false;
  state.offlineReady = Boolean(controller && controller === navigator.serviceWorker.controller && status?.version === APP_VERSION && status.ready);
  if (state.offlineReady) {
    state.offlineError = "";
    setStatus("offline-status", "");
  } else {
    setStatus("offline-status", state.offlineError || "Офлайн-запуск ещё не готов. Оставьте VPN включённым и дождитесь сохранения приложения. При ошибке нажмите «Проверить обновления».", state.offlineError ? "bad" : "");
  }
  return state.offlineReady;
}

function watchWorker(registration) {
  const watch = worker => {
    if (!worker) return;
    worker.addEventListener("statechange", () => {
      if (worker.state === "redundant") {
        state.offlineError ||= "Не удалось сохранить приложение. Оставьте VPN включённым и повторите проверку обновлений.";
      }
      if (["installed", "activated", "redundant"].includes(worker.state)) checkOfflineReady().catch(() => {});
    });
  };
  watch(registration.installing);
  registration.addEventListener("updatefound", () => watch(registration.installing));
}

async function initializeOffline() {
  if (!("serviceWorker" in navigator)) { await checkOfflineReady(); return; }
  navigator.serviceWorker.addEventListener("controllerchange", () => checkOfflineReady().catch(() => {}));
  navigator.serviceWorker.addEventListener("message", event => {
    if (event.data?.type === "OFFLINE_ERROR") {
      state.offlineError = "Не удалось сохранить " + event.data.file + ": " + event.data.error + ". Оставьте VPN включённым и повторите проверку обновлений.";
      setStatus("offline-status", state.offlineError, "bad");
    }
    if (event.data?.type === "OFFLINE_ACTIVE") checkOfflineReady().catch(() => {});
  });
  checkOfflineReady().catch(() => {});
  try {
    const registration = await registerAppWorker();
    watchWorker(registration);
    if (registration.waiting) registration.waiting.postMessage({ type: "SKIP_WAITING" });
    await checkOfflineReady();
  } catch (error) {
    if (!(await checkOfflineReady())) {
      state.offlineError = "Не удалось включить офлайн-запуск: " + error.message + ". Повторите проверку обновлений с VPN.";
      setStatus("offline-status", state.offlineError, "bad");
    }
  }
}

async function registerAppWorker() {
  if (!("serviceWorker" in navigator)) return null;
  return navigator.serviceWorker.register("sw.js", { updateViaCache: "none" });
}

function waitForWorker(worker, target) {
  const reached = () => worker.state === target || (target === "installed" && ["activating", "activated"].includes(worker.state));
  if (reached()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Обновление не завершилось. Попробуйте ещё раз.")); }, 120000);
    const cleanup = () => { clearTimeout(timer); worker.removeEventListener("statechange", changed); };
    const changed = () => {
      if (reached()) { cleanup(); resolve(); }
      else if (worker.state === "redundant") { cleanup(); reject(new Error("Не удалось установить обновление.")); }
    };
    worker.addEventListener("statechange", changed);
    changed();
  });
}

async function refreshApp(options={}) {
  const silent=options.silent===true;
  if(state.silentUpdating)return;
  if(silent)state.silentUpdating=true;
  const button = $("refresh-app");
  button.disabled = true;
  setStatus("update-status", "Проверяю обновления…");
  try {
    const response = await fetch("version.json?t=" + Date.now(), { cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("Не удалось проверить версию на сайте (" + response.status + ").");
    const release = await response.json();
    if (!/^\d+$/.test(String(release.version))) throw new Error("Некорректный файл версии.");
    if (BigInt(String(release.version)) < BigInt(APP_VERSION)) {
      setStatus("update-status", "На сайте более старая версия (" + release.version + "). Установлена версия " + APP_VERSION + ".", "ok");
      return;
    }
    const sameVersion = String(release.version) === APP_VERSION;
    if(silent&&sameVersion)return;
    setStatus("update-status", sameVersion ? "Проверяю и восстанавливаю сохранение приложения…" : "Загружаю версию " + release.version + "…");
    const registration = await registerAppWorker();
    if (!registration) throw new Error("Браузер не поддерживает офлайн-запуск.");
    await registration.update();
    if (registration.installing) await waitForWorker(registration.installing, "installed");
    if (registration.waiting) {
      const worker = registration.waiting;
      const activated = waitForWorker(worker, "activated");
      worker.postMessage({ type: "SKIP_WAITING" });
      await activated;
    } else if (registration.active && registration.active.state !== "activated") {
      await waitForWorker(registration.active, "activated");
    }
    const worker = registration.active;
    let status = await workerRequest(worker, "STATUS");
    if (status?.version !== String(release.version)) throw new Error("Офлайн-модуль ещё не обновился. Повторите проверку с VPN.");
    if (!status.ready) {
      status = await workerRequest(worker, "REPAIR_CACHE", 180000);
      if (!status?.ready) throw new Error(status?.error || "Не удалось сохранить приложение. Повторите с VPN.");
    }
    if (sameVersion) {
      if (navigator.serviceWorker.controller !== worker) {
        const url = new URL(location.href);
        url.searchParams.set("v", APP_VERSION);
        location.replace(url.href);
        return;
      }
      await checkOfflineReady();
      setStatus("update-status", "Установлена актуальная версия: " + APP_VERSION + ".", "ok");
      return;
    }
    // A unique navigation and versioned script URLs also bypass an older cache-first worker.
    const url = new URL(location.href);
    url.searchParams.set("v", release.version);
    url.searchParams.set("updated", Date.now());
    location.replace(url.href);
  } catch (err) {
    setStatus("update-status", "Обновление не выполнено: " + err.message, "bad");
  } finally {
    button.disabled = false;
    state.silentUpdating=false;
  }
}

function bind() {
  $("app-version").textContent = "Версия " + APP_VERSION;
  const cfg = settings();
  $("script-url").value = cfg.scriptUrl;
  $("script-secret").value = cfg.secret;
  $("message-text").value = cfg.messageText;
  $("open-cam").addEventListener("click", () => { state.cameraMode="plate"; $("cam").classList.remove("meter-camera"); $("plate-frame").querySelector("span").textContent="Держите номер целиком в рамке"; openCamera(); });
  $("close-cam").addEventListener("click", closeCamera);
  $("shot").addEventListener("click", () => state.cameraMode === "meter" ? shootMeter() : shoot());
  $("torch").addEventListener("click", toggleTorch);
  $("zoom-slider").addEventListener("input", () => setZoom(sliderToZoom(Number($("zoom-slider").value))));
  $("plate-frame").addEventListener("click", e => {selectPlateType("long"); if(state.stream) focusAt(e.clientX,e.clientY);});
  $("square-frame").addEventListener("click", e => {selectPlateType("square"); if(state.stream) focusAt(e.clientX,e.clientY);});
  $("open-history").addEventListener("click", () => {
    if ($("search-history").classList.contains("hidden")) openSearchHistory();
    else closeSearchHistory();
  });
  selectPlateType("long");
  window.addEventListener("resize", () => { if (state.stream) paintCameraTransform(); fitMessageButtons(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !$("search-history").classList.contains("hidden")) renderSearchHistory().catch(() => {});
  });
  setInterval(() => {
    if (!$("search-history").classList.contains("hidden")) renderSearchHistory().catch(() => {});
  }, 60000);
  bindPinchZoom();
  bindFocus();
  $("defer-yes").addEventListener("click", deferMissingPlate);
  $("save-local").addEventListener("click", saveLocal);
  $("cancel-contact").addEventListener("click", cancelContactEditor);
  $("contact-dialog").addEventListener("cancel", e => {e.preventDefault();cancelContactEditor();});
  $("delete-yes").addEventListener("click", confirmDeleteWaiting);
  $("delete-no").addEventListener("click", cancelDeleteWaiting);
  $("delete-dialog").addEventListener("cancel", event => { event.preventDefault(); cancelDeleteWaiting(); });
  $("sync").addEventListener("click", sync);
  $("save-settings").addEventListener("click", saveSettings);
  $("save-message").addEventListener("click",()=>{localStorage.setItem("messageText",$("message-text").value);setStatus("message-status","Сообщение сохранено.","ok");});
  renderSearchHistory().catch(()=>{});
  $("refresh-app").addEventListener("click", refreshApp);
  $("open-settings").addEventListener("click", toggleSettings);
  $("retry-models").addEventListener("click", startModels);
  
  $("continue-manual").addEventListener("click", hideWait);
  $("plate-mask").addEventListener("click", editPlate);
  $("plate").addEventListener("input", () => {
    state.searchRequest = (state.searchRequest || 0) + 1;
    hideMissingOffer();
    $("result").classList.add("hidden");
    setStatus("search-status", "");
    const next = formatPlate($("plate").value);
    if ($("plate").value !== next) $("plate").value = next;
    paintPlate();
  });
  $("plate").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("plate").blur(); } });
  $("plate").addEventListener("blur", () => { finishPlateEdit(); search(); });
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    state.installEvent = e;
  });
  $("install").addEventListener("click", async () => {
    if (!state.installEvent) {
      setStatus("sync-status", "Установка: в меню браузера «Добавить на экран Домой».", "");
      return;
    }
    state.installEvent.prompt();
    await state.installEvent.userChoice;
    state.installEvent = null;
  });
  window.addEventListener("online", () => { $("net").textContent = "сеть есть, распознавание локальное"; });
  window.addEventListener("offline", () => { $("net").textContent = "офлайн, поиск по скачанной базе"; });
  $("net").textContent = navigator.onLine ? "распознавание на телефоне" : "офлайн";
  paintPlate();
  paintLastSync();
  renderWaiting().catch(() => {});
  renderPending().catch(() => {});
  initializeOffline().catch(error => setStatus("offline-status", error.message, "bad"));
  navigator.storage?.persist?.().catch(() => {});
  startModels();
  maybeAutoUpdate();
}

// Two-row plates are rearranged as image fragments before OCR.
// Independent browser implementation of the multiline-to-single-line approach;
// no Nomeroff Net source or weights are bundled.
function squareLetterChoice(values,raw) {
  const allowed="ABEKMHOPCTYX";
  if(allowed.includes(raw))return raw;
  let candidate=raw,score=-Infinity;
  for(const char of allowed){const value=values[ALPHABET.indexOf(char)];if(value>score){score=value;candidate=char;}}
  const rawScore=values[ALPHABET.indexOf(raw)];
  // A known Russian letter position can resolve an ambiguous global-model
  // result, but must not replace a confidently different character.
  return score>=rawScore*.8 && rawScore-score<=.05 ? candidate : raw;
}

function squareInk(source) {
  const scale=Math.min(1,600/Math.max(source.width,source.height));
  const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(source.width*scale));canvas.height=Math.max(1,Math.round(source.height*scale));
  const ctx=canvas.getContext("2d",{willReadFrequently:true});ctx.drawImage(source,0,0,canvas.width,canvas.height);
  const rgba=ctx.getImageData(0,0,canvas.width,canvas.height).data;
  const gray=new Uint8Array(canvas.width*canvas.height),hist=new Uint32Array(256);let sum=0;
  for(let i=0;i<gray.length;i++){gray[i]=Math.round(rgba[4*i]*.299+rgba[4*i+1]*.587+rgba[4*i+2]*.114);hist[gray[i]]++;sum+=gray[i];}
  let count=0,part=0,best=-1,threshold=125;
  for(let t=0;t<255;t++){count+=hist[t];part+=hist[t]*t;if(!count||count===gray.length)continue;const delta=part/count-(sum-part)/(gray.length-count);const score=count*(gray.length-count)*delta*delta;if(score>best){best=score;threshold=t;}}
  threshold=Math.max(65,Math.min(180,threshold));
  return {w:canvas.width,h:canvas.height,scale,rgba,mask:gray.map(value=>value<=threshold?1:0)};
}

function regionFrame(image) {
  const {w,h,mask}=image;if(w<35||h<30)return null;
  const radius=Math.max(1,Math.round(Math.min(w,h)*.008));
  const rows=Array.from({length:h},()=>new Int32Array(w+1));
  const cols=Array.from({length:w},()=>new Int32Array(h+1));
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    let horizontal=0,vertical=0;
    for(let d=-radius;d<=radius;d++){
      if(y+d>=0&&y+d<h)horizontal|=mask[(y+d)*w+x];
      if(x+d>=0&&x+d<w)vertical|=mask[y*w+x+d];
    }
    rows[y][x+1]=rows[y][x]+horizontal;cols[x][y+1]=cols[x][y]+vertical;
  }
  const coverageH=(y,a,b)=>(rows[y][b+1]-rows[y][a])/(b-a+1);
  const coverageV=(x,a,b)=>(cols[x][b+1]-cols[x][a])/(b-a+1);
  const candidates=[];
  for(let x=Math.floor(w*.45);x<Math.ceil(w*.81);x++){
    let start=-1,last=-1,gap=0;
    const flush=()=>{if(start>=0&&last-start>=h*.28&&last>=h*.87&&start<=h*.7)candidates.push({x,top:start,bottom:last,length:last-start});start=-1;last=-1;gap=0;};
    for(let y=Math.floor(h*.3);y<Math.ceil(h*.99);y++){
      const dark=cols[x][y+1]-cols[x][y];
      if(dark){if(start<0)start=y;last=y;gap=0;}else if(start>=0&&++gap>radius+1)flush();
    }
    flush();
  }
  // Collapse a thick edge into one candidate instead of spending all attempts
  // on adjacent pixels of the same frame stroke.
  candidates.sort((a,b)=>b.length-a.length);
  const distinct=[];for(const c of candidates)if(distinct.every(p=>Math.abs(p.x-c.x)>radius*2+1)){distinct.push(c);if(distinct.length===12)break;}
  let best=null,bestScore=.66;
  const tolerance=Math.max(2,Math.round(h*.045));
  for(const c of distinct)for(let top=Math.max(Math.floor(h*.32),c.top-tolerance);top<=Math.min(Math.floor(h*.71),c.top+radius);top++){
    for(let bottom=Math.max(Math.floor(h*.86),c.bottom-radius);bottom<=Math.min(h-2,c.bottom+tolerance);bottom++){
      for(let right=Math.max(Math.floor(w*.88),c.x+Math.floor(w*.20));right<=Math.min(w-2,c.x+Math.ceil(w*.53));right++){
        const ratio=(right-c.x)/(bottom-top);if(ratio<1.05||ratio>3)continue;
        const t=coverageH(top,c.x,right),b=coverageH(bottom,c.x,right),l=coverageV(c.x,top,bottom),r=coverageV(right,top,bottom);
        if(t<.45||b<.4||l<.7||r<.7)continue;
        const score=(t+b+l+r)/4+.025*(right/w);
        if(score>bestScore){bestScore=score;best={left:c.x,top,right,bottom,score};}
      }
    }
  }
  return best;
}

function squareRowSplit(image,right) {
  const {w,h,mask}=image,left=Math.floor(w*.06),end=Math.max(left+1,Math.floor(right));
  let best=Math.round(h*.49),bestScore=-Infinity,start=-1;
  for(let y=Math.floor(h*.31);y<=Math.floor(h*.7);y++){
    let count=0;for(let x=left;x<end;x++)count+=mask[y*w+x];
    const blank=count/(end-left)<.025;
    if(blank&&start<0)start=y;
    if((!blank||y===Math.floor(h*.7))&&start>=0){
      const stop=blank?y:y-1,mid=(start+stop)/2;
      const score=stop-start+1-Math.abs(mid-h*.49)*.2;
      if(score>bestScore){bestScore=score;best=Math.round(mid);}start=-1;
    }
  }
  return best;
}

function glyphBounds(image,rect,region=false) {
  const {w,h,mask}=image;
  const left=Math.max(0,Math.ceil(rect.left)),top=Math.max(0,Math.ceil(rect.top));
  const right=Math.min(w-1,Math.floor(rect.right)),bottom=Math.min(h-1,Math.floor(rect.bottom));
  const rw=right-left+1,rh=bottom-top+1;if(rw<2||rh<2)return rect;
  const seen=new Uint8Array(rw*rh),queue=new Int32Array(rw*rh),components=[];
  for(let seed=0;seed<seen.length;seed++){
    const x=seed%rw+left,y=Math.floor(seed/rw)+top;if(seen[seed]||!mask[y*w+x])continue;
    let head=0,tail=1,minX=x,maxX=x,minY=y,maxY=y;queue[0]=seed;seen[seed]=1;
    while(head<tail){const n=queue[head++],cx=n%rw,cy=Math.floor(n/rw);minX=Math.min(minX,cx+left);maxX=Math.max(maxX,cx+left);minY=Math.min(minY,cy+top);maxY=Math.max(maxY,cy+top);
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
        const nx=cx+dx,ny=cy+dy,j=ny*rw+nx;
        if(nx>=0&&nx<rw&&ny>=0&&ny<rh&&!seen[j]&&mask[(ny+top)*w+nx+left]){seen[j]=1;queue[tail++]=j;}
      }
    }
    const cw=maxX-minX+1,ch=maxY-minY+1;
    // Reject frame strokes, tiny RUS/flag details and clipped outer holders.
    if(ch<Math.max(3,h*.095)||cw>rw*.85||cw/ch>1.8||cw/ch<.07)continue;
    if((minX===left||maxX===right||minY===top||maxY===bottom)&&ch>rh*.85)continue;
    components.push({left:minX,right:maxX,top:minY,bottom:maxY,height:ch,area:tail,pixels:Array.from(queue.subarray(0,tail),n=>(Math.floor(n/rw)+top)*w+n%rw+left)});
  }
  if(!components.length)return {...rect,fallback:true};
  const maxHeight=Math.max(...components.map(c=>c.height));
  const selected=components.filter(c=>c.height>=maxHeight*.62&&(!region||c.top<top+rh*.56));
  if(!selected.length)return {...rect,fallback:true};
  const bounds={left:Math.min(...selected.map(c=>c.left)),right:Math.max(...selected.map(c=>c.right)),top:Math.min(...selected.map(c=>c.top)),bottom:Math.max(...selected.map(c=>c.bottom)),count:selected.length};
  Object.defineProperty(bounds,"inkIndices",{value:selected.flatMap(c=>c.pixels)});
  return bounds;
}

function lowerTextGap(image,split) {
  const {w,h,mask}=image;
  let start=-1,best=w*.62,length=0;
  for(let x=Math.floor(w*.43);x<Math.floor(w*.83);x++){
    let count=0;for(let y=Math.ceil(split+h*.035);y<Math.floor(h*.82);y++)count+=mask[y*w+x];
    if(count<=1&&start<0)start=x;
    if((count>1||x===Math.floor(w*.83)-1)&&start>=0){
      const stop=count>1?x-1:x,span=stop-start+1;
      if(span>length){length=span;best=(start+stop)/2;}start=-1;
    }
  }
  return best;
}

function unfoldSquarePlate(source) {
  const analysis=squareInk(source),{w,h,scale}=analysis;
  const frame=regionFrame(analysis);
  const split=squareRowSplit(analysis,frame?frame.left-w*.02:w*.58);
  const boundary=frame?frame.left:lowerTextGap(analysis,split);
  const inset=Math.max(2,Math.round(Math.min(w,h)*.022));
  const upper=glyphBounds(analysis,{left:w*.035,top:h*.035,right:w*.965,bottom:split-1});
  const lower=glyphBounds(analysis,{left:w*.035,top:split+1,right:boundary-inset,bottom:h*.965});
  const region=glyphBounds(analysis,frame?{left:frame.left+inset,top:frame.top+inset,right:frame.right-inset,bottom:frame.bottom-inset}:{left:boundary+inset,top:split+1,right:w*.965,bottom:h*.95},true);
  state.squareLayout={frame,upper,lower,region,split,analysisWidth:w,analysisHeight:h};
  const height=96,gap=10,pad=3;
  const pieces=[upper,lower,region].map(box=>{
    if(!box.inkIndices)return cropImage(source,(box.left-pad)/scale,(box.top-pad)/scale,(box.right+pad+1)/scale,(box.bottom+pad+1)/scale);
    const piece=document.createElement("canvas");piece.width=box.right-box.left+1+pad*2;piece.height=box.bottom-box.top+1+pad*2;
    const ctx=piece.getContext("2d"),out=ctx.createImageData(piece.width,piece.height);out.data.fill(255);
    const keep=new Uint8Array(w*h);
    for(const index of box.inkIndices){const x=index%w,y=Math.floor(index/w);for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(x+dx>=0&&x+dx<w&&y+dy>=0&&y+dy<h)keep[(y+dy)*w+x+dx]=1;}
    for(let y=box.top-1;y<=box.bottom+1;y++)for(let x=box.left-1;x<=box.right+1;x++){
      if(x<0||x>=w||y<0||y>=h||!keep[y*w+x])continue;
      const target=((y-box.top+pad)*piece.width+x-box.left+pad)*4,src=(y*w+x)*4;
      for(let channel=0;channel<3;channel++)out.data[target+channel]=analysis.rgba[src+channel];
    }
    ctx.putImageData(out,0,0);return piece;
  });
  const widths=pieces.map(c=>Math.max(1,Math.round(c.width/c.height*height)));
  const line=document.createElement("canvas");line.width=widths.reduce((s,v)=>s+v,0)+gap*4;line.height=height+gap*2;
  const ctx=line.getContext("2d");ctx.fillStyle="#fff";ctx.fillRect(0,0,line.width,line.height);
  let x=gap;pieces.forEach((c,i)=>{ctx.drawImage(c,x,gap,widths[i],height);x+=widths[i]+gap;});
  return line;
}

function todayKey(date = new Date()) {
  return [date.getFullYear(), String(date.getMonth()+1).padStart(2,"0"), String(date.getDate()).padStart(2,"0")].join("-");
}
function searchHistory() {
 const start=new Date();start.setHours(0,0,0,0);start.setDate(start.getDate()-2);
 try{const saved=JSON.parse(localStorage.getItem("searchHistory")||"{}");if(Array.isArray(saved.items))return {day:todayKey(),items:saved.items.filter(item=>Number.isFinite(item.time)&&item.time>=start.getTime()&&item.time<=Date.now())};}catch(_){}
 return {day:todayKey(),items:[]};
}
function recordSearch(key) {
  const saved=searchHistory();
  saved.items=saved.items.filter(item=>item.key!==key);
  saved.items.unshift({key,time:Date.now()});
  renderSearchHistory().catch(()=>{});
  try {localStorage.setItem("searchHistory",JSON.stringify(saved));} catch (_) {}
}
async function copyPhone(phone, button) {
  const original=button.innerHTML;
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(phone);
    else {
      const input=document.createElement("textarea"); input.value=phone;
      input.style.cssText="position:fixed;left:-9999px";document.body.appendChild(input);
      input.select();const copied=document.execCommand("copy");input.remove();
      if (!copied) throw new Error("Не удалось скопировать");
    }
    button.textContent="Скопировано";
  } catch (_) {button.textContent="Не скопировано";}
  setTimeout(()=>{button.innerHTML=original;fitMessageButtons();},1800);
}
function closeSearchHistory(){setAppSection('car');}
async function openSearchHistory(){setAppSection('car');await renderSearchHistory();$('search-history').scrollIntoView({behavior:'smooth'});}
async function renderSearchHistory() {
  const request=state.historyRequest=(state.historyRequest||0)+1;
  const rows=await dbAll("directory");
  if (request!==state.historyRequest) return;
  const entries=searchHistory().items.filter(item=>contactsFor(rows.find(row=>row.key===item.key)).some(c=>Boolean(phoneHref(c.phone))));
  const box=$("history-list");
  box.innerHTML=entries.length ? entries.map(item=>{
    const contacts=contactsFor(rows.find(row=>row.key===item.key));
    return `<article class="history-item${state.historyHighlight?.key === item.key && state.historyHighlight.until > Date.now() ? " history-highlight" : ""}" data-key="${escapeHtml(item.key)}">
      <button class="history-remove" data-action="remove-history" type="button" aria-label="Удалить номер из истории">×</button><div class="history-heading"><strong>${escapeHtml(formatPlate(item.key))}</strong><small>${new Date(item.time).toLocaleString("ru-RU",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"})}</small></div>
      ${contacts.length ? contacts.map((contact,i)=>`<div class="history-contact" data-index="${i}" data-contact-id="${escapeHtml(contact.id || "")}" data-contact-phone="${escapeHtml(contact.phone)}"><small>${escapeHtml(contact.phone)}</small><div class="history-actions">
        <button class="call" data-action="call" type="button" aria-label="Позвонить">☎</button>
        <button class="ghost" data-action="sms" type="button" aria-label="Отправить SMS">${actionIcon("sms")}</button><button class="ghost" data-action="telegram" type="button" aria-label="Написать в Telegram">${actionIcon("telegram")}</button>
        <button class="ghost" data-action="copy" type="button" aria-label="Скопировать номер телефона">${actionIcon("copy")}</button><button class="ghost history-add" data-action="add" type="button" aria-label="Добавить телефон">+ телефон</button>
        <button class="ghost" data-action="edit" type="button" aria-label="Редактировать контакт">${actionIcon("edit")}</button>
        <button class="ghost" data-action="delete" type="button" aria-label="Удалить контакт">×</button>
      </div></div>`).join("") : '<small>Телефон не найден</small>'}
      </article>`;
  }).join("") : '<p class="help">За последние три дня поисков нет.</p>';
  box.querySelectorAll("[data-action]").forEach(button=>button.addEventListener("click",async()=>{
    const key=button.closest(".history-item").dataset.key;
    const index=Number(button.closest(".history-contact")?.dataset.index ?? -1);
    const action=button.dataset.action;
    if (action==="remove-history") {
      const saved=searchHistory();saved.items=saved.items.filter(item=>item.key!==key);
      try {localStorage.setItem("searchHistory",JSON.stringify(saved));} catch (_) {return;}
      await renderSearchHistory();return;
    }
    const row=(await dbAll("directory")).find(r=>r.key===key);
    const node=button.closest(".history-contact"), contacts=contactsFor(row);
    const currentIndex=node ? contacts.findIndex(c=>node.dataset.contactId ? c.id===node.dataset.contactId : c.phone===node.dataset.contactPhone) : -1;
    const contact=contacts[currentIndex];
    if (action==="add" || action==="edit") {
      if(action==="edit" && !contact){await renderSearchHistory();return;}
      await openContactEditor(key,action==="edit" ? currentIndex : -1);return;
    }
    if (!contact) {await renderSearchHistory();return;}
    if (action==="delete") {askDeleteContact(key,contact);return;}
    if (action==="copy") {await copyPhone(contact.phone,button);return;}
    const tel=phoneHref(contact.phone);if (!tel) return;
    window.location.href=action==="call" ? "tel:"+tel : messageLink(action,tel,settings().messageText);
  }));
}

function highlightHistory(key) {
  state.historyHighlight = {key,until:Date.now()+2000};
  const item=[...$("history-list").querySelectorAll(".history-item")].find(node=>node.dataset.key===key);
  if (!item) return;
  item.classList.add("history-highlight");
  clearTimeout(state.historyHighlightTimer);
  state.historyHighlightTimer=setTimeout(()=>{
    state.historyHighlight=null;
    $("history-list").querySelectorAll(".history-highlight").forEach(node=>node.classList.remove("history-highlight"));
  },2000);
}

function paintCameraShade() {
  const cam=$("cam").getBoundingClientRect(), canvas=$("camera-shade");
  if (!cam.width || !cam.height) return;
  canvas.width=Math.round(cam.width);canvas.height=Math.round(cam.height);
  const ctx=canvas.getContext("2d");
  ctx.fillStyle="rgba(0,0,0,.72)";ctx.fillRect(0,0,canvas.width,canvas.height);
  const inactive=$(state.plateType==="square" ? "plate-frame" : "square-frame").getBoundingClientRect();
  const active=$(state.plateType==="square" ? "square-frame" : "plate-frame").getBoundingClientRect();
  if(state.cameraMode !== "meter") ctx.clearRect(inactive.left-cam.left,inactive.top-cam.top,inactive.width,inactive.height);
  if(state.cameraMode !== "meter") {ctx.fillStyle="rgba(0,0,0,.35)";ctx.fillRect(inactive.left-cam.left,inactive.top-cam.top,inactive.width,inactive.height);}
  ctx.clearRect(active.left-cam.left+3,active.top-cam.top+3,Math.max(0,active.width-6),Math.max(0,active.height-6));
}

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

function refinePlateQuad(hull,quad) {
  const groups=[[],[],[],[]];
  for(const p of hull){
    let best=0,distance=Infinity;
    for(let i=0;i<4;i++){
      const a=quad[i],b=quad[(i+1)%4],dx=b.x-a.x,dy=b.y-a.y;
      const value=Math.abs(dx*(p.y-a.y)-dy*(p.x-a.x))/Math.hypot(dx,dy);
      if(value<distance){distance=value;best=i;}
    }
    groups[best].push(p);
  }
  const lines=groups.map((points,i)=>{
    if(points.length<2)points=[quad[i],quad[(i+1)%4]];
    const x=points.reduce((s,p)=>s+p.x,0)/points.length,y=points.reduce((s,p)=>s+p.y,0)/points.length;
    let xx=0,xy=0,yy=0;for(const p of points){xx+=(p.x-x)**2;xy+=(p.x-x)*(p.y-y);yy+=(p.y-y)**2;}
    const angle=.5*Math.atan2(2*xy,xx-yy),a=-Math.sin(angle),b=Math.cos(angle);
    return {a,b,c:a*x+b*y};
  });
  const refined=[];
  for(let i=0;i<4;i++){
    const a=lines[(i+3)%4],b=lines[i],d=a.a*b.b-b.a*a.b;
    if(Math.abs(d)<.05)return quad;
    const point={x:(a.c*b.b-b.c*a.b)/d,y:(a.a*b.c-b.a*a.c)/d};
    if(Math.hypot(point.x-quad[i].x,point.y-quad[i].y)>Math.max(10,Math.hypot(quad[(i+1)%4].x-quad[i].x,quad[(i+1)%4].y-quad[i].y)*.15))return quad;
    refined.push(point);
  }
  return refined;
}

function plateCorners(source) {
  const scale=Math.min(1,400/Math.max(source.width,source.height));
  const small=document.createElement("canvas");small.width=Math.max(1,Math.round(source.width*scale));small.height=Math.max(1,Math.round(source.height*scale));
  const ctx=small.getContext("2d",{willReadFrequently:true});ctx.drawImage(source,0,0,small.width,small.height);
  const w=small.width,h=small.height;if(w<20||h<12)return null;
  const rgba=ctx.getImageData(0,0,w,h).data,gray=new Uint8Array(w*h),hist=new Uint32Array(256);
  let total=0;for(let i=0;i<gray.length;i++){const value=Math.round(rgba[i*4]*.299+rgba[i*4+1]*.587+rgba[i*4+2]*.114);gray[i]=value;hist[value]++;total+=value;}
  let count=0,sum=0,max=-1,threshold=140;
  for(let t=0;t<255;t++){count+=hist[t];sum+=t*hist[t];if(!count||count===gray.length)continue;const diff=sum/count-(total-sum)/(gray.length-count);const variance=count*(gray.length-count)*diff*diff;if(variance>max){max=variance;threshold=t;}}
  threshold=Math.max(120,Math.min(220,threshold));
  const visited=new Uint8Array(w*h),queue=new Int32Array(w*h);let best=null,bestScore=0;
  for(let seed=0;seed<gray.length;seed++){
    if(visited[seed]||gray[seed]<=threshold)continue;
    let head=0,tail=1,sx=0,sy=0;queue[0]=seed;visited[seed]=1;
    const left=new Int32Array(h).fill(w),right=new Int32Array(h).fill(-1);
    while(head<tail){const i=queue[head++],x=i%w,y=Math.floor(i/w);sx+=x;sy+=y;left[y]=Math.min(left[y],x);right[y]=Math.max(right[y],x);
      for(const j of [x>0?i-1:-1,x<w-1?i+1:-1,y>0?i-w:-1,y<h-1?i+w:-1])if(j>=0&&!visited[j]&&gray[j]>threshold){visited[j]=1;queue[tail++]=j;}
    }
    if(tail<w*h*.12||tail>w*h*.98)continue;
    const distance=Math.hypot(sx/tail/w-.5,sy/tail/h-.5);
    const score=tail*(1-distance);if(score<=bestScore)continue;
    const points=[];for(let y=0;y<h;y++)if(right[y]>=left[y]){points.push({x:left[y],y},{x:right[y],y});}
    const hull=convexHull(points);
    const initial=quadFromHull(hull);if(!initial)continue;
    let quad=initial;for(let pass=0;pass<3;pass++)quad=refinePlateQuad(hull,quad);
    const area=Math.abs(quad.reduce((s,p,i)=>s+p.x*quad[(i+1)%4].y-p.y*quad[(i+1)%4].x,0))/2;
    if(area<w*h*.15||tail/area<.45)continue;
    const length=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
    const width=(length(quad[0],quad[1])+length(quad[3],quad[2]))/2;
    const height=(length(quad[0],quad[3])+length(quad[1],quad[2]))/2;
    const ratio=width/height,square=(state.photoPlateType||state.plateType)==="square";
    if(!Number.isFinite(ratio)||(square?(ratio<1.1||ratio>2.6):(ratio<2.6||ratio>7)))continue;
    bestScore=score;best=quad.map(p=>({x:p.x/scale,y:p.y/scale}));
  }
  return best;
}

// Solve the eight coefficients mapping destination coordinates back to source.
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
  const canvas=document.createElement("canvas");canvas.width=width;canvas.height=height;
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

function rectifyPlate(source) {
  const corners=plateCorners(source);
  state.perspectiveApplied=Boolean(corners);
  return corners ? warpPlate(source,corners) : source;
}


// Smooth user requests; keep at most one hardware command in flight.
function setZoom(value) {
  if (state.shooting) return state.zoomMotion || state.zoomQueue || Promise.resolve();
  state.zoomTarget = Math.max(state.zoomMin || 1, Math.min(state.zoomMax || 4, value));
  if (state.zoomMotion) return state.zoomMotion;
  const token = state.zoomMotionToken = (state.zoomMotionToken || 0) + 1;
  const stream = state.stream;
  state.zoomMotion = (async () => {
    let last = performance.now();
    while (stream && stream === state.stream && token === state.zoomMotionToken) {
      const now = await new Promise(resolve => requestAnimationFrame(resolve));
      const dt = Math.min(80, Math.max(16, now-last)); last=now;
      const current = state.zoom || state.zoomMin || 1;
      const target = state.zoomTarget;
      const next = Math.abs(target-current)<0.015 ? target : current+(target-current)*(1-Math.exp(-dt/95));
      await applyZoom(next);
      // The slider follows the finger, while the preview smoothly catches up.
      $("zoom-slider").value = zoomToSlider(state.zoomTarget);
      if (next === state.zoomTarget) break;
    }
  })().finally(() => { if(token===state.zoomMotionToken) state.zoomMotion=null; });
  return state.zoomMotion;
}

async function toggleTorch() {
  const stream=state.stream;
  if (!stream || !state.cameraCaps?.torch || state.shooting) return;
  const button=$("torch"); button.disabled=true;
  const zoomReady=state.zoomQueue, focusReady=state.focusQueue;
  state.torchQueue=(state.torchQueue || Promise.resolve()).then(async()=>{
    await zoomReady; await focusReady;
    if(stream!==state.stream) return;
    const on=!state.torchOn;
    const config={torch:on};
    if(state.hardwareZoom) config.zoom=state.acceptedHardwareZoom ?? state.appliedHardwareZoom;
    await stream.getVideoTracks()[0].applyConstraints({advanced:[config]});
    if(stream!==state.stream) return;
    state.torchOn=on; if(state.cameraMode==='meter')localStorage.setItem('meter-camera-torch',String(on)); button.textContent=on?"Выключить фонарик":"Фонарик";
    button.setAttribute("aria-pressed",String(on));
  }).catch(()=>{ button.textContent="Фонарик недоступен"; button.classList.add("hidden"); })
    .finally(()=>{button.disabled=false;});
  return state.torchQueue;
}

function paddleInput(image, height, width, detector=false) {
  const canvas=document.createElement("canvas"); canvas.width=width; canvas.height=height;
  const ctx=canvas.getContext("2d",{willReadFrequently:true});
  let usedWidth=width;
  if(detector) ctx.drawImage(image,0,0,width,height);
  else { usedWidth=Math.min(width,Math.ceil(height*image.width/image.height)); ctx.drawImage(image,0,0,usedWidth,height); }
  const rgba=ctx.getImageData(0,0,width,height).data, data=new Float32Array(3*height*width);
  const mean=[.485,.456,.406],std=[.229,.224,.225];
  for(let y=0;y<height;y++) for(let x=0;x<width;x++) for(let c=0;c<3;c++) {
    const i=y*width+x;
    data[c*height*width+i]=!detector && x>=usedWidth ? 0 : detector ? (rgba[i*4+2-c]/255-mean[c])/std[c] : rgba[i*4+2-c]/127.5-1;
  }
  return new ort.Tensor("float32",data,[1,3,height,width]);
}

function paddleTextBoxes(map,w,h,imageWidth,imageHeight) {
  const seen=new Uint8Array(w*h),queue=new Int32Array(w*h),boxes=[];
  for(let seed=0;seed<map.length;seed++) {
    if(seen[seed] || map[seed]<.3) continue;
    let head=0,tail=1,l=seed%w,r=l,t=Math.floor(seed/w),b=t,sum=0; seen[seed]=1;queue[0]=seed;
    while(head<tail) {
      const i=queue[head++],x=i%w,y=Math.floor(i/w);l=Math.min(l,x);r=Math.max(r,x);t=Math.min(t,y);b=Math.max(b,y);sum+=map[i];
      for(const j of [x?i-1:-1,x<w-1?i+1:-1,y?i-w:-1,y<h-1?i+w:-1]) if(j>=0&&!seen[j]&&map[j]>=.3){seen[j]=1;queue[tail++]=j;}
    }
    if(tail<8 || sum/tail<.55 || b-t<3 || r-l<3) continue;
    const px=(b-t+1)*.4,py=(b-t+1)*.3;
    boxes.push({left:Math.max(0,(l-px)*imageWidth/w),top:Math.max(0,(t-py)*imageHeight/h),right:Math.min(imageWidth,(r+1+px)*imageWidth/w),bottom:Math.min(imageHeight,(b+1+py)*imageHeight/h)});
  }
  return boxes.sort((a,b)=>a.top-b.top).slice(0,20);
}

function paddleDecode(output) {
  const classes=output.dims[output.dims.length-1], steps=output.data.length/classes;
  if(classes!==PADDLE_CHARACTERS.length) throw new Error("Словарь PaddleOCR не соответствует модели");
  let text="",sum=0,count=0,last=-1;
  for(let t=0;t<steps;t++) {
    let best=0;
    for(let c=1;c<classes;c++) if(output.data[t*classes+c]>output.data[t*classes+best]) best=c;
    if(best && best!==last) {text+=PADDLE_CHARACTERS[best];sum+=output.data[t*classes+best];count++;} last=best;
  }
  return {text,conf:count?sum/count:0};
}

function plateTextRows(items) {
  const valid=items.map(item=>({...item,text:normalizePlate(item.text)})).filter(item=>item.text&&!/^RUS/.test(item.text)&&item.text!=="RU");
  const anchors=valid.filter(item=>/^[ABEKMHOPCTYX0-9]+$/.test(item.text));
  const rows=[];
  for(const anchor of anchors){
    const height=anchor.bottom-anchor.top,cy=(anchor.top+anchor.bottom)/2;
    const row=valid.filter(item=>{
      const h=item.bottom-item.top,y=(item.top+item.bottom)/2;
      return h>=height*.4&&h<=height*2.2&&Math.abs(y-cy)<=Math.max(height,h)*.48;
    }).sort((a,b)=>a.left-b.left);
    const key=row.map(item=>items.findIndex(i=>i.left===item.left&&i.top===item.top)).join(',');
    if(!rows.some(r=>r.key===key))rows.push({key,items:row,height});
  }
  return rows.sort((a,b)=>b.height-a.height);
}

function assemblePaddlePlate(items, square) {
  const clean=items.map(item=>({...item,text:normalizePlate(item.text)})).filter(item=>item.text && !/^RUS/.test(item.text) && item.text!=="RU");
  if(!square) {
    for(const row of plateTextRows(items)){
      const plate=extractRuPlate(row.items.map(item=>item.text).join(""));
      if(plate)return plate;
    }
    return "";
  }
  // Find the four-symbol upper group, then letters and region by their positions.
  const tops=clean.filter(item=>/^[ABEKMHOPCTYX]\d{3}$/.test(item.text));
  for(const upper of tops.sort((a,b)=>b.conf-a.conf)) {
    const lower=clean.filter(item=>item!==upper && item.bottom-item.top>=(upper.bottom-upper.top)*.4 && /^[ABEKMHOPCTYX0-9]+$/.test(item.text) && (item.top+item.bottom)/2>(upper.top+upper.bottom)/2+(upper.bottom-upper.top)*.3 && (item.top+item.bottom)/2<(upper.top+upper.bottom)/2+(upper.bottom-upper.top)*1.8).sort((a,b)=>a.left-b.left);
    const text=upper.text+lower.map(item=>item.text).join("");
    if(PLATE_RE.test(text)) return text;
  }
  // Handles detectors that split the top row into several text regions.
  const large=clean.filter(item=>/^[ABEKMHOPCTYX0-9]+$/.test(item.text)&&item.bottom-item.top>=Math.max(...clean.map(c=>c.bottom-c.top))*.4);
  if(large.length) {
    const mid=large.reduce((sum,item)=>sum+(item.top+item.bottom)/2,0)/large.length;
    const top=large.filter(item=>(item.top+item.bottom)/2<mid).sort((a,b)=>a.left-b.left);
    const lower=large.filter(item=>(item.top+item.bottom)/2>=mid).sort((a,b)=>a.left-b.left);
    const text=[...top,...lower].map(item=>item.text).join("");
    if(PLATE_RE.test(text)) return text;
  }
  return "";
}

async function readPaddlePlate(crop) {
  const det=state.ocr.paddleDet,rec=state.ocr.paddleRec;
  if(!det||!rec) throw new Error("PaddleOCR ещё не загружен");
  const scale=Math.min(960/Math.max(crop.width,crop.height),Math.max(1,320/crop.height));
  const w=Math.max(32,Math.round(crop.width*scale/32)*32),h=Math.max(32,Math.round(crop.height*scale/32)*32);
  const result=await det.run({[det.inputNames[0]]:paddleInput(crop,h,w,true)});
  const map=result[det.outputNames[0]],mh=map.dims[map.dims.length-2],mw=map.dims[map.dims.length-1];
  const boxes=paddleTextBoxes(map.data,mw,mh,crop.width,crop.height).filter(box=>{const center=(box.top+box.bottom)/2;return center>=crop.height*.05&&center<=crop.height*.90;}),items=[];
  for(const box of boxes) {
    const canvas=document.createElement("canvas"); canvas.width=Math.max(1,Math.ceil(box.right-box.left));canvas.height=Math.max(1,Math.ceil(box.bottom-box.top));
    canvas.getContext("2d").drawImage(crop,box.left,box.top,box.right-box.left,box.bottom-box.top,0,0,canvas.width,canvas.height);
    const width=Math.max(32,Math.min(960,Math.ceil(48*canvas.width/canvas.height/32)*32));
    const output=await rec.run({[rec.inputNames[0]]:paddleInput(canvas,48,width)});
    const decoded=paddleDecode(output[rec.outputNames[0]]);
    if(decoded.conf>=.45) items.push({...box,...decoded});
  }
  state.paddleItems=items;
  const text=assemblePaddlePlate(items,(state.photoPlateType||state.plateType)==="square");
  return {text,rawText:items.map(item=>item.text).join("\n"),conf:items.length?items.reduce((sum,item)=>sum+item.conf,0)/items.length:0};
}

const PADDLE_CHARACTERS = ["", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z", "!", "\"", "#", "$", "%", "&", "'", "(", ")", "*", "+", ",", "-", ".", "/", ":", ";", "<", "=", ">", "?", "@", "[", "\\", "]", "_", "`", "{", "|", "}", "^", "~", "©", "®", "℉", "№", "Ω", "℮", "™", "∆", "✓", "✔", "✗", "✘", "✕", "☑", "☒", "●", "▪", "▫", "◼", "▶", "◀", "⬆", "¤", "¦", "§", "¨", "ª", "«", "¬", "¯", "°", "²", "³", "´", "µ", "¶", "¸", "¹", "º", "»", "¼", "½", "¾", "¿", "×", "‐", "‑", "‒", "—", "―", "‖", "‗", "‘", "’", "‚", "‛", "“", "”", "„", "‟", "†", "‡", "‣", "․", "…", "‧", "‰", "‴", "‵", "‶", "‷", "‸", "‹", "›", "※", "‼", "‽", "‾", "−", "₤", "₡", "₹", "₽", "₴", "₿", "¢", "€", "£", "¥", "Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ", "Ⅹ", "Ⅺ", "Ⅻ", "ⅰ", "ⅱ", "ⅲ", "ⅳ", "ⅴ", "ⅵ", "ⅶ", "ⅷ", "ⅸ", "ⅹ", "ⅺ", "ⅻ", "➀", "➁", "➂", "➃", "➄", "➅", "➆", "➇", "➈", "➉", "➊", "➋", "➌", "➍", "➎", "➏", "➐", "➑", "➒", "➓", "❶", "❷", "❸", "❹", "❺", "❻", "❼", "❽", "❾", "❿", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "↑", "→", "↓", "↕", "←", "↔", "⇒", "⇐", "⇔", "∀", "∃", "∄", "∴", "∵", "∝", "∞", "∩", "∪", "∂", "∫", "∬", "∭", "∮", "∯", "∰", "∑", "∏", "√", "∛", "∜", "∱", "∲", "∳", "∶", "∷", "∼", "∖", "∗", "≈", "≠", "≡", "≤", "≥", "⊂", "⊃", "⊥", "⊾", "⊿", "□", "∥", "∋", "ƒ", "′", "″", "À", "Á", "Â", "Ã", "Ä", "Å", "Æ", "Ç", "È", "É", "Ê", "Ë", "Ì", "Í", "Î", "Ï", "Ð", "Ñ", "Ò", "Ó", "Ô", "Õ", "Ö", "Ø", "Ù", "Ú", "Û", "Ü", "Ý", "Þ", "à", "á", "â", "ã", "ä", "å", "æ", "ç", "è", "é", "ê", "ë", "ì", "í", "î", "ï", "ð", "ñ", "ò", "ó", "ô", "õ", "ö", "ø", "ù", "ú", "û", "ü", "ý", "þ", "ÿ", "Α", "Β", "Γ", "Δ", "Ε", "Ζ", "Η", "Θ", "Ι", "Κ", "Λ", "Μ", "Ν", "Ξ", "Ο", "Π", "Ρ", "Σ", "Τ", "Υ", "Φ", "Χ", "Ψ", "Ω", "α", "β", "γ", "δ", "ε", "ζ", "η", "θ", "ι", "κ", "λ", "μ", "ν", "ξ", "ο", "π", "ρ", "σ", "ς", "τ", "υ", "φ", "χ", "ψ", "ω", "Å", "ℏ", "⌀", "⍺", "⍵", "𝑢", "𝜓", "०", "‥", "︽", "﹥", "•", "÷", "∕", "∙", "⋅", "·", "±", "∓", "∟", "∠", "∡", "∢", "℧", "☺", " "];

bind();

$("open-car").addEventListener("click",()=>setAppSection("car"));

function maybeAutoUpdate(){
 if(state.stream||state.shooting||state.silentUpdating||document.visibilityState==='hidden')return;
 const now=Date.now(),last=Number(localStorage.getItem('nomera-last-auto-update'))||0;
 if(now-last<14*24*60*60*1000)return;
 localStorage.setItem('nomera-last-auto-update',String(now));
 refreshApp({silent:true});
}
document.addEventListener('visibilitychange',maybeAutoUpdate);
setInterval(maybeAutoUpdate,60*60*1000);

window.addEventListener("online",()=>{if(!state.stream&&!state.loadingModels)loadAllModels().catch(e=>setStatus("model-status",e.message,"bad"));});
