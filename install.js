// Instalación y actualizaciones: detección de plataforma, bloqueo en iOS fuera de la app instalada, oferta de instalación
// en Android y aviso de versión nueva. Código puro (el navegador se pasa como parámetro), probado en Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FichajeInstall = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // env = {ua, platform, maxTouchPoints, standalone (navigator.standalone), displayStandalone (display-mode: standalone), sim}
  // sim (solo para probar): 'ios-safari' | 'ios-app' | 'android' fuerza la plataforma.
  // Devuelve {os:'ios'|'android'|'otro', installed, mustInstall, canInstallHere}
  //  · iOS: si se abre desde Safari (o cualquier navegador) y no desde el icono instalado, hay que instalar primero:
  //    Safari y la app instalada guardan los datos por separado, y Safari puede borrar los suyos si no se usa unos días.
  //  · Android: no se bloquea nada; Chrome ofrece instalar.
  function detect(env) {
    env = env || {};
    const ua = String(env.ua || ''), sim = env.sim;
    let os = 'otro';
    if (/iPhone|iPad|iPod/i.test(ua) || (env.platform === 'MacIntel' && Number(env.maxTouchPoints) > 1)) os = 'ios';   // iPadOS dice «Macintosh»
    else if (/Android/i.test(ua)) os = 'android';
    let installed = env.standalone === true || env.displayStandalone === true;
    if (sim === 'ios-safari') { os = 'ios'; installed = false; }
    else if (sim === 'ios-app') { os = 'ios'; installed = true; }
    else if (sim === 'android') { os = 'android'; installed = false; }
    return { os, installed, mustInstall: os === 'ios' && !installed, canInstallHere: os === 'android' && !installed };
  }
  const SIMS = ['ios-safari', 'ios-app', 'android'];
  const simFrom = search => { const m = /[?&]sim=([a-z-]+)/.exec(String(search || '')); return m && SIMS.includes(m[1]) ? m[1] : undefined; };

  // ---------------- actualizaciones del service worker ----------------
  // reg = ServiceWorkerRegistration, nav = navigator. Llama a onWaiting(worker) cuando hay una versión nueva ya
  // instalada y esperando (y la página está controlada por la anterior). Devuelve una función que lo comprueba ahora.
  function watchUpdates(reg, nav, onWaiting) {
    const check = () => { if (reg.waiting && nav.serviceWorker && nav.serviceWorker.controller) onWaiting(reg.waiting); };
    reg.addEventListener('updatefound', () => {
      const w = reg.installing; if (!w) return;
      w.addEventListener('statechange', () => { if (w.state === 'installed') check(); });
    });
    check();
    return check;
  }
  // Pide a la versión que espera que tome el control y recarga UNA vez cuando lo haga
  function applyUpdate(worker, nav, reload) {
    let done = false;
    nav.serviceWorker.addEventListener('controllerchange', () => { if (done) return; done = true; reload(); });
    worker.postMessage('SKIP_WAITING');
  }

  // Texto de ayuda para instalar en iPhone
  const IOS_STEPS = ['Toca el botón Compartir (el cuadrado con la flecha hacia arriba) de Safari.', 'Elige «Añadir a pantalla de inicio».', 'Abre «Fichaje» desde el icono nuevo de tu pantalla de inicio.'];

  return { detect, simFrom, SIMS, watchUpdates, applyUpdate, IOS_STEPS };
});
