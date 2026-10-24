// Guarda la app para abrirla sin internet. Los números (datos.json) se piden siempre a la red primero.
const CACHE = "pick3-v15";
const APP = ["./", "index.html", "manifest.webmanifest", "icono-192.png", "icono-512.png", "icono-180.png", "historico.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Red primero para todo lo nuestro; si no hay conexión, lo guardado
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) {
        const copia = r.clone();
        const clave = url.pathname.endsWith("datos.json") ? new Request(url.origin + url.pathname) : e.request;
        caches.open(CACHE).then(c => c.put(clave, copia));
      }
      return r;
    }).catch(() => caches.match(url.pathname.endsWith("datos.json") ? new Request(url.origin + url.pathname) : e.request))
  );
});
