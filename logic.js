// Lógica de fichaje de la mini app: código puro (sin DOM ni almacenamiento), probado en Node.
// Cada acción recibe los eventos actuales y devuelve {error} o {put: [eventos]}: los eventos nuevos o modificados
// que hay que guardar (insertar o reemplazar por id). Quien llama guarda y actualiza su lista.
// Las reglas son las del núcleo (fichaje-core.js): empresa de la jornada, modelos de esa empresa, tres resultados.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./fichaje-core.js'));
  else root.FichajeLogic = factory(root.FichajeCore);
})(typeof self !== 'undefined' ? self : this, function (F) {
  'use strict';

  const UNDO_S = 10;               // segundos para deshacer el fin de jornada
  const MAX_QTY = 999;
  const FUTURE_MS = 60000;         // margen de reloj: una hora no puede estar en el futuro
  const err = error => ({ error });
  // Orden de eventos de una jornada (igual que el núcleo): por hora y, a igual hora, inicio primero y fin último
  const TYPE_ORDER = { jornada_inicio: 0, modelo: 1, pausa_fin: 1, entrega: 1, pausa_inicio: 1, jornada_fin: 2, imputacion: 3 };
  const msOf = ts => Date.parse(ts);
  const byTime = (a, b) => (msOf(a.ts) - msOf(b.ts)) || ((TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9));

  // ---------------- catálogo ----------------
  // catalog = {companies:[…], models:[{model, company, …}]} (el que valida el núcleo) o null
  const companies = cat => cat ? [...cat.companies].sort((a, b) => a.localeCompare(b, 'es')) : [];
  const modelsOf = (cat, company) => cat ? cat.models.filter(m => m.company === F.normCompany(company)).map(m => m.model).sort((a, b) => a.localeCompare(b, 'es')) : [];
  function companyOf(cat) {
    const map = new Map(cat ? cat.models.map(m => [m.model, m.company]) : []);
    return model => map.get(model) || '';
  }

  // ---------------- estado ----------------
  const analysis = (events, now, cat) => F.analyzeAll(events, { now, companyOf: companyOf(cat) });
  // Jornada abierta (la de este dispositivo si hay varias) con su evento de inicio, modelo actual y pausa
  function openInfo(events, now, cat, devId) {
    const A = analysis(events, now, cat);
    const open = A.jornadas.filter(j => j.open);
    const j = open.filter(x => x.dev === devId).pop() || open.pop() || null;
    if (!j) return null;
    const ini = events.find(e => !e.deleted && e.jornadaId === j.jornadaId && e.type === 'jornada_inicio') || null;
    const seg = j.segments[j.segments.length - 1];
    const pause = j.pauses.find(p => p.open) || null;
    return { j, ini, model: seg ? seg.model : '', modelSince: seg ? seg.start : null, pause, analysis: A };
  }

  // ---------------- acciones ----------------
  function build(events, devId, ini, fields, now) {
    const ev = ini ? F.makeJornadaEvent(ini, fields, devId, now) : F.makeEvent(fields, devId, now);
    const bad = F.validateEvent(ev);
    return bad.length ? { error: 'No se puede guardar el fichaje: ' + bad.join(', ') } : { ev };
  }

  function start(events, devId, cat, o, now) {
    now = now || new Date();
    if (!cat || !cat.companies.length) return err('Falta el catálogo: impórtalo desde el archivo que exporta el escritorio.');
    if (openInfo(events, now, cat, devId)) return err('Ya hay una jornada abierta. Ciérrala antes de abrir otra.');
    const company = F.normCompany(o && o.company);
    if (!company || !cat.companies.includes(company)) return err('Elige la empresa de la jornada.');
    const first = F.normModel(o && o.firstModel);
    if (first && !modelsOf(cat, company).includes(first)) return err(`«${first}» no es un modelo de ${company}.`);
    const a = build(events, devId, null, { type: 'jornada_inicio', company, ts: now }, now);
    if (a.error) return a;
    const put = [a.ev];
    if (first) { const m = build(events, devId, a.ev, { type: 'modelo', model: first, ts: now }, now); if (m.error) return m; put.push(m.ev); }
    return { put, jornadaId: a.ev.jornadaId };
  }

  function changeModel(events, devId, cat, model, now) {
    now = now || new Date();
    const O = openInfo(events, now, cat, devId);
    if (!O) return err('No hay jornada abierta.');
    if (O.pause) return err('Estás en pausa: reanuda antes de cambiar de modelo.');
    model = F.normModel(model);
    if (!model) return err('Elige el modelo nuevo.');
    if (!modelsOf(cat, O.j.company).includes(model)) return err(`«${model}» no es un modelo de ${O.j.company}.`);
    if (model === O.model) return err('Ya estás con ese modelo.');
    const r = build(events, devId, O.ini, { type: 'modelo', model, ts: now }, now);
    return r.error ? r : { put: [r.ev] };
  }

  function togglePause(events, devId, cat, now) {
    now = now || new Date();
    const O = openInfo(events, now, cat, devId);
    if (!O) return err('No hay jornada abierta.');
    const r = build(events, devId, O.ini, { type: O.pause ? 'pausa_fin' : 'pausa_inicio', ts: now }, now);
    return r.error ? r : { put: [r.ev], paused: !O.pause };
  }

  function entrega(events, devId, cat, o, now) {
    now = now || new Date();
    const O = openInfo(events, now, cat, devId);
    if (!O) return err('No hay jornada abierta.');
    if (O.pause) return err('Estás en pausa: reanuda antes de registrar una entrega.');
    const model = F.normModel((o && o.model) || O.model);
    if (!model) return err('Elige el modelo de la entrega.');
    if (!modelsOf(cat, O.j.company).includes(model)) return err(`«${model}» no es un modelo de ${O.j.company}.`);
    const qty = Math.round(Number(o && o.qty));
    if (!(qty >= 1) || qty > MAX_QTY) return err(`La cantidad tiene que estar entre 1 y ${MAX_QTY}.`);
    if (!F.RESULTS.includes(o && o.result)) return err('Elige el resultado: reparado, sin reparar o descartado.');
    const r = build(events, devId, O.ini, { type: 'entrega', model, qty, result: o.result, ts: now }, now);
    return r.error ? r : { put: [r.ev] };
  }

  // Fin de jornada: si estaba en pausa, la pausa se cierra a la misma hora. Devuelve los ids para poder deshacerlo.
  function end(events, devId, cat, now) {
    now = now || new Date();
    const O = openInfo(events, now, cat, devId);
    if (!O) return err('No hay jornada abierta.');
    const put = [];
    if (O.pause) { const p = build(events, devId, O.ini, { type: 'pausa_fin', ts: now }, now); if (p.error) return p; put.push(p.ev); }
    const f = build(events, devId, O.ini, { type: 'jornada_fin', ts: now }, now);
    if (f.error) return f;
    put.push(f.ev);
    return { put, undo: { ids: put.map(e => e.id), jornadaId: O.j.jornadaId, until: now.getTime() + UNDO_S * 1000, company: O.j.company, endMs: now.getTime(), startMs: O.j.start } };
  }
  // Deshacer el fin: marca como borrados los eventos de ese cierre (y las imputaciones que se hubieran añadido)
  function undoEnd(events, ids, now) {
    const set = new Set(ids), put = events.filter(e => set.has(e.id) && !e.deleted).map(e => F.deleteEvent(e, now));
    return put.length ? { put } : err('No hay nada que deshacer.');
  }

  // ---------------- imputación de horas (modelo con horas y ningún reparado) ----------------
  const pendingImput = (events, jornadaId, now, cat) => { const j = analysis(events, now, cat).jornadas.find(x => x.jornadaId === jornadaId); return j && !j.open ? j.pendingImput : []; };
  // choices: {modelo: destino | '' (sin asignar)}
  function imputar(events, devId, cat, jornadaId, choices, now) {
    now = now || new Date();
    const j = analysis(events, now, cat).jornadas.find(x => x.jornadaId === jornadaId);
    if (!j || j.open) return err('La jornada tiene que estar cerrada para imputar sus horas.');
    const valid = new Set(modelsOf(cat, j.company)), put = [];
    for (const m of j.pendingImput) {
      if (!(m in (choices || {}))) return err(`Elige un modelo (o «Dejar sin asignar») para «${m}».`);
      const to = F.normModel(choices[m]);
      if (to && (!valid.has(to) || to === m)) return err(`Destino no válido para «${m}».`);
      const ev = F.makeEvent({ type: 'imputacion', model: m, toModel: to, ts: new Date(j.end), jornadaId, day: j.day }, devId, now);
      const bad = F.validateEvent(ev); if (bad.length) return err('No se puede guardar: ' + bad.join(', '));
      put.push(ev);
    }
    return put.length ? { put } : err('Esta jornada no tiene horas pendientes de imputar.');
  }

  // ---------------- último fichaje: corregir la hora o borrarlo ----------------
  // «Último» = el último que ficha ESTE dispositivo (por fecha de guardado; a igual segundo, el posterior en la jornada).
  // Las imputaciones no cuentan: se deshacen junto con el fin de su jornada.
  function lastFichaje(events, devId) {
    const mine = events.filter(e => !e.deleted && e.dev === devId && e.type !== 'imputacion');
    if (!mine.length) return null;
    return mine.slice().sort((a, b) => (msOf(b.updatedAt) - msOf(a.updatedAt)) || byTime(b, a))[0];
  }
  // hm = 'HH:MM'. Mantiene el día natural del evento (si quedaría antes del anterior, es ya del día siguiente).
  function correctLast(events, devId, hm, now) {
    now = now || new Date();
    const ev = lastFichaje(events, devId);
    if (!ev) return err('No hay ningún fichaje que corregir.');
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
    if (!m || +m[1] > 23 || +m[2] > 59) return err('Escribe la hora como HH:MM.');
    const sib = events.filter(e => !e.deleted && e.jornadaId === ev.jornadaId && e.id !== ev.id && e.type !== 'imputacion').sort(byTime);
    const mine = new Date(ev.ts); let ts = new Date(mine.getFullYear(), mine.getMonth(), mine.getDate(), +m[1], +m[2], 0);
    // vecinos según su posición actual
    const before = sib.filter(e => byTime(e, ev) < 0).pop(), after = sib.find(e => byTime(e, ev) > 0);
    // solo se pasa al día siguiente si el fichaje ya era de después de medianoche (la jornada cruza de día)
    if (before && F.dayOf(mine) !== ev.day && ts.getTime() < msOf(before.ts)) ts = new Date(ts.getTime() + 86400000);
    if (before && ts.getTime() < msOf(before.ts)) return err(`La hora no puede ser anterior al fichaje anterior (${hmOf(msOf(before.ts))}).`);
    if (after && ts.getTime() > msOf(after.ts)) return err(`La hora no puede ser posterior al fichaje siguiente (${hmOf(msOf(after.ts))}).`);
    if (ts.getTime() > now.getTime() + FUTURE_MS) return err('La hora no puede estar en el futuro.');
    const next = F.editEvent(ev, { ts: F.localIso(ts) }, now), bad = F.validateEvent(next);
    return bad.length ? err('No se puede guardar: ' + bad.join(', ')) : { put: [next], event: next };
  }
  function deleteLast(events, devId, now) {
    const ev = lastFichaje(events, devId);
    if (!ev) return err('No hay ningún fichaje que borrar.');
    const put = [F.deleteEvent(ev, now)];
    // al borrar el fin de una jornada, sus imputaciones ya no tienen sentido: se borran con él
    if (ev.type === 'jornada_fin') for (const e of events) if (!e.deleted && e.jornadaId === ev.jornadaId && e.type === 'imputacion') put.push(F.deleteEvent(e, now));
    return { put, event: ev };
  }

  const pad = n => String(n).padStart(2, '0');
  const hmOf = ms => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  // Aplica a una lista de eventos lo que devuelve una acción (reemplaza por id o añade)
  function apply(events, put) {
    const idx = new Map(events.map((e, i) => [e.id, i])), out = events.slice();
    for (const e of put) { if (idx.has(e.id)) out[idx.get(e.id)] = e; else { idx.set(e.id, out.length); out.push(e); } }
    return out;
  }

  return { UNDO_S, MAX_QTY, companies, modelsOf, companyOf, analysis, openInfo, start, changeModel, togglePause, entrega, end, undoEnd,
    pendingImput, imputar, lastFichaje, correctLast, deleteLast, apply, hmOf };
});
