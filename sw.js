// Service worker: la app funciona sin conexión una vez cargada.
// · Caché versionada («fichaje-<versión>», la versión sale de version.js). Al activarse una versión nueva se BORRAN las
//   cachés anteriores de la app.
// · La versión nueva se instala en segundo plano y ESPERA: la página avisa y, cuando la persona pulsa «Actualizar»,
//   le manda SKIP_WAITING. Así nunca se cambia el código de la app mientras se está fichando.
// · Todas las rutas son relativas: funciona en una subcarpeta (p. ej. /fichajes/ de GitHub Pages).
// · Los datos NO pasan por aquí: viven en IndexedDB del móvil. Esta caché solo guarda el código de la app.
importScripts('version.js');

const PREFIX = 'fichaje-';
const CACHE = PREFIX + self.APP_VERSION;
// Todo lo que necesita la app para abrirse sin red (hay un test que comprueba que no falta ningún archivo de pwa/)
const FILES = [
  './', 'index.html', 'fichaje.html', 'styles.css', 'version.js',
  'fichaje-core.js', 'store.js', 'logic.js', 'files.js', 'view.js', 'install.js', 'app.js',
  'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'
];

self.addEventListener('install', event => {
  // cache:'reload' evita llenar la caché nueva con copias viejas del caché HTTP del navegador
  event.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  const d = event.data;
  if (d === 'SKIP_WAITING' || (d && d.type === 'SKIP_WAITING')) self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;               // solo lo propio
  event.respondWith(
    caches.open(CACHE).then(cache => cache.match(req, { ignoreSearch: true })).then(hit => {
      if (hit) return hit;
      return fetch(req).catch(() => {
        // sin red y sin copia: al abrir una página se devuelve la app; lo demás falla sin más
        if (req.mode === 'navigate') return caches.open(CACHE).then(c => c.match('fichaje.html'));
        return Response.error();
      });
    })
  );
});
