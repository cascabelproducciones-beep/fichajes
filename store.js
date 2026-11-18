// Capa de almacenamiento de la mini app de fichaje: IndexedDB muy fina.
// Solo usa open / createObjectStore / transaction / put / get / getAll / clear, para poder simularla en Node.
// Dos almacenes: «events» (clave id, los eventos ledrc.fichaje) y «meta» (clave key: dispositivo, ajustes).
// Los eventos nunca se borran de aquí: un evento borrado es un evento con deleted:true (lo decide el núcleo).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FichajeStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DB_NAME = 'ledrc-fichaje', DB_VERSION = 1, EVENTS = 'events', META = 'meta';

  // Convierte una petición de IndexedDB en promesa
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error || new Error('error de IndexedDB')); });
  // Espera a que una transacción termine de verdad (no solo a que se encolen las operaciones)
  const done = tx => new Promise((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error || new Error('error de transacción'));
    tx.onabort = () => rej(tx.error || new Error('transacción cancelada'));
  });

  // idb = indexedDB (o el simulado de las pruebas). Devuelve la API del almacén.
  async function openStore(idb, name) {
    const db = await new Promise((res, rej) => {
      const r = idb.open(name || DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore(EVENTS, { keyPath: 'id' });
        d.createObjectStore(META, { keyPath: 'key' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error || new Error('no se pudo abrir la base de datos'));
      r.onblocked = () => rej(new Error('base de datos bloqueada por otra pestaña'));
    });

    async function getAllEvents() { return req(db.transaction([EVENTS], 'readonly').objectStore(EVENTS).getAll()); }
    // Guarda (inserta o reemplaza por id) una lista de eventos en una sola transacción: o entran todos o ninguno.
    async function putEvents(list) {
      const tx = db.transaction([EVENTS], 'readwrite'), st = tx.objectStore(EVENTS);
      for (const ev of list) st.put(ev);
      await done(tx);
    }
    // Sustituye TODOS los eventos por los de la lista, en una sola transacción (restaurar una copia)
    async function replaceEvents(list) {
      const tx = db.transaction([EVENTS], 'readwrite'), st = tx.objectStore(EVENTS);
      st.clear();
      for (const ev of list) st.put(ev);
      await done(tx);
    }
    async function getMeta(key) {
      const row = await req(db.transaction([META], 'readonly').objectStore(META).get(key));
      return row ? row.value : undefined;
    }
    async function setMeta(key, value) {
      const tx = db.transaction([META], 'readwrite'); tx.objectStore(META).put({ key, value });
      await done(tx);
    }
    function close() { if (db.close) db.close(); }
    return { getAllEvents, putEvents, replaceEvents, getMeta, setMeta, close };
  }

  // Dispositivo de este móvil: se crea una vez y se guarda (el id va en cada evento que se ficha).
  // F = FichajeCore. Si ya existe se devuelve tal cual.
  async function ensureDevice(store, F, defaultName) {
    let dev = await store.getMeta('device');
    if (!dev || !dev.id) { dev = F.makeDevice(defaultName || 'Móvil'); await store.setMeta('device', dev); }
    return dev;
  }

  // Pide almacenamiento persistente (que el navegador no borre los datos por falta de espacio).
  // nav = navigator. Devuelve {supported, persisted, usage, quota}; nunca lanza.
  async function requestPersist(nav) {
    const out = { supported: false, persisted: false, usage: null, quota: null };
    try {
      const s = nav && nav.storage;
      if (!s) return out;
      if (typeof s.persist === 'function') {
        out.supported = true;
        out.persisted = (typeof s.persisted === 'function' && await s.persisted()) || await s.persist();
      }
      if (typeof s.estimate === 'function') { const e = await s.estimate(); out.usage = e.usage == null ? null : e.usage; out.quota = e.quota == null ? null : e.quota; }
    } catch (e) { /* el navegador puede negarlo: la app funciona igual */ }
    return out;
  }

  return { DB_NAME, DB_VERSION, EVENTS, META, openStore, ensureDevice, requestPersist };
});
