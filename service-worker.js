const CACHE = "akara-koko-v1";
const ASSETS = ["./", "./index.html", "./css/style.css", "./js/app.js", "./manifest.json", "./icon.svg", "./images/akara.jpg", "./images/koko.jpg"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener("fetch", event => {
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
