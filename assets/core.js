/* AntionWhat Web — núcleo puro (sin DOM): lectores de formatos, fechas,
 * combinación de copias y detección de mensajes falsos.
 *
 * Funciona en el navegador (window.AWCore) y en Node (module.exports) para
 * poder probarse sin interfaz.
 *
 * Modelo de mensaje normalizado:
 *   { d: "i"|"o", t: texto, ts: "10:04 a. m.", date: "11 de julio de 2026",
 *     mt: tipo de multimedia, mf: ruta del archivo, mn: nombre mostrado,
 *     au: autor (grupos), art: true si es un mensaje falso conocido }
 * Los separadores de fecha no se guardan: la fecha va en cada mensaje.
 */
(function (root) {
  "use strict";

  // ── texto ───────────────────────────────────────────────────────────────
  const FOLD = new Map();
  function foldChar(ch) {
    let f = FOLD.get(ch);
    if (f === undefined) {
      f = ch.normalize("NFD")[0].toLowerCase();
      if (f.length !== 1) f = ch;
      FOLD.set(ch, f);
    }
    return f;
  }
  /** Minúsculas sin acentos, conservando la longitud (para resaltar). */
  function fold(s) {
    s = String(s || "");
    let out = "";
    for (let k = 0; k < s.length; k++) out += foldChar(s[k]);
    return out;
  }
  const cleanSpaces = (s) => String(s || "").replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();
  const READ_MORE = /\s*(?:\.\.\.|…)\s*Leer más\s*$/;
  const stripReadMore = (t) => String(t || "").replace(READ_MORE, "");

  /** Clave estable de un chat a partir de su nombre (o número). */
  function chatKey(name) {
    const n = cleanSpaces(name);
    const digits = n.replace(/\D/g, "");
    if (digits.length >= 7 && !/[a-zA-ZÀ-ÿ]/.test(n)) return "tel:" + digits.slice(-10);
    return "n:" + fold(n);
  }

  // ── fechas ──────────────────────────────────────────────────────────────
  const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
    "septiembre", "octubre", "noviembre", "diciembre"];
  const WEEKDAYS = ["domingo", "lunes", "martes", "miercoles", "jueves", "viernes", "sabado"];
  const DAY_MS = 86400000;

  function fmtDate(d) {
    return `${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`;
  }

  /** Convierte un separador de WhatsApp a fecha absoluta («11 de julio de 2026»).
   *  ref = fecha de la exportación (para «Hoy», «Ayer», días de la semana). */
  function resolveDate(text, ref) {
    const raw = cleanSpaces(text);
    if (!raw) return "";
    const low = fold(raw);
    const base = ref ? new Date(ref) : null;
    if (base) base.setHours(12, 0, 0, 0);
    if (low === "hoy" && base) return fmtDate(base);
    if (low === "ayer" && base) return fmtDate(new Date(base - DAY_MS));
    const wd = WEEKDAYS.indexOf(low);
    if (wd >= 0 && base) {
      const back = ((base.getDay() - wd + 7) % 7) || 7;
      return fmtDate(new Date(base - back * DAY_MS));
    }
    let m = /(\d{1,2}) de ([a-z]+)(?: de (\d{4}))?/.exec(low);
    if (m && MONTHS.includes(m[2])) {
      let year = m[3] ? +m[3] : (base ? base.getFullYear() : new Date().getFullYear());
      const d = new Date(year, MONTHS.indexOf(m[2]), +m[1], 12);
      if (!m[3] && base && d > base) d.setFullYear(year - 1);
      return fmtDate(d);
    }
    m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/.exec(low);
    if (m) {
      let y = +m[3]; if (y < 100) y += 2000;
      return fmtDate(new Date(y, +m[2] - 1, +m[1], 12));
    }
    return raw;
  }

  /** Días desde 1970 para una fecha absoluta en español, o null. */
  function dayNumber(date) {
    const m = /(\d{1,2}) de ([a-z]+) de (\d{4})/.exec(fold(date));
    if (!m || !MONTHS.includes(m[2])) return null;
    return Math.round(Date.UTC(+m[3], MONTHS.indexOf(m[2]), +m[1]) / DAY_MS);
  }

  /** Minutos desde medianoche para «10:04 a. m.», «3:45 PM», «15:30». */
  function minuteOfDay(ts) {
    const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])?\.?\s*m?/i.exec(cleanSpaces(ts));
    if (!m) return null;
    let h = +m[1];
    const ap = (m[3] || "").toLowerCase();
    if (ap === "p" && h < 12) h += 12;
    if (ap === "a" && h === 12) h = 0;
    return h * 60 + +m[2];
  }

  // ── mensajes falsos conocidos ───────────────────────────────────────────
  /** Versiones antiguas del lector guardaban los botones de la barra de
   *  escribir (micrófono, emojis) como un trío de mensajes: voz entrante,
   *  sticker entrante, voz saliente, sin texto y con la misma hora en los
   *  tres (vacía, o la del mensaje más cercano). Aparecía una vez por cada
   *  pantalla recorrida, a veces con un archivo ajeno asignado. Medido en
   *  una copia real de 2.160 chats: 2.152 tríos, ninguno con horas
   *  distintas. Se marcan (art), no se borran. */
  function flagArtifacts(msgs) {
    let flagged = 0;
    for (let k = 0; k + 2 < msgs.length; k++) {
      const a = msgs[k], b = msgs[k + 1], c = msgs[k + 2];
      if (a.d === "i" && a.mt === "voice" && b.d === "i" && b.mt === "sticker" &&
          c.d === "o" && c.mt === "voice" && !a.t && !b.t && !c.t &&
          (a.ts || "") === (b.ts || "") && (b.ts || "") === (c.ts || "")) {
        a.art = b.art = c.art = true;
        flagged += 3;
        k += 2;
      }
    }
    return flagged;
  }

  // ── lectores ────────────────────────────────────────────────────────────
  /** Registros de AntionWhat ({dir, text, ts, date, media_*}) → mensajes. */
  function fromAntionRecords(records, ref) {
    const out = [];
    let date = "";
    for (const r of records || []) {
      if (!r || typeof r !== "object") continue;
      if (r.dir === "DATE_SEP") { date = resolveDate(r.text, ref); continue; }
      const m = { d: r.dir === "o" ? "o" : "i", t: stripReadMore(r.text || ""), ts: cleanSpaces(r.ts) };
      const own = r.date ? resolveDate(r.date, ref) : "";
      m.date = own || date;
      if (r.media_type) m.mt = r.media_type;
      if (r.media_file) m.mf = String(r.media_file).replace(/\\/g, "/");
      if (r.media_name) m.mn = r.media_name;
      out.push(m);
    }
    flagArtifacts(out);
    return out;
  }

  /** Nombre del chat a partir del nombre de archivo de AntionWhat. */
  function nameFromFilename(fn) {
    let n = String(fn).split(/[\\/]/).pop().replace(/\.(json|html?|txt)$/i, "");
    n = n.replace(/^Chat de WhatsApp con /i, "").replace(/^WhatsApp Chat with /i, "");
    if (/^_?\d{2}[ _]\d{3}/.test(n)) n = "+" + n.replace(/^_/, "").replace(/_/g, " ");
    return cleanSpaces(n) || "Chat sin nombre";
  }

  /** Detecta y lee un .json: sidecar de AntionWhat, o backup de esta web. */
  function parseJSONFile(text, filename, ref) {
    const data = JSON.parse(text);
    if (Array.isArray(data)) {
      return { kind: "chats", chats: [{ name: nameFromFilename(filename), messages: fromAntionRecords(data, ref) }] };
    }
    if (data && data.format === "antionwhat-web" && Array.isArray(data.chats)) {
      return { kind: "chats", chats: data.chats.map((c) => ({
        name: c.name, isGroup: !!c.isGroup, fav: !!c.fav,
        messages: (c.messages || []).map(normalizeStored),
      })) };
    }
    // Backups de la versión anterior de esta web: {meta, chats:[…]} o {meta, chat}
    const legacy = data && (data.chats || (data.chat ? [data.chat] : null));
    if (Array.isArray(legacy)) {
      return { kind: "chats", chats: legacy.filter(Boolean).map((c) => ({
        name: c.name || nameFromFilename(c.filename || filename), isGroup: !!c.isGroup,
        messages: (c.messages || []).map((m) => ({
          d: m.out ? "o" : "i", t: m.text || "", ts: cleanSpaces(m.time),
          date: m.date ? resolveDate(m.date, ref) : "", mt: m.mediaType || undefined, au: m.author || undefined,
        })),
      })) };
    }
    throw new Error("JSON no reconocido");
  }

  function normalizeStored(m) {
    const o = { d: m.d === "o" ? "o" : "i", t: m.t || "", ts: m.ts || "", date: m.date || "" };
    for (const k of ["mt", "mf", "mn", "au"]) if (m[k]) o[k] = m[k];
    if (m.art) o.art = true;
    return o;
  }

  /** index.html de AntionWhat (visor combinado): versión nueva (const DATA)
   *  y antigua (const CHATS). Un solo archivo trae todos los chats. */
  function parseAntionIndex(html, ref) {
    let m = /const DATA = (\{[\s\S]*?\});\s*\n/.exec(html);
    if (m) {
      const data = JSON.parse(m[1]);
      return { kind: "chats", chats: data.chats.map((c) => {
        const msgs = [];
        let date = "";
        for (const x of c.m || []) {
          if (x.d === "s") { date = resolveDate(x.t, ref); continue; }
          const dt = x.dt && x.ts ? x.dt.replace(x.ts, "").trim() : "";
          const msg = { d: x.d === "o" ? "o" : "i", t: x.t || "", ts: cleanSpaces(x.ts), date: (dt && resolveDate(dt, ref)) || date };
          if (x.mt) msg.mt = x.mt;
          if (x.mf) msg.mf = x.mf;
          if (x.mn) msg.mn = x.mn;
          msgs.push(msg);
        }
        flagArtifacts(msgs);
        return { name: c.n, messages: msgs, failed: c.s === "failed" };
      }) };
    }
    m = /const CHATS=(\[[\s\S]*?\]);\s*\n/.exec(html);
    if (m) {
      const list = JSON.parse(m[1]);
      return { kind: "chats", chats: list.map((c) => ({
        name: c.name,
        failed: c.status === "failed",
        messages: fromAntionRecords((c.msgs || []).map((x) => ({
          dir: x.dir, text: x.dir === "DATE_SEP" ? x.txt : x.txt, ts: x.ts,
          date: x.dt && x.ts ? x.dt.replace(x.ts, "").trim() : "", media_type: x.mt, media_file: x.mf,
        })), ref),
      })) };
    }
    return null;
  }

  /** Página .html de un chat de AntionWhat (formato nuevo y antiguo). */
  function parseAntionChatHTML(doc, filename, ref) {
    const title = doc.querySelector(".top h1, .hi h2, .hdr h2, title");
    const name = cleanSpaces(title ? title.textContent : "") || nameFromFilename(filename);
    const nodes = doc.querySelectorAll(".thread-inner > .day, .thread-inner > .msg, .chat > .date-sep, .chat > .m");
    if (!nodes.length) return null;
    const records = [];
    nodes.forEach((el) => {
      if (el.classList.contains("day") || el.classList.contains("date-sep")) {
        records.push({ dir: "DATE_SEP", text: el.textContent.trim() });
        return;
      }
      const out = el.classList.contains("out") || el.classList.contains("o");
      const timeEl = el.querySelector("time, .ts, .ts-media");
      const textEl = el.querySelector(".text");
      let text = "";
      if (textEl) text = textEl.textContent;
      else {
        const clone = el.cloneNode(true);
        clone.querySelectorAll(".ts, .ts-media, .media-ph, .media-link, a, img, video, audio, .meta").forEach((x) => x.remove());
        clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
        text = clone.textContent;
      }
      const media = el.querySelector("img, video, audio, .m-doc, .media-link, .m-miss, .media-ph");
      let mt;
      if (media) {
        const tag = media.tagName.toLowerCase();
        const lbl = fold(media.textContent || media.getAttribute("alt") || "");
        mt = tag === "video" ? "video" : tag === "audio" ? (lbl.includes("voz") ? "voice" : "audio")
          : tag === "img" ? (media.classList.contains("m-stk") || media.classList.contains("media-stk") ? "sticker" : "image")
          : /voz/.test(lbl) ? "voice" : /audio/.test(lbl) ? "audio" : /video/.test(lbl) ? "video"
          : /sticker/.test(lbl) ? "sticker" : /imagen|foto/.test(lbl) ? "image" : "document";
      }
      const src = media && (media.getAttribute("src") || media.getAttribute("href"));
      records.push({ dir: out ? "o" : "i", text: text.trim(), ts: timeEl ? timeEl.textContent : "",
        media_type: mt, media_file: src && !/^(https?|data|blob):/.test(src) ? decodeURIComponent(src) : undefined });
    });
    return { kind: "chats", chats: [{ name, messages: fromAntionRecords(records, ref) }] };
  }

  /** Exportación nativa de WhatsApp (.txt): «12/05/24, 3:45 p. m. - Autor: texto». */
  function parseWhatsAppTXT(text, filename, ref) {
    const lines = String(text).replace(/\r/g, "").split("\n");
    if (lines.some((l) => /^(ENTRANTE|SALIENTE):/.test(l))) return parseLegacyTXT(lines, filename);
    const re = /^‎?\[?(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}),?\s+(\d{1,2}:\d{2}(?::\d{2})?(?:[\s  ]*[aApP]\.?[\s  ]*[mM]\.?)?)\]?\s*(?:[-–]\s*)?(.*)$/;
    const msgs = [];
    const authors = new Map();
    let cur = null;
    for (const line of lines) {
      const m = re.exec(line);
      if (m) {
        const [, d, ts, rest] = m;
        const ix = rest.indexOf(": ");
        if (ix < 0) { cur = null; continue; }                // mensaje del sistema
        const au = rest.slice(0, ix).replace(/^‎/, "").trim();
        let body = rest.slice(ix + 2);
        authors.set(au, (authors.get(au) || 0) + 1);
        const msg = { d: "i", au, t: body, ts: cleanSpaces(ts), date: resolveDate(d, ref) };
        const att = /<(?:adjunto|attached):\s*([^>]+)>/i.exec(body) || /^‎?(\S+\.\w{2,4}) \((?:archivo adjunto|file attached)\)/i.exec(body);
        if (att) {
          msg.mf = att[1].trim(); msg.mn = msg.mf; msg.t = "";
          msg.mt = /\.(jpe?g|png|webp|heic)$/i.test(msg.mf) ? "image" : /\.(mp4|3gp|mov)$/i.test(msg.mf) ? "video"
            : /\.(opus|ogg)$/i.test(msg.mf) ? "voice" : /\.(mp3|m4a|aac)$/i.test(msg.mf) ? "audio" : "document";
        } else if (/<(?:Multimedia omitido|Media omitted)>/i.test(body)) {
          msg.mt = "image"; msg.t = ""; msg.omitted = true;
        }
        msgs.push(msg);
        cur = msg;
      } else if (cur && line.trim()) {
        cur.t += (cur.t ? "\n" : "") + line;
      }
    }
    if (!msgs.length) return null;
    const name = nameFromFilename(filename);
    const nameKey = fold(name);
    const list = [...authors.keys()];
    const isGroup = list.length > 2;
    // En chats 1 a 1, el contacto es quien tiene el nombre del chat; el otro autor es el dueño.
    // Si no se puede saber quién es quién, se muestran los nombres en vez de adivinar.
    const contact = list.find((a) => fold(a) === nameKey);
    for (const m of msgs) {
      if (!isGroup && contact) { m.d = m.au === contact ? "i" : "o"; delete m.au; }
    }
    return { kind: "chats", chats: [{ name, isGroup, messages: msgs }] };
  }

  function parseLegacyTXT(lines, filename) {
    const msgs = [];
    let cur = null;
    for (const line of lines) {
      const m = /^(?:\[([^\]]+)\]\s+)?(ENTRANTE|SALIENTE):\s*(.*)$/.exec(line);
      if (m) {
        cur = { d: m[2] === "SALIENTE" ? "o" : "i", t: m[3], ts: cleanSpaces(m[1]), date: "" };
        const media = /^\[(IMAGE|VIDEO|AUDIO|STICKER)\]$/i.exec(m[3]);
        if (media) { cur.mt = media[1].toLowerCase(); cur.t = ""; }
        msgs.push(cur);
      } else if (cur && line.trim() && !/^(Chat|Exportado|Mensajes):/.test(line)) {
        cur.t += "\n" + line;
      }
    }
    return msgs.length ? { kind: "chats", chats: [{ name: nameFromFilename(filename), messages: msgs }] } : null;
  }

  // ── combinación de copias ───────────────────────────────────────────────
  /** Identidad de un mensaje entre copias: misma dirección, día, minuto,
   *  tipo y comienzo del texto (una copia antigua puede tenerlo recortado). */
  function messageKey(m) {
    return [m.d, dayNumber(m.date) ?? "", minuteOfDay(m.ts) ?? "", m.mt || "", fold(stripReadMore(m.t)).replace(/\s+/g, " ").slice(0, 60), m.mn || ""].join("|");
  }

  /** Une las partes de un chat (una por copia) sin duplicar mensajes.
   *  parts: [{ src, ref, messages }] en orden de importación. */
  function mergeParts(parts) {
    if (!parts.length) return [];
    if (parts.length === 1) return parts[0].messages.slice();
    const best = new Map();        // key -> { msg, count, order }
    parts.forEach((p, pi) => {
      const seen = new Map();
      let lastDay = null, lastMin = null;
      // Ordenable: día y minuto conocidos o heredados del mensaje anterior.
      const withKeys = p.messages.map((m, i) => {
        const dn = dayNumber(m.date); const mn = minuteOfDay(m.ts);
        if (dn !== null) lastDay = dn;
        if (mn !== null) lastMin = mn; else if (dn !== null && dn !== lastDay) lastMin = null;
        return { m, i, day: dn ?? lastDay, min: mn ?? lastMin };
      });
      // Rellenar hacia atrás los primeros sin fecha.
      let nextDay = null;
      for (let k = withKeys.length - 1; k >= 0; k--) {
        if (withKeys[k].day !== null) nextDay = withKeys[k].day; else withKeys[k].day = nextDay;
      }
      for (const w of withKeys) {
        const base = messageKey(w.m);
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        const key = base + "#" + n;              // repeticiones reales («Ok», «Ok»)
        const prev = best.get(key);
        const score = (x) => (x.t ? x.t.length : 0) + (x.ts ? 1000 : 0) + (x.mf ? 500 : 0) - (x.art ? 1e6 : 0);
        if (!prev) best.set(key, { msg: w.m, day: w.day, min: w.min, pi, i: w.i });
        else if (score(w.m) > score(prev.msg)) prev.msg = w.m;
      }
    });
    const all = [...best.values()];
    const big = 1e9;
    all.sort((a, b) => ((a.day ?? big) - (b.day ?? big)) || ((a.min ?? -1) - (b.min ?? -1)) || (a.pi - b.pi) || (a.i - b.i));
    return all.map((x) => x.msg);
  }

  // ── resumen ─────────────────────────────────────────────────────────────
  function chatSummary(messages, showArtifacts) {
    const vis = showArtifacts ? messages : messages.filter((m) => !m.art);
    let media = 0, first = null, last = null, lastMsg = null;
    for (const m of vis) {
      if (m.mt) media++;
      const dn = dayNumber(m.date);
      if (dn !== null) { if (first === null || dn < first) first = dn; if (last === null || dn > last) last = dn; }
      lastMsg = m;
    }
    return { count: vis.length, media, first, last, lastMsg, artifacts: messages.length - vis.length };
  }

  function dayToDate(dn) { return dn === null ? null : new Date(dn * DAY_MS + 12 * 3600000); }
  function shortDay(dn) {
    const d = dayToDate(dn);
    return d ? `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}` : "";
  }

  const api = {
    fold, cleanSpaces, chatKey, resolveDate, dayNumber, minuteOfDay, flagArtifacts,
    fromAntionRecords, nameFromFilename, parseJSONFile, parseAntionIndex, parseAntionChatHTML,
    parseWhatsAppTXT, messageKey, mergeParts, chatSummary, dayToDate, shortDay, MONTHS,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AWCore = api;
})(typeof window !== "undefined" ? window : globalThis);
