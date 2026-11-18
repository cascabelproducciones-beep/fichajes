// Archivos de la mini app: leer el catálogo y los archivos de eventos, generar la copia y las exportaciones, y entregarlos
// (compartir o descargar). Código puro: el navegador se pasa como parámetro, así se prueba en Node.
// Formatos del esquema ledrc.fichaje v1 (los mismos que escribe y lee el escritorio): «catalogo», «backup» y «export».
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./fichaje-core.js'));
  else root.FichajeFiles = factory(root.FichajeCore);
})(typeof self !== 'undefined' ? self : this, function (F) {
  'use strict';

  const MAX_BYTES = 20 * 1024 * 1024;     // un archivo de fichaje nunca se acerca a esto
  // Campos que delatan un precio o un importe: el catálogo del móvil no debe llevarlos
  const PRICE_KEY = /^(pre[cz]ios?|price|prices|pvp|eur|euros?|coste|costes|cost|tarifa|tarifas|importe|importes|facturaci[oó]n|baremo)$/i;

  function parse(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'el archivo está vacío' };
    if (text.length > MAX_BYTES) return { ok: false, error: 'el archivo es demasiado grande' };
    try { return { ok: true, obj: JSON.parse(text.replace(/^﻿/, '')) }; }
    catch (e) { return { ok: false, error: 'no es un archivo JSON válido' }; }
  }
  const kindName = k => ({ catalogo: 'catálogo', backup: 'copia de seguridad', export: 'eventos exportados' }[k] || String(k));

  // ---------------- catálogo ----------------
  // Solo se acepta kind:"catalogo" y sin precios. Devuelve {ok, errors[], catalog:{companies, models, exportedAt}}
  function readCatalog(text) {
    const p = parse(text); if (!p.ok) return { ok: false, errors: [p.error], catalog: null };
    const o = p.obj;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, errors: ['el archivo no es un catálogo'], catalog: null };
    if (o.schema !== F.SCHEMA) return { ok: false, errors: ['no es un archivo de fichaje'], catalog: null };
    if (o.kind !== 'catalogo') return { ok: false, errors: [`es un archivo de tipo «${kindName(o.kind)}», no un catálogo. Aquí solo se importa el catálogo; los eventos se importan en «Restaurar o importar eventos».`], catalog: null };
    const prices = [];
    for (const k of Object.keys(o)) if (PRICE_KEY.test(k)) prices.push(k);
    if (Array.isArray(o.models)) o.models.forEach((m, i) => { if (m && typeof m === 'object') for (const k of Object.keys(m)) if (PRICE_KEY.test(k)) prices.push(`modelo ${i + 1}: ${k}`); });
    if (prices.length) return { ok: false, errors: ['el catálogo lleva precios y no se importa (' + [...new Set(prices)].slice(0, 4).join(', ') + '). Genera de nuevo el catálogo en el escritorio.'], catalog: null };
    const v = F.validateFile(o, ['catalogo']);
    if (!v.ok) return { ok: false, errors: v.errors, catalog: null };
    if (!v.catalog.models.length) return { ok: false, errors: ['el catálogo no tiene ningún modelo'], catalog: null };
    // Se guarda solo lo que sale validado del núcleo (empresas, modelos y su fecha): nada más del archivo
    return { ok: true, errors: [], catalog: { companies: v.catalog.companies, models: v.catalog.models, exportedAt: o.exportedAt || null } };
  }
  // Qué cambia al sustituir un catálogo por otro
  function catalogChanges(oldC, newC) {
    const om = new Map(((oldC && oldC.models) || []).map(m => [m.model, m.company])), nm = new Map(newC.models.map(m => [m.model, m.company]));
    const oc = new Set((oldC && oldC.companies) || []);
    return {
      addedModels: [...nm.keys()].filter(m => !om.has(m)).length,
      removedModels: [...om.keys()].filter(m => !nm.has(m)).length,
      movedModels: [...nm.keys()].filter(m => om.has(m) && om.get(m) !== nm.get(m)).length,
      removedCompanies: [...oc].filter(c => !newC.companies.includes(c))
    };
  }

  // ---------------- eventos: copia, exportación e importación ----------------
  // Lee un archivo de eventos (copia o exportación). El catálogo y lo que no es de fichaje se rechazan con un motivo claro.
  function readEvents(text) {
    const p = parse(text); if (!p.ok) return { ok: false, errors: [p.error], events: [], invalid: [] };
    const o = p.obj;
    if (o && o.kind === 'catalogo') return { ok: false, errors: ['es un catálogo, no una copia de eventos. Impórtalo en la sección «Catálogo».'], events: [], invalid: [] };
    const v = F.validateFile(o, ['backup', 'export']);
    if (!v.ok) return { ok: false, errors: v.errors, events: v.events || [], invalid: v.invalid || [] };
    if (!v.events.length && !v.invalid.length) return { ok: false, errors: ['el archivo no trae ningún evento'], events: [], invalid: [] };
    return v;
  }
  // Copia de seguridad: TODOS los eventos (también los borrados) con el id del dispositivo
  function buildBackup(events, device, now) { return checked(F.buildExport(events, device, 'backup', now)); }
  // Eventos de unas fechas (AAAA-MM-DD; vacío = sin límite). Incluye los borrados para que el borrado también viaje.
  function buildEvents(events, device, from, to, now) { return checked(F.buildExport(F.filterEventsByDays(events, from, to), device, 'export', now)); }
  function checked(file) {
    const c = F.checkGenerated(file);
    return c.ok ? { ok: true, file, count: c.count } : { ok: false, errors: c.errors, file: null, count: 0 };
  }
  const nameBackup = day => F.exportFileName('backup', { day });
  const nameEvents = (from, to, day) => F.exportFileName('export', { from, to, day });
  const toText = file => JSON.stringify(file, null, 2);

  // ---------------- entregar un archivo: compartir o descargar ----------------
  // env = {nav, doc, URL, Blob, File}. mode: 'compartir' (si se puede) o 'descargar'.
  // Devuelve 'compartido' | 'descargado' | 'cancelado'; lanza si no se puede entregar de ninguna forma.
  function canShareFiles(env, name, text) {
    try {
      const nav = env.nav;
      if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function' || typeof env.File !== 'function') return false;
      return !!nav.canShare({ files: [new env.File([text], name, { type: 'application/json' })] });
    } catch (e) { return false; }
  }
  function download(env, name, text) {
    const blob = new env.Blob([text], { type: 'application/json' }), url = env.URL.createObjectURL(blob);
    const a = env.doc.createElement('a'); a.href = url; a.download = name; a.style.display = 'none';
    env.doc.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => { try { env.URL.revokeObjectURL(url); } catch (e) { /* ya liberada */ } }, 10000);
    return 'descargado';
  }
  async function deliver(env, name, text, mode) {
    if (mode !== 'descargar' && canShareFiles(env, name, text)) {
      try { await env.nav.share({ files: [new env.File([text], name, { type: 'application/json' })], title: name }); return 'compartido'; }
      catch (e) {
        if (e && e.name === 'AbortError') return 'cancelado';           // el usuario cerró la hoja de compartir
        // si compartir falla por otra causa, se descarga: el archivo nunca se pierde
      }
    }
    return download(env, name, text);
  }

  // ---------------- importación de eventos: previsualización ----------------
  // local = eventos del móvil; v = resultado de readEvents; mode: 'nuevos' | 'reemplazar' | 'saltar'.
  function previewImport(local, v, mode, opts) {
    const cmp = F.compareImport(local, v.events), selected = F.defaultSelection(cmp.items, mode || 'nuevos');
    return { cmp, selected, groups: F.groupImport(cmp.items), counts: F.importCounts(cmp.items, selected), overlaps: F.importOverlaps(local, cmp.items, selected, opts) };
  }
  // Aplica la selección: devuelve {events (lista completa), changed (eventos a guardar), added, replaced}
  function applyPreview(local, cmp, selected) {
    const r = F.applyImport(local, cmp.items, selected);
    const ids = new Set(cmp.items.filter(it => it.status !== 'existe' && !F.importBlocked(it) && selected.has(it.ev.id)).map(it => it.ev.id));
    return { events: r.events, changed: r.events.filter(e => ids.has(e.id)), added: r.added, replaced: r.replaced };
  }

  return { PRICE_KEY, readCatalog, catalogChanges, readEvents, buildBackup, buildEvents, nameBackup, nameEvents, toText, canShareFiles, deliver, previewImport, applyPreview, kindName };
});
