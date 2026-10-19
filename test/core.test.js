// Pruebas del núcleo (sin navegador): node --test test/
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../assets/core.js");

const REF = new Date(2026, 9, 16, 12); // viernes 16 de octubre de 2026

test("resuelve fechas relativas respecto a la fecha de la copia", () => {
  assert.equal(C.resolveDate("Hoy", REF), "16 de octubre de 2026");
  assert.equal(C.resolveDate("Ayer", REF), "15 de octubre de 2026");
  assert.equal(C.resolveDate("Lunes", REF), "12 de octubre de 2026");
  assert.equal(C.resolveDate("Miércoles", REF), "14 de octubre de 2026");
  assert.equal(C.resolveDate("20 de diciembre", REF), "20 de diciembre de 2025");
  assert.equal(C.resolveDate("11 de julio de 2026", REF), "11 de julio de 2026");
  assert.equal(C.resolveDate("12/05/24", REF), "12 de mayo de 2024");
});

test("lee horas con espacios especiales y a. m./p. m.", () => {
  assert.equal(C.minuteOfDay("10:04 a. m."), 604);
  assert.equal(C.minuteOfDay("3:45 p. m."), 945);
  assert.equal(C.minuteOfDay("12:10 a. m."), 10);
  assert.equal(C.minuteOfDay("15:30"), 930);
  assert.equal(C.minuteOfDay(""), null);
});

test("convierte un sidecar de AntionWhat y propaga la fecha", () => {
  const r = C.parseJSONFile(JSON.stringify([
    { dir: "DATE_SEP", text: "Ayer" },
    { dir: "i", text: "Hola", ts: "9:00 a. m." },
    { dir: "o", text: "", ts: "9:01 a. m.", media_type: "document", media_file: "x_media/a.pdf", media_name: "a.pdf" },
  ]), "+57 300 000 0000.json", REF);
  const chat = r.chats[0];
  assert.equal(chat.name, "+57 300 000 0000");
  assert.equal(chat.messages.length, 2);
  assert.equal(chat.messages[0].date, "15 de octubre de 2026");
  assert.equal(chat.messages[1].mn, "a.pdf");
});

test("marca los mensajes falsos de versiones antiguas (firma exacta)", () => {
  const fake = [
    { dir: "i", text: "Hola", ts: "9:00" },
    { dir: "i", text: "", ts: "", media_type: "voice" },
    { dir: "i", text: "", ts: "", media_type: "sticker", media_file: "x_media/ajeno.webp" },
    { dir: "o", text: "", ts: "", media_type: "voice" },
  ];
  const msgs = C.fromAntionRecords(fake, REF);
  assert.deepEqual(msgs.map((m) => !!m.art), [false, true, true, true]);
  // También en mitad del chat y con la hora del mensaje cercano (misma en los tres).
  const mid = C.fromAntionRecords([
    { dir: "i", text: "", ts: "10:03 a. m.", media_type: "voice" },
    { dir: "i", text: "", ts: "10:03 a. m.", media_type: "sticker" },
    { dir: "o", text: "", ts: "10:03 a. m.", media_type: "voice" },
    { dir: "i", text: "Sigue la conversación", ts: "10:05 a. m." },
  ], REF);
  assert.deepEqual(mid.map((m) => !!m.art), [true, true, true, false]);
  // Horas distintas = mensajes reales: no se marcan.
  const real = C.fromAntionRecords([{ dir: "i", ts: "9:00", media_type: "voice", text: "" },
    { dir: "i", ts: "9:02", media_type: "sticker", text: "" }, { dir: "o", ts: "9:10", media_type: "voice", text: "" }], REF);
  assert.ok(real.every((m) => !m.art));
});

test("combina dos copias sin duplicar y conserva repeticiones reales", () => {
  // WhatsApp recorta los mensajes largos (~700 caracteres) con «… Leer más».
  const largo = "Gracias por comunicarse con la sede. Horario de atención de lunes a viernes. ".repeat(10);
  const julio = C.fromAntionRecords([
    { dir: "DATE_SEP", text: "11 de julio de 2026" },
    { dir: "i", text: "Buenos días", ts: "9:00 a. m." },
    { dir: "o", text: "Ok", ts: "9:05 a. m." },
    { dir: "o", text: "Ok", ts: "9:05 a. m." },
    { dir: "i", text: largo.slice(0, 300) + "... Leer más", ts: "9:06 a. m." },
  ], REF);
  const octubre = C.fromAntionRecords([
    { dir: "DATE_SEP", text: "11 de julio de 2026" },
    { dir: "o", text: "Ok", ts: "9:05 a. m." },
    { dir: "o", text: "Ok", ts: "9:05 a. m." },
    { dir: "i", text: largo, ts: "9:06 a. m." },
    { dir: "DATE_SEP", text: "Hoy" },
    { dir: "i", text: "Mensaje nuevo", ts: "8:00 a. m." },
  ], REF);
  const merged = C.mergeParts([{ messages: julio }, { messages: octubre }]);
  assert.deepEqual(merged.map((m) => m.t), ["Buenos días", "Ok", "Ok", largo, "Mensaje nuevo"]);
});

test("una copia antigua no reintroduce el mensaje falso si la nueva lo tiene limpio", () => {
  const vieja = C.fromAntionRecords([
    { dir: "DATE_SEP", text: "1 de julio de 2026" },
    { dir: "i", text: "Hola", ts: "9:00" },
    { dir: "i", text: "", ts: "", media_type: "voice" },
    { dir: "i", text: "", ts: "", media_type: "sticker" },
    { dir: "o", text: "", ts: "", media_type: "voice" },
  ], REF);
  const merged = C.mergeParts([{ messages: vieja }, { messages: C.fromAntionRecords([
    { dir: "DATE_SEP", text: "1 de julio de 2026" }, { dir: "i", text: "Hola", ts: "9:00" }], REF) }]);
  assert.equal(merged.filter((m) => !m.art).length, 1);
});

test("lee una exportación nativa .txt de WhatsApp", () => {
  const txt = [
    "12/05/24, 3:45 p. m. - Los mensajes y las llamadas están cifrados de extremo a extremo.",
    "12/05/24, 3:46 p. m. - Ana Torres: Hola",
    "segunda línea",
    "12/05/24, 3:47 p. m. - Daniel: IMG-20240512-WA0001.jpg (archivo adjunto)",
  ].join("\n");
  const r = C.parseWhatsAppTXT(txt, "Chat de WhatsApp con Ana Torres.txt", REF);
  const c = r.chats[0];
  assert.equal(c.name, "Ana Torres");
  assert.equal(c.messages.length, 2);
  assert.equal(c.messages[0].d, "i");
  assert.equal(c.messages[0].t, "Hola\nsegunda línea");
  assert.equal(c.messages[1].d, "o");
  assert.equal(c.messages[1].mt, "image");
  assert.equal(c.messages[0].date, "12 de mayo de 2024");
});

test("lee el index.html nuevo (const DATA) y el antiguo (const CHATS)", () => {
  const nuevo = 'x<script>\n  const DATA = {"chats":[{"n":"Juan","s":"done","m":[{"d":"s","t":"Hoy"},{"d":"i","t":"Hola \\u003cb\\u003e","ts":"9:00"}]}],"total":1,"media":0};\n</script>';
  const a = C.parseAntionIndex(nuevo, REF);
  assert.equal(a.chats[0].name, "Juan");
  assert.equal(a.chats[0].messages[0].t, "Hola <b>");
  assert.equal(a.chats[0].messages[0].date, "16 de octubre de 2026");
  const viejo = '<script>\nconst CHATS=[{"name":"Ana","status":"failed","msgs":[{"dir":"DATE_SEP","txt":"1 de julio de 2026"},{"dir":"o","txt":"Hola","ts":"9:00"}]}];\nlet cur=-1;</script>';
  const b = C.parseAntionIndex(viejo, REF);
  assert.equal(b.chats[0].failed, true);
  assert.equal(b.chats[0].messages[0].date, "1 de julio de 2026");
});

test("la clave de chat une el mismo contacto escrito distinto", () => {
  assert.equal(C.chatKey("+57 300 555 0101"), C.chatKey("+57 300 5550101"));
  assert.equal(C.chatKey("María Fernanda Reina"), C.chatKey("Maria Fernanda  Reina"));
  assert.notEqual(C.chatKey("Ana"), C.chatKey("Ana Torres"));
});
