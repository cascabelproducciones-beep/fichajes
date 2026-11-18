// =====================================================================
//  LED Repair Control V3 · Núcleo del Control horario (esquema ledrc.fichaje v1)
//  Código puro, sin DOM ni dependencias: lo usan el escritorio (renderer), la mini app
//  del móvil (iPhone y Android) y las pruebas en Node (scripts/test-fichaje-core.js).
//
//  Reglas:
//   · Los eventos de fichaje_v3 son la fuente de verdad del fichaje; las filas del Excel
//     son su respaldo derivado (se regeneran por jornada).
//   · Toda jornada lleva jornadaId y su empresa (en jornada_inicio). Varias jornadas por día,
//     sin solaparse en el tiempo (tampoco entre dispositivos distintos).
//   · Tiempo de jornada de un modelo = su tramo completo: de su evento «modelo» al siguiente «modelo» o al
//     fin de jornada, CON las pausas (toda pausa cuenta como jornada; para salir fuera se cierra la jornada).
//     El primer tramo empieza en el inicio de jornada, así la suma de HORAS de las filas = duración de la jornada.
//     Las pausas solo sirven para el tiempo EFECTIVO (tramo − pausas), un dato secundario.
//   · Tres resultados de entrega: reparado (se factura y es entregado), sin_reparar (devuelto sin reparar porque
//     no lo necesitaba: es entregado y completa módulo, no se factura ni consume tiempo) y descartado (irreparable:
//     ni se factura ni es entregado; cifra aparte). ENTREGADO = reparados + sin reparar.
//   · Tiempo por tile = horas del modelo ÷ tiles REPARADOS (mismo criterio que Costes): todo el tiempo del modelo,
//     también el dedicado a descartados, se reparte entre sus reparados. Tiles/hora = reparados ÷ horas.
//   · Imputación: si un modelo acaba una jornada con horas y ningún reparado, un evento «imputacion» (model → toModel)
//     pasa sus horas a otro modelo de la misma jornada; toModel vacío = «dejar sin asignar» (las horas se quedan en
//     el modelo: su cifra diaria es «—» y cuentan en la media acumulada). La suma de HORAS no cambia.
//   · Nada se borra: un evento borrado queda con deleted:true y rev+1 (para que una
//     reimportación antigua no lo resucite).
// =====================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FichajeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCHEMA = 'ledrc.fichaje';
  const VERSION = 1;
  const KINDS = ['export', 'backup', 'catalogo'];
  const TYPES = ['jornada_inicio', 'jornada_fin', 'pausa_inicio', 'pausa_fin', 'modelo', 'entrega', 'imputacion'];
  const RESULTS = ['reparado', 'sin_reparar', 'descartado'];
  const START_ISO = '2026-10-05';          // no hay datos antes del 05/10/2026
  const LONG_JORNADA_H = 14;               // aviso: posible fin de jornada olvidado
  // Campos que forman el contenido de un evento (rev y updatedAt no: son metadatos de versión)
  const CONTENT_FIELDS = ['jornadaId', 'dev', 'day', 'type', 'ts', 'company', 'model', 'qty', 'result', 'toModel', 'deleted'];
  // Orden dentro del mismo instante: el inicio va primero y el fin el último; el resto, en el orden
  // en que se ficharon (la ordenación es estable), p. ej. pausa y reanudar pulsados en el mismo segundo
  const TYPE_ORDER = { jornada_inicio: 0, modelo: 1, pausa_fin: 1, entrega: 1, pausa_inicio: 1, jornada_fin: 2, imputacion: 3 };

  // ---------------- utilidades ----------------
  const pad = n => String(n).padStart(2, '0');
  const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
  // Redondea a 2 decimales una lista de cantidades de modo que la suma sea round2(suma real)
  // (mayor resto: el redondeo no puede descuadrar la suma de HORAS con la duración de la jornada)
  function splitRound(vals) {
    const cents = vals.map(v => (Number(v) || 0) * 100), target = Math.round(cents.reduce((a, b) => a + b, 0));
    const base = cents.map(c => Math.floor(c + 1e-9)); let left = target - base.reduce((a, b) => a + b, 0);
    const byRest = cents.map((c, i) => [c - base[i], i]).sort((a, b) => (b[0] - a[0]) || (a[1] - b[1]));
    for (let k = 0; k < byRest.length && left > 0; k++, left--) base[byRest[k][1]]++;
    return base.map(c => c / 100);
  }
  const normCompany = s => String(s == null ? '' : s).trim().toUpperCase();
  const normModel = s => String(s == null ? '' : s).trim();
  const isDay = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && (() => {
    const [y, m, d] = s.split('-').map(Number); const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  })();
  const msOf = ts => { const t = Date.parse(ts); return isFinite(t) ? t : NaN; };
  // Fecha local con su desfase: 2026-11-18T08:00:00+01:00
  function localIso(date) {
    const d = date instanceof Date ? date : new Date(date);
    const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', a = Math.abs(off);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  }
  const dayOf = date => { const d = date instanceof Date ? date : new Date(date); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  function newId() {
    const c = (typeof crypto !== 'undefined') ? crypto : null;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    const b = new Uint8Array(16);
    if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b); else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  const evSort = (a, b) => (msOf(a.ts) - msOf(b.ts)) || ((TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9));

  // ---------------- almacén y dispositivo ----------------
  const makeDevice = name => ({ id: newId(), name: String(name || 'Dispositivo') });
  const emptyStore = device => ({ schema: SCHEMA, version: VERSION, device: device || null, events: [] });

  // ---------------- creación y edición de eventos ----------------
  // fields: {type, ts (Date o ISO), jornadaId?, company?, model?, qty?, result?}. now/ts por defecto = ahora.
  function makeEvent(fields, dev, now) {
    const at = now ? new Date(now) : new Date();
    const tsDate = fields.ts ? new Date(fields.ts) : at;
    const ev = {
      id: newId(),
      jornadaId: fields.jornadaId || (fields.type === 'jornada_inicio' ? 'J-' + newId() : ''),
      dev: String(dev || ''),
      day: fields.day || dayOf(tsDate),
      type: fields.type,
      ts: typeof fields.ts === 'string' ? fields.ts : localIso(tsDate),
      rev: 1, updatedAt: localIso(at), deleted: false
    };
    if (fields.type === 'jornada_inicio') ev.company = normCompany(fields.company);
    if (fields.type === 'modelo' || fields.type === 'entrega' || fields.type === 'imputacion') ev.model = normModel(fields.model);
    if (fields.type === 'entrega') { ev.qty = Math.round(Number(fields.qty)); ev.result = fields.result; }
    if (fields.type === 'imputacion') ev.toModel = normModel(fields.toModel);
    return ev;
  }
  // Evento dentro de una jornada abierta: hereda su jornadaId y su día (aunque pase de medianoche)
  const makeJornadaEvent = (inicio, fields, dev, now) => makeEvent({ ...fields, jornadaId: inicio.jornadaId, day: inicio.day }, dev, now);
  // Devuelve una copia con los cambios, rev+1 y updatedAt nuevo (no toca id, jornadaId, dev ni type)
  function editEvent(ev, changes, now) {
    const out = { ...ev };
    for (const k of ['ts', 'day', 'company', 'model', 'qty', 'result', 'toModel']) if (changes && k in changes) out[k] = changes[k];
    if (typeof out.ts !== 'string') out.ts = localIso(out.ts);
    if ('company' in out && out.type === 'jornada_inicio') out.company = normCompany(out.company);
    if ('model' in out) out.model = normModel(out.model);
    if ('toModel' in out) out.toModel = normModel(out.toModel);
    if ('qty' in out) out.qty = Math.round(Number(out.qty));
    out.rev = (Number(ev.rev) || 1) + 1; out.updatedAt = localIso(now ? new Date(now) : new Date());
    return out;
  }
  const deleteEvent = (ev, now) => ({ ...editEvent(ev, {}, now), deleted: true });

  // ---------------- validación de un evento y de un archivo ----------------
  function validateEvent(ev) {
    const e = [];
    if (!ev || typeof ev !== 'object') return ['no es un objeto'];
    if (typeof ev.id !== 'string' || !ev.id) e.push('falta id');
    if (typeof ev.jornadaId !== 'string' || !ev.jornadaId) e.push('falta jornadaId');
    if (typeof ev.dev !== 'string' || !ev.dev) e.push('falta dev (dispositivo)');
    if (!TYPES.includes(ev.type)) e.push('tipo desconocido: ' + ev.type);
    if (!isDay(ev.day)) e.push('día no válido: ' + ev.day);
    if (typeof ev.ts !== 'string' || !isFinite(msOf(ev.ts))) e.push('hora no válida: ' + ev.ts);
    if (!(Number.isInteger(ev.rev) && ev.rev >= 1)) e.push('rev no válida');
    if (typeof ev.updatedAt !== 'string' || !isFinite(msOf(ev.updatedAt))) e.push('updatedAt no válido');
    if (ev.deleted !== undefined && typeof ev.deleted !== 'boolean') e.push('deleted debe ser true/false');
    if (ev.type === 'jornada_inicio' && !normCompany(ev.company)) e.push('jornada_inicio sin empresa');
    if ((ev.type === 'modelo' || ev.type === 'entrega' || ev.type === 'imputacion') && !normModel(ev.model)) e.push(ev.type + ' sin modelo');
    if (ev.type === 'imputacion') {
      if (typeof ev.toModel !== 'string') e.push('imputacion sin modelo destino (vacío = sin asignar)');
      else if (normModel(ev.toModel) && normModel(ev.toModel) === normModel(ev.model)) e.push('imputacion al mismo modelo');
    }
    if (ev.type === 'entrega') {
      if (!(Number.isInteger(ev.qty) && ev.qty >= 1)) e.push('cantidad no válida: ' + ev.qty);
      if (!RESULTS.includes(ev.result)) e.push('resultado no válido: ' + ev.result);
    }
    return e;
  }
  // Valida la envoltura y cada evento. Devuelve {ok, errors[], kind, device, events[] (válidos), invalid[{index,id,errors}]}
  function validateFile(obj, allowedKinds) {
    const errors = [];
    if (!obj || typeof obj !== 'object') return { ok: false, errors: ['el archivo no es un JSON de objeto'], events: [], invalid: [] };
    if (obj.schema !== SCHEMA) errors.push(`no es un archivo de fichaje (schema «${obj.schema}»)`);
    if (obj.version !== VERSION) errors.push(`versión ${obj.version} no admitida (se espera ${VERSION})`);
    if (!KINDS.includes(obj.kind)) errors.push('tipo de archivo desconocido: ' + obj.kind);
    else if (allowedKinds && !allowedKinds.includes(obj.kind)) errors.push(`aquí no se admite un archivo de tipo «${obj.kind}»`);
    if (obj.kind === 'catalogo') {
      const c = validateCatalog(obj);
      return { ok: !errors.length && c.ok, errors: errors.concat(c.errors), kind: obj.kind, catalog: c.catalog, events: [], invalid: [] };
    }
    if (!Array.isArray(obj.events)) { errors.push('falta la lista de eventos'); return { ok: false, errors, events: [], invalid: [] }; }
    const events = [], invalid = [];
    obj.events.forEach((ev, i) => {
      const e = validateEvent(ev);
      if (e.length) invalid.push({ index: i, id: ev && ev.id, errors: e });
      else events.push({ ...ev, deleted: ev.deleted === true });
    });
    return { ok: !errors.length, errors, kind: obj.kind, device: obj.device || null, exportedAt: obj.exportedAt || null, events, invalid };
  }

  // ---------------- catálogo (sin precios) ----------------
  // {schema, version, kind:'catalogo', exportedAt, companies:[...], models:[{model, company, pixel, amb, tpm}]}
  function buildCatalog(models, now) {
    const list = models.filter(m => normModel(m.model) && normCompany(m.company))
      .filter((m, i, arr) => arr.findIndex(x => normModel(x.model) === normModel(m.model)) === i)      // un modelo, una entrada
      .map(m => ({ model: normModel(m.model), company: normCompany(m.company), pixel: m.pixel || '', amb: m.amb || '', tpm: Number(m.tpm) > 0 ? Number(m.tpm) : null }))
      .sort((a, b) => a.company.localeCompare(b.company, 'es') || a.model.localeCompare(b.model, 'es'));
    return { schema: SCHEMA, version: VERSION, kind: 'catalogo', exportedAt: localIso(now || new Date()),
      companies: [...new Set(list.map(m => m.company))], models: list };
  }
  function validateCatalog(obj) {
    const errors = [];
    if (!Array.isArray(obj.models)) return { ok: false, errors: ['el catálogo no trae la lista de modelos'], catalog: null };
    const seen = new Set(), models = [];
    obj.models.forEach((m, i) => {
      const model = normModel(m && m.model), company = normCompany(m && m.company);
      if (!model || !company) { errors.push(`modelo ${i + 1} sin nombre o sin empresa`); return; }
      if (seen.has(model)) { errors.push('modelo repetido: ' + model); return; }
      seen.add(model); models.push({ model, company, pixel: m.pixel || '', amb: m.amb || '', tpm: Number(m.tpm) > 0 ? Number(m.tpm) : null });
    });
    return { ok: !errors.length, errors, catalog: { companies: [...new Set(models.map(m => m.company))], models } };
  }

  // ---------------- Precios: empresa por modelo ----------------
  // Nombre comparable: sin acentos, espacios ni signos, en mayúsculas
  const normName = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const pixelOf = s => (String(s).trim().match(/^P\d+(\.\d+)?/i) || [''])[0].toUpperCase();
  function lev(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i]; let best = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (cur[j] < best) best = cur[j];
      }
      if (best > max) return max + 1;
      prev = cur;
    }
    return prev[b.length];
  }
  // Pares de nombres casi idénticos (≤ maxDist cambios tras normalizar) con el mismo pixel
  function similarNames(models, maxDist) {
    const md = maxDist === undefined ? 2 : maxDist, out = [];
    const L = [...new Set(models)].map(m => ({ m, n: normName(m), p: pixelOf(m) }));
    for (let i = 0; i < L.length; i++) for (let k = i + 1; k < L.length; k++) {
      if (L[i].p !== L[k].p) continue;
      const d = lev(L[i].n, L[k].n, md);
      if (d <= md) out.push({ a: L[i].m, b: L[k].m, dist: d });
    }
    return out;
  }
  // Empresa propuesta para los modelos sin empresa: solo si en TODAS sus filas aparece la misma empresa
  // rows: [{model, company}] · current: {modelo: empresa}. Devuelve [{model, company, filas}]
  function proposeCompanies(rows, current) {
    const seen = {};
    for (const r of rows) {
      const m = normModel(r.model); if (!m) continue;
      (seen[m] = seen[m] || { companies: new Set(), n: 0 }).n++;
      seen[m].companies.add(normCompany(r.company));
    }
    return Object.keys(seen).filter(m => !normCompany(current && current[m]))
      .map(m => ({ model: m, set: [...seen[m].companies], filas: seen[m].n }))
      .filter(x => x.set.length === 1 && x.set[0])
      .map(x => ({ model: x.model, company: x.set[0], filas: x.filas }))
      .sort((a, b) => a.model.localeCompare(b.model, 'es'));
  }

  // ---------------- exportación ----------------
  function buildExport(events, device, kind, now) {
    return { schema: SCHEMA, version: VERSION, kind: kind || 'export', device: device || null,
      exportedAt: localIso(now || new Date()), events: events.map(e => ({ ...e })) };
  }

  // ---------------- exportaciones desde el escritorio ----------------
  // Catálogo para el móvil: solo modelos CON empresa. Devuelve {file, excluded[]} con los modelos dejados fuera
  // (sin empresa) para avisar de cuáles son. models: [{model, company, pixel, amb, tpm}] (sin precios).
  function catalogReport(models, now) {
    const seen = new Set(), excluded = [];
    for (const m of models) {
      const name = normModel(m.model); if (!name || seen.has(name)) continue; seen.add(name);
      if (!normCompany(m.company)) excluded.push(name);
    }
    return { file: buildCatalog(models, now), excluded: excluded.sort((a, b) => a.localeCompare(b, 'es')) };
  }
  // Eventos de los días [from, to] (AAAA-MM-DD; vacío = sin límite). Se filtra por el día de la jornada, así una jornada
  // que pasa de medianoche sale entera. Incluye los eventos borrados: así el borrado también viaja y no se resucita.
  const filterEventsByDays = (events, from, to) => events.filter(e => (!from || e.day >= from) && (!to || e.day <= to));
  // Nombre de archivo claro: tipo + fecha. kind: 'catalogo' | 'backup' | 'export'; o: {day, from, to, prueba}
  function exportFileName(kind, o) {
    o = o || {}; const day = o.day || dayOf(new Date()), pr = o.prueba ? 'PRUEBA_' : '';
    if (kind === 'catalogo') return `fichaje_${pr}catalogo_${day}.json`;
    if (kind === 'backup') return `fichaje_${pr}copia-eventos_${day}.json`;
    const range = o.from || o.to ? `${o.from || 'inicio'}_a_${o.to || 'hoy'}` : `todo_${day}`;
    return `fichaje_${pr}eventos_${range}.json`;
  }
  // Comprueba un archivo generado como lo haría quien lo lea: serializa, vuelve a leer y valida con validateFile.
  // Devuelve {ok, errors[], kind, count (modelos o eventos)}
  function checkGenerated(file) {
    const errors = [];
    let back; try { back = JSON.parse(JSON.stringify(file)); } catch (e) { return { ok: false, errors: ['no se puede serializar'], kind: file && file.kind, count: 0 }; }
    const v = validateFile(back, [file.kind]);
    if (!v.ok) errors.push(...v.errors);
    let count = 0;
    if (file.kind === 'catalogo') {
      count = v.catalog ? v.catalog.models.length : 0;
      if (count !== file.models.length) errors.push('el catálogo no se vuelve a leer completo');
      if (file.models.some(m => 'price' in m || 'precio' in m)) errors.push('el catálogo no debe llevar precios');
    } else {
      count = v.events.length;
      if (v.invalid.length) errors.push(`${v.invalid.length} evento(s) no válidos`);
      if (count !== file.events.length) errors.push('los eventos no se vuelven a leer completos');
      if (!file.device || !file.device.id) errors.push('falta el identificador del dispositivo');
    }
    return { ok: !errors.length, errors, kind: file.kind, count };
  }

  // ---------------- jornadas: agrupación y análisis ----------------
  // Agrupa por jornadaId (los borrados se descartan aquí; siguen en el almacén)
  function groupJornadas(events) {
    const map = new Map();
    for (const ev of events) {
      if (ev.deleted) continue;
      if (!map.has(ev.jornadaId)) map.set(ev.jornadaId, []);
      map.get(ev.jornadaId).push(ev);
    }
    for (const list of map.values()) list.sort(evSort);
    return map;
  }

  // Analiza una jornada: tramos, pausas, horas y entregas por modelo y avisos.
  // opts: {now (Date|ISO, para jornadas abiertas), companyOf(model) -> empresa del catálogo o ''}
  function analyzeJornada(evts, opts) {
    opts = opts || {};
    const list = evts.filter(e => !e.deleted).slice().sort(evSort);
    const W = [];
    // soft: aviso suave (informativo; no cuenta como incoherencia)
    const warn = (code, msg, ev, soft) => W.push(soft ? { code, msg, eventId: ev ? ev.id : null, soft: true } : { code, msg, eventId: ev ? ev.id : null });
    const inicios = list.filter(e => e.type === 'jornada_inicio'), fines = list.filter(e => e.type === 'jornada_fin');
    const ini = inicios[0] || null, fin = fines[fines.length - 1] || null;
    const jornadaId = list.length ? list[0].jornadaId : null;
    if (!ini) warn('sin_inicio', 'La jornada no tiene inicio');
    if (inicios.length > 1) warn('inicio_duplicado', 'La jornada tiene más de un inicio', inicios[1]);
    if (fines.length > 1) warn('fin_duplicado', 'La jornada tiene más de un fin', fines[0]);
    const company = ini ? normCompany(ini.company) : '';
    const day = ini ? ini.day : (list[0] ? list[0].day : null);
    const dev = ini ? ini.dev : (list[0] ? list[0].dev : '');
    const open = !fin;
    const start = ini ? msOf(ini.ts) : (list[0] ? msOf(list[0].ts) : NaN);
    const nowMs = opts.now ? new Date(opts.now).getTime() : NaN;
    const lastMs = list.length ? msOf(list[list.length - 1].ts) : start;
    const end = fin ? msOf(fin.ts) : (isFinite(nowMs) ? Math.max(nowMs, lastMs) : lastMs);
    if (day && day < START_ISO) warn('antes_inicio_datos', 'Jornada anterior al 05/10/2026: no entra en los datos');

    const segments = [], pauses = [], models = {}, order = [];
    const M = m => { if (!models[m]) { models[m] = { ms: 0, effMs: 0, rep: 0, sinRep: 0, desc: 0, inMs: 0, outMs: 0, imputedTo: null }; order.push(m); } return models[m]; };
    const imps = new Map();      // modelo origen → último evento de imputación
    const checkCompany = (m, ev) => {
      if (typeof opts.companyOf !== 'function') return;
      const c = normCompany(opts.companyOf(m));
      if (!c) warn('modelo_sin_empresa', `«${m}» no tiene empresa en Precios`, ev);
      else if (company && c !== company) warn('modelo_otra_empresa', `«${m}» es de ${c}, no de ${company}`, ev);
    };
    let pauseStart = null;
    const explicit = [], dels = [];
    for (const ev of list) {
      const t = msOf(ev.ts);
      if (ev.day !== day) warn('dia_distinto', 'Evento con un día distinto al de su jornada', ev);
      if (ini && ev !== ini && t < start) warn('antes_de_inicio', 'Evento anterior al inicio de la jornada', ev);
      if (fin && ev !== fin && ev.type !== 'imputacion' && t > end) warn('despues_de_fin', 'Evento posterior al fin de la jornada', ev);
      switch (ev.type) {
        case 'modelo':
          explicit.push({ t, model: ev.model }); M(ev.model); checkCompany(ev.model, ev);
          break;
        case 'pausa_inicio':
          if (pauseStart !== null) warn('pausa_doble', 'Pausa iniciada con otra pausa abierta', ev);
          else pauseStart = t;
          break;
        case 'pausa_fin':
          if (pauseStart === null) warn('pausa_fin_sin_inicio', 'Fin de pausa sin pausa abierta', ev);
          else { pauses.push({ start: pauseStart, end: t }); pauseStart = null; }
          break;
        case 'entrega': {
          const m = M(ev.model);
          if (ev.result === 'descartado') m.desc += ev.qty; else if (ev.result === 'sin_reparar') m.sinRep += ev.qty; else m.rep += ev.qty;
          dels.push({ t, model: ev.model, ev });
          checkCompany(ev.model, ev);
          break;
        }
        case 'imputacion':
          imps.set(ev.model, ev);
          break;
      }
    }
    // ---- Asignación del tiempo a modelos (el cambio de modelo es informativo; las entregas indican el modelo) ----
    //  · Deducido: cada entrega (reparado, sin reparar o descartado) fija el modelo del tramo entre la entrega
    //    anterior (o el inicio de la jornada) y ella; una entrega de otro modelo es un cambio desde la entrega anterior.
    //  · Explícito: un cambio de modelo cubre desde su hora hasta el siguiente cambio explícito y prevalece sobre lo
    //    deducido en ese tramo. Solo lo corta una entrega posterior de un modelo que no se ha elegido a mano antes en
    //    la jornada (p. ej., se olvidó pulsar «Cambiar modelo»): el corte va desde la entrega anterior a esa
    //    (o desde el cambio explícito, si es posterior). Entregar tarde un modelo elegido antes no corta nada.
    //  · Tras la última entrega: el modelo elegido a mano que siga vigente o, si no hay, el último entregado (aviso suave).
    //  · Antes del primer cambio explícito, sin entregas: el primer modelo elegido (cuenta desde el inicio de la jornada).
    const S = start, E = end, clamp = x => Math.min(E, Math.max(S, x));
    const cover = [];                       // tramos explícitos [a, b) con su modelo
    explicit.forEach((x, k) => {
      const next = k + 1 < explicit.length ? explicit[k + 1].t : E;
      const chosenBefore = new Set(explicit.slice(0, k + 1).map(y => y.model));
      let u = next;
      for (let i = 0; i < dels.length; i++) {
        const d = dels[i];
        if (d.t <= x.t || d.t > next || chosenBefore.has(d.model)) continue;
        u = Math.min(u, Math.max(x.t, i ? dels[i - 1].t : S)); break;
      }
      if (u > x.t) cover.push({ a: clamp(x.t), b: clamp(u), model: x.model });
    });
    const lastDel = dels.length ? dels[dels.length - 1] : null;
    let tailMs = 0;
    if (isFinite(S) && isFinite(E) && E > S) {
      const pts = [...new Set([S, E, ...explicit.map(x => x.t), ...dels.map(d => d.t), ...cover.flatMap(c => [c.a, c.b])].map(clamp))].sort((a, b) => a - b);
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1]; if (!(b > a)) continue;
        const c = cover.find(x => x.a <= a && a < x.b);
        let model = c ? c.model : null;
        if (!model) { const d = dels.find(x => x.t >= b); if (d) model = d.model; }
        if (!model && lastDel) { model = lastDel.model; tailMs += b - a; }
        if (!model) { const x = explicit.find(y => y.t >= b); if (x) model = x.model; }
        if (!model) continue;
        const prev = segments[segments.length - 1];
        if (prev && prev.model === model && prev.end === a) prev.end = b; else segments.push({ model, start: a, end: b });
      }
    }
    if (!open && tailMs > 0) warn('tras_ultima_entrega', `${Math.round(tailMs / 60000)} min tras la última entrega asignados a «${lastDel.model}» (último modelo entregado; no se eligió otro a mano)`, lastDel.ev, true);
    if (pauseStart !== null) { if (!open) warn('pausa_abierta', 'La jornada se cerró con una pausa abierta'); pauses.push({ start: pauseStart, end, open: true }); }
    const overlap = (a, b) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
    let totalMs = 0, effMs = 0;
    for (const s of segments) {
      s.ms = s.end - s.start; s.effMs = s.ms - pauses.reduce((acc, p) => acc + overlap(s, p), 0);
      M(s.model).ms += s.ms; models[s.model].effMs += s.effMs; totalMs += s.ms; effMs += s.effMs;
    }
    const pauseMs = pauses.reduce((a, p) => a + Math.max(0, p.end - p.start), 0);
    // Imputaciones: las horas del modelo origen pasan enteras al destino (dentro de la jornada; la suma no cambia)
    const imputations = [];
    for (const [from, ev] of imps) {
      const src = models[from];
      if (!src || !(src.ms > 0)) { warn('imputacion_sin_horas', `Imputación de «${from}», que no tiene horas en esta jornada`, ev); continue; }
      src.imputedTo = ev.toModel || '';
      if (!ev.toModel) { imputations.push({ from, to: '', ms: src.ms, eventId: ev.id }); continue; }
      if (src.rep > 0) warn('imputacion_con_reparados', `«${from}» tiene reparados y aun así sus horas se imputan a «${ev.toModel}»`, ev);
      const dst = M(ev.toModel);
      checkCompany(ev.toModel, ev);
      dst.ms += src.ms; dst.effMs += src.effMs; dst.inMs += src.ms; src.outMs += src.ms;
      imputations.push({ from, to: ev.toModel, ms: src.ms, eventId: ev.id });
      src.ms = 0; src.effMs = 0;
    }
    // Aviso al cerrar: modelo con horas y ningún reparado, sin decisión de imputación
    const pending = open ? [] : order.filter(m => models[m].ms > 0 && models[m].rep === 0 && models[m].inMs === 0 && !imps.has(m));
    for (const m of pending) { warn('horas_sin_reparados', `«${m}» tiene ${round2(models[m].ms / 3600000)} h y ningún reparado: elige a qué modelo imputarlas o déjalas sin asignar`); W[W.length - 1].model = m; }
    // HORAS por modelo redondeadas a 2 decimales de forma que sumen exactamente las horas de la jornada
    const split = splitRound(order.map(m => models[m].ms / 3600000));
    order.forEach((m, i) => { models[m].hours = split[i]; models[m].effHours = round2(models[m].effMs / 3600000); });
    if (!segments.length && !open) warn('sin_modelo', 'Jornada cerrada sin ningún modelo trabajado');
    // Entregas sin tiempo (p. ej., dos modelos entregados en el mismo instante): aviso suave
    if (!open) for (const m of order) if ((models[m].rep + models[m].sinRep + models[m].desc) > 0 && !(models[m].ms > 0) && !models[m].outMs && !models[m].inMs)
      warn('entrega_sin_tiempo', `«${m}» tiene entregas pero ningún tiempo asignado en esta jornada (sus entregas van justo detrás de las de otro modelo)`, null, true);
    if (isFinite(start) && isFinite(end) && (end - start) / 3600000 > LONG_JORNADA_H) warn('jornada_larga', `Jornada de más de ${LONG_JORNADA_H} h: ¿falta el fin de jornada?`);
    return { jornadaId, day, dev, company, start, end, open, segments, pauses, models, order, totalMs, effMs, pauseMs, imputations, pendingImput: pending,
      durMs: isFinite(start) && isFinite(end) ? Math.max(0, end - start) : 0,
      hours: round2(totalMs / 3600000), effHours: round2(effMs / 3600000), warnings: W };
  }

  // Analiza todas las jornadas y busca solapes (también entre dispositivos) y varias abiertas a la vez
  function analyzeAll(events, opts) {
    const jornadas = [...groupJornadas(events).values()].map(l => analyzeJornada(l, opts))
      .sort((a, b) => (a.start - b.start) || String(a.jornadaId).localeCompare(String(b.jornadaId)));
    resolveDayImput(jornadas);
    return { jornadas, overlaps: findOverlaps(jornadas), openCount: jornadas.filter(j => j.open).length };
  }
  // El tiempo por tile es por día y modelo (horas del modelo en todas las jornadas del día ÷ sus reparados del día).
  // Por eso, si un modelo cierra una jornada con horas y ningún reparado, pero otra jornada del MISMO día (cerrada o
  // en curso) tiene reparados suyos, sus horas ya se reparten con ellos: no hace falta imputarlas. Si se dejó
  // «para más tarde», el aviso se resuelve solo en cuanto aparecen esos reparados. Las filas y HORAS no cambian.
  function resolveDayImput(jornadas) {
    const repDay = new Map();
    for (const j of jornadas) for (const m of j.order) if (j.models[m].rep > 0) repDay.set(j.day + '|' + m, (repDay.get(j.day + '|' + m) || 0) + j.models[m].rep);
    for (const j of jornadas) {
      if (!j.pendingImput.length) continue;
      const shared = j.pendingImput.filter(m => repDay.get(j.day + '|' + m) > 0);
      if (!shared.length) continue;
      j.pendingImput = j.pendingImput.filter(m => !shared.includes(m));
      j.warnings = j.warnings.filter(w => !(w.code === 'horas_sin_reparados' && shared.includes(w.model)));
      for (const m of shared) j.warnings.push({ code: 'horas_con_reparados_del_dia', soft: true, eventId: null, model: m,
        msg: `«${m}»: sus ${round2(j.models[m].ms / 3600000)} h se reparten con sus ${repDay.get(j.day + '|' + m)} reparados de otra jornada del mismo día` });
    }
    return jornadas;
  }
  // ---------------- línea de jornadas de un día: huecos y solapes ----------------
  // analyses: jornadas de UN día (análisis; las abiertas llegan hasta «now»). Devuelve, ordenado por inicio:
  //  jornadas [{jornadaId, company, dev, start, end, open, durMs}]
  //  gaps     [{start, end, ms, after, before}]   huecos entre jornadas seguidas (pista visual, no error)
  //  overlaps [{a, b, start, end, ms, crossDevice}] tramos en que dos jornadas se pisan
  //  span     {start, end}                        de la primera entrada a la última salida
  function dayTimeline(analyses) {
    const js = analyses.filter(a => isFinite(a.start) && isFinite(a.end)).slice()
      .sort((x, y) => (x.start - y.start) || (x.end - y.end) || String(x.jornadaId).localeCompare(String(y.jornadaId)))
      .map(a => ({ jornadaId: a.jornadaId, company: a.company, dev: a.dev, start: a.start, end: Math.max(a.start, a.end), open: !!a.open, durMs: a.durMs }));
    const gaps = [], overlaps = [];
    let maxEnd = -Infinity, lastId = null;
    for (const j of js) {
      if (isFinite(maxEnd) && j.start > maxEnd) gaps.push({ start: maxEnd, end: j.start, ms: j.start - maxEnd, after: lastId, before: j.jornadaId });
      if (j.end >= maxEnd) { maxEnd = j.end; lastId = j.jornadaId; }
    }
    for (let i = 0; i < js.length; i++) for (let k = i + 1; k < js.length; k++) {
      const a = js[i], b = js[k], s = Math.max(a.start, b.start), e = Math.min(a.end, b.end);
      if (e > s) overlaps.push({ a: a.jornadaId, b: b.jornadaId, start: s, end: e, ms: e - s, crossDevice: a.dev !== b.dev });
    }
    return { jornadas: js, gaps, overlaps, span: js.length ? { start: js[0].start, end: Math.max(...js.map(j => j.end)) } : null };
  }

  // ---------------- días laborables sin ninguna jornada fichada ----------------
  // o: {from, to, today ('AAAA-MM-DD'), firstDay (primer día con fichaje), jornadaDays: Set, festivos: Set,
  //     dataDays: {día: {x: bool, v: bool}} (lo que dice Datos de ese día, si hay filas)}
  // Referencia: si Datos tiene ese día, manda su marca (X = trabajado → se avisa si no hay jornada, aunque sea festivo
  // o fin de semana; V o sin X → no se avisa). Sin datos ese día: se avisa si es laborable (lunes a viernes, no festivo).
  // Solo desde el primer día con fichaje y hasta ayer (hoy aún está en curso). Devuelve [{day, reason: 'x' | 'laborable'}].
  function missingDays(o) {
    const out = [], from = [o.from, o.firstDay, START_ISO].filter(Boolean).sort().pop(), to = [o.to, o.today].filter(Boolean).sort()[0];
    if (!from || !to || from > to) return out;
    const [y, m, d] = from.split('-').map(Number);
    for (let dt = new Date(y, m - 1, d); dayOf(dt) <= to; dt.setDate(dt.getDate() + 1)) {
      const ds = dayOf(dt);
      if (ds >= o.today || (o.jornadaDays && o.jornadaDays.has(ds))) continue;
      const info = o.dataDays && o.dataDays[ds];
      if (info) { if (info.x) out.push({ day: ds, reason: 'x' }); continue; }
      const w = dt.getDay();
      if (w >= 1 && w <= 5 && !(o.festivos && o.festivos.has(ds))) out.push({ day: ds, reason: 'laborable' });
    }
    return out;
  }

  function findOverlaps(jornadas) {
    const out = [];
    const js = jornadas.filter(j => isFinite(j.start) && isFinite(j.end)).slice().sort((a, b) => a.start - b.start);
    for (let i = 0; i < js.length; i++) for (let k = i + 1; k < js.length; k++) {
      const a = js[i], b = js[k];
      if (b.start >= a.end) continue;
      out.push({ a: a.jornadaId, b: b.jornadaId, crossDevice: a.dev !== b.dev,
        msg: a.dev !== b.dev ? 'Jornadas de dos dispositivos distintos que se pisan en el tiempo' : 'Jornadas que se pisan en el tiempo' });
    }
    return out;
  }

  // ---------------- filas del Excel generadas por jornada ----------------
  // Una fila por modelo con horas o entregas. day queda como 'AAAA-MM-DD' (el escritorio lo convierte a Date).
  // metaOf(model) -> {pixel, amb} (opcional)
  function jornadaRows(a, metaOf) {
    const out = [];
    for (const m of a.order) {
      const s = a.models[m];
      if (!(s.ms > 0 || s.rep > 0 || s.sinRep > 0 || s.desc > 0)) continue;
      const meta = (typeof metaOf === 'function' && metaOf(m)) || {};
      out.push({ trab: 'X', day: a.day, model: m, pixel: meta.pixel || '', amb: meta.amb || '',
        tiles: s.rep, hours: s.hours, company: a.company,
        entregado: s.rep + s.sinRep, modXls: null, descartados: s.desc, src: 'fichaje', jornadaId: a.jornadaId });
    }
    return out;
  }
  // Clave de coincidencia exacta fila Excel ↔ fila generada (HORAS a 2 decimales)
  const rowKey = (r, dayStr) => [dayStr, normModel(r.model), normCompany(r.company), Number(r.tiles) || 0, round2(r.hours).toFixed(2),
    r.entregado === null || r.entregado === undefined ? '' : Number(r.entregado), Number(r.descartados) || 0].join('|');

  // Tras cargar un Excel: devuelve el jornadaId a las filas que coinciden con las generadas.
  // rows: filas cargadas (sin src) · generated: filas de jornadas cerradas · dayStrOf(row) -> 'AAAA-MM-DD'
  // Devuelve {rows (copias), matched, missing[{jornadaId, day, model}], extra[{index, day, model}]}
  function retagRows(rows, generated, dayStrOf) {
    const ds = r => (r.day ? r.day : dayStrOf(r));
    const pool = new Map();
    const out = rows.map((r, i) => {
      const c = { ...r };
      if (!c.src) { const k = rowKey(c, ds(c)); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(i); }
      return c;
    });
    let matched = 0; const missing = [];
    for (const g of generated) {
      const k = rowKey(g, g.day), q = pool.get(k);
      if (q && q.length) { const i = q.shift(); out[i].src = 'fichaje'; out[i].jornadaId = g.jornadaId; out[i].trab = 'X'; matched++; }
      else missing.push({ jornadaId: g.jornadaId, day: g.day, model: g.model });
    }
    const fichDays = new Set(generated.map(g => g.day));
    const extra = [];
    out.forEach((r, i) => { if (!r.src && r.model && fichDays.has(ds(r))) extra.push({ index: i, day: ds(r), model: r.model }); });
    return { rows: out, matched, missing, extra };
  }
  // Sustituye solo las filas de esa jornada (nunca las de otras jornadas del mismo día)
  const replaceJornadaRows = (rows, jornadaId, newRows) => rows.filter(r => r.jornadaId !== jornadaId).concat(newRows);
  // Filas del Excel (sin src) de un día: candidatas a la confirmación de volcado
  const excelRowsOfDay = (rows, dayStr, dayStrOf) => rows.filter(r => !r.src && r.model && (r.day || dayStrOf(r)) === dayStr);

  // ---------------- volcado a Datos (por jornada y aditivo) ----------------
  // Solo se tocan las filas con el jornadaId de las jornadas que se vuelcan: las de otras jornadas (también del
  // mismo día) y las de otros días no cambian. Las filas del Excel (sin marca) de un día con fichaje:
  //   · si coinciden exactamente con una fila generada, la fila generada ocupa su lugar (no se duplica);
  //   · si no coinciden, se pregunta: «sumar» (se mantienen y se suman), «sustituir» (se quitan) o «cancelar»
  //     (ese día no se vuelca). Las mantenidas se recuerdan en keep {día: [rowKey]} para no volver a preguntar,
  //     también tras exportar y recargar el Excel (la clave es su contenido).
  // opts: {metaOf(model) -> {pixel, amb}, dayStrOf(row) -> 'AAAA-MM-DD', keep}
  const multisetEq = (a, b) => a.length === b.length && JSON.stringify(a.slice().sort()) === JSON.stringify(b.slice().sort());
  const volcable = a => !!(a && !a.open && a.day && a.day >= START_ISO);
  // jids: jornadas a volcar (null = todas las cerradas, más las filas huérfanas de jornadas borradas o reabiertas)
  function volcadoPlan(rows, analyses, jids, opts) {
    opts = opts || {};
    const ds = r => (r.day ? r.day : opts.dayStrOf(r)), keep = opts.keep || {};
    const byId = new Map(analyses.map(a => [a.jornadaId, a]));
    let list = jids ? [...new Set(jids)] : analyses.filter(volcable).map(a => a.jornadaId);
    if (!jids) for (const r of rows) if (r.src === 'fichaje' && r.jornadaId && !list.includes(r.jornadaId)) list.push(r.jornadaId);
    const items = list.map(jid => {
      const a = byId.get(jid), gen = volcable(a) ? jornadaRows(a, opts.metaOf) : [];
      const cur = [];
      rows.forEach((r, i) => { if (r.src === 'fichaje' && r.jornadaId === jid) cur.push(i); });
      const same = multisetEq(cur.map(i => rowKey(rows[i], ds(rows[i]))), gen.map(g => rowKey(g, g.day)));
      return { jornadaId: jid, day: a ? a.day : (cur.length ? ds(rows[cur[0]]) : null), company: a ? a.company : '',
        start: a ? a.start : NaN, end: a ? a.end : NaN, open: a ? a.open : false, exists: !!a, gen, current: cur, same };
    });
    // Filas del Excel de los días que cambian: las que coinciden se adoptan; las demás (salvo las mantenidas) se preguntan
    const conflicts = [], adopt = [];
    const days = [...new Set(items.filter(it => !it.same && it.gen.length).map(it => it.day))].sort();
    for (const d of days) {
      const gens = items.filter(it => !it.same && it.day === d).flatMap(it => it.gen.map(g => ({ g, jid: it.jornadaId })));
      const pool = new Map();
      for (const x of gens) { const k = rowKey(x.g, d); if (!pool.has(k)) pool.set(k, []); pool.get(k).push(x.jid); }
      const kept = new Set(keep[d] || []), unmatched = [];
      rows.forEach((r, i) => {
        if (r.src || !r.model || ds(r) !== d) return;
        const k = rowKey(r, d), q = pool.get(k);
        if (q && q.length) adopt.push({ index: i, jornadaId: q.shift(), day: d });
        else if (!kept.has(k)) unmatched.push({ index: i, row: r, key: k });
      });
      if (unmatched.length) conflicts.push({ day: d, rows: unmatched, jornadaIds: [...new Set(gens.map(x => x.jid))],
        gen: gens.map(x => x.g) });
    }
    return { items, conflicts, adopt, pending: items.filter(it => !it.same).length };
  }
  // decisions: {día: 'sumar' | 'sustituir' | 'cancelar'} para los días con conflicto (sin decisión = cancelar)
  // opts.toRow(filaGenerada) -> fila de Datos (el escritorio pasa day → date). Devuelve {rows, keep, done, cancelled, ...}
  function applyVolcado(rows, plan, decisions, opts) {
    opts = opts || {};
    const dec = decisions || {}, toRow = opts.toRow || (r => r);
    const keep = JSON.parse(JSON.stringify(opts.keep || {}));
    const conflictDays = new Map(plan.conflicts.map(c => [c.day, c]));
    const cancelledDay = d => conflictDays.has(d) && !['sumar', 'sustituir'].includes(dec[d]);
    const todo = plan.items.filter(it => !it.same && !(it.gen.length && cancelledDay(it.day)));
    const cancelled = plan.items.filter(it => !it.same && it.gen.length && cancelledDay(it.day)).map(it => it.jornadaId);
    const doneIds = new Set(todo.map(it => it.jornadaId)), remove = new Set();
    for (const it of todo) it.current.forEach(i => remove.add(i));
    let adopted = 0, removedExcel = 0, keptExcel = 0;
    for (const a of plan.adopt) if (doneIds.has(a.jornadaId) && !remove.has(a.index)) { remove.add(a.index); adopted++; }
    for (const c of plan.conflicts) {
      if (cancelledDay(c.day)) continue;
      if (dec[c.day] === 'sustituir') { for (const x of c.rows) { remove.add(x.index); removedExcel++; } }
      else { keep[c.day] = [...new Set([...(keep[c.day] || []), ...c.rows.map(x => x.key)])]; keptExcel += c.rows.length; }
    }
    const added = todo.flatMap(it => it.gen.map(g => toRow({ ...g })));
    const out = rows.filter((_, i) => !remove.has(i)).concat(added);
    return { rows: out, keep, done: [...doneIds], cancelled, adopted, removedExcel, keptExcel,
      removedFichaje: todo.reduce((s, it) => s + it.current.length, 0), added: added.length };
  }
  // Estado del volcado de cada jornada: 'volcada' | 'pendiente' | 'sin_filas' (cerrada pero sin modelo) | 'abierta'
  function volcadoStatus(rows, analyses, opts) {
    const plan = volcadoPlan(rows, analyses, null, opts), st = {};
    for (const a of analyses) st[a.jornadaId] = a.open ? 'abierta' : !volcable(a) ? 'fuera' : 'volcada';
    // pendiente = sus filas en Datos no son las que genera hoy (faltan, sobran o se editaron); huerfana = filas de una jornada que ya no existe
    for (const it of plan.items) st[it.jornadaId] = !it.same ? (it.exists ? 'pendiente' : 'huerfana') : it.gen.length ? 'volcada' : 'sin_filas';
    return { status: st, pending: plan.items.filter(it => !it.same).map(it => it.jornadaId) };
  }

  // ---------------- indicadores ----------------
  const dev = (v, ref) => (v === null || !(ref > 0)) ? null : (v - ref) / ref * 100;
  // hours = tiempo de jornada (con pausas): manda en €/hora y en tiempo por tile. effHours = efectivo (secundario).
  // Tiempo por tile = horas ÷ REPARADOS (como en Costes); sin reparados → null («—»). Tiles/hora = reparados ÷ horas.
  function statsOf(hours, rep, sinRep, desc, fact, jornadaH, baremo, effHours) {
    const ent = rep + sinRep, bh = jornadaH > 0 ? baremo / jornadaH : 0;
    const eurHora = hours > 0 ? fact / hours : null;
    return { hours: round2(hours), effHours: round2(effHours || 0), rep, sinRep, desc, ent, fact,
      repHora: hours > 0 ? rep / hours : null,
      horasPorTile: rep > 0 ? hours / rep : null,
      eurHora, devHora: dev(eurHora, bh) };
  }
  // cfg: {priceOf(model) -> €/tile, jornada (h/día), baremo (€/día)}
  function sumModels(analyses, cfg) {
    const acc = {}, order = [];
    for (const a of analyses) for (const m of a.order) {
      if (!acc[m]) { acc[m] = { ms: 0, effMs: 0, rep: 0, sinRep: 0, desc: 0 }; order.push(m); }
      const x = a.models[m];
      acc[m].ms += x.ms; acc[m].effMs += x.effMs || 0; acc[m].rep += x.rep; acc[m].sinRep += x.sinRep || 0; acc[m].desc += x.desc;
    }
    const models = {}; let H = 0, E = 0, R = 0, S = 0, D = 0, F = 0;
    for (const m of order) {
      const s = acc[m], h = s.ms / 3600000, e = s.effMs / 3600000, f = s.rep * (Number(cfg.priceOf(m)) || 0);
      models[m] = statsOf(h, s.rep, s.sinRep, s.desc, f, cfg.jornada, cfg.baremo, e); H += h; E += e; R += s.rep; S += s.sinRep; D += s.desc; F += f;
    }
    return { order, models, total: statsOf(H, R, S, D, F, cfg.jornada, cfg.baremo, E) };
  }
  // Por jornada: €/día EQUIVALENTE = €/hora × horas de jornada de Ajustes
  function jornadaStats(a, cfg) {
    const r = sumModels([a], cfg), t = r.total;
    t.eurDiaEquiv = t.eurHora !== null ? t.eurHora * cfg.jornada : null;
    t.devDiaEquiv = dev(t.eurDiaEquiv, cfg.baremo);
    return r;
  }
  // Por día (suma sus jornadas): €/día REAL = facturación del día (el día cuenta una vez)
  function dayStats(analyses, cfg) {
    const r = sumModels(analyses, cfg), t = r.total;
    t.eurDia = t.fact; t.devDia = dev(t.eurDia, cfg.baremo); t.jornadas = analyses.length;
    return r;
  }

  // Resumen de un periodo: €/día MEDIO = facturación ÷ días trabajados (días con alguna jornada), frente al baremo.
  // Suma también la duración y el efectivo de las jornadas.
  function periodStats(analyses, cfg) {
    const r = sumModels(analyses, cfg), t = r.total;
    t.dias = new Set(analyses.map(a => a.day).filter(Boolean)).size;
    t.jornadas = analyses.length;
    t.durMs = analyses.reduce((s, a) => s + (a.durMs || 0), 0);
    t.effMs = analyses.reduce((s, a) => s + (a.effMs || 0), 0);
    t.eurDiaMedio = t.dias ? t.fact / t.dias : null;
    t.devDiaMedio = dev(t.eurDiaMedio, cfg.baremo);
    return r;
  }

  // Tiempo por tile de referencia: media acumulada por modelo en las jornadas dadas (el periodo cargado).
  // Cada jornada imputa su tiempo a los tiles que entrega; un tile empezado un día y entregado al siguiente
  // no necesita ajuste: la media lo compensa. Las horas «sin asignar» (modelo sin reparados) cuentan en el numerador.
  // Devuelve {modelo: {hours, rep, sinRep, desc, ent, jornadas, horasPorTile = horas ÷ reparados}}
  function modelAverages(analyses) {
    const out = {};
    for (const a of analyses) for (const m of a.order) {
      const s = a.models[m], o = out[m] || (out[m] = { ms: 0, rep: 0, sinRep: 0, desc: 0, jornadas: 0 });
      o.ms += s.ms; o.rep += s.rep; o.sinRep += s.sinRep || 0; o.desc += s.desc; o.jornadas++;
    }
    for (const m in out) {
      const o = out[m]; o.hours = o.ms / 3600000; o.ent = o.rep + o.sinRep;
      o.horasPorTile = o.rep > 0 ? o.hours / o.rep : null;
    }
    return out;
  }

  // ---------------- contadores en vivo ----------------
  // Todo sale de las horas de los eventos y de «now»: nunca se acumulan ticks, así que los valores son
  // correctos tras bloquear la pantalla, dormir el equipo o recargar la página.
  // opts: {day ('AAAA-MM-DD', por defecto el de now), jornadaH (h de jornada de Ajustes), companyOf}
  function liveCounters(events, now, opts) {
    opts = opts || {};
    const nowDate = now ? new Date(now) : new Date(), nowMs = nowDate.getTime();
    const day = opts.day || dayOf(nowDate);
    const A = analyzeAll(events, { now: nowDate, companyOf: opts.companyOf });
    const openJ = A.jornadas.filter(j => j.open), j = openJ[openJ.length - 1] || null;
    const ofDay = A.jornadas.filter(x => x.day === day || x.open);
    const live = events.filter(e => !e.deleted);
    let model = '', modelSince = null, pause = null;
    if (j) {
      // Modelo actual: el del último tramo (elegido a mano o deducido de las entregas) y desde cuándo
      const seg = j.segments[j.segments.length - 1];
      if (seg) { model = seg.model; modelSince = seg.start; }
      pause = j.pauses.find(p => p.open) || null;
    }
    const ids = new Set(ofDay.map(x => x.jornadaId));
    const entregas = live.filter(e => e.type === 'entrega' && ids.has(e.jornadaId));
    const rep = entregas.filter(e => e.result === 'reparado').reduce((s, e) => s + e.qty, 0);
    const sinRep = entregas.filter(e => e.result === 'sin_reparar').reduce((s, e) => s + e.qty, 0);
    const desc = entregas.filter(e => e.result === 'descartado').reduce((s, e) => s + e.qty, 0);
    const lastEnt = entregas.reduce((mx, e) => Math.max(mx, msOf(e.ts)), -Infinity);
    const dayMs = ofDay.reduce((s, x) => s + x.durMs, 0);
    const jh = Number(opts.jornadaH) || 0;
    return {
      now: nowMs, day, state: !j ? 'sin' : pause ? 'pausa' : 'marcha',
      jornada: j, company: j ? j.company : '', jornadaStart: j ? j.start : null,
      jornadaMs: j ? j.durMs : 0,                                      // jornada actual, con pausas
      jornadaEffMs: j ? j.effMs : 0,                                   // efectiva (sin pausas)
      pauseMs: j ? j.pauseMs : 0, pauseSince: pause ? pause.start : null,
      dayMs, jornadasHoy: ofDay.length,                                // acumulado del día (suma de jornadas)
      model, modelSince, modelMs: modelSince !== null ? Math.max(0, nowMs - modelSince) : 0,
      modelJornadaMs: j && model && j.models[model] ? j.models[model].ms : 0,
      rep, sinRep, desc, ent: rep + sinRep,
      tilesHora: dayMs > 0 ? rep / (dayMs / 3600000) : null,                // reparados ÷ horas
      horasPorTile: rep > 0 ? (dayMs / 3600000) / rep : null,

      lastEntrega: isFinite(lastEnt) ? lastEnt : null, sinceEntregaMs: isFinite(lastEnt) ? Math.max(0, nowMs - lastEnt) : null,
      progress: jh > 0 ? dayMs / (jh * 3600000) : null,
      analysis: A
    };
  }

  // ---------------- importación ----------------
  const contentKey = ev => JSON.stringify(CONTENT_FIELDS.map(k => ev[k] === undefined ? null : ev[k]));
  // Compara eventos entrantes con los locales. status: nuevo | existe | difiere; newer: entrante | local | igual
  function compareImport(localEvents, incoming) {
    const local = new Map(localEvents.map(e => [e.id, e]));
    const byId = new Map(), dupIds = [];
    for (const ev of incoming) {           // id repetido en el archivo: se queda la versión más alta
      const prev = byId.get(ev.id);
      if (prev) { dupIds.push(ev.id); if (newerOf(ev, prev) !== 'b') continue; }
      byId.set(ev.id, ev);
    }
    const items = [...byId.values()].map(ev => {
      const l = local.get(ev.id);
      if (!l) return { ev, local: null, status: 'nuevo', newer: 'entrante' };
      if (contentKey(l) === contentKey(ev)) return { ev, local: l, status: 'existe', newer: 'igual' };
      const n = newerOf(ev, l);
      return { ev, local: l, status: 'difiere', newer: n === 'a' ? 'entrante' : n === 'b' ? 'local' : 'igual' };
    });
    return { items, dupIds: [...new Set(dupIds)] };
  }
  // 'a' si a es más reciente, 'b' si lo es b, '' si empatan (updatedAt y luego rev)
  function newerOf(a, b) {
    const d = msOf(a.updatedAt) - msOf(b.updatedAt);
    if (d) return d > 0 ? 'a' : 'b';
    if (a.rev !== b.rev) return a.rev > b.rev ? 'a' : 'b';
    return '';
  }
  // Lo borrado no reaparece: un evento borrado en local no se sustituye por una versión entrante no borrada
  // (aunque se marque a mano). Sí se acepta que el entrante también esté borrado y sea más reciente.
  const importBlocked = it => !!(it.status === 'difiere' && it.local && it.local.deleted && !it.ev.deleted);
  // Selección por modo: «nuevos» marca los nuevos; «reemplazar» también los que difieren Y donde el entrante es más
  // reciente (si el local es más reciente o empatan, no se marca: hay que marcarlo a mano); «saltar» no marca nada.
  // «existe» y los bloqueados nunca.
  const defaultSelection = (items, mode) => mode === 'saltar' ? new Set() : new Set(items
    .filter(it => !importBlocked(it) && (it.status === 'nuevo' || (mode === 'reemplazar' && it.status === 'difiere' && it.newer === 'entrante'))).map(it => it.ev.id));
  // Aplica los seleccionados. Los que ya existen y los bloqueados nunca se tocan. Devuelve {events, added, replaced, touchedJornadas}
  function applyImport(localEvents, items, selected) {
    const out = localEvents.map(e => ({ ...e })), idx = new Map(out.map((e, i) => [e.id, i]));
    let added = 0, replaced = 0; const touched = new Set();
    for (const it of items) {
      if (it.status === 'existe' || importBlocked(it) || !selected.has(it.ev.id)) continue;
      if (it.status === 'nuevo') { out.push({ ...it.ev }); added++; }
      else { out[idx.get(it.ev.id)] = { ...it.ev }; replaced++; if (it.local) touched.add(it.local.jornadaId); }
      touched.add(it.ev.jornadaId);
    }
    return { events: out, added, replaced, touchedJornadas: [...touched] };
  }
  // Recuentos de la previsualización: por estado y de lo marcado
  function importCounts(items, selected) {
    const c = { total: items.length, nuevo: 0, existe: 0, difiere: 0, bloqueados: 0, marcados: 0, nuevosMarcados: 0, reemplazos: 0 };
    for (const it of items) {
      c[it.status]++;
      if (importBlocked(it)) c.bloqueados++;
      if (it.status !== 'existe' && !importBlocked(it) && selected.has(it.ev.id)) { c.marcados++; if (it.status === 'nuevo') c.nuevosMarcados++; else c.reemplazos++; }
    }
    return c;
  }
  // Solapes NUEVOS entre jornadas de dispositivos distintos que provocaría aplicar la selección (los que ya había
  // antes de importar no se cuentan). Devuelve [{a, b, day, start, end, ms, ja, jb}] con los datos de cada jornada.
  function importOverlaps(localEvents, items, selected, opts) {
    const key = o => [o.a, o.b].sort().join('|');
    const before = new Set(analyzeAll(localEvents, opts).overlaps.map(key));
    const after = analyzeAll(applyImport(localEvents, items, selected).events, opts);
    const by = new Map(after.jornadas.map(j => [j.jornadaId, j]));
    const info = j => ({ jornadaId: j.jornadaId, day: j.day, company: j.company, dev: j.dev, start: j.start, end: j.end, open: j.open });
    return after.overlaps.filter(o => o.crossDevice && !before.has(key(o))).map(o => {
      const ja = by.get(o.a), jb = by.get(o.b), s = Math.max(ja.start, jb.start), e = Math.min(ja.end, jb.end);
      return { a: o.a, b: o.b, day: ja.day, start: s, end: e, ms: Math.max(0, e - s), ja: info(ja), jb: info(jb) };
    });
  }
  // Agrupa la previsualización por día y, dentro, por jornada
  function groupImport(items) {
    const days = new Map();
    for (const it of items) {
      const d = it.ev.day, j = it.ev.jornadaId;
      if (!days.has(d)) days.set(d, new Map());
      if (!days.get(d).has(j)) days.get(d).set(j, []);
      days.get(d).get(j).push(it);
    }
    return [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([day, js]) => ({ day, jornadas: [...js.entries()].map(([jornadaId, list]) => ({ jornadaId, items: list.sort((x, y) => evSort(x.ev, y.ev)) })) }));
  }

  return {
    SCHEMA, VERSION, KINDS, TYPES, RESULTS, START_ISO, CONTENT_FIELDS,
    round2, splitRound, normCompany, normModel, isDay, localIso, dayOf, newId,
    makeDevice, emptyStore, makeEvent, makeJornadaEvent, editEvent, deleteEvent,
    validateEvent, validateFile, buildCatalog, validateCatalog, buildExport, catalogReport, filterEventsByDays, exportFileName, checkGenerated,
    normName, pixelOf, similarNames, proposeCompanies,
    groupJornadas, analyzeJornada, analyzeAll, resolveDayImput, findOverlaps, dayTimeline, missingDays,
    jornadaRows, rowKey, retagRows, replaceJornadaRows, excelRowsOfDay, volcadoPlan, applyVolcado, volcadoStatus,
    jornadaStats, dayStats, periodStats, modelAverages, liveCounters,
    contentKey, compareImport, newerOf, importBlocked, defaultSelection, applyImport, importCounts, importOverlaps, groupImport
  };
});
