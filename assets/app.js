/* AntionWhat Web — interfaz. Todo el contenido de los chats se trata como no
 * confiable: se escapa con esc() o se asigna con textContent, y las rutas de
 * archivos se resuelven a blob: locales. No hay manejadores inline (CSP). */
(function () {
  "use strict";
  const C = window.AWCore, Store = window.AWStore;
  const $ = (s) => document.querySelector(s);
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const icon = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
  const fmt = (n) => Number(n || 0).toLocaleString("es-CO");
  const plural = (n, a, b) => `${fmt(n)} ${n === 1 ? a : b}`;

  const MEDIA = { image: ["Foto", "image"], gif: ["GIF", "image"], video: ["Video", "video"], audio: ["Audio", "music"],
    voice: ["Nota de voz", "mic"], document: ["Documento", "file"], sticker: ["Sticker", "smile"] };
  const mediaInfo = (mt) => MEDIA[mt] || ["Archivo", "file"];

  // ── estado ────────────────────────────────────────────────────────────
  const state = {
    chats: new Map(),      // id -> { id, name, isGroup, fav, parts: {srcId: msgs} }
    sources: new Map(),    // id -> { id, label, importedAt, fileDate, chats, messages, signature }
    merged: new Map(),     // id -> mensajes combinados (caché)
    media: new Map(),      // ruta relativa en minúsculas -> File (solo esta sesión)
    mediaByName: new Map(),
    urls: new Map(),       // File -> blob:
    showArtifacts: false, filter: "all", sort: "recent", query: "", cur: null,
  };
  try { state.showArtifacts = localStorage.getItem("aw_show_art") === "1"; } catch (e) { /* sin almacenamiento */ }

  function merged(chat) {
    let m = state.merged.get(chat.id);
    if (!m) {
      const parts = Object.keys(chat.parts).map((src) => ({ src, messages: chat.parts[src] }));
      m = C.mergeParts(parts);
      state.merged.set(chat.id, m);
    }
    return m;
  }
  const visible = (msgs) => (state.showArtifacts ? msgs : msgs.filter((m) => !m.art));

  // Índice de búsqueda por chat (perezoso)
  const searchText = new Map();
  function chatText(chat) {
    let t = searchText.get(chat.id);
    if (t === undefined) {
      t = C.fold(visible(merged(chat)).map((m) => m.t || "").join("\n"));
      searchText.set(chat.id, t);
    }
    return t;
  }
  function invalidate(id) {
    if (id) { state.merged.delete(id); searchText.delete(id); }
    else { state.merged.clear(); searchText.clear(); }
  }

  // ── utilidades de interfaz ────────────────────────────────────────────
  let toastTimer = 0;
  function toast(msg, ms = 2800) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("on");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("on"), ms);
  }
  function confirmDialog(title, msg, okText = "Aceptar", danger = true) {
    return new Promise((resolve) => {
      $("#modal-title").textContent = title; $("#modal-msg").textContent = msg;
      const ok = $("#modal-ok"), cancel = $("#modal-cancel");
      ok.textContent = okText; ok.className = "btn " + (danger ? "danger" : "primary");
      $("#modal").hidden = false; ok.focus();
      const done = (v) => { $("#modal").hidden = true; ok.onclick = cancel.onclick = null; resolve(v); };
      ok.onclick = () => done(true); cancel.onclick = () => done(false);
    });
  }
  const hueClass = (name) => { let h = 0; for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return "h" + (h % 12); };
  function initials(name) {
    const w = String(name || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
    const s = w.map((x) => (x.match(/[\p{L}\p{N}]/u) || [""])[0]).join("").toUpperCase();
    return !s || /^\d/.test(s) ? "#" : s;
  }
  function highlight(text, fq) {
    text = String(text || "");
    if (!fq) return esc(text);
    const ft = C.fold(text);
    let out = "", from = 0, at;
    while ((at = ft.indexOf(fq, from)) !== -1) {
      out += esc(text.slice(from, at)) + "<mark>" + esc(text.slice(at, at + fq.length)) + "</mark>";
      from = at + fq.length;
    }
    return out + esc(text.slice(from));
  }

  // ── importación ───────────────────────────────────────────────────────
  const IGNORE = /(^|\/)(_media_raw|_native_raw|\.git|node_modules)(\/|$)/i;
  const DATA_EXT = /\.(json|html?|txt)$/i;

  async function filesFromDrop(dt) {
    const items = [...(dt.items || [])].map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (!items.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));
    const out = [];
    const readDir = (dir) => new Promise((res) => {
      const reader = dir.createReader(); const all = [];
      const next = () => reader.readEntries((batch) => { if (!batch.length) res(all); else { all.push(...batch); next(); } }, () => res(all));
      next();
    });
    async function walk(entry, prefix) {
      if (entry.isFile) {
        const f = await new Promise((res) => entry.file(res, () => res(null)));
        if (f) out.push({ file: f, path: prefix + entry.name });
      } else if (entry.isDirectory) {
        for (const e of await readDir(entry)) await walk(e, prefix + entry.name + "/");
      }
    }
    for (const e of items) await walk(e, "");
    return out;
  }

  const readText = (file) => file.text ? file.text() : new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file);
  });

  async function importEntries(entries) {
    entries = entries.filter((e) => !IGNORE.test(e.path) && !/(^|\/)\./.test(e.path.split("/").pop()));
    if (!entries.length) { toast("No se encontraron archivos para importar"); return; }
    const roots = new Set(entries.map((e) => e.path.includes("/") ? e.path.split("/")[0] : ""));
    const label = roots.size === 1 && [...roots][0] ? [...roots][0] : plural(entries.length, "archivo", "archivos");
    const stripRoot = (p) => (roots.size === 1 && [...roots][0] && p.includes("/") ? p.slice(p.indexOf("/") + 1) : p);

    // 1) multimedia de esta sesión
    let mediaCount = 0;
    for (const e of entries) {
      if (DATA_EXT.test(e.path)) continue;
      const rel = stripRoot(e.path).toLowerCase();
      state.media.set(rel, e.file);
      state.mediaByName.set(rel.split("/").pop(), e.file);
      mediaCount++;
    }

    // 2) datos: si hay .json de chats, se ignoran los .html (son la misma información)
    const data = entries.filter((e) => DATA_EXT.test(e.path));
    const jsonStems = new Set(data.filter((e) => /\.json$/i.test(e.path)).map((e) => e.path.replace(/\.json$/i, "").toLowerCase()));
    const found = new Map();   // chatKey -> {name, messages, isGroup, fav, failed}
    let skipped = 0, files = 0, latest = 0, done = 0;
    const add = (c) => {
      if (!c || !c.name) return;
      const key = C.chatKey(c.name);
      const prev = found.get(key);
      if (prev) prev.messages = prev.messages.concat(c.messages);
      else found.set(key, { name: c.name, messages: c.messages || [], isGroup: !!c.isGroup, fav: !!c.fav, failed: !!c.failed });
    };
    const indexFiles = [];
    for (const e of data) {
      const name = e.path.split("/").pop();
      if (/^resumen_antionwhat/i.test(name)) continue;
      const ref = e.file.lastModified || Date.now();
      latest = Math.max(latest, ref);
      try {
        const text = await readText(e.file);
        if (/\.json$/i.test(name)) {
          C.parseJSONFile(text.replace(/^﻿/, ""), name, ref).chats.forEach(add); files++;
        } else if (/\.html?$/i.test(name)) {
          if (/const (DATA|CHATS)\s?=/.test(text)) { indexFiles.push({ text, ref }); continue; }
          if (jsonStems.has(e.path.replace(/\.html?$/i, "").toLowerCase())) continue;
          const doc = new DOMParser().parseFromString(text, "text/html");
          const r = C.parseAntionChatHTML(doc, name, ref);
          if (r) { r.chats.forEach(add); files++; } else skipped++;
        } else {
          const r = C.parseWhatsAppTXT(text, name, ref);
          if (r) { r.chats.forEach(add); files++; } else skipped++;
        }
      } catch (err) { skipped++; }
      if (++done % 200 === 0) toast(`Leyendo ${fmt(done)} de ${fmt(data.length)} archivos…`, 60000);
    }
    // El index.html trae todos los chats de una exportación: se usa solo si no
    // vinieron los .json individuales (serían duplicados de lo mismo).
    if (!files) for (const ix of indexFiles) {
      try { const r = C.parseAntionIndex(ix.text, ix.ref); if (r) { r.chats.forEach(add); files++; } } catch (e) { skipped++; }
    }

    if (!found.size) {
      toast(mediaCount ? `Se cargaron ${fmt(mediaCount)} archivos multimedia (sin chats nuevos)` : "No se reconoció ningún chat en esos archivos", 4000);
      if (mediaCount && state.cur) openChat(state.cur, null, true);
      return;
    }

    // 3) registrar la copia (reemplaza una idéntica ya cargada)
    const totalSize = entries.reduce((s, e) => s + (e.file.size || 0), 0);
    const signature = `${label}|${entries.length}|${totalSize}`;
    const same = [...state.sources.values()].find((s) => s.signature === signature);
    if (same) await removeSource(same.id, true);
    const src = { id: "src-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      label, importedAt: Date.now(), fileDate: latest || Date.now(), signature, chats: found.size,
      messages: 0, artifacts: 0 };
    const touched = [];
    for (const [key, c] of found) {
      let chat = state.chats.get(key);
      if (!chat) { chat = { id: key, name: c.name, isGroup: c.isGroup, fav: c.fav, parts: {} }; state.chats.set(key, chat); }
      chat.parts[src.id] = c.messages;
      if (c.isGroup) chat.isGroup = true;
      src.messages += c.messages.filter((m) => !m.art).length;
      src.artifacts += c.messages.filter((m) => m.art).length;
      invalidate(key);
      touched.push(chat);
    }
    state.sources.set(src.id, src);
    try { await Store.saveSource(src); await Store.saveChats(touched); } catch (e) { toast("No se pudo guardar en este navegador: los datos se mantienen solo en esta sesión", 5000); }
    const extra = [skipped ? `${fmt(skipped)} sin reconocer` : "", mediaCount ? `${fmt(mediaCount)} archivos multimedia` : ""].filter(Boolean).join(" · ");
    toast(`Copia «${label}»: ${plural(found.size, "chat", "chats")}${extra ? " · " + extra : ""}`, 4500);
    render();
  }

  async function removeSource(id, silent) {
    const touched = [], removed = [];
    for (const chat of state.chats.values()) {
      if (!(id in chat.parts)) continue;
      delete chat.parts[id];
      invalidate(chat.id);
      if (Object.keys(chat.parts).length) touched.push(chat);
      else { removed.push(chat.id); state.chats.delete(chat.id); }
    }
    state.sources.delete(id);
    try { await Store.deleteSource(id, touched, removed); } catch (e) { /* solo memoria */ }
    if (state.cur && !state.chats.has(state.cur)) state.cur = null;
    if (!silent) { toast("Copia quitada del visor"); render(); }
  }

  // ── multimedia de la sesión ───────────────────────────────────────────
  function mediaFile(mf) {
    if (!mf) return null;
    const rel = String(mf).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    return state.media.get(rel) || state.mediaByName.get(rel.split("/").pop()) || null;
  }
  function urlFor(file) {
    let u = state.urls.get(file);
    if (!u) { u = URL.createObjectURL(file); state.urls.set(file, u); }
    return u;
  }

  // ── lista de chats ────────────────────────────────────────────────────
  function summary(chat) {
    const s = C.chatSummary(merged(chat), state.showArtifacts);
    s.copies = Object.keys(chat.parts).length;
    return s;
  }
  function snippetFor(chat, fq) {
    for (const m of visible(merged(chat))) {
      if (!m.t) continue;
      const at = C.fold(m.t).indexOf(fq);
      if (at !== -1) { const st = Math.max(0, at - 24); return (st ? "…" : "") + m.t.slice(st, st + 90).replace(/\s+/g, " "); }
    }
    return null;
  }
  function renderList() {
    const fq = C.fold(state.query.trim());
    const rows = [];
    for (const chat of state.chats.values()) {
      const s = summary(chat);
      if (state.filter === "media" && !s.media) continue;
      if (state.filter === "fav" && !chat.fav) continue;
      if (state.filter === "multi" && s.copies < 2) continue;
      let snippet = null;
      if (fq && !C.fold(chat.name).includes(fq)) {
        if (!chatText(chat).includes(fq)) continue;
        snippet = snippetFor(chat, fq);
      }
      rows.push({ chat, s, snippet });
    }
    const by = { recent: (a, b) => (b.s.last ?? -1) - (a.s.last ?? -1), count: (a, b) => b.s.count - a.s.count,
      name: (a, b) => a.chat.name.localeCompare(b.chat.name, "es") };
    rows.sort(by[state.sort] || by.recent);
    const html = rows.map(({ chat, s, snippet }) => {
      const last = s.lastMsg;
      let pv;
      if (snippet != null) pv = `<span>${highlight(snippet, fq)}</span>`;
      else if (!last) pv = "<span>Sin mensajes</span>";
      else if (last.t) pv = (last.mt ? icon(mediaInfo(last.mt)[1]) : "") + `<span>${esc(last.t.slice(0, 90))}</span>`;
      else pv = icon(mediaInfo(last.mt)[1]) + `<span>${mediaInfo(last.mt)[0]}</span>`;
      return `<button class="row${chat.id === state.cur ? " on" : ""}" data-id="${esc(chat.id)}" type="button" role="listitem">` +
        `<div class="avatar ${hueClass(chat.name)}">${esc(initials(chat.name))}</div><div class="body">` +
        `<div class="l1"><span class="nm">${fq ? highlight(chat.name, fq) : esc(chat.name)}</span>` +
        (chat.fav ? `<svg class="ic star"><use href="#i-star"/></svg>` : "") +
        `<span class="when">${esc(C.shortDay(s.last))}</span></div>` +
        `<div class="l2"><span class="pv">${pv}</span>` +
        (s.copies > 1 ? `<span class="copies" title="Combinado de ${s.copies} copias">${s.copies}×</span>` : "") +
        (s.count ? `<span class="cnt">${fmt(s.count)}</span>` : "") + `</div></div></button>`;
    });
    $("#list").innerHTML = html.join("") || `<div class="none">${state.chats.size ? "Sin resultados" + (state.query ? " para «" + esc(state.query) + "»" : "") : "Carga una carpeta de AntionWhat para empezar."}</div>`;
    $("#side-sub").textContent = state.chats.size
      ? (rows.length === state.chats.size ? `${plural(state.chats.size, "chat", "chats")} · ${plural(state.sources.size, "copia", "copias")}` : `${fmt(rows.length)} de ${fmt(state.chats.size)} chats`)
      : "Visor de copias";
  }

  // ── inicio / resumen ──────────────────────────────────────────────────
  function renderHome() {
    const home = $("#home");
    if (!state.chats.size) {
      home.innerHTML = `<div class="home-inner"><div class="hero"><div>
        <span class="pill">${icon("shield")}100 % local · nada se sube a internet</span>
        <h1>Todas tus copias de WhatsApp, en un solo lugar</h1>
        <p class="lead">Carga las carpetas que exporta AntionWhat (o los .txt de WhatsApp). El visor las combina sin duplicar mensajes, oculta errores de versiones antiguas y deja todo buscable.</p>
        <div class="cta"><button class="btn primary" data-act="folder" type="button">${icon("folder")}Cargar carpeta</button>
        <button class="btn" data-act="files" type="button">${icon("upload")}Elegir archivos</button></div>
        <p class="formats"><b>Formatos:</b> carpetas de AntionWhat (.json, .html, index.html) · exportaciones .txt de WhatsApp · copias guardadas desde este visor.</p>
      </div><div class="dropzone" data-act="folder">${icon("upload")}<b>Arrastra aquí una carpeta</b><span>o varios archivos a la vez</span></div></div>
      <div class="steps">
        <div class="step"><div class="num">1</div><b>Exporta con AntionWhat</b><p>La app de escritorio genera una carpeta con un .json y un .html por chat, y sus archivos.</p></div>
        <div class="step"><div class="num">2</div><b>Carga una o varias copias</b><p>Cada carpeta es una copia. Si un chat está en varias, se combinan en orden y sin repetir.</p></div>
        <div class="step"><div class="num">3</div><b>Consulta y busca</b><p>Fotos, videos y audios se ven mientras la carpeta esté cargada. Los chats quedan guardados en este navegador.</p></div>
      </div></div>`;
      return;
    }
    const chats = [...state.chats.values()];
    let msgs = 0, media = 0, arts = 0, first = null, last = null, multi = 0;
    const months = new Map(), kinds = new Map(), sums = [];
    for (const chat of chats) {
      const all = merged(chat);
      const s = C.chatSummary(all, state.showArtifacts);
      msgs += s.count; media += s.media; sums.push({ chat, s });
      for (const m of all) if (m.art) arts++;
      if (s.first !== null && (first === null || s.first < first)) first = s.first;
      if (s.last !== null && (last === null || s.last > last)) last = s.last;
      if (Object.keys(chat.parts).length > 1) multi++;
      for (const m of visible(all)) {
        if (m.mt) kinds.set(m.mt, (kinds.get(m.mt) || 0) + 1);
        const dn = C.dayNumber(m.date);
        if (dn !== null) { const d = C.dayToDate(dn); const k = d.getUTCFullYear() * 12 + d.getUTCMonth(); months.set(k, (months.get(k) || 0) + 1); }
      }
    }
    // actividad: últimos 12 meses con datos
    const keys = [...months.keys()].sort((a, b) => a - b);
    const lastK = keys.length ? keys[keys.length - 1] : 0;
    const span = [];
    for (let k = lastK - 11; k <= lastK; k++) span.push(k);
    const maxM = Math.max(1, ...span.map((k) => months.get(k) || 0));
    const MON = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
    const bars = span.map((k) => {
      const v = months.get(k) || 0;
      return `<div class="bar" title="${MON[k % 12]} ${Math.floor(k / 12)}: ${fmt(v)} mensajes"><em>${v ? fmt(v) : ""}</em>` +
        `<i class="b${Math.round((v / maxM) * 20)}"></i><span>${MON[k % 12]}</span></div>`;
    }).join("");
    const top = sums.sort((a, b) => b.s.count - a.s.count).slice(0, 6).map(({ chat, s }) =>
      `<li><button data-id="${esc(chat.id)}" type="button"><div class="avatar ${hueClass(chat.name)}">${esc(initials(chat.name))}</div>` +
      `<span class="nm">${esc(chat.name)}</span><span class="v">${fmt(s.count)}</span></button></li>`).join("");
    const srcs = [...state.sources.values()].sort((a, b) => b.fileDate - a.fileDate).map((s) =>
      `<div class="source">${icon("layers")}<div class="info"><b>${esc(s.label)}</b>` +
      `<span>Archivos del ${esc(new Date(s.fileDate).toLocaleDateString("es-CO"))} · ${plural(s.chats, "chat", "chats")} · ${plural(s.messages, "mensaje", "mensajes")}</span></div>` +
      `<button class="icon-btn" data-remove="${esc(s.id)}" type="button" title="Quitar esta copia">${icon("trash")}</button></div>`).join("");
    const kindHtml = [...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) =>
      `<span>${icon(mediaInfo(k)[1])}${esc(mediaInfo(k)[0])}: ${fmt(v)}</span>`).join("");
    const quality = arts || state.showArtifacts ? `<div class="quality">${icon("alert")}<div>
      <b>${plural(arts, "mensaje falso detectado", "mensajes falsos detectados")} en copias antiguas</b>
      <p>Versiones antiguas del lector guardaban los botones de la barra de escribir (micrófono y stickers) como mensajes: un trío «nota de voz, sticker, nota de voz» sin texto. Están ${state.showArtifacts ? "visibles y marcados en naranja" : "ocultos"}; no se borra nada.</p>
      <label class="switch"><input type="checkbox" id="toggle-art"${state.showArtifacts ? " checked" : ""}> Mostrar mensajes falsos</label></div></div>` : "";
    home.innerHTML = `<div class="home-inner">
      <div class="dash-head"><div><h1>Resumen de tus copias</h1>
        <p>${first !== null ? `Del ${esc(C.shortDay(first))} al ${esc(C.shortDay(last))}` : "Sin fechas reconocidas"}${multi ? ` · ${plural(multi, "chat combinado", "chats combinados")} de varias copias` : ""}</p></div>
        <div class="btns"><button class="btn m-back" data-act="list" type="button">${icon("back")}Chats</button><button class="btn" data-act="export" type="button">${icon("download")}Guardar copia combinada</button>
        <button class="btn ghost" data-act="clear" type="button">${icon("trash")}Borrar todo</button></div></div>
      <div class="kpis">
        <div class="kpi"><span>Chats</span><b>${fmt(chats.length)}</b></div>
        <div class="kpi"><span>Mensajes</span><b>${fmt(msgs)}</b></div>
        <div class="kpi"><span>Fotos, audios y documentos</span><b>${fmt(media)}</b></div>
        <div class="kpi"><span>Copias cargadas</span><b>${fmt(state.sources.size)}</b></div>
      </div>
      ${quality}
      <div class="grid2">
        <div class="card"><h2>${icon("chat")}Mensajes por mes</h2><p class="sub">Últimos 12 meses con actividad</p><div class="bars">${bars}</div></div>
        <div class="card"><h2>${icon("star")}Chats con más mensajes</h2><ul class="toplist">${top}</ul></div>
      </div>
      <div class="grid2">
        <div class="card"><h2>${icon("layers")}Copias cargadas</h2><p class="sub">Si un chat aparece en varias, se combina sin repetir mensajes.</p><div class="sources">${srcs}</div></div>
        <div class="card"><h2>${icon("image")}Multimedia</h2><div class="media-kinds">${kindHtml || "<span>Sin multimedia</span>"}</div></div>
      </div>
      <p class="privacy">${icon("shield")}Todo se procesa en este navegador. Los chats se guardan aquí mismo${Store.persistent ? "" : " (este navegador no permite guardar: se perderán al cerrar)"}; los archivos multimedia se ven mientras la carpeta esté cargada.</p>
    </div>`;
    // alturas de barra como clases (sin estilos en línea por la CSP)
    home.querySelectorAll(".bar i").forEach((el) => { const lvl = +el.className.slice(1); el.style.height = (lvl * 5) + "%"; });
  }

  // ── conversación ──────────────────────────────────────────────────────
  let gallery = [], gi = 0, marks = [], markIdx = -1, pin = null;

  function mediaHtml(m) {
    const [label, ic] = mediaInfo(m.mt);
    const file = mediaFile(m.mf);
    if (!file) {
      const why = m.mf ? " (carga la carpeta para verlo)" : "";
      const nm = m.mn ? ": " + esc(m.mn) : "";
      return [`<span class="m m-miss">${icon(ic)}${label} no disponible${nm}${why}</span>`, "missing"];
    }
    const url = esc(urlFor(file));
    if (m.mt === "image" || m.mt === "gif") { gallery.push({ m, file }); return [`<img class="m m-img" src="${url}" alt="${label}" loading="lazy" data-g="${gallery.length - 1}">`, "visual"]; }
    if (m.mt === "sticker") return [`<img class="m m-stk" src="${url}" alt="Sticker" loading="lazy">`, "sticker"];
    if (m.mt === "audio" || m.mt === "voice") return [`<audio class="m m-aud" controls preload="none" src="${url}"></audio>`, "audio"];
    if (m.mt === "video") { gallery.push({ m, file }); return [`<span class="m m-vid"><video controls preload="metadata" src="${url}"></video><button class="m-exp" data-g="${gallery.length - 1}" type="button" title="Ver en grande">${icon("expand")}</button></span>`, "video"]; }
    const name = m.mn || file.name;
    const ext = (name.includes(".") ? name.split(".").pop() : "file").slice(0, 4).toUpperCase();
    return [`<a class="m m-doc" href="${url}" target="_blank" rel="noopener" download="${esc(name)}"><span class="badge">${esc(ext)}</span><div><div class="nm">${esc(name)}</div><div class="sub">${label} · Abrir</div></div></a>`, "doc"];
  }

  function openChat(id, q, keepScroll) {
    const chat = state.chats.get(id);
    if (!chat) return;
    state.cur = id;
    gallery = [];
    $("#list").querySelectorAll(".row.on").forEach((r) => r.classList.remove("on"));
    const row = $("#list").querySelector(`.row[data-id="${CSS.escape(id)}"]`);
    if (row) row.classList.add("on");
    $("#home").hidden = true; $("#conv").hidden = false; $("#app").classList.add("open");
    const s = summary(chat);
    const av = $("#h-av"); av.className = "avatar sm " + hueClass(chat.name); av.textContent = initials(chat.name);
    $("#h-name").textContent = chat.name;
    const sub = [plural(s.count, "mensaje", "mensajes")];
    if (s.media) sub.push(plural(s.media, "archivo", "archivos"));
    if (s.first !== null) sub.push(s.first === s.last ? C.shortDay(s.first) : `${C.shortDay(s.first)} – ${C.shortDay(s.last)}`);
    if (s.copies > 1) sub.push(`combinado de ${s.copies} copias`);
    if (s.artifacts) sub.push(`${fmt(s.artifacts)} falsos ocultos`);
    $("#h-sub").textContent = sub.join(" · ");
    $("#fav").classList.toggle("on", !!chat.fav);

    const out = []; let prev = null, prevDate = null;
    visible(merged(chat)).forEach((m, k) => {
      if (m.date && m.date !== prevDate) { out.push(`<div class="day">${esc(m.date)}</div>`); prevDate = m.date; prev = null; }
      const first = m.d !== prev; prev = m.d;
      const meta = m.ts ? `<span class="meta"><time>${esc(m.ts)}</time></span>` : "";
      const author = m.au ? `<span class="author">${esc(m.au)}</span>` : "";
      const art = m.art ? `<span class="art-tag">Mensaje falso de una versión antigua</span>` : "";
      const text = m.t ? `<span class="text">${esc(m.t)}</span>` : "";
      let cls = "bubble", media = "";
      if (m.mt) { const [h, kind] = mediaHtml(m); media = h; cls += text ? " with-media" : " media" + (kind === "visual" || kind === "sticker" ? " " + kind : ""); }
      out.push(`<div class="msg ${m.d === "o" ? "out" : "in"}${first ? " first" : ""}${m.art ? " art" : ""}" data-k="${k}"><div class="${cls}">${art}${author}${media}${text}${meta}</div></div>`);
    });
    const thread = $("#thread");
    const keep = keepScroll ? thread.scrollTop : null;
    $("#msgs").innerHTML = out.join("") || `<div class="none">Este chat no tiene mensajes.</div>`;
    if (keep !== null) thread.scrollTop = keep; else { pin = "bottom"; thread.scrollTop = thread.scrollHeight; }
    closeFind();
    if (q) openFind(q);
    try { history.replaceState(null, "", "#c=" + encodeURIComponent(id)); } catch (e) { /* file:// */ }
  }

  function goHome(show) {
    state.cur = null;
    $("#conv").hidden = true; $("#home").hidden = false;
    $("#list").querySelectorAll(".row.on").forEach((r) => r.classList.remove("on"));
    // en el celular el resumen es una pantalla aparte: se abre al tocar la marca
    $("#app").classList.toggle("open", !!show || !state.chats.size);
    renderHome();
    try { history.replaceState(null, "", location.pathname); } catch (e) { /* file:// */ }
  }

  // ── buscar en la conversación ─────────────────────────────────────────
  function runFind() {
    const fq = C.fold($("#find-q").value.trim());
    const chat = state.chats.get(state.cur);
    const msgs = chat ? visible(merged(chat)) : [];
    $("#msgs").querySelectorAll(".text").forEach((span) => {
      const m = msgs[+span.closest(".msg").dataset.k];
      if (!m) return;
      span.innerHTML = fq && C.fold(m.t).includes(fq) ? highlight(m.t, fq) : esc(m.t);
    });
    marks = fq ? [...$("#msgs").querySelectorAll("mark")] : [];
    markIdx = -1;
    if (marks.length) gotoMark(marks.length - 1); else updateCount();
  }
  function updateCount() {
    const has = !!$("#find-q").value.trim();
    $("#find-n").textContent = !has ? "" : marks.length ? `${markIdx + 1} de ${marks.length}` : "Sin resultados";
    $("#find-prev").disabled = $("#find-next").disabled = marks.length < 2;
  }
  function gotoMark(k) {
    if (!marks.length) return;
    if (marks[markIdx]) marks[markIdx].classList.remove("cur");
    markIdx = (k + marks.length) % marks.length;
    marks[markIdx].classList.add("cur");
    marks[markIdx].scrollIntoView({ block: "center" });
    pin = "mark"; updateCount();
  }
  function openFind(q) { $("#find").classList.add("on"); if (q != null) $("#find-q").value = q; $("#find-q").focus(); $("#find-q").select(); runFind(); }
  function closeFind() { $("#find").classList.remove("on"); $("#find-q").value = ""; marks = []; markIdx = -1; updateCount(); }

  // ── galería ───────────────────────────────────────────────────────────
  function showLb(k) {
    if (!gallery.length) return;
    gi = (k + gallery.length) % gallery.length;
    const { m, file } = gallery[gi]; const url = esc(urlFor(file));
    $("#lb-media").innerHTML = m.mt === "video" ? `<video src="${url}" controls autoplay playsinline></video>` : `<img src="${url}" alt="">`;
    $("#lb-t").textContent = `${gi + 1} de ${gallery.length}` + (m.date ? `  ·  ${m.date}` : "") + (m.ts ? ` ${m.ts}` : "");
    $("#lb-open").setAttribute("href", urlFor(file));
    $("#lb-prev").hidden = $("#lb-next").hidden = gallery.length < 2;
    $("#lb").classList.add("on");
  }
  function closeLb() { const v = $("#lb-media").querySelector("video"); if (v) v.pause(); $("#lb-media").innerHTML = ""; $("#lb").classList.remove("on"); }

  // ── exportar ──────────────────────────────────────────────────────────
  function download(name, data) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function exportAll() {
    const chats = [...state.chats.values()].map((c) => ({ name: c.name, isGroup: !!c.isGroup, fav: !!c.fav, messages: merged(c) }));
    download(`antionwhat-copia-combinada-${new Date().toISOString().slice(0, 10)}.json`,
      { format: "antionwhat-web", version: 2, exportedAt: new Date().toISOString(), sources: [...state.sources.values()].map((s) => s.label), chats });
    toast("Copia combinada descargada");
  }
  function exportChat(chat) {
    // Mismo formato que los .json de AntionWhat: se puede volver a cargar aquí o en otras herramientas.
    const recs = []; let prevDate = null;
    for (const m of merged(chat)) {
      if (m.art) continue;
      if (m.date && m.date !== prevDate) { recs.push({ dir: "DATE_SEP", text: m.date }); prevDate = m.date; }
      const r = { ts: m.ts || "", dir: m.d, text: m.t || "" };
      if (m.date) r.date = m.date; if (m.mt) r.media_type = m.mt; if (m.mf) r.media_file = m.mf; if (m.mn) r.media_name = m.mn;
      recs.push(r);
    }
    download(chat.name.replace(/[\\/:*?"<>|]/g, "_") + ".json", recs);
  }

  // ── eventos ───────────────────────────────────────────────────────────
  function render() { renderList(); if (state.cur && state.chats.has(state.cur)) openChat(state.cur, null, true); else goHome(); }

  $("#pick-folder").addEventListener("click", () => $("#in-folder").click());
  $("#pick-files").addEventListener("click", () => $("#in-files").click());
  const fromInput = (input) => [...input.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }));
  $("#in-folder").addEventListener("change", async (e) => { await importEntries(fromInput(e.target)); e.target.value = ""; });
  $("#in-files").addEventListener("change", async (e) => { await importEntries(fromInput(e.target)); e.target.value = ""; });

  // arrastrar y soltar en toda la ventana (la versión anterior nunca llamaba a preventDefault)
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { if ([...(e.dataTransfer.types || [])].includes("Files")) { e.preventDefault(); dragDepth++; $("#drop").hidden = false; } });
  window.addEventListener("dragover", (e) => { if ([...(e.dataTransfer.types || [])].includes("Files")) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#drop").hidden = true; } });
  window.addEventListener("drop", async (e) => {
    e.preventDefault(); dragDepth = 0; $("#drop").hidden = true;
    if (e.dataTransfer && e.dataTransfer.files.length) await importEntries(await filesFromDrop(e.dataTransfer));
  });

  $("#list").addEventListener("click", (e) => { const r = e.target.closest(".row"); if (r) openChat(r.dataset.id, state.query.trim()); });
  $("#home").addEventListener("click", async (e) => {
    const t = e.target.closest("[data-act],[data-id],[data-remove]");
    if (!t) return;
    if (t.dataset.id) return openChat(t.dataset.id);
    if (t.dataset.remove) {
      const s = state.sources.get(t.dataset.remove);
      if (s && await confirmDialog("Quitar copia", `¿Quitar «${s.label}» del visor?\nLos chats que solo estaban en esta copia desaparecerán del visor. Tus archivos no se tocan.`, "Quitar")) await removeSource(s.id);
      return;
    }
    const act = t.dataset.act;
    if (act === "folder") $("#in-folder").click();
    else if (act === "files") $("#in-files").click();
    else if (act === "export") exportAll();
    else if (act === "list") $("#app").classList.remove("open");
    else if (act === "clear" && await confirmDialog("Borrar todo", "¿Quitar todas las copias y chats de este navegador?\nTus archivos originales no se tocan.", "Borrar todo")) {
      await Store.clear(); state.chats.clear(); state.sources.clear(); invalidate(); state.cur = null; render(); toast("Visor vaciado");
    }
  });
  $("#home").addEventListener("change", (e) => {
    if (e.target.id !== "toggle-art") return;
    state.showArtifacts = e.target.checked;
    try { localStorage.setItem("aw_show_art", state.showArtifacts ? "1" : "0"); } catch (err) { /* sin almacenamiento */ }
    invalidate(); render();
  });
  $("#home").addEventListener("dragover", (e) => { const z = e.target.closest(".dropzone"); if (z) z.classList.add("over"); });
  $("#home").addEventListener("dragleave", (e) => { const z = e.target.closest(".dropzone"); if (z) z.classList.remove("over"); });

  let qTimer = 0;
  $("#q").addEventListener("input", (e) => { state.query = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(renderList, 140); });
  $("#chips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    document.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", x === b));
    state.filter = b.dataset.f; renderList();
  });
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderList(); });
  $("#go-home").addEventListener("click", () => goHome(true));
  $("#back").addEventListener("click", () => { state.cur = null; $("#app").classList.remove("open"); $("#conv").hidden = true; $("#home").hidden = false; renderList(); });

  $("#fav").addEventListener("click", async () => {
    const chat = state.chats.get(state.cur); if (!chat) return;
    chat.fav = !chat.fav; $("#fav").classList.toggle("on", chat.fav);
    try { await Store.saveChats([chat]); } catch (e) { /* solo memoria */ }
    renderList();
  });
  $("#export-chat").addEventListener("click", () => { const c = state.chats.get(state.cur); if (c) exportChat(c); });
  $("#delete-chat").addEventListener("click", async () => {
    const chat = state.chats.get(state.cur); if (!chat) return;
    if (!await confirmDialog("Quitar chat", `¿Quitar «${chat.name}» del visor?\nTus archivos originales no se tocan.`, "Quitar")) return;
    state.chats.delete(chat.id); invalidate(chat.id);
    try { await Store.deleteChat(chat.id); } catch (e) { /* solo memoria */ }
    state.cur = null; render(); toast("Chat quitado del visor");
  });

  const thread = $("#thread"), fab = $("#fab");
  thread.addEventListener("scroll", () => fab.classList.toggle("on", thread.scrollHeight - thread.scrollTop - thread.clientHeight > 600));
  fab.addEventListener("click", () => { thread.scrollTop = thread.scrollHeight; });
  $("#msgs").addEventListener("load", () => {
    if (pin === "bottom") thread.scrollTop = thread.scrollHeight;
    else if (pin === "mark" && marks[markIdx]) marks[markIdx].scrollIntoView({ block: "center" });
  }, true);
  ["wheel", "touchstart", "mousedown"].forEach((ev) => thread.addEventListener(ev, () => { pin = null; }, { passive: true }));
  $("#msgs").addEventListener("click", (e) => { const t = e.target.closest("[data-g]"); if (t) { e.preventDefault(); showLb(+t.dataset.g); } });

  let fTimer = 0;
  $("#find-open").addEventListener("click", () => ($("#find").classList.contains("on") ? closeFind() : openFind()));
  $("#find-close").addEventListener("click", () => { closeFind(); runFind(); });
  $("#find-prev").addEventListener("click", () => gotoMark(markIdx - 1));
  $("#find-next").addEventListener("click", () => gotoMark(markIdx + 1));
  $("#find-q").addEventListener("input", () => { clearTimeout(fTimer); fTimer = setTimeout(runFind, 150); });
  $("#find-q").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); gotoMark(markIdx + (e.shiftKey ? 1 : -1)); } });

  $("#lb-x").addEventListener("click", closeLb);
  $("#lb-prev").addEventListener("click", () => showLb(gi - 1));
  $("#lb-next").addEventListener("click", () => showLb(gi + 1));
  $("#lb").addEventListener("click", (e) => { if (e.target.id === "lb" || e.target.id === "lb-media" || e.target.classList.contains("stage")) closeLb(); });

  const rootEl = document.documentElement;
  const effectiveTheme = () => rootEl.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const syncThemeIcon = () => $("#theme use").setAttribute("href", effectiveTheme() === "dark" ? "#i-sun" : "#i-moon");
  $("#theme").addEventListener("click", () => {
    rootEl.dataset.theme = effectiveTheme() === "dark" ? "light" : "dark";
    try { localStorage.setItem("aw_theme", rootEl.dataset.theme); } catch (e) { /* sin almacenamiento */ }
    syncThemeIcon();
  });
  try { const t = localStorage.getItem("aw_theme"); if (t === "light" || t === "dark") rootEl.dataset.theme = t; } catch (e) { /* */ }
  syncThemeIcon();

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if ($("#lb").classList.contains("on")) {
      if (e.key === "Escape") closeLb(); else if (e.key === "ArrowLeft") showLb(gi - 1); else if (e.key === "ArrowRight") showLb(gi + 1);
      return;
    }
    if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); if (state.cur && !e.shiftKey) openFind(); else { $("#q").focus(); $("#q").select(); } }
    else if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); $("#q").focus(); $("#q").select(); }
    else if (e.key === "Escape" && $("#find").classList.contains("on")) { closeFind(); runFind(); }
  });

  // ── arranque ──────────────────────────────────────────────────────────
  (async function boot() {
    const { chats, sources } = await Store.load().catch(() => ({ chats: [], sources: [] }));
    chats.forEach((c) => state.chats.set(c.id, c));
    sources.forEach((s) => state.sources.set(s.id, s));
    renderList();
    const m = /#c=([^&]+)/.exec(location.hash);
    if (m && state.chats.has(decodeURIComponent(m[1]))) openChat(decodeURIComponent(m[1]));
    else goHome();
    window.AW = { importEntries, state };   // para pruebas automatizadas
  })();
})();
