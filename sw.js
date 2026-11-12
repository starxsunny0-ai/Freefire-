// Fraglord service worker. Pictures and icons come from the phone first (instant), the app page comes from the network first
// (so updates always arrive) and falls back to the saved copy if the network is slow or offline.
const C = "fraglord-v5";
const SHELL = ["/", "/app.html", "/img-logo.webp", "/img-splash.jpg", "/icon-192.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(C).then(c => c.addAll(SHELL)).catch(() => {})); self.skipWaiting(); });
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x != C).map(x => caches.delete(x)))).then(() => self.clients.claim())));
const save = (r, res) => { if (res && res.ok) { const c = res.clone(); caches.open(C).then(x => x.put(r, c)); } return res; };
self.addEventListener("fetch", e => {
  const r = e.request, u = new URL(r.url);
  if (r.method != "GET" || u.origin != location.origin || u.pathname.startsWith("/.netlify/") || u.pathname.endsWith(".apk") || u.pathname.startsWith("/ads/")) return;   // payments, Firebase and the APK always go live
  if (u.pathname.startsWith("/img-") || u.pathname.startsWith("/icon-")) {      // pictures: cache first, refresh quietly
    e.respondWith(caches.match(r).then(m => m || fetch(r).then(res => save(r, res)))); return; }
  e.respondWith(new Promise(ok => {                                              // pages: network first, but never wait more than 4 seconds
    const t = setTimeout(() => caches.match(r).then(m => m && ok(m)), 4000);
    fetch(r).then(res => { clearTimeout(t); ok(save(r, res)); }).catch(() => { clearTimeout(t); caches.match(r).then(m => ok(m || caches.match("/") || Response.error())); }); }));
});
