const VERSION = "99";
const CACHE = "nomera-full-v" + VERSION;
const MODEL_CACHE = "nomera-models";
const CORE = ["./index.html", "./styles.css?v=99", "./app.js?v=99",
  "./meter.js?v=99", "./meter-markup.js?v=99", "./meter-worker.js?v=99", "./meter-models.json?v=99",
  "./ort/ort.webgpu.min.js", "./ort/ort-wasm-simd-threaded.jsep.mjs", "./ort/ort-wasm-simd-threaded.jsep.wasm",
  "./ort/ort.wasm.min.js", "./ort/ort-wasm-simd-threaded.wasm", "./ort/ort-wasm-simd-threaded.mjs"];
const OPTIONAL = ["./manifest.json", "./icons/icon-192.png", "./icons/icon-512.png"];
const absolute = path => new URL(path, self.location.href).href;

async function navigationResponse(response) {
  // A cached response fetched through /index.html -> / can be redirected.
  // Navigation uses redirect:manual; a fresh Response removes that URL history.
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("location");
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(await response.arrayBuffer(), { status: 200, headers });
}

async function report(data) {
  for (const client of await self.clients.matchAll({ includeUncontrolled: true, type: "window" })) client.postMessage(data);
}

async function findSaved(request, previous = false) {
  const keys = previous ? [CACHE, ...(await caches.keys()).filter(key => key !== CACHE && /^nomera-(?:reset-|full-)?v\d+$/.test(key)).sort((a,b) => Number(b.startsWith('nomera-reset-v'))-Number(a.startsWith('nomera-reset-v')) || Number(b.match(/v(\d+)$/)[1])-Number(a.match(/v(\d+)$/)[1]))] : [CACHE];
  for (const key of keys) {
    const response = await (await caches.open(key)).match(request);
    if (response && response.ok) return response;
  }
  return null;
}

let saving;
function saveShell() {
  if (saving) return saving;
  saving = (async () => {
    const cache = await caches.open(CACHE);
    for (const path of CORE) {
      const url = absolute(path);
      try {
        let response = await cache.match(url);
        // Runtime binaries are unchanged since v35; reuse them if already saved.
        if (!response && path.includes("/ort/")) response = await findSaved(url, true);
        if (!response) response = await fetch(new Request(url, { cache: "reload", redirect: "follow", signal: AbortSignal.timeout(60000) }));
        if (!response.ok) throw new Error("HTTP " + response.status);
        if (path === "./index.html") response = await navigationResponse(response);
        await cache.put(url, response);
      } catch (error) {
        await report({ type: "OFFLINE_ERROR", file: path, error: error.message });
        throw new Error("Не сохранён " + path + ": " + error.message);
      }
    }
    // The root URL is another key for exactly the same safe HTML response.
    const html = await cache.match(absolute("./index.html"));
    await cache.put(absolute("./"), html.clone());
    for (const path of OPTIONAL) {
      try {
        const url = absolute(path);
        if (!(await cache.match(url))) {
          const response = await fetch(new Request(url, { cache: "reload", signal: AbortSignal.timeout(15000) }));
          if (response.ok) await cache.put(url, response);
        }
      } catch (_) { /* Icon or manifest failure must not disable offline opening. */ }
    }
  })().finally(() => { saving = null; });
  return saving;
}

self.addEventListener("install", event => {
  event.waitUntil(saveShell().then(() => self.skipWaiting()));
});
self.addEventListener("activate", event => {
  // Retain earlier copies for recovery and tabs still using their versioned scripts.
  event.waitUntil(self.clients.claim().then(() => report({ type: "OFFLINE_ACTIVE", version: VERSION })));
});
self.addEventListener("message", event => {
  const reply = data => event.ports?.[0]?.postMessage(data);
  if (event.data?.type === "SKIP_WAITING") { event.waitUntil(self.skipWaiting()); return; }
  if (event.data?.type === "STATUS") {
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      const ready = (await Promise.all(CORE.map(path => cache.match(absolute(path))))).every(Boolean);
      reply({ version: VERSION, ready });
    })());
  }
  if (event.data?.type === "REPAIR_CACHE") {
    event.waitUntil(saveShell().then(() => reply({ version: VERSION, ready: true }), error => reply({ version: VERSION, ready: false, error: error.message })));
  }
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  if (url.pathname.includes("/models/") || /\/(version\.json|sw\.js)$/.test(url.pathname)) return;
  if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      const saved = await findSaved(absolute("./index.html"), true);
      if (saved) return navigationResponse(saved);
      try {
        const response = await fetch(event.request);
        if (response.ok) return navigationResponse(response);
      } catch (_) {}
      return new Response('<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Номера</title><body style="background:#10141b;color:#fff;font:18px sans-serif;padding:24px"><h1>Номера</h1><p>Локальная копия приложения недоступна. Включите VPN и откройте приложение снова, затем дождитесь подтверждения сохранения на телефоне.</p><p>Не очищайте данные сайта: там сохранены база и модели.</p><a style="color:#3ddc97" href="./">Повторить открытие</a></body></html>', { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    })());
    return;
  }
  event.respondWith((async () => {
    const hit = await findSaved(event.request, true);
    if (hit) return hit;
    const response = await fetch(event.request);
    if (response.ok) event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, response.clone())));
    return response;
  })());
});
