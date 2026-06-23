/* =====================================================================
   Mouth of the South LLC — Scheduler server
   ---------------------------------------------------------------------
   One small app that does three jobs:
     1. Serves the scheduling website (the /public folder)
     2. Provides a tiny JSON API the website reads/writes
     3. Runs a Telegram bot that turns photos & typed notes into
        appointments on the same schedule

   Storage: a plain data.json file next to this script. Simple and
   dependency-free. (See DEPLOY.md for the note about keeping backups
   on free hosts that wipe their disk on restart.)

   Required to enable the bot:  environment variable  TELEGRAM_TOKEN
   Optional security:           TELEGRAM_ALLOWED_IDS  (comma-separated
                                 Telegram chat ids allowed to add jobs)
   ===================================================================== */

const express = require("express");
const fs = require("fs");
const path = require("path");

/* Safety net: a single failed Telegram send (or any stray async error) must
   never take the whole server down. Log it and keep running. */
process.on("unhandledRejection", (err) =>
  console.error("unhandledRejection:", (err && err.message) || err));
process.on("uncaughtException", (err) =>
  console.error("uncaughtException:", (err && err.message) || err));

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

/* ---------------- tiny JSON "database" ---------------- */
function readAll() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch (e) { return []; }
}
function writeAll(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function todayYMD() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
         "-" + String(d.getDate()).padStart(2, "0");
}

/* ---------------- web server + API ---------------- */
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/appointments", (req, res) => {
  res.json(readAll());
});

app.post("/api/appointments", (req, res) => {
  const list = readAll();
  const a = sanitize(req.body);
  a.id = uid();
  a.created = Date.now();
  list.push(a);
  writeAll(list);
  res.json(a);
});

app.put("/api/appointments/:id", (req, res) => {
  const list = readAll();
  const i = list.findIndex(x => x.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: "not found" });
  // merge raw fields onto the existing record, THEN sanitize, so a partial
  // update only changes the keys that were actually sent.
  const merged = { ...list[i], ...req.body };
  list[i] = { ...sanitize(merged), id: list[i].id, created: list[i].created };
  writeAll(list);
  res.json(list[i]);
});

app.delete("/api/appointments/:id", (req, res) => {
  let list = readAll();
  list = list.filter(x => x.id !== req.params.id);
  writeAll(list);
  res.json({ ok: true });
});

function sanitize(b = {}) {
  const types = ["inspection", "sales", "followup"];
  return {
    name: String(b.name || "").slice(0, 120),
    phone: String(b.phone || "").slice(0, 40),
    address: String(b.address || "").slice(0, 200),
    date: String(b.date || todayYMD()),
    time: String(b.time || "").slice(0, 8),
    type: types.includes(b.type) ? b.type : "inspection",
    notes: String(b.notes || "").slice(0, 2000)
  };
}

app.listen(PORT, () => console.log("✅ Web + API running on port " + PORT));

/* =====================================================================
   TELEGRAM AGENT
   ===================================================================== */
const TOKEN = process.env.TELEGRAM_TOKEN;
if (!TOKEN) {
  console.log("ℹ️  No TELEGRAM_TOKEN set — website runs, bot is off.");
} else {
  startBot(TOKEN);
}

/* =====================================================================
   SMART EXTRACTION (optional) — AI reading of photos & notes
   ---------------------------------------------------------------------
   Set ONE of these and the bot reads with AI vision (far better than the
   offline OCR, and it understands "tomorrow / Tuesday 2pm"):
     • GROQ_API_KEY    — free, no credit card   (model via GROQ_MODEL)
     • GEMINI_API_KEY  — Google AI              (model via GEMINI_MODEL)
   With neither (or if a provider errors), it falls back to free offline OCR.
   ===================================================================== */
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
let geminiCooldownUntil = 0;   // set after a quota/error so we don't hammer a dead key
const GROQ_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
let groqCooldownUntil = 0;

/* The shared instruction both AI providers use. */
function buildInstruction() {
  const today = todayYMD();
  const weekday = new Date().toLocaleDateString("en-US", { weekday: "long" });
  return "You read messy lead notes for a roofing company's appointment scheduler in Alabama (US Central time). " +
    "Today is " + today + " (a " + weekday + "). From the photo and/or text, extract ONE appointment. " +
    "Resolve relative dates like 'tomorrow', 'Tuesday', 'next week' into a real date. " +
    "Return ONLY a JSON object with EXACTLY these keys: " +
    "name (person's full name, '' if none), phone (as written, '' if none), " +
    "address (street plus city/state if present, '' if none), " +
    "date (YYYY-MM-DD, or '' if truly none is stated), time (24-hour HH:MM, or ''), " +
    "type (one of: inspection, sales, followup — default inspection), " +
    "notes (anything else worth keeping: damage details, insurance, best time to call). " +
    "Never invent data; use an empty string for anything unknown.";
}

/* Try whichever AI provider is configured (Groq first, then Gemini). */
async function aiExtract(args) {
  return (await groqExtract(args)) || (await geminiExtract(args));
}

/* ---- Groq (free) — OpenAI-compatible chat completions with vision ---- */
async function groqExtract({ text = "", imageB64 = "", mime = "image/jpeg" }) {
  if (!GROQ_KEY || Date.now() < groqCooldownUntil) return null;
  const content = [{ type: "text", text: buildInstruction() + (text ? "\n\nText provided:\n" + text : "") }];
  if (imageB64) content.push({ type: "image_url", image_url: { url: "data:" + mime + ";base64," + imageB64 } });
  const body = { model: GROQ_MODEL, messages: [{ role: "user", content }], temperature: 0, response_format: { type: "json_object" } };
  try {
    const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + GROQ_KEY },
      body: JSON.stringify(body)
    });
    if (!r.ok) {
      if (r.status === 429 || r.status === 403) groqCooldownUntil = Date.now() + 10 * 60 * 1000;
      console.error("Groq " + r.status + ": " + (await r.text().catch(() => "")).slice(0, 160));
      return null;
    }
    const j = await r.json();
    const out = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
    const obj = JSON.parse(out);
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) { console.error("Groq error", e.message); return null; }
}

/* ---- Google Gemini ---- */
async function geminiExtract({ text = "", imageB64 = "", mime = "image/jpeg" }) {
  if (!GEMINI_KEY || Date.now() < geminiCooldownUntil) return null;
  const instruction = buildInstruction();
  const parts = [{ text: instruction + (text ? "\n\nText provided:\n" + text : "") }];
  if (imageB64) parts.push({ inline_data: { mime_type: mime, data: imageB64 } });
  const body = { contents: [{ parts }], generationConfig: { temperature: 0, responseMimeType: "application/json" } };
  try {
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
                GEMINI_MODEL + ":generateContent?key=" + GEMINI_KEY;
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      if (r.status === 429 || r.status === 403) geminiCooldownUntil = Date.now() + 10 * 60 * 1000;
      console.error("Gemini " + r.status + ": " + (await r.text().catch(() => "")).slice(0, 160));
      return null;
    }
    const j = await r.json();
    const out = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
                j.candidates[0].content.parts && j.candidates[0].content.parts[0].text || "";
    const obj = JSON.parse(out);
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) { console.error("Gemini error", e.message); return null; }
}

/* Normalize an extracted object into a clean appointment, defaulting a missing
   date to today and flagging it so the bot can warn the user. */
function finalizeAppt(o = {}) {
  const types = ["inspection", "sales", "followup"];
  const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(String(o.date || ""));
  return {
    name: String(o.name || "").trim().slice(0, 120),
    phone: String(o.phone || "").trim().slice(0, 40),
    address: String(o.address || "").trim().slice(0, 200),
    date: hasDate ? o.date : todayYMD(),
    time: /^\d{1,2}:\d{2}$/.test(String(o.time || "")) ? o.time : "",
    type: types.includes(o.type) ? o.type : "inspection",
    notes: String(o.notes || "").trim().slice(0, 2000),
    _dateGuessed: !hasDate
  };
}

function startBot(token) {
  const TelegramBot = require("node-telegram-bot-api");
  const { createWorker } = require("tesseract.js");
  const bot = new TelegramBot(token, { polling: true });

  const allowed = (process.env.TELEGRAM_ALLOWED_IDS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const isAllowed = id => allowed.length === 0 || allowed.includes(String(id));

  console.log("🤖 Telegram agent started" +
    (allowed.length ? " (locked to " + allowed.length + " id[s])" : " (open to anyone who finds it)"));

  bot.onText(/^\/start|^\/help/, (msg) => {
    bot.sendMessage(msg.chat.id,
      "👄 *Mouth of the South Scheduler*\n\n" +
      "Send me a *photo* of a lead note, business card, or signup sheet — " +
      "or just *type* the details — and I'll add it to your calendar.\n\n" +
      "Example text:\n`John Smith 205-555-0142, 12 Oak St Birmingham, Tues 2pm inspection`\n\n" +
      "Your Telegram id is `" + msg.chat.id + "` (give this to your setup if you want to lock the bot to just you).",
      { parse_mode: "Markdown" });
  });

  /* ---- typed messages ---- */
  bot.on("message", async (msg) => {
    if (msg.photo) return;                       // photos handled below
    if (!msg.text || msg.text.startsWith("/")) return;
    if (!isAllowed(msg.chat.id)) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
    const ai = await aiExtract({ text: msg.text });            // null unless an AI key is set
    const appt = ai ? finalizeAppt(ai) : parseLead(msg.text);
    saveAndReply(bot, msg.chat.id, appt, ai ? "your message" : "your message");
  });

  /* ---- photos ---- */
  bot.on("photo", async (msg) => {
    if (!isAllowed(msg.chat.id)) return bot.sendMessage(msg.chat.id, "⛔ Not authorized.");
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, "📷 Got it — reading the photo…");
    try {
      const fileId = msg.photo[msg.photo.length - 1].file_id;   // largest size
      const link = await bot.getFileLink(fileId);
      const resp = await fetch(link);
      const buf = Buffer.from(await resp.arrayBuffer());

      // Best: AI vision reads the image directly (sharp accuracy, handles handwriting).
      const ai = await aiExtract({ imageB64: buf.toString("base64"), mime: "image/jpeg", text: msg.caption || "" });
      if (ai) return saveAndReply(bot, chatId, finalizeAppt(ai), "photo");

      // Free fallback: offline OCR + the rule-based parser.
      const worker = await createWorker("eng");
      const { data } = await worker.recognize(buf);
      await worker.terminate();
      const text = (data.text || "").trim();
      if (!text) return bot.sendMessage(chatId, "Hmm, I couldn't read any text. Try a clearer, well-lit photo — or just type the details.");

      const appt = parseLead(text + (msg.caption ? "\n" + msg.caption : ""));
      saveAndReply(bot, chatId, appt, "photo");
    } catch (err) {
      console.error("photo error", err);
      bot.sendMessage(chatId, "⚠️ Something went wrong reading that photo. Try again or type the details.");
    }
  });

  bot.on("polling_error", e => console.error("polling_error", e.code || e.message));
}

/* ---------------- save + confirm ---------------- */
function saveAndReply(bot, chatId, appt, source) {
  const guessed = appt._dateGuessed;
  delete appt._dateGuessed;                 // internal flag — never store it

  const list = readAll();
  appt.id = uid();
  appt.created = Date.now();
  list.push(appt);
  writeAll(list);

  const TYPE = { inspection: "Inspection", sales: "Sales", followup: "Follow-up" }[appt.type];
  const dateNote = guessed ? "  (date defaulted to today — fix in the app if wrong)" : "";

  // Plain text on purpose: customer names/notes can contain characters that
  // break Telegram's Markdown parser, which used to crash the bot.
  bot.sendMessage(chatId,
    "✅ Added to your schedule (from " + source + ")\n\n" +
    "👤 " + (appt.name || "(no name found)") + "\n" +
    "📞 " + (appt.phone || "—") + "\n" +
    "📍 " + (appt.address || "—") + "\n" +
    "🗓️ " + appt.date + (appt.time ? "  " + to12(appt.time) : "") + dateNote + "\n" +
    "🏷️ " + TYPE + "\n" +
    (appt.notes ? "📝 " + appt.notes.slice(0, 200) + "\n" : "") +
    "\nOpen the app to review or edit."
  ).catch((e) => console.error("reply failed:", e.message));
}

/* =====================================================================
   LEAD PARSER — pulls name / phone / address / date / time / type
   from messy OCR text or a typed note.
   ===================================================================== */
function parseLead(raw) {
  const text = String(raw || "");
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
  const joined = text.replace(/\n/g, " ");
  const SUF = "st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|ct|court|way|hwy|highway|pkwy|cir|circle|trl|trail|pl|place|ter|terrace";
  // Capture just the street span: house number -> street word -> suffix, with
  // an OPTIONAL ", City ST 35801" tail (only when a comma sets it off, so we
  // never swallow trailing words like "Tues 2pm").
  const addrRe = new RegExp(
    "\\d{1,6}\\s+(?:[A-Za-z0-9.'\\-]+\\s+){0,5}?(?:" + SUF + ")\\b\\.?" +
    "(?:,\\s*[A-Za-z][A-Za-z .]{1,30})?" +
    "(?:\\s*\\d{5}(?:-\\d{4})?)?",
    "i");

  // ---- phone (accepts 2055550142, 205-555-0142, (205) 555-0142, +1 …) ----
  const phoneMatch = joined.match(/(\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}/);
  const phone = phoneMatch ? phoneMatch[0].trim() : "";

  // ---- address: pull out only the street span, not the whole line ----
  // Remove the phone first so its digits can't be mistaken for a house number.
  let addrText = joined;
  if (phone) addrText = addrText.split(phone).join(" ");
  addrText = addrText.replace(/\d{7,}/g, " ");        // strip any other long digit runs
  const am = addrText.match(addrRe);
  let address = am ? am[0].replace(/\s{2,}/g, " ").replace(/[,\s]+$/, "").trim() : "";

  // ---- name: the words that come BEFORE the first number ----
  // (handles "John Smith 2055550142 12 oak st…" where there are no commas).
  let name = "";
  for (const l of lines) {
    let n = l.split(/\d/)[0]                          // text up to the first digit
             .replace(/[,(].*$/, "")                  // stop at a comma or "("
             .replace(/[^A-Za-z .'\-]/g, " ")
             .replace(/\s{2,}/g, " ").trim();
    if (/roof|inspect|insur|estimate|quote|claim|llc|inc|follow|callback|sign|sales/i.test(n)) continue;
    const w = n.split(/\s+/).filter(Boolean);
    if (n.length >= 2 && w.length >= 1 && w.length <= 4) { name = n; break; }
  }

  // type
  let type = "inspection";
  if (/follow|callback|call back/i.test(joined)) type = "followup";
  else if (/sales|quote|estimate|sign|close|sell/i.test(joined)) type = "sales";
  else if (/inspect/i.test(joined)) type = "inspection";

  // date + time
  const { date, time, guessed } = parseDateTime(joined);

  return {
    name, phone, address, date, time, type,
    notes: text.trim(),
    _dateGuessed: guessed
  };
}

function pad(n) { return String(n).padStart(2, "0"); }
function ymdOf(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

function parseDateTime(s) {
  const lower = s.toLowerCase();
  const now = new Date();
  let date = null, guessed = false;

  if (/\btoday\b/.test(lower)) date = ymdOf(now);
  else if (/\btomorrow\b/.test(lower)) { const d = new Date(now); d.setDate(d.getDate() + 1); date = ymdOf(d); }

  // weekday name -> next occurrence (handles common abbreviations like
  // "Tues", "Thurs", "Weds" without matching false friends like "month")
  if (!date) {
    const dayForms = [
      ["sunday", "sun"], ["monday", "mon"], ["tuesday", "tues", "tue"],
      ["wednesday", "weds", "wed"], ["thursday", "thurs", "thur", "thu"],
      ["friday", "fri"], ["saturday", "sat"]
    ];
    for (let i = 0; i < 7; i++) {
      const re = new RegExp("\\b(" + dayForms[i].join("|") + ")\\b");
      if (re.test(lower)) {
        const d = new Date(now);
        let add = (i - d.getDay() + 7) % 7; if (add === 0) add = 7;
        d.setDate(d.getDate() + add);
        date = ymdOf(d);
        break;
      }
    }
  }

  // MM/DD or MM/DD/YY(YY)
  if (!date) {
    const m = lower.match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?\b/);
    if (m) {
      let yr = m[3] ? Number(m[3]) : now.getFullYear();
      if (yr < 100) yr += 2000;
      const d = new Date(yr, Number(m[1]) - 1, Number(m[2]));
      if (!isNaN(d)) date = ymdOf(d);
    }
  }

  // Month name DD
  if (!date) {
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const m = lower.match(new RegExp("\\b(" + months.map(x => x.slice(0, 3)).join("|") + ")[a-z]*\\.?\\s+(\\d{1,2})\\b"));
    if (m) {
      const mi = months.findIndex(x => x.startsWith(m[1]));
      const d = new Date(now.getFullYear(), mi, Number(m[2]));
      if (!isNaN(d)) date = ymdOf(d);
    }
  }

  if (!date) { date = ymdOf(now); guessed = true; }

  // time: 2pm, 2:30 pm, 14:00
  let time = "";
  const t = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) || lower.match(/\b(\d{1,2}):(\d{2})\b/);
  if (t) {
    let h = Number(t[1]); const min = t[2] ? Number(t[2]) : 0; const ap = t[3];
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h >= 0 && h <= 23) time = pad(h) + ":" + pad(min);
  }

  return { date, time, guessed };
}

function to12(t) {
  const [h, m] = t.split(":").map(Number);
  const ap = h >= 12 ? "PM" : "AM"; const hh = (h % 12) || 12;
  return hh + ":" + pad(m) + " " + ap;
}
