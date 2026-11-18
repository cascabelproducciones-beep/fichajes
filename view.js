// Vistas de la mini app: funciones puras que devuelven HTML (texto). No tocan el DOM, así se prueban en Node.
// Pensadas para pantalla estrecha (375 px): nada de tablas anchas; el resumen por modelo son tarjetas apiladas
// cuyas cifras se parten en varias líneas, y la barra de tiempo va en porcentajes.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./fichaje-core.js'));
  else root.FichajeView = factory(root.FichajeCore);
})(typeof self !== 'undefined' ? self : this, function (F) {
  'use strict';

  const pad = n => String(n).padStart(2, '0');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hm = ms => { const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const dur = ms => { const m = Math.max(0, Math.round(ms / 60000)); return Math.floor(m / 60) + ' h ' + pad(m % 60) + ' min'; };
  const durS = ms => { const m = Math.max(0, Math.round(ms / 60000)); return Math.floor(m / 60) + ':' + pad(m % 60) + ' h'; };
  const clock = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60); };
  const num = (n, d) => (Number(n) || 0).toLocaleString('es-ES', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 });
  // Tiempo por tile: horas ÷ reparados, en minutos si es menos de una hora
  const perTile = h => { if (h === null || h === undefined || !isFinite(h)) return '—'; const m = h * 60; return m < 60 ? num(m, m < 10 ? 1 : 0) + ' min' : dur(h * 3600000); };
  const DOW = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
  const dayLabel = iso => { const [y, m, d] = iso.split('-').map(Number), dt = new Date(y, m - 1, d); return `${DOW[dt.getDay()]} ${pad(d)}/${pad(m)}/${y}`; };
  const RES = { reparado: 'Reparado', sin_reparar: 'Sin reparar', descartado: 'Descartado' };
  const LABEL = { jornada_inicio: 'Inicio de jornada', jornada_fin: 'Fin de jornada', pausa_inicio: 'Pausa', pausa_fin: 'Fin de pausa', modelo: 'Cambio de modelo', entrega: 'Entrega', imputacion: 'Horas imputadas' };
  const CFG = { priceOf: () => 0, jornada: 0, baremo: 0 };   // la app del móvil no maneja precios

  // ---------------- panel de estado en vivo ----------------
  // C = FichajeCore.liveCounters(...). Verde = en marcha, ámbar = en pausa, gris = sin jornada.
  function statusPanel(C, now) {
    if (C.state === 'sin') {
      return `<section class="panel st-sin" id="panel" aria-live="off"><div class="st-top"><span class="st-dot"></span><b>SIN JORNADA</b></div>
        <div class="st-sub">Hoy: ${num(C.jornadasHoy)} jornada(s) · ${dur(C.dayMs)} · ${num(C.rep)} reparados</div></section>`;
    }
    const paused = C.state === 'pausa';
    return `<section class="panel ${paused ? 'st-pausa' : 'st-marcha'}" id="panel" aria-live="off">
      <div class="st-top"><span class="st-dot"></span><b>${paused ? 'EN PAUSA' : 'EN MARCHA'}</b><span class="st-co">${esc(C.company)}</span></div>
      <div class="st-clock">${clock(C.jornadaMs)}</div>
      <div class="st-sub">Jornada desde las ${hm(C.jornadaStart)}${C.pauseMs ? ` · pausas ${dur(C.pauseMs)}` : ''}${paused ? ` · en pausa desde las ${hm(C.pauseSince)} (${clock(now - C.pauseSince)})` : ''}</div>
      <div class="st-model">${C.model ? `<b>${esc(C.model)}</b> <span class="dim">desde las ${hm(C.modelSince)} · ${dur(C.modelMs)}</span>` : '<span class="dim">Aún sin modelo: elige uno al entregar o cambia de modelo</span>'}</div>
      <div class="st-cnt">
        <div><b>${num(C.rep)}</b><span>reparados</span></div>
        <div><b>${num(C.sinRep)}</b><span>sin reparar</span></div>
        <div><b>${num(C.desc)}</b><span>descartados</span></div>
        <div><b>${num(C.ent)}</b><span>entregados</span></div>
      </div>
      <div class="st-sub">${C.sinceEntregaMs !== null ? `Última entrega hace ${dur(C.sinceEntregaMs)}` : 'Aún sin entregas hoy'}${C.tilesHora !== null ? ` · ${num(C.tilesHora, 2)} tiles/h` : ''}</div></section>`;
  }

  // ---------------- barra de tiempo de los día ----------------
  function timeline(js) {
    const T = F.dayTimeline(js); if (!T.span) return '';
    const H = 3600000, s0 = Math.floor(T.span.start / H) * H, s1 = Math.max(s0 + H, Math.ceil(T.span.end / H) * H), W = s1 - s0;
    const pos = (a, b) => `left:${((a - s0) / W * 100).toFixed(2)}%;width:${Math.max(0.5, (b - a) / W * 100).toFixed(2)}%`;
    const inOv = new Set(T.overlaps.flatMap(x => [x.a, x.b]));
    const bar = T.jornadas.map(j => `<i class="tl-j${j.open ? ' open' : ''}${inOv.has(j.jornadaId) ? ' ov' : ''}" style="${pos(j.start, j.end)}"></i>`).join('')
      + T.gaps.map(g => `<i class="tl-gap" style="${pos(g.start, g.end)}"></i>`).join('')
      + T.overlaps.map(x => `<i class="tl-ov" style="${pos(x.start, x.end)}"></i>`).join('');
    const name = id => { const j = T.jornadas.find(x => x.jornadaId === id); return j ? `${esc(j.company)} ${hm(j.start)}` : '¿?'; };
    const notes = [
      ...T.overlaps.map(x => `<span class="tl-n ov">⚠ Solape ${hm(x.start)}–${hm(x.end)} · ${durS(x.ms)} (${name(x.a)} y ${name(x.b)}${x.crossDevice ? ', dos dispositivos' : ''})</span>`),
      ...T.gaps.map(g => `<span class="tl-n">↔ Hueco ${hm(g.start)}–${hm(g.end)} · ${durS(g.ms)}</span>`)];
    return `<div class="tl"><div class="tl-bar" role="img" aria-label="Jornadas del día de ${hm(s0)} a ${hm(s1)}">${bar}</div>
      <div class="tl-axis"><span>${hm(s0)}</span><span>${hm(s1)}</span></div>${notes.length ? `<div class="tl-notes">${notes.join('')}</div>` : ''}</div>`;
  }

  // ---------------- resumen por modelo: tarjetas apiladas (sin tabla) ----------------
  // D = FichajeCore.dayStats(...) o jornadaStats(...): {order, models:{m:{hours, rep, sinRep, desc, horasPorTile}}}
  function modelCards(D, notes) {
    if (!D.order.length) return '<div class="dim small">Sin modelos trabajados.</div>';
    return D.order.map(m => {
      const s = D.models[m];
      return `<div class="mcard"><div class="mc-h"><b class="mc-name">${esc(m)}</b><span class="mc-hours">${num(s.hours, 2)} h</span></div>
        <div class="mc-chips"><span><b>${num(s.rep)}</b> reparados</span><span><b>${num(s.sinRep)}</b> sin reparar</span><span><b>${num(s.desc)}</b> descartados</span></div>
        <div class="mc-t">Tiempo por tile: <b>${perTile(s.horasPorTile)}</b>${notes && notes[m] ? `<div class="dim small">${notes[m].map(esc).join(' · ')}</div>` : ''}</div></div>`;
    }).join('');
  }
  // Notas de imputación de las jornadas de un día, por modelo
  function impNotes(js) {
    const n = {}, add = (m, t) => (n[m] = n[m] || []).push(t);
    for (const j of js) for (const x of j.imputations) {
      if (x.to) { add(x.from, `horas imputadas a ${x.to}`); add(x.to, `+${dur(x.ms)} imputadas de ${x.from}`); }
      else add(x.from, 'horas sin asignar: solo cuentan en la media');
    }
    return n;
  }

  // ---------------- una jornada: línea contraída y detalle ----------------
  // j = análisis; events = eventos vivos de esa jornada; o = {open, expanded, devId, overlap}
  function jornadaItem(j, events, o) {
    const endDays = j.open ? 0 : Math.round((new Date(new Date(j.end).getFullYear(), new Date(j.end).getMonth(), new Date(j.end).getDate()) - new Date(+j.day.slice(0, 4), +j.day.slice(5, 7) - 1, +j.day.slice(8, 10))) / 86400000);
    const endTxt = j.open ? '<span class="tag-curso">en curso</span>' : hm(j.end) + (endDays > 0 ? `<small>+${endDays} día${endDays > 1 ? 's' : ''}</small>` : '');
    const rep = j.order.reduce((s, m) => s + j.models[m].rep, 0), ent = rep + j.order.reduce((s, m) => s + j.models[m].sinRep, 0);
    const hard = j.warnings.filter(w => !w.soft);
    const meta = [o.overlap ? '<span class="tag-warn">⚠ SOLAPE</span>' : '', j.dev === o.devId ? 'este móvil' : 'otro dispositivo',
      hard.length ? `<span class="tag-warn">⚠ ${hard.length} aviso(s)</span>` : ''].filter(Boolean).join(' · ');
    const impBtn = !j.open && j.pendingImput.length ? `<button class="mini warn" data-act="imputar" data-jid="${esc(j.jornadaId)}">↪ Imputar horas</button>` : '';
    let html = `<article class="jor${j.open ? ' open' : ''}${o.overlap ? ' ovl' : ''}" data-jid="${esc(j.jornadaId)}">
      <button class="jor-line" data-act="fold" data-jid="${esc(j.jornadaId)}" aria-expanded="${!!o.expanded}">
        <span class="tbox"><b>${hm(j.start)}</b><b class="e">${endTxt}</b></span>
        <span class="jbody"><span class="jtop"><b>${esc(j.company || '¿sin empresa?')}</b> · ${durS(j.durMs)}</span>
          <span class="jsub">${num(rep)} reparados · ${num(ent)} entregados</span><span class="jsub">${meta}</span></span>
        <span class="chev">${o.expanded ? '▾' : '▸'}</span></button>`;
    if (hard.length) html += `<div class="jwarn">${hard.map(w => '⚠ ' + esc(w.msg)).join('<br>')}</div>`;
    if (impBtn) html += `<div class="jact">${impBtn}</div>`;
    if (o.expanded) {
      const D = F.jornadaStats(j, CFG);
      html += `<div class="jdet">${modelCards(D, impNotes([j]))}
        <div class="evl-t">Fichajes de la jornada</div>${eventList(j, events)}</div>`;
    }
    return html + '</article>';
  }
  function eventList(j, events) {
    const ord = { jornada_inicio: 0, modelo: 1, pausa_fin: 1, entrega: 1, pausa_inicio: 1, jornada_fin: 2, imputacion: 3 };
    const list = events.slice().sort((a, b) => (Date.parse(a.ts) - Date.parse(b.ts)) || ((ord[a.type] ?? 9) - (ord[b.type] ?? 9)));
    return `<ul class="evl">${list.map(e => {
      const t = Date.parse(e.ts), nd = F.dayOf(new Date(t)) !== j.day ? ' <small>+1 día</small>' : '';
      let what = LABEL[e.type] || e.type;
      if (e.type === 'jornada_inicio') what += ' · ' + esc(e.company);
      else if (e.type === 'entrega') what = `${esc(RES[e.result] || e.result)} ×${num(e.qty)} · ${esc(e.model)}`;
      else if (e.type === 'modelo') what += ' · ' + esc(e.model);
      else if (e.type === 'imputacion') what += ` · ${esc(e.model)} → ${e.toModel ? esc(e.toModel) : 'sin asignar'}`;
      return `<li><time>${hm(t)}${nd}</time><span>${what}</span></li>`;
    }).join('')}</ul>`;
  }

  // ---------------- un día completo ----------------
  // js = jornadas (análisis) del día; byJ = Map(jornadaId → eventos vivos); o = {fold:Set, devId, ovIds:Set, today}
  function dayBlock(day, js, byJ, o) {
    const D = F.dayStats(js, CFG), T = D.total, durMs = js.reduce((s, j) => s + j.durMs, 0);
    const head = `<header class="day-h"><div><b>${o.today ? '<span class="tag-hoy">HOY</span> ' : ''}${dayLabel(day)}</b>
      <div class="dim small">${js.length} jornada(s) · ${dur(durMs)}</div></div>
      <div class="day-k"><b>${num(T.rep)}</b> rep. · <b>${num(T.ent)}</b> ent.${T.repHora !== null ? `<div class="dim small">${num(T.repHora, 2)} tiles/h</div>` : ''}</div></header>`;
    const items = js.map(j => jornadaItem(j, byJ.get(j.jornadaId) || [], { expanded: o.fold.has(j.jornadaId), devId: o.devId, overlap: o.ovIds && o.ovIds.has(j.jornadaId) })).join('');
    return `<section class="day">${head}${timeline(js)}${items}
      <details class="daysum"><summary>Resumen del día por modelo</summary>${modelCards(D, impNotes(js))}</details></section>`;
  }


  // ---------------- solapes entre jornadas de dispositivos distintos ----------------
  // A = FichajeCore.analyzeAll(...): lista cada tramo en que dos jornadas de dispositivos distintos se pisan
  function overlapBanner(A) {
    const by = new Map(A.jornadas.map(j => [j.jornadaId, j])), list = A.overlaps.filter(o => o.crossDevice);
    if (!list.length) return '';
    const name = j => j ? `${esc(j.company || '¿?')} ${hm(j.start)}–${j.open ? 'en curso' : hm(j.end)}` : '¿?';
    return `<div class="warnbox" role="alert"><b>⚠ Jornadas que se pisan entre dispositivos</b>${list.map(o => {
      const a = by.get(o.a), b = by.get(o.b);
      const ms = a && b ? Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start)) : 0;     // el núcleo no da la duración del solape
      return `<div>· ${a ? dayLabel(a.day) : ''}: ${name(a)} y ${name(b)} · ${durS(ms)} en común</div>`;
    }).join('')}<div class="dim small">Revísalo y corrige las horas en el escritorio (o borra aquí el último fichaje).</div></div>`;
  }

  // ---------------- previsualización de una importación de eventos ----------------
  // P = {fileInfo:{kind, device, exportedAt, invalid}, counts, mode, groups, selected:Set, overlaps, canAdopt, adopt, busy}
  function importPreview(P, F2) {
    const c = P.counts, fi = P.fileInfo;
    const kindTxt = fi.kind === 'backup' ? 'Copia de seguridad' : 'Eventos exportados';
    const groups = P.groups.map(g => `<div class="ig-day"><div class="evl-t">${dayLabel(g.day)}</div>${g.jornadas.map(jg => {
      const ini = jg.items.find(it => it.ev.type === 'jornada_inicio'), sel = jg.items.filter(it => it.status !== 'existe' && !F2.importBlocked(it));
      const marked = sel.filter(it => P.selected.has(it.ev.id)).length, n = { nuevo: 0, existe: 0, difiere: 0 };
      for (const it of jg.items) n[it.status]++;
      const blocked = jg.items.filter(F2.importBlocked).length;
      const chips = [n.nuevo ? `${n.nuevo} nuevos` : '', n.existe ? `${n.existe} ya existen` : '', n.difiere ? `${n.difiere} difieren` : '', blocked ? `${blocked} borrados aquí (no reaparecen)` : ''].filter(Boolean).join(' · ');
      return `<label class="ig-j${sel.length ? '' : ' off'}"><input type="checkbox" data-impj="${esc(jg.jornadaId)}"${marked === sel.length && sel.length ? ' checked' : ''}${sel.length ? '' : ' disabled'}>
        <span><b>${ini ? hm(Date.parse(ini.ev.ts)) + ' · ' + esc(ini.ev.company) : 'Jornada sin inicio'}</b><span class="jsub">${jg.items.length} evento(s) · ${chips}</span></span></label>`;
    }).join('')}</div>`).join('');
    const ov = P.overlaps.length ? `<div class="warnbox"><b>⚠ Al importar se pisarían jornadas de dispositivos distintos</b>${P.overlaps.map(o =>
      `<div>· ${dayLabel(o.day)}: ${esc(o.ja.company)} ${hm(o.ja.start)}–${hm(o.ja.end)} y ${esc(o.jb.company)} ${hm(o.jb.start)}–${hm(o.jb.end)} · ${durS(o.ms)}</div>`).join('')}
      <div class="dim small">Puedes importar igualmente: quedará como aviso para corregirlo.</div></div>` : '';
    return `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="imp-t"><h2 id="imp-t">⇪ Importar eventos</h2>
      <p class="dim small">${kindTxt}${fi.device ? ' de «' + esc(fi.device.name || 'dispositivo') + '»' : ''}${fi.exportedAt ? ' · exportado el ' + esc(String(fi.exportedAt).slice(0, 10)) : ''}.</p>
      <div class="st-cnt cnt3"><div><b>${num(c.nuevo)}</b><span>nuevos</span></div><div><b>${num(c.existe)}</b><span>ya existen</span></div><div><b>${num(c.difiere)}</b><span>difieren</span></div></div>
      ${fi.invalid ? `<p class="bad small">${num(fi.invalid)} evento(s) del archivo no son válidos y se han ignorado.</p>` : ''}
      ${c.bloqueados ? `<p class="dim small">${num(c.bloqueados)} evento(s) borrados en este móvil no se restauran.</p>` : ''}
      <label class="lbl" for="imp-mode">Qué marcar</label>
      <select id="imp-mode" data-impmode><option value="nuevos"${P.mode === 'nuevos' ? ' selected' : ''}>Solo los nuevos</option><option value="reemplazar"${P.mode === 'reemplazar' ? ' selected' : ''}>Nuevos y reemplazar los más recientes</option><option value="saltar"${P.mode === 'saltar' ? ' selected' : ''}>No marcar nada</option></select>
      ${ov}
      ${P.canAdopt ? `<label class="chk"><input type="checkbox" data-impadopt${P.adopt ? ' checked' : ''}><span>Esta copia es de <b>este móvil</b>: seguir como el mismo dispositivo</span></label>` : ''}
      <div class="ig">${groups || '<p class="dim">No hay nada que importar.</p>'}</div>
      <div class="two"><button class="big" data-act="impCancel"${P.busy ? ' disabled' : ''}>Cancelar</button><button class="big go" data-act="impApply"${P.busy || !c.marcados ? ' disabled' : ''}>Importar ${num(c.marcados)}</button></div></div></div>`;
  }
  // Confirmación de un catálogo nuevo: qué entra y qué cambia
  function catalogPreview(P) {
    const ch = P.changes, cat = P.catalog, warn = [];
    if (ch.removedCompanies.length) warn.push(`Empresas que ya no están: ${ch.removedCompanies.map(esc).join(', ')}.`);
    if (P.openCompanyGone) warn.push(`La jornada abierta es de ${esc(P.openCompanyGone)}, que no está en este catálogo.`);
    return `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="cat-t"><h2 id="cat-t">Catálogo a importar</h2>
      <div class="st-cnt cnt3"><div><b>${num(cat.companies.length)}</b><span>empresas</span></div><div><b>${num(cat.models.length)}</b><span>modelos</span></div><div><b>${P.hadCatalog ? num(ch.addedModels) : '—'}</b><span>modelos nuevos</span></div></div>
      <p class="dim small">${cat.exportedAt ? 'Generado el ' + esc(String(cat.exportedAt).slice(0, 10)) + '. ' : ''}Sin precios.${P.hadCatalog ? ` Cambios: ${num(ch.addedModels)} nuevos, ${num(ch.removedModels)} quitados, ${num(ch.movedModels)} cambian de empresa.` : ''}</p>
      ${warn.length ? `<div class="warnbox">${warn.map(w => '<div>⚠ ' + w + '</div>').join('')}</div>` : ''}
      <div class="two"><button class="big" data-act="catCancel">Cancelar</button><button class="big go" data-act="catApply">${P.hadCatalog ? 'Sustituir catálogo' : 'Usar este catálogo'}</button></div></div></div>`;
  }

  return { overlapBanner, importPreview, catalogPreview, esc, hm, dur, durS, clock, num, perTile, dayLabel, RES, LABEL, statusPanel, timeline, modelCards, jornadaItem, eventList, dayBlock };
});
