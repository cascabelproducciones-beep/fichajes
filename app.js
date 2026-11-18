// Mini app de fichaje: estado, pantallas Hoy | Histórico y acciones. La lógica está en logic.js, las vistas en view.js
// y el almacenamiento en store.js; aquí solo se conectan con el DOM.
(function () {
  'use strict';
  const F = FichajeCore, L = FichajeLogic, V = FichajeView, ST = FichajeStore, FL = FichajeFiles, FI = FichajeInstall;
  const $ = id => document.getElementById(id), esc = V.esc;
  const S = {
    store: null, dev: null, events: [], catalog: null, persist: null,
    tab: 'hoy', ui: { company: '', firstModel: '', model: '', entModel: '', qty: 1, result: 'reparado' },
    fold: new Set(), undo: null, imp: null, corr: null, delAsk: false, histLimit: 14, toast: '',
    // pestaña Archivos
    lastBackup: null, exp: { from: '', to: '' }, fileMsg: null, pick: null, catPrev: null, impPrev: null,
    // instalación, sin conexión y versión
    plat: { os: 'otro', installed: false, mustInstall: false, canInstallHere: false }, blocked: false,
    sw: 'comprobando…', waiting: null, installEvt: null, installHidden: false, updating: false
  };
  const BLOCK_MSG = 'En iPhone hay que abrir la app desde el icono instalado (Compartir → Añadir a pantalla de inicio). Hasta entonces no se puede fichar ni importar.';
  const env = () => ({ nav: navigator, doc: document, URL, Blob, File: typeof File === 'function' ? File : undefined });
  let toastTimer = null;

  // ---------------- mensajes y guardado ----------------
  function toast(msg) {
    S.toast = msg; const el = $('toast'); if (!el) return;
    el.textContent = msg; el.hidden = !msg; clearTimeout(toastTimer);
    if (msg) toastTimer = setTimeout(() => { S.toast = ''; el.hidden = true; }, 6000);
  }
  // Guarda lo que devuelve una acción de logic.js; si falla no cambia nada en pantalla
  async function commit(r) {
    if (S.blocked) { toast(BLOCK_MSG); return false; }
    if (r.error) { toast(r.error); return false; }
    try { await S.store.putEvents(r.put); }
    catch (e) { console.error(e); toast('No se pudo guardar el fichaje: ' + (e && e.message || e)); return false; }
    S.events = L.apply(S.events, r.put); toast(''); render(); return true;
  }
  const dev = () => S.dev.id;
  const info = () => L.openInfo(S.events, new Date(), S.catalog, dev());

  // ---------------- acciones ----------------
  const act = {
    async start() {
      const ok = await commit(L.start(S.events, dev(), S.catalog, { company: S.ui.company, firstModel: S.ui.firstModel }));
      if (ok) { S.ui.entModel = S.ui.firstModel; S.ui.firstModel = ''; S.ui.model = ''; S.ui.qty = 1; S.ui.result = 'reparado'; S.undo = null; render(); }
    },
    async changeModel() {
      const m = S.ui.model;
      if (await commit(L.changeModel(S.events, dev(), S.catalog, m))) { S.ui.entModel = m; S.ui.model = ''; render(); }
    },
    async pause() { await commit(L.togglePause(S.events, dev(), S.catalog)); },
    async end() {
      const r = L.end(S.events, dev(), S.catalog); if (r.error) return toast(r.error);
      if (!(await commit(r))) return;
      S.undo = r.undo; S.corr = null; S.delAsk = false;
      const pend = L.pendingImput(S.events, r.undo.jornadaId, new Date(), S.catalog);
      if (pend.length) openImput(r.undo.jornadaId);
      render();
    },
    async entrega() {
      const O = info(); if (!O) return toast('No hay jornada abierta.');
      const ok = await commit(L.entrega(S.events, dev(), S.catalog, { model: S.ui.entModel || O.model, qty: S.ui.qty, result: S.ui.result }));
      if (ok) { S.ui.qty = 1; S.ui.result = 'reparado'; render(); }     // tras cada entrega: cantidad 1 y «Reparado»
    },
    qty(el) { S.ui.qty = Math.max(1, Math.min(L.MAX_QTY, (Math.round(Number(S.ui.qty)) || 1) + Number(el.dataset.d))); const q = $('qty'); if (q) q.value = S.ui.qty; },
    result(el) { S.ui.result = el.dataset.r; render(); },
    async undoEnd() {
      if (!S.undo || Date.now() > S.undo.until) { S.undo = null; return render(); }
      const ids = S.undo.ids; S.undo = null; S.imp = null;
      await commit(L.undoEnd(S.events, ids));
    },
    fold(el) { const id = el.dataset.jid; S.fold.has(id) ? S.fold.delete(id) : S.fold.add(id); render(); },
    tab(el) { S.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
    more() { S.histLimit += 14; render(); },
    corrOpen() { const e = L.lastFichaje(S.events, dev()); if (e) { S.corr = { hm: V.hm(Date.parse(e.ts)) }; S.delAsk = false; render(); } },
    corrCancel() { S.corr = null; render(); },
    async corrSave() {
      const v = ($('corr-time') || {}).value;
      if (await commit(L.correctLast(S.events, dev(), v))) { S.corr = null; render(); }
    },
    delAsk() { S.delAsk = true; S.corr = null; render(); },
    delNo() { S.delAsk = false; render(); },
    async delYes() { S.delAsk = false; await commit(L.deleteLast(S.events, dev())); },
    imputar(el) { openImput(el.dataset.jid); render(); },
    impLater() { S.imp = null; render(); },
    async impSave() {
      if (!S.imp) return;
      const left = Object.keys(S.imp.sel).filter(m => S.imp.sel[m] === undefined);
      if (left.length) return toast('Elige un modelo (o «Dejar sin asignar») para: ' + left.join(', '));
      const r = L.imputar(S.events, dev(), S.catalog, S.imp.jid, S.imp.sel);
      if (r.error) return toast(r.error);
      const jid = S.imp.jid; S.imp = null;
      // si el fin aún se puede deshacer, deshacerlo quita también estas imputaciones
      if (S.undo && Date.now() < S.undo.until && S.undo.jornadaId === jid) S.undo.ids.push(...r.put.map(e => e.id));
      await commit(r);
    }
  };
  // ---------------- archivos: catálogo, copia, restauración y exportación ----------------
  const msg = (tone, text) => { S.fileMsg = text ? { tone, text } : null; };
  Object.assign(act, {
    pickFile(el) { if (S.blocked) { toast(BLOCK_MSG); return; } S.pick = el.dataset.kind; const i = $('file'); i.value = ''; i.click(); },
    async exportFile(el) {
      const what = el.dataset.what, now = new Date();
      let r, name;
      if (what === 'backup') {
        if (!S.events.length) { msg('err', 'Todavía no hay fichajes que guardar.'); return render(); }
        r = FL.buildBackup(S.events, S.dev, now); name = FL.nameBackup(F.dayOf(now));
      } else {
        const { from, to } = S.exp;
        if (from && to && from > to) { msg('err', 'La fecha «desde» es posterior a «hasta».'); return render(); }
        r = FL.buildEvents(S.events, S.dev, from, to, now); name = FL.nameEvents(from, to, F.dayOf(now));
        if (r.ok && !r.count) { msg('err', 'No hay fichajes en esas fechas.'); return render(); }
      }
      if (!r.ok) { msg('err', 'No se puede generar el archivo: ' + r.errors.join(', ')); return render(); }
      let res;
      try { res = await FL.deliver(env(), name, FL.toText(r.file), el.dataset.mode); }
      catch (e) { console.error(e); msg('err', 'No se pudo entregar el archivo: ' + (e && e.message || e)); return render(); }
      if (res === 'cancelado') { msg(null); return render(); }
      if (what === 'backup') { S.lastBackup = F.localIso(now); try { await S.store.setMeta('lastBackup', S.lastBackup); } catch (e) { /* solo informativo */ } }
      msg('ok', `${res === 'compartido' ? 'Compartido' : 'Descargado'}: ${name} · ${r.count} evento(s).` + (res === 'descargado' ? ' Búscalo en la carpeta de descargas del móvil.' : ''));
      render();
    },
    catCancel() { S.catPrev = null; render(); },
    async catApply() {
      const P = S.catPrev; if (!P) return;
      if (S.blocked) { S.catPrev = null; toast(BLOCK_MSG); return render(); }
      const cat = { ...P.catalog, importedAt: F.localIso(new Date()) };
      try { await S.store.setMeta('catalog', cat); }
      catch (e) { console.error(e); msg('err', 'No se pudo guardar el catálogo: ' + (e && e.message || e)); S.catPrev = null; return render(); }
      S.catalog = cat; S.catPrev = null;
      if (!cat.companies.includes(S.ui.company)) { S.ui.company = ''; S.ui.firstModel = ''; }
      msg('ok', `Catálogo importado: ${cat.companies.length} empresa(s) y ${cat.models.length} modelo(s), sin precios.`); render();
    },
    impCancel() { S.impPrev = null; render(); },
    async impApply() {
      const P = S.impPrev; if (!P || P.busy || !P.counts.marcados) return;
      if (S.blocked) { S.impPrev = null; toast(BLOCK_MSG); return render(); }
      P.busy = true; render();
      const ap = FL.applyPreview(S.events, P.cmp, P.selected);
      try {
        if (P.adopt && P.canAdopt) { await S.store.setMeta('device', { id: P.v.device.id, name: P.v.device.name || 'Móvil' }); S.dev = { id: P.v.device.id, name: P.v.device.name || 'Móvil' }; }
        await S.store.putEvents(ap.changed);
      } catch (e) { console.error(e); P.busy = false; msg('err', 'No se pudo guardar la importación: ' + (e && e.message || e)); S.impPrev = null; return render(); }
      S.events = ap.events; S.impPrev = null;
      const pisa = L.analysis(S.events, new Date(), S.catalog).overlaps.some(o => o.crossDevice);
      msg('ok', `Importado: ${ap.added} nuevo(s) y ${ap.replaced} reemplazado(s).` + (pisa ? ' Hay jornadas que se pisan entre dispositivos: aparece el aviso en Hoy y en Histórico.' : ''));
      render();
    }
  });
  Object.assign(act, {
    async installApp() {
      const e = S.installEvt; if (!e) return;
      S.installEvt = null;
      try { e.prompt(); await e.userChoice; } catch (err) { /* el usuario puede cancelar */ }
      render();
    },
    hideInstall() { S.installHidden = true; render(); },
    updateApp() {
      if (!S.waiting || S.updating) return;
      S.updating = true; render();
      FI.applyUpdate(S.waiting, navigator, () => location.reload());
    }
  });
  async function onFile(file) {
    const kind = S.pick; S.pick = null; if (!file) return;
    if (S.blocked) { toast(BLOCK_MSG); return; }
    let text;
    try { text = await file.text(); } catch (e) { msg('err', 'No se pudo leer el archivo.'); return render(); }
    if (kind === 'catalog') {
      const r = FL.readCatalog(text);
      if (!r.ok) { msg('err', 'Catálogo rechazado: ' + r.errors.join(' ')); return render(); }
      const O = info(), gone = O && !r.catalog.companies.includes(O.j.company) ? O.j.company : '';
      msg(null); S.catPrev = { catalog: r.catalog, changes: FL.catalogChanges(S.catalog, r.catalog), hadCatalog: !!S.catalog, openCompanyGone: gone };
    } else {
      const v = FL.readEvents(text);
      if (!v.ok) { msg('err', 'Archivo rechazado: ' + v.errors.join(' ')); return render(); }
      msg(null);
      S.impPrev = { v, mode: 'nuevos', busy: false, adopt: false, canAdopt: !S.events.length && v.kind === 'backup' && !!(v.device && v.device.id && v.device.id !== S.dev.id),
        fileInfo: { kind: v.kind, device: v.device, exportedAt: v.exportedAt, invalid: v.invalid.length } };
      refreshImp(true);
    }
    render();
  }
  // Recalcula la previsualización (con modo nuevo si reset; si no, conserva la selección manual)
  const impOpts = () => ({ now: new Date(), companyOf: L.companyOf(S.catalog) });
  function refreshImp(reset) {
    const P = S.impPrev; if (!P) return;
    if (reset) { const pv = FL.previewImport(S.events, P.v, P.mode, impOpts()); Object.assign(P, { cmp: pv.cmp, selected: pv.selected, groups: pv.groups }); }
    P.counts = F.importCounts(P.cmp.items, P.selected);
    P.overlaps = F.importOverlaps(S.events, P.cmp.items, P.selected, impOpts());
  }

  function openImput(jid) {
    const pend = L.pendingImput(S.events, jid, new Date(), S.catalog);
    if (!pend.length) return toast('Esta jornada no tiene horas pendientes de imputar.');
    S.imp = { jid, sel: Object.fromEntries(pend.map(m => [m, undefined])) };
  }

  // ---------------- pantallas ----------------
  const opt = (v, label, sel) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;

  function startCard() {
    const cs = L.companies(S.catalog);
    if (!cs.length) return `<section class="card"><h2>Sin catálogo</h2><p class="dim">Esta app aún no tiene empresas ni modelos. El catálogo entra desde el archivo que se exporta en el escritorio («⇩ Catálogo para el móvil»).</p>
      <button class="big go" data-act="tab" data-tab="files">Ir a Archivos para importarlo</button></section>`;
    if (!cs.includes(S.ui.company)) S.ui.company = '';
    const ms = S.ui.company ? L.modelsOf(S.catalog, S.ui.company) : [];
    if (!ms.includes(S.ui.firstModel)) S.ui.firstModel = '';
    return `<section class="card"><h2>Iniciar jornada</h2>
      <label class="lbl" for="company">Empresa</label>
      <select id="company" data-ui="company">${opt('', '— Elige la empresa —', !S.ui.company)}${cs.map(c => opt(c, c, c === S.ui.company)).join('')}</select>
      <label class="lbl" for="firstModel">Primer modelo (opcional)</label>
      <select id="firstModel" data-ui="firstModel"${S.ui.company ? '' : ' disabled'}>${opt('', '— Sin modelo todavía —', !S.ui.firstModel)}${ms.map(m => opt(m, m, m === S.ui.firstModel)).join('')}</select>
      <button class="big go" data-act="start"${S.ui.company ? '' : ' disabled'}>▶ INICIAR JORNADA</button></section>`;
  }

  function workCard(O) {
    const ms = L.modelsOf(S.catalog, O.j.company), paused = !!O.pause;
    const entModel = ms.includes(S.ui.entModel) ? S.ui.entModel : (O.model || '');
    const R = [['reparado', 'Reparado'], ['sin_reparar', 'Sin reparar'], ['descartado', 'Descartado']];
    return `<section class="card">
      <div class="two">
        <button class="big warnbtn" data-act="pause">${paused ? '▶ REANUDAR' : '⏸ PAUSA'}</button>
        <button class="big stop" data-act="end">⏹ FIN DE JORNADA</button></div>
      <h2>Entrega</h2>
      <label class="lbl" for="entModel">Modelo</label>
      <select id="entModel" data-ui="entModel"${paused ? ' disabled' : ''}>${opt('', '— Elige el modelo —', !entModel)}${ms.map(m => opt(m, m, m === entModel)).join('')}</select>
      <div class="seg" role="radiogroup" aria-label="Resultado">${R.map(([k, t]) => `<button role="radio" aria-checked="${S.ui.result === k}" class="${S.ui.result === k ? 'on ' + k : ''}" data-act="result" data-r="${k}"${paused ? ' disabled' : ''}>${t}</button>`).join('')}</div>
      <div class="qty"><button class="step" data-act="qty" data-d="-1" aria-label="Menos"${paused ? ' disabled' : ''}>−</button>
        <input id="qty" data-ui="qty" type="number" inputmode="numeric" min="1" max="${L.MAX_QTY}" value="${S.ui.qty}" aria-label="Cantidad"${paused ? ' disabled' : ''}>
        <button class="step" data-act="qty" data-d="1" aria-label="Más"${paused ? ' disabled' : ''}>+</button></div>
      <button class="big go" data-act="entrega"${paused ? ' disabled' : ''}>✔ REGISTRAR ENTREGA</button>
      ${paused ? '<p class="dim small">En pausa: reanuda para registrar entregas o cambiar de modelo.</p>' : ''}
      <h2>Cambiar de modelo</h2>
      <div class="two"><select id="model" data-ui="model" aria-label="Modelo nuevo"${paused ? ' disabled' : ''}>${opt('', '— Modelo nuevo —', !S.ui.model)}${ms.filter(m => m !== O.model).map(m => opt(m, m, m === S.ui.model)).join('')}</select>
        <button class="big" data-act="changeModel"${paused || !S.ui.model ? ' disabled' : ''}>Cambiar</button></div></section>`;
  }

  function lastCard() {
    const e = L.lastFichaje(S.events, dev()); if (!e) return '';
    const t = Date.parse(e.ts);
    let what = V.LABEL[e.type];
    if (e.type === 'entrega') what = `${V.RES[e.result]} ×${V.num(e.qty)} · ${e.model}`;
    else if (e.type === 'modelo') what += ' · ' + e.model;
    else if (e.type === 'jornada_inicio') what += ' · ' + e.company;
    let body;
    if (S.corr) body = `<div class="corr"><label class="lbl" for="corr-time">Nueva hora</label><input id="corr-time" type="time" value="${esc(S.corr.hm)}">
      <div class="two"><button class="big go" data-act="corrSave">Guardar hora</button><button class="big" data-act="corrCancel">Cancelar</button></div></div>`;
    else if (S.delAsk) body = `<div class="corr"><p><b>¿Borrar este fichaje?</b>${e.type === 'jornada_fin' ? ' La jornada volverá a estar abierta.' : ''}</p>
      <div class="two"><button class="big stop" data-act="delYes">Sí, borrar</button><button class="big" data-act="delNo">No</button></div></div>`;
    else body = `<div class="two"><button class="big" data-act="corrOpen">✎ Corregir hora</button><button class="big" data-act="delAsk">🗑 Borrar</button></div>`;
    return `<section class="card"><h2>Último fichaje</h2><div class="last"><time>${V.hm(t)}</time><span>${esc(what)}</span></div>${body}</section>`;
  }

  function daysHtml(filter) {
    const A = L.analysis(S.events, new Date(), S.catalog), today = F.dayOf(new Date());
    const js = A.jornadas.filter(j => j.day && filter(j, today)), byJ = new Map();
    for (const e of S.events) if (!e.deleted) (byJ.get(e.jornadaId) || byJ.set(e.jornadaId, []).get(e.jornadaId)).push(e);
    const days = [...new Set(js.map(j => j.day))].sort().reverse(), ovIds = new Set(A.overlaps.flatMap(x => [x.a, x.b]));
    return { A, days, html: days.map(d => V.dayBlock(d, js.filter(j => j.day === d), byJ, { fold: S.fold, devId: dev(), ovIds, today: d === today })) };
  }

  function viewHoy() {
    const O = info();
    const t = daysHtml((j, today) => j.day === today || j.open);
    return V.overlapBanner(t.A) + panelHtml() + (S.blocked ? '' : (O ? workCard(O) : startCard()) + lastCard())
      + `<h2 class="zone">Hoy</h2>` + (t.html.join('') || '<p class="dim">Hoy no hay fichajes.</p>');
  }
  function viewHist() {
    const t = daysHtml((j, today) => j.day !== today && !j.open);
    const shown = t.days.slice(0, S.histLimit);
    return V.overlapBanner(t.A) + `<h2 class="zone">Histórico</h2>` + (shown.length ? t.html.slice(0, S.histLimit).join('') : '<p class="dim">Todavía no hay jornadas anteriores.</p>')
      + (t.days.length > shown.length ? `<button class="big" data-act="more">Ver ${Math.min(14, t.days.length - shown.length)} días más</button>` : '');
  }
  // Pestaña Archivos
  function viewFiles() {
    const cat = S.catalog, share = FL.canShareFiles(env(), 'a.json', '{}');
    const when = iso => iso ? new Date(iso).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '';
    const stale = !S.lastBackup || (Date.now() - Date.parse(S.lastBackup)) > 7 * 86400000;
    const btns = (what) => `<div class="two">${share ? `<button class="big go" data-act="exportFile" data-what="${what}" data-mode="compartir">Compartir</button>` : ''}<button class="big${share ? '' : ' go'}" data-act="exportFile" data-what="${what}" data-mode="descargar">Descargar</button></div>`;
    return (S.fileMsg ? `<div class="msg ${S.fileMsg.tone}" role="status">${esc(S.fileMsg.text)}</div>` : '')
      + `<section class="card"><h2>Catálogo</h2>
        ${cat ? `<div class="row2"><span class="dim">Empresas</span><b>${cat.companies.length}</b></div><div class="row2"><span class="dim">Modelos</span><b>${cat.models.length}</b></div>
          <div class="row2"><span class="dim">Generado</span><b>${esc(cat.exportedAt ? String(cat.exportedAt).slice(0, 10) : '—')}</b></div>` : '<p class="dim">Aún no hay catálogo.</p>'}
        <p class="dim small">Es el archivo «⇩ Catálogo para el móvil» del escritorio. No lleva precios.</p>
        <button class="big" data-act="pickFile" data-kind="catalog"${S.blocked ? " disabled" : ""}>${cat ? 'Importar un catálogo nuevo' : 'Importar catálogo'}</button></section>`
      + `<section class="card"><h2>Copia de seguridad</h2>
        <p class="${stale ? 'warn-t' : 'dim'} small">${S.lastBackup ? 'Última copia: ' + esc(when(S.lastBackup)) + (stale ? ' (hace más de 7 días)' : '') : 'Aún no has hecho ninguna copia.'}</p>
        <p class="dim small">Guarda todos los fichajes (también los borrados) con el identificador de este móvil. Hazla a menudo.</p>
        ${btns('backup')}
        <h2>Restaurar o importar eventos</h2>
        <p class="dim small">Abre una copia de seguridad o unos eventos exportados. Verás una previsualización antes de importar: no se pisa nada sin que lo marques, y lo que borraste aquí no reaparece.</p>
        <button class="big" data-act="pickFile" data-kind="events"${S.blocked ? " disabled" : ""}>Elegir archivo de eventos</button></section>`
      + `<section class="card"><h2>Exportar eventos por fechas</h2>
        <div class="dates"><div><label class="lbl" for="exp-from">Desde</label><input id="exp-from" type="date" data-exp="from" value="${esc(S.exp.from)}"></div>
          <div><label class="lbl" for="exp-to">Hasta</label><input id="exp-to" type="date" data-exp="to" value="${esc(S.exp.to)}"></div></div>
        <p class="dim small">Vacío = sin límite. Es el archivo que se carga en el escritorio con «⇪ Importar del móvil».</p>
        ${btns('events')}</section>`
      + `<section class="card"><h2>Este móvil</h2><div class="row2"><span class="dim">Dispositivo</span><b>${esc(S.dev.name)} · ${esc(S.dev.id.slice(0, 8))}</b></div>
        <div class="row2"><span class="dim">Fichajes guardados</span><b>${S.events.length}</b></div>
        <div class="row2"><span class="dim">Almacenamiento persistente</span><b>${S.persist && S.persist.supported ? (S.persist.persisted ? 'sí' : 'no concedido') : 'no disponible'}</b></div>
        <div class="row2"><span class="dim">Versión</span><b>${esc(self.APP_VERSION || '—')}</b></div>
        <div class="row2"><span class="dim">Sin conexión</span><b>${esc(S.sw)}</b></div>
        <div class="row2"><span class="dim">Instalada</span><b>${S.plat.installed ? 'sí' : 'no'}</b></div>
        ${S.plat.canInstallHere && !S.installEvt ? '<p class="dim small">Para instalarla en Android: menú ⋮ de Chrome → «Instalar aplicación» (o «Añadir a la pantalla de inicio»).</p>' : ''}</section>`;
  }
  function panelHtml() {
    const now = new Date(), C = F.liveCounters(S.events, now, { companyOf: L.companyOf(S.catalog) });
    return V.statusPanel(C, now.getTime());
  }

  function impModal() {
    if (!S.imp) return '';
    const j = L.analysis(S.events, new Date(), S.catalog).jornadas.find(x => x.jornadaId === S.imp.jid); if (!j) { S.imp = null; return ''; }
    const ms = L.modelsOf(S.catalog, j.company);
    const rows = Object.keys(S.imp.sel).map(m => {
      const s = j.models[m], v = S.imp.sel[m];
      return `<div class="mcard"><div class="mc-h"><b class="mc-name">${esc(m)}</b><span class="mc-hours">${V.dur(s.ms)}</span></div>
        <select data-imp="${esc(m)}" aria-label="Destino de las horas de ${esc(m)}">${opt('', '— Elige —', v === undefined)}${ms.filter(x => x !== m).map(x => opt(x, x + (j.models[x] && j.models[x].rep ? ` · ${j.models[x].rep} reparados` : ''), v === x)).join('')}${opt('__none__', 'Dejar sin asignar (solo cuenta en la media)', v === '')}</select></div>`;
    }).join('');
    return `<div class="modal-back"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="imp-t"><h2 id="imp-t">↪ Horas sin ningún reparado</h2>
      <p class="dim small">Jornada de <b>${esc(j.company)}</b> · ${V.hm(j.start)}–${V.hm(j.end)}. ¿A qué modelo imputas estas horas? Solo se ofrecen modelos de ${esc(j.company)}.</p>${rows}
      <div class="two"><button class="big" data-act="impLater">Decidir más tarde</button><button class="big go" data-act="impSave">💾 Guardar</button></div></div></div>`;
  }
  function undoBar() {
    const left = S.undo ? Math.ceil((S.undo.until - Date.now()) / 1000) : 0;
    if (!S.undo || left <= 0) { S.undo = null; return ''; }
    return `<div class="undo" role="status"><span>⏹ Jornada de ${esc(S.undo.company)} cerrada a las ${V.hm(S.undo.endMs)} · ${V.dur(S.undo.endMs - S.undo.startMs)}</span><button data-act="undoEnd">↶ DESHACER (${left})</button></div>`;
  }

  // Avisos de arriba: iPhone sin instalar (bloquea), versión nueva y oferta de instalación en Android
  function banners() {
    let h = '';
    if (S.blocked) h += `<section class="card block" role="alert"><h2>⛔ Instala la app para fichar</h2>
      <p>Estás en el navegador. En iPhone, Safari y la app instalada guardan los datos <b>por separado</b> y Safari puede borrar los suyos si no se usa unos días. Por eso <b>no se puede fichar ni importar</b> desde aquí.</p>
      <ol class="steps">${FI.IOS_STEPS.map(x => '<li>' + esc(x) + '</li>').join('')}</ol>
      <p class="dim small">Una vez instalada, este aviso desaparece. Si ya la instalaste, ábrela desde su icono.</p></section>`;
    if (S.waiting) h += `<div class="newver" role="status"><span>Hay una versión nueva de la app.</span><button data-act="updateApp"${S.updating ? ' disabled' : ''}>${S.updating ? 'Actualizando…' : 'Actualizar'}</button></div>`;
    if (S.tab === 'hoy' && S.plat.canInstallHere && !S.installHidden && S.installEvt)
      h += `<div class="newver" role="status"><span>Instala la app en tu móvil para abrirla como cualquier otra y usarla sin conexión.</span><button data-act="installApp">Instalar</button><button class="x" data-act="hideInstall" aria-label="Ocultar">✕</button></div>`;
    return h;
  }
  function render() {
    const main = $('main'); if (!main) return;
    const keep = document.activeElement && document.activeElement.id;
    main.innerHTML = `<nav class="tabs" role="tablist"><button role="tab" aria-selected="${S.tab === 'hoy'}" data-act="tab" data-tab="hoy">Hoy</button><button role="tab" aria-selected="${S.tab === 'hist'}" data-act="tab" data-tab="hist">Histórico</button><button role="tab" aria-selected="${S.tab === 'files'}" data-act="tab" data-tab="files">Archivos</button></nav>`
      + banners() + (S.tab === 'hoy' ? viewHoy() : S.tab === 'hist' ? viewHist() : viewFiles());
    $('overlay').innerHTML = S.impPrev ? V.importPreview(S.impPrev, F) : S.catPrev ? V.catalogPreview(S.catPrev) : impModal();
    $('undo').innerHTML = undoBar(); document.body.classList.toggle('has-undo', !!S.undo);
    if (keep && $(keep) && !$(keep).disabled && keep !== 'qty') try { $(keep).focus(); } catch (e) { /* ignorar */ }
  }
  // Una vez por segundo: panel en vivo y cuenta atrás del «Deshacer». Todo sale de las horas de los eventos y de «ahora».
  function tick() {
    if (S.tab === 'hoy' && $('panel') && !S.imp) $('panel').outerHTML = panelHtml();
    if (S.undo) { const u = undoBar(); $('undo').innerHTML = u; if (!u) render(); }
  }

  // ---------------- eventos del DOM ----------------
  document.addEventListener('click', ev => {
    const el = ev.target.closest('[data-act]'); if (!el || el.disabled) return;
    const f = act[el.dataset.act]; if (f) f(el);
  });
  document.addEventListener('change', ev => {
    const el = ev.target;
    if (el.dataset.ui) {
      const k = el.dataset.ui; S.ui[k] = k === 'qty' ? Math.max(1, Math.min(L.MAX_QTY, Math.round(Number(el.value)) || 1)) : el.value;
      if (k === 'company') { S.ui.firstModel = ''; render(); } else if (k === 'model') render();
    } else if (el.dataset.imp && S.imp) {
      S.imp.sel[el.dataset.imp] = el.value === '' ? undefined : el.value === '__none__' ? '' : el.value;
    } else if (el.dataset.exp) {
      S.exp[el.dataset.exp] = el.value;
    } else if (el.id === 'file') {
      onFile(el.files && el.files[0]);
    } else if (el.dataset.impmode !== undefined && S.impPrev) {
      S.impPrev.mode = el.value; refreshImp(true); render();
    } else if (el.dataset.impadopt !== undefined && S.impPrev) {
      S.impPrev.adopt = el.checked;
    } else if (el.dataset.impj && S.impPrev) {
      const P = S.impPrev, jg = P.groups.flatMap(g => g.jornadas).find(x => x.jornadaId === el.dataset.impj);
      if (jg) for (const it of jg.items) if (it.status !== 'existe' && !F.importBlocked(it)) { el.checked ? P.selected.add(it.ev.id) : P.selected.delete(it.ev.id); }
      refreshImp(false); render();
    }
  });
  document.addEventListener('input', ev => { if (ev.target.id === 'qty') S.ui.qty = Math.max(1, Math.round(Number(ev.target.value)) || 1); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  // ---------------- arranque ----------------
  // Plataforma, oferta de instalación y service worker (sin conexión y avisos de versión)
  async function startPlatform() {
    const mm = q => { try { return !!(window.matchMedia && matchMedia(q).matches); } catch (e) { return false; } };
    S.plat = FI.detect({ ua: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints,
      standalone: navigator.standalone === true, displayStandalone: mm('(display-mode: standalone)'), sim: FI.simFrom(location.search) });
    S.blocked = S.plat.mustInstall;
    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEvt = e; render(); });
    window.addEventListener('appinstalled', () => { S.installEvt = null; S.plat.installed = true; S.plat.canInstallHere = false; render(); });
    if (!('serviceWorker' in navigator)) { S.sw = window.isSecureContext ? 'no disponible en este navegador' : 'requiere HTTPS'; return; }
    try {
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      const check = FI.watchUpdates(reg, navigator, w => { S.waiting = w; render(); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) { reg.update().catch(() => {}); check(); } });
      await navigator.serviceWorker.ready;
      const ready = async () => (await caches.keys()).includes('fichaje-' + self.APP_VERSION);
      S.sw = (await ready()) ? 'lista (funciona sin red)' : 'preparando…';
      if (S.sw === 'preparando…') setTimeout(async () => { S.sw = (await ready()) ? 'lista (funciona sin red)' : 'no disponible'; render(); }, 3000);
    } catch (e) { console.error(e); S.sw = 'no se pudo preparar'; }
    render();
  }
  async function init() {
    try {
      S.store = await ST.openStore(window.indexedDB);
      S.dev = await ST.ensureDevice(S.store, F, 'Móvil');
      S.events = await S.store.getAllEvents();
      S.catalog = (await S.store.getMeta('catalog')) || null;
      S.lastBackup = (await S.store.getMeta('lastBackup')) || null;
      S.persist = await ST.requestPersist(navigator);
    } catch (e) {
      $('main').innerHTML = `<section class="card"><h2>No se puede usar el almacenamiento</h2><p class="bad">${esc(e && e.message || e)}</p><p class="dim">Sin almacenamiento local la app no puede guardar los fichajes. Prueba fuera de la navegación privada.</p></section>`;
      return;
    }
    startPlatform();
    render(); setInterval(tick, 1000);
    window.__fichaje = S;          // para depurar en el navegador
  }
  init();
})();
