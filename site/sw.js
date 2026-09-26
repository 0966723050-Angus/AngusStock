/* Service Worker：App 殼層快取優先，資料一律走網路 */
const CACHE = "angus-stock-v30";
const SHELL = [
  "./",
  "index.html",
  "css/style.css?v=30",
  "js/app.js?v=8",
  "js/idxk.js?v=30",
  "js/home.js?v=30",
  "js/watch.js?v=8",
  "js/stock.js?v=29",
  "js/vprofile.js?v=22",
  "js/tech.js?v=23",
  "js/screen.js?v=26",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "https://cdn.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js",
  "https://cdn.jsdelivr.net/npm/sortablejs@1.15.2/Sortable.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  // 資料檔：網路優先，離線時回傳最後一次快取
  if (url.pathname.includes("/data/") || e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request).then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(url.origin + url.pathname, copy));
        return r;
      }).catch(() => caches.match(url.origin + url.pathname))
    );
    return;
  }
  // 其他：快取優先，背景更新
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request).then((r) => {
        if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return r;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
