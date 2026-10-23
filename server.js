// Session Canvas – zoombare Sternkarte aller Claude-Code-Sessions.
// Liest die Transkripte aus ~/.claude/projects und liefert sie an die Oberfläche
// in public/index.html. Sessions lassen sich von dort aus über die Claude-Code-CLI
// fortsetzen (`claude -p --resume`). Keine Abhängigkeiten nötig.
//
//   node server.js            -> http://localhost:4747
//   PORT=5000 node server.js
//   CLAUDE_PROJECTS=D:\pfad node server.js

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { treeNode, deadBranches } = require("./branches");

const PORT = Number(process.env.PORT) || 4747;
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
// Schützt die Steuer-Endpunkte: nur die von hier ausgelieferte Seite kennt dieses Token
const TOKEN = crypto.randomBytes(24).toString("hex");
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS || path.join(os.homedir(), ".claude", "projects");
const PUBLIC_DIR = path.join(__dirname, "public");
const ACTIVE_MS = 3 * 60 * 1000; // Datei in den letzten 3 Minuten geändert => "läuft"
const PREVIEW_MSGS = 16;
const MAX_MSGS = 400;   // so viele Nachrichten zeigt das Logbuch normalerweise
const KEEP_MSGS = 1500; // so viele hält der Server pro Session für die Volltextsuche
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const CURVE_BUCKETS = 48;

// Cache: Dateipfad -> { size, mtimeMs, s, rest }. Gewachsene Dateien werden nur ab
// der letzten Position weitergelesen, damit laufende Sessions billig bleiben.
const cache = new Map();

function cleanText(s) {
  if (typeof s !== "string") return "";
  return s
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(command-message|command-args|local-command-stdout|local-command-caveat)>[\s\S]*?<\/\1>/g, "")
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, "$1")
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, "[eingefügter Text]")
    .trim();
}

function textOf(content) {
  if (typeof content === "string") return cleanText(content);
  if (!Array.isArray(content)) return "";
  return cleanText(content.filter(c => c && c.type === "text").map(c => c.text).join("\n"));
}

function toolsOf(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(c => c && c.type === "tool_use").map(c => {
    const i = c.input || {};
    let hint = i.description || i.file_path || i.command || i.pattern || i.url || i.query || i.prompt || "";
    if (typeof hint !== "string") hint = "";
    return { name: c.name, hint: hint.replace(/\s+/g, " ").slice(0, 120) };
  });
}

function decodeProjectDir(dir) {
  // "d--entwicklung-vsc-tbh" -> "d:\entwicklung-vsc-tbh" (nur Fallback, cwd aus dem Transkript ist genauer)
  return dir.replace(/^([a-zA-Z])--/, "$1:\\");
}

function emptySession(file, projectDir) {
  return {
    id: path.basename(file, ".jsonl"),
    projectDir,
    cwd: null, branch: null, entrypoint: null, model: null,
    customTitle: null, aiTitle: null, firstPrompt: null, lastPrompt: null,
    start: null, end: null,
    userMsgs: 0, assistantMsgs: 0, toolCalls: 0, tools: {},
    cost: null, costAt: null, linesAdded: 0, linesRemoved: 0,
    outTokens: 0, seenMsgIds: new Set(),
    files: new Map(), // von Claude geschriebene/geänderte Dateien
    last: null,       // letzter Eintrag: wer ist dran? { r, kind, tools, ts }
    plan: null,       // Aufgabenliste aus update_plan, nachgespielt
    wrap: null,       // letzter Abschluss (wrap_up): recap, ask, actions
    split: 0,         // Stellen, an denen sich der Verlauf aufgespalten hat
    question: null,   // letzte Frage per AskUserQuestion
    lastClaude: "",   // letzter Antworttext von Claude
    lastYou: "",      // letzter Prompt
    times: [],    // Zeitpunkte aller Nachrichten (ms) für die Aktivitätskurve
    messages: [], // gekürzter Verlauf für Vorschau / Logbuch
  };
}

function processEntry(s, o) {
  const t = o.type;
  if (t === "custom-title") s.customTitle = o.customTitle || s.customTitle;
  else if (t === "ai-title") s.aiTitle = o.aiTitle || s.aiTitle;
  else if (t === "last-prompt") s.lastPrompt = cleanText(o.lastPrompt) || s.lastPrompt;
  else if (t === "cost-state") {
    // Claude schreibt die Kosten erst, wenn ein Prozess sauber endet: Stand = letzte Nachricht davor
    if (typeof o.totalCostUSD === "number") { s.cost = o.totalCostUSD; s.costAt = s.end; }
    s.linesAdded = o.totalLinesAdded || s.linesAdded;
    s.linesRemoved = o.totalLinesRemoved || s.linesRemoved;
  } else if (t === "user" || t === "assistant") {
    if (o.isSidechain) return;
    if (o.timestamp) {
      if (!s.start) s.start = o.timestamp;
      s.end = o.timestamp;
    }
    if (o.cwd && !s.cwd) s.cwd = o.cwd; // Projektordner = erster Ordner; später kann Claude in Unterordner wechseln
    if (o.gitBranch) s.branch = o.gitBranch;
    if (o.entrypoint) s.entrypoint = o.entrypoint;
    const msg = o.message || {};
    const content = msg.content;
    const ms = o.timestamp ? Date.parse(o.timestamp) : 0;
    if (t === "user") {
      const isResult = o.toolUseResult || (Array.isArray(content) && content.some(c => c && c.type === "tool_result"));
      if (isResult) { s.last = { r: "user", kind: "tool_result", ts: o.timestamp }; return; }
      if (o.isMeta || o.isCompactSummary) return;
      const text = textOf(content);
      if (!text) return;
      if (/^\[Request interrupted/.test(text)) { s.last = { r: "user", kind: "interrupt", ts: o.timestamp }; s.messages.push({ r: "note", t: "Gestoppt", ts: o.timestamp }); return; }
      s.last = { r: "user", kind: "text", ts: o.timestamp };
      s.userMsgs++;
      if (ms) s.times.push(ms);
      if (!s.firstPrompt) s.firstPrompt = text.slice(0, 400);
      s.lastYou = text.slice(0, 300);
      s.messages.push({ r: "user", t: text.slice(0, 2400), ts: o.timestamp });
    } else {
      if (msg.model && msg.model !== "<synthetic>") s.model = msg.model;
      // Ein API-Aufruf wird als mehrere Zeilen gespeichert – Tokens nur einmal zählen
      if (msg.usage && msg.id && !s.seenMsgIds.has(msg.id)) {
        s.seenMsgIds.add(msg.id);
        s.outTokens += msg.usage.output_tokens || 0;
      }
      const text = textOf(content);
      const tools = toolsOf(content);
      for (const tl of tools) s.tools[tl.name] = (s.tools[tl.name] || 0) + 1;
      if (tools.length) s.last = { r: "assistant", kind: "tool_use", tools: tools.map(x => x.name), ts: o.timestamp };
      else if (text) s.last = { r: "assistant", kind: "text", ts: o.timestamp };
      if (text) s.lastClaude = text.slice(0, 600);
      if (Array.isArray(content)) for (const c of content) {
        if (!c || c.type !== "tool_use" || !c.input) continue;
        const i = c.input;
        if (FILE_TOOLS.has(c.name)) {
          const fp = i.file_path || i.notebook_path;
          if (typeof fp !== "string") continue;
          const f = s.files.get(fp) || { path: fp, edits: 0, created: c.name === "Write" };
          f.edits++;
          f.ts = o.timestamp;
          s.files.delete(fp); // ans Ende, damit die Reihenfolge "zuletzt geändert" bleibt
          s.files.set(fp, f);
        } else if (c.name === "mcp__ccd_turn__update_plan") {
          // Aufgabenliste der Claude-App nachspielen: items setzt sie, advance/done/start verschieben den Zeiger
          if (Array.isArray(i.items)) s.plan = i.items.map(x => ({ t: String(x.content || ""), st: x.status || "pending" }));
          else if (s.plan) {
            if (i.advance) {
              const cur = s.plan.findIndex(x => x.st === "in_progress");
              if (cur >= 0) s.plan[cur].st = "completed";
              const nx = s.plan.findIndex(x => x.st === "pending");
              if (nx >= 0) s.plan[nx].st = "in_progress";
            }
            if (Array.isArray(i.done)) for (const n of i.done) if (s.plan[n - 1]) s.plan[n - 1].st = "completed";
            if (i.start && s.plan[i.start - 1]) { for (const x of s.plan) if (x.st === "in_progress") x.st = "pending"; s.plan[i.start - 1].st = "in_progress"; }
          }
        } else if (c.name === "mcp__ccd_turn__wrap_up") {
          s.wrap = { recap: String(i.recap || "").slice(0, 500), ask: i.ask ? String(i.ask).slice(0, 200) : "",
            actions: (Array.isArray(i.actions) ? i.actions : []).filter(a => a && a.label).slice(0, 3)
              .map(a => ({ label: String(a.label).slice(0, 40), message: String(a.message || a.label).slice(0, 300) })), ts: o.timestamp };
          if (s.plan) for (const x of s.plan) x.st = "completed";
        } else if (c.name === "AskUserQuestion") {
          s.question = { ts: o.timestamp, q: (Array.isArray(i.questions) ? i.questions : []).map(q => q && q.question).filter(Boolean).join(" ").slice(0, 300) };
        }
      }
      s.toolCalls += tools.length;
      if (ms && (text || tools.length)) s.times.push(ms);
      if (text) {
        s.assistantMsgs++;
        s.messages.push({ r: "assistant", t: text.slice(0, 2400), ts: o.timestamp });
      }
      if (tools.length) {
        const last = s.messages[s.messages.length - 1];
        if (last && last.r === "tools") last.tools.push(...tools.slice(-30));
        else s.messages.push({ r: "tools", tools, ts: o.timestamp });
      }
    }
    if (s.messages.length > KEEP_MSGS + 100) s.messages = s.messages.slice(-KEEP_MSGS);
  }
}

function readRange(file, from, len) {
  const chunk = Buffer.alloc(Math.max(0, len));
  if (!chunk.length) return chunk;
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, chunk, 0, chunk.length, from); } finally { fs.closeSync(fd); }
  return chunk;
}

function entriesOf(buf) {
  const out = [];
  for (const line of buf.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* kaputte Zeile überspringen */ }
  }
  return out;
}

function parseSession(file, projectDir) {
  const st = fs.statSync(file);
  let c = cache.get(file);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return { s: c.s, st };

  let from = 0;
  if (c && st.size > c.size) from = c.size; // nur das Neue lesen
  else c = { s: emptySession(file, projectDir), rest: Buffer.alloc(0), nodes: new Map(), leaf: null, sig: "" };

  const start = from - c.rest.length; // ab hier steht buf in der Datei
  const buf = Buffer.concat([c.rest, readRange(file, from, st.size - from)]);
  // Nur bis zum letzten Zeilenumbruch verarbeiten, den Rest (halbe Zeile) aufheben
  const cut = buf.lastIndexOf(0x0a) + 1;
  c.rest = buf.subarray(cut);
  let entries = entriesOf(buf.subarray(0, cut));

  // Verlaufsbaum mitführen; aktiv ist der Zweig mit dem zuletzt geschriebenen Prompt bzw. der letzten Antwort
  for (const o of entries) {
    if (!o.uuid || o.isSidechain) continue;
    c.nodes.set(o.uuid, treeNode(o));
    if (o.type === "user" || o.type === "assistant") c.leaf = o.uuid;
  }
  const br = deadBranches(c.nodes, c.leaf);
  if (br.sig !== c.sig && from > 0) {
    // Neue Aufspaltung oder anderer Zweig aktiv: alles bisher Gezählte gilt nicht mehr, von vorn auswerten
    c.s = emptySession(file, projectDir);
    entries = entriesOf(readRange(file, 0, start + cut));
  }
  c.sig = br.sig;
  for (const o of entries) {
    if (br.dead.has(o.uuid)) {
      if (br.forks.has(o.parentUuid)) c.s.messages.push({ r: "note", t: "Hier hat sich der Verlauf aufgespalten, der andere Zweig ist ausgeblendet", ts: o.timestamp });
      continue;
    }
    processEntry(c.s, o);
  }
  c.s.split = br.forks.size;
  for (const m of c.s.messages) if (m.tools && m.tools.length > 30) m.tools = m.tools.slice(-30);

  c.size = st.size;
  c.mtimeMs = st.mtimeMs;
  cache.set(file, c);
  return { s: c.s, st };
}

function activityCurve(times, startMs, endMs) {
  const buckets = new Array(CURVE_BUCKETS).fill(0);
  if (!times.length) return buckets;
  const span = Math.max(1, endMs - startMs);
  for (const t of times) {
    const i = Math.min(CURVE_BUCKETS - 1, Math.max(0, Math.floor(((t - startMs) / span) * CURVE_BUCKETS)));
    buckets[i]++;
  }
  return buckets;
}

function summarize(s, st) {
  const title = s.customTitle || s.aiTitle || (s.firstPrompt ? s.firstPrompt.split("\n")[0].slice(0, 80) : "Ohne Titel");
  const cwd = s.cwd || decodeProjectDir(s.projectDir);
  const topTools = Object.entries(s.tools).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const startMs = s.start ? Date.parse(s.start) : st.mtimeMs;
  const endMs = s.end ? Date.parse(s.end) : st.mtimeMs;
  return {
    id: s.id,
    title,
    project: path.basename(cwd.replace(/[\\/]+$/, "")) || cwd,
    cwd,
    scratch: /scratch-workspaces/i.test(cwd),
    branch: s.branch,
    entrypoint: s.entrypoint,
    model: s.model,
    firstPrompt: s.firstPrompt,
    lastPrompt: s.lastPrompt,
    start: s.start,
    end: s.end || new Date(st.mtimeMs).toISOString(),
    updatedMs: st.mtimeMs,
    active: Date.now() - st.mtimeMs < ACTIVE_MS,
    userMsgs: s.userMsgs,
    assistantMsgs: s.assistantMsgs,
    toolCalls: s.toolCalls,
    topTools,
    cost: s.cost,
    costAt: s.costAt,
    outTokens: s.outTokens,
    linesAdded: s.linesAdded,
    linesRemoved: s.linesRemoved,
    filesChanged: s.files.size,
    split: s.split, // Zahl der Stellen, an denen sich der Verlauf aufgespalten hat
    state: stateOf(s, st),
    plan: s.plan,
    wrap: s.wrap,
    lastClaude: s.lastClaude.slice(0, 300),
    lastYou: s.lastYou,
    sizeKB: Math.round(st.size / 1024),
    curve: activityCurve(s.times, startMs, endMs),
    preview: s.messages.slice(-PREVIEW_MSGS),
    opener: openerOf(s),
    run: runs.has(s.id) ? runInfo(runs.get(s.id)) : null,
    // Schreibt gerade (oder bis vor kurzem) unser eigener Prozess? Dann ist "läuft" keine fremde Nutzung.
    ours: Date.now() - (lastOurs.get(s.id) || 0) < 5 * 60 * 1000,
  };
}

function listSessionFiles() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const full = path.join(PROJECTS_DIR, d.name);
    let files = [];
    try { files = fs.readdirSync(full); } catch { continue; }
    for (const f of files) if (f.endsWith(".jsonl")) out.push({ file: path.join(full, f), projectDir: d.name });
  }
  return out;
}

function allSessions() {
  const res = [];
  for (const { file, projectDir } of listSessionFiles()) {
    try {
      const { s, st } = parseSession(file, projectDir);
      if (!s.userMsgs && !s.assistantMsgs) continue; // leere Sessions ausblenden
      res.push(summarize(s, st));
    } catch (e) {
      console.warn("Konnte nicht lesen:", file, e.message);
    }
  }
  res.sort((a, b) => (b.end || "").localeCompare(a.end || ""));
  return res;
}

// ---------- Live-Updates per Server-Sent Events ----------
const listeners = new Set();
let pushTimer = null;
function pushChange() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    for (const res of listeners) res.write(`data: change\n\n`);
  }, 250);
}
try {
  fs.watch(PROJECTS_DIR, { recursive: true }, (_ev, name) => {
    if (name && String(name).endsWith(".jsonl")) pushChange();
  });
} catch (e) {
  console.warn("Dateiüberwachung nicht verfügbar, die Oberfläche fragt stattdessen regelmäßig nach:", e.message);
}
setInterval(() => { for (const res of listeners) res.write(`: ping\n\n`); }, 25000);

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) res.write(msg);
}

// ---------- Sessions steuern ----------
// Pro Session höchstens ein Claude-Prozess (`claude -p --resume <id>` im Stream-JSON-Modus).
// Berechtigungsabfragen kommen als control_request an und werden in der Oberfläche beantwortet.
const runs = new Map();     // sessionId -> Lauf
// sessionId -> Zeitpunkt, an dem unser Prozess zuletzt etwas getan hat. Wird gespeichert,
// damit nach einem Neustart die eigenen Änderungen nicht als "woanders aktiv" gelten.
const OURS_FILE = path.join(os.tmpdir(), "session-canvas-ours.json");
const lastOurs = new Map();
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(OURS_FILE, "utf8")))) lastOurs.set(k, v); } catch {}
let oursTimer = null;
const _set = lastOurs.set.bind(lastOurs);
lastOurs.set = (k, v) => {
  _set(k, v);
  clearTimeout(oursTimer);
  oursTimer = setTimeout(() => {
    const keep = Object.fromEntries([...lastOurs].filter(([, t]) => Date.now() - t < 10 * 60 * 1000));
    fs.writeFile(OURS_FILE, JSON.stringify(keep), () => {});
  }, 1000);
  return lastOurs;
};
const IDLE_MS = 15 * 60 * 1000;
const MODES = { manual: "manual", acceptEdits: "acceptEdits", plan: "plan" };
// Wählbar in der Session-Eingabe; leer = Modell der Session bzw. Standard-Effort
const MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function runInfo(r) {
  return { sid: r.sid, status: r.status, mode: r.mode, model: r.model, effort: r.effort, note: r.note, partial: r.partial, pending: [...r.pending.values()], error: r.error };
}
function emitRun(r) { broadcast("run", runInfo(r)); }
function writeTo(r, obj) {
  if (!r.proc.stdin.writable) throw new Error("Der Claude-Prozess für diese Session läuft nicht mehr.");
  r.proc.stdin.write(JSON.stringify(obj) + "\n");
  r.lastActivity = Date.now();
}

function findSession(id) {
  const hit = listSessionFiles().find(x => path.basename(x.file, ".jsonl") === id);
  if (!hit) return null;
  const { s, st } = parseSession(hit.file, hit.projectDir);
  return summarize(s, st);
}

function findRaw(id) {
  const hit = listSessionFiles().find(x => path.basename(x.file, ".jsonl") === id);
  return hit ? parseSession(hit.file, hit.projectDir) : null;
}

// fresh = neue Session mit dieser ID anlegen statt eine bestehende fortzusetzen
// model/effort: Auswahl aus MODELS/EFFORTS, sonst Modell der Session und Standard-Effort
function startRun(sess, mode, fresh, model = "", effort = "") {
  if (!sess.cwd || !fs.existsSync(sess.cwd)) {
    throw new Error(`Den Projektordner dieser Session gibt es nicht mehr (${sess.cwd || "unbekannt"}). Ohne ihn kann Claude dort nicht weiterarbeiten.`);
  }
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", "--permission-prompts", "host", "--permission-prompt-tool", "stdio",
    "--permission-mode", MODES[mode] || "manual", fresh ? "--session-id" : "--resume", sess.id];
  if (model || sess.model) args.push("--model", model || sess.model);
  if (effort) args.push("--effort", effort);
  const proc = spawn(CLAUDE_BIN, args, { cwd: sess.cwd, windowsHide: true });
  const r = { sid: sess.id, proc, status: "starting", mode: MODES[mode] || "manual", model, effort, note: "", partial: "", pending: new Map(),
    error: null, stderr: "", buf: "", lastActivity: Date.now() };
  runs.set(sess.id, r);

  proc.stdout.on("data", d => {
    r.buf += d;
    let i;
    while ((i = r.buf.indexOf("\n")) >= 0) {
      const line = r.buf.slice(0, i); r.buf = r.buf.slice(i + 1);
      if (line.trim()) { try { onClaudeEvent(r, JSON.parse(line)); } catch { /* keine JSON-Zeile */ } }
    }
  });
  proc.stderr.on("data", d => { r.stderr = (r.stderr + d).slice(-2000); });
  proc.on("error", e => {
    r.error = e.code === "ENOENT" ? `Das Programm "${CLAUDE_BIN}" wurde nicht gefunden. Ist Claude Code installiert und im PATH? (Sonst CLAUDE_BIN setzen.)` : e.message;
  });
  proc.on("exit", code => {
    runs.delete(sess.id);
    lastOurs.set(sess.id, Date.now());
    const error = r.error || (code && r.status !== "closing" ? (r.stderr.trim().split("\n").pop() || `Claude wurde mit Code ${code} beendet.`) : null);
    broadcast("run", { sid: sess.id, status: "off", error, pending: [] });
  });

  writeTo(r, { type: "control_request", request_id: "init_" + crypto.randomUUID(), request: { subtype: "initialize" } });
  return r;
}

function onClaudeEvent(r, o) {
  lastOurs.set(r.sid, Date.now());
  r.lastActivity = Date.now();
  const sub = o.parent_tool_use_id; // Ereignisse von Unteragenten nicht als Haupttext zeigen
  if (o.type === "control_request" && o.request && o.request.subtype === "can_use_tool") {
    const q = o.request;
    r.pending.set(o.request_id, { requestId: o.request_id, tool: q.tool_name, display: q.display_name || q.tool_name, input: q.input || {}, at: Date.now() });
    r.status = "waiting";
    emitRun(r);
  } else if (o.type === "control_cancel_request") {
    r.pending.delete(o.request_id);
    if (!r.pending.size && r.status === "waiting") r.status = "working";
    emitRun(r);
  } else if (o.type === "stream_event" && !sub) {
    const ev = o.event || {};
    if (ev.type === "message_start") r.partial = "";
    else if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
      r.partial += ev.delta.text;
      broadcast("delta", { sid: r.sid, text: ev.delta.text });
    }
  } else if (o.type === "assistant" && !sub) {
    r.partial = "";
    const tools = toolsOf(o.message && o.message.content);
    if (tools.length) r.note = `${tools[0].name}${tools[0].hint ? ": " + tools[0].hint : ""}`;
    if (r.status !== "waiting") r.status = "working";
    emitRun(r);
  } else if (o.type === "system" && o.subtype === "init") {
    r.status = "working";
    emitRun(r);
  } else if (o.type === "system" && o.subtype === "post_turn_summary") {
    r.note = o.status_detail || r.note;
    emitRun(r);
  } else if (o.type === "result") {
    r.status = "idle";
    r.partial = "";
    r.pending.clear();
    if (r.interrupted) { r.interrupted = false; r.error = null; r.note = "Gestoppt"; }
    else r.error = o.is_error ? (o.result || "Claude hat den Zug mit einem Fehler beendet.") : null;
    emitRun(r);
    broadcast("done", { sid: r.sid, error: r.error, note: r.note });
  }
}

async function sendMessage(id, text, mode, model, effort) {
  markSeen(id);
  model = MODELS.has(model) ? model : "";
  effort = EFFORTS.has(effort) ? effort : "";
  let r = runs.get(id);
  // Modell und Effort gelten ab dem Start des Prozesses: bei einem Wechsel neu starten
  if (r && (model !== r.model || effort !== r.effort)) {
    if (r.status !== "idle") throw new Error("Modell und Effort lassen sich nur wechseln, während Claude nicht arbeitet. Stoppe Claude oder warte, bis der Zug fertig ist.");
    const old = r;
    await new Promise(done => { old.proc.once("exit", done); release(id); });
    r = null;
  }
  if (!r) {
    const sess = findSession(id);
    if (!sess) throw new Error("Diese Session gibt es nicht.");
    r = startRun(sess, mode, false, model, effort);
  } else if (mode && MODES[mode] && MODES[mode] !== r.mode) {
    writeTo(r, { type: "control_request", request_id: "mode_" + crypto.randomUUID(), request: { subtype: "set_permission_mode", mode: MODES[mode] } });
    r.mode = MODES[mode];
  }
  writeTo(r, { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: id });
  r.status = "working";
  r.error = null;
  r.note = "";
  emitRun(r);
}

async function newSession(dir, text, mode) {
  const cwd = path.resolve(String(dir || ""));
  if (!dir || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Den Ordner gibt es nicht: ${dir || "(leer)"}`);
  if (!String(text || "").trim()) throw new Error("Schreib Claude, womit es anfangen soll.");
  const id = crypto.randomUUID();
  startRun({ id, cwd, model: null }, mode, true);
  await sendMessage(id, String(text).trim(), mode);
  return id;
}

// ---------- Volltextsuche über alle Verläufe ----------
function search(q) {
  const words = String(q).toLowerCase().split(/\s+/).filter(w => w.length > 1).slice(0, 6);
  if (!words.length) return [];
  const hits = [];
  for (const { file, projectDir } of listSessionFiles()) {
    let parsed;
    try { parsed = parseSession(file, projectDir); } catch { continue; }
    const { s, st } = parsed;
    if (!s.userMsgs && !s.assistantMsgs) continue;
    let perSession = 0, sum = null;
    for (let i = s.messages.length - 1; i >= 0 && perSession < 4; i--) {
      const m = s.messages[i];
      if (m.r !== "user" && m.r !== "assistant") continue;
      const low = m.t.toLowerCase();
      if (!words.every(w => low.includes(w))) continue;
      sum = sum || summarize(s, st);
      const at = low.indexOf(words[0]);
      const from = Math.max(0, at - 70);
      const snippet = (from ? "…" : "") + m.t.slice(from, at + 150).replace(/\s+/g, " ") + (at + 150 < m.t.length ? "…" : "");
      hits.push({ id: s.id, title: sum.title, project: sum.project, scratch: sum.scratch, r: m.r, ts: m.ts, snippet });
      perSession++;
    }
  }
  hits.sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  return hits.slice(0, 40);
}

// ---------- Geänderte Dateien öffnen ----------
const fileOpener = () => hasCommand("code") ? "code" : "explorer";
function openFile(id, file) {
  const raw = findRaw(id);
  if (!raw) throw new Error("Diese Session gibt es nicht.");
  // Nur Dateien, die Claude in dieser Session geändert hat – keine beliebigen Pfade
  if (!raw.s.files.has(file)) throw new Error("Diese Datei gehört nicht zu dieser Session.");
  if (!fs.existsSync(file)) throw new Error(`Die Datei gibt es nicht mehr: ${file}`);
  if (fileOpener() === "code") {
    if (process.platform === "win32") spawn("cmd.exe", ["/d", "/s", "/c", `"code -g "${file}""`], { ...detach, windowsVerbatimArguments: true }).unref();
    else spawn("code", ["-g", file], detach).unref();
  } else if (process.platform === "win32") spawn("explorer.exe", [`/select,${file}`], detach).unref();
  else if (process.platform === "darwin") spawn("open", ["-R", file], detach).unref();
  else spawn("xdg-open", [path.dirname(file)], detach).unref();
}

function answerPermission(id, requestId, allow, answers, message) {
  const r = runs.get(id);
  const p = r && r.pending.get(requestId);
  if (!p) throw new Error("Diese Anfrage ist nicht mehr offen.");
  const response = allow
    ? { behavior: "allow", updatedInput: answers ? { ...p.input, answers } : p.input }
    : { behavior: "deny", message: message || "Abgelehnt in Session Canvas." };
  writeTo(r, { type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  r.pending.delete(requestId);
  r.status = r.pending.size ? "waiting" : "working";
  emitRun(r);
}

function interrupt(id) {
  const r = runs.get(id);
  if (!r) return;
  for (const reqId of r.pending.keys()) {
    writeTo(r, { type: "control_response", response: { subtype: "success", request_id: reqId, response: { behavior: "deny", message: "Abgebrochen in Session Canvas." } } });
  }
  r.pending.clear();
  writeTo(r, { type: "control_request", request_id: "int_" + crypto.randomUUID(), request: { subtype: "interrupt" } });
  r.interrupted = true;
  r.note = "wird gestoppt";
  emitRun(r);
}

function release(id) {
  const r = runs.get(id);
  if (!r) return;
  r.status = "closing";
  try { r.proc.stdin.end(); } catch {}
  // Erst nach einer Gnadenfrist hart beenden: nur ein sauber beendeter Prozess schreibt seine Kosten ins Transkript
  setTimeout(() => { if (runs.get(id) === r) r.proc.kill(); }, 30000);
}

setInterval(() => {
  for (const [id, r] of runs) if (r.status === "idle" && Date.now() - r.lastActivity > IDLE_MS) release(id);
}, 60 * 1000);
// Beim Beenden die Claude-Prozesse sauber schließen (damit ihre Kosten geschrieben werden), höchstens 10 Sekunden.
// Ein zweites Strg C beendet sofort.
function shutdown() {
  if (!runs.size) process.exit(0);
  console.log(`Beende ${runs.size} Claude-Prozess(e) …`);
  for (const id of [...runs.keys()]) release(id);
  setInterval(() => { if (!runs.size) process.exit(0); }, 200);
  setTimeout(() => { for (const r of runs.values()) r.proc.kill(); process.exit(0); }, 10000);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, shutdown);

// ---------- Dort öffnen, wo die Session herkommt ----------
// Die Claude-App führt pro Code-Session eine Datei local_<id>.json mit der zugehörigen
// Transkript-ID (cliSessionId). Darüber findet der Link claude://code/continue die Session.
function appSessionDirs() {
  const home = os.homedir(), dirs = [];
  if (process.env.CLAUDE_APP_SESSIONS) dirs.push(process.env.CLAUDE_APP_SESSIONS);
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
    try { for (const d of fs.readdirSync(path.join(local, "Claude-Data"))) dirs.push(path.join(local, "Claude-Data", d, "claude-code-sessions")); } catch {}
    dirs.push(path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude-code-sessions"));
  } else if (process.platform === "darwin") {
    dirs.push(path.join(home, "Library", "Application Support", "Claude", "claude-code-sessions"));
  } else {
    dirs.push(path.join(home, ".config", "Claude", "claude-code-sessions"));
  }
  return dirs.filter(d => fs.existsSync(d));
}

let appMap = new Map(), appMapAt = 0;
function appSessions() {
  if (Date.now() - appMapAt < 15000) return appMap;
  const map = new Map();
  const walk = (dir, depth) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && /^local_[\w-]+\.json$/.test(e.name)) {
        try {
          const o = JSON.parse(fs.readFileSync(p, "utf8"));
          if (o.cliSessionId && /^local_[A-Za-z0-9-]{1,64}$/.test(o.sessionId)) map.set(o.cliSessionId, {
            id: o.sessionId, archived: !!o.isArchived,
            focusedAt: o.lastFocusedAt || 0, turnEdgeAt: o.lastTurnEdgeAt || 0,
            summary: o.postTurnSummary || null, report: o.lastTurnReport || null,
            cutShort: !!o.lastTurnCutShort, awaiting: o.interruptedAwaitingPerson || null,
          });
        } catch {}
      }
    }
  };
  for (const d of appSessionDirs()) walk(d, 0);
  appMap = map;
  appMapAt = Date.now();
  return map;
}

// ---------- Zustand: Wer ist dran, und braucht die Session dich? ----------
// Gesehen-Zeitpunkte: wann du eine Session hier zuletzt geöffnet hast (die App merkt sich ihres selbst)
const SEEN_FILE = path.join(os.tmpdir(), "session-canvas-seen.json");
const seen = new Map();
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")))) seen.set(k, v); } catch {}
let seenTimer = null;
function markSeen(id) {
  seen.set(id, Date.now());
  clearTimeout(seenTimer);
  seenTimer = setTimeout(() => fs.writeFile(SEEN_FILE, JSON.stringify(Object.fromEntries(seen)), () => {}), 500);
}

// Archiviert: wann du eine Session hier archiviert hast (0 = ausdrücklich zurückgeholt).
// Tut sich danach etwas in ihr, ist sie von selbst wieder da. Ohne Eintrag zählt das Archiv der Claude-App.
const ARCHIVE_FILE = path.join(os.tmpdir(), "session-canvas-archived.json");
const archived = new Map();
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(ARCHIVE_FILE, "utf8")))) archived.set(k, v); } catch {}
function setArchived(id, on) {
  archived.set(id, on ? Date.now() : 0);
  fs.writeFile(ARCHIVE_FILE, JSON.stringify(Object.fromEntries(archived)), () => {});
}

const STALL_MS = 3 * 60 * 1000;   // so lange darf Claudes Zug still sein, bevor er als hängend gilt
const FRESH_MS = 6 * 60 * 60 * 1000; // ohne Gesehen-Info gelten nur so junge Antworten als ungelesen

function stateOf(s, st) {
  const run = runs.get(s.id), app = appSessions().get(s.id);
  const quiet = Date.now() - st.mtimeMs;
  const last = s.last;
  const endMs = s.end ? Date.parse(s.end) : st.mtimeMs;
  const claudesTurn = !!last && !(last.r === "assistant" && last.kind === "text") && last.kind !== "interrupt";
  const seenAt = Math.max(seen.get(s.id) || 0, app ? app.focusedAt : 0);
  const age = Date.now() - endMs;
  const unread = !claudesTurn && age < 3 * 864e5 && (seenAt ? endMs > seenAt : age < FRESH_MS);
  const wrapIsCurrent = s.wrap && last && s.wrap.ts && Date.parse(s.wrap.ts) >= Date.parse(last.ts) - 60000;
  const summary = app && app.summary && app.turnEdgeAt && endMs - app.turnEdgeAt < 120000 ? app.summary : null;
  const where = app && !run ? " in der Claude-App" : "";
  let kind, detail = "", since = null;

  if (run && run.pending.size) {
    const p = [...run.pending.values()][0];
    kind = "needs_you"; since = p.at;
    detail = p.tool === "AskUserQuestion" ? "Claude stellt dir eine Frage" : `Wartet auf deine Erlaubnis für ${p.display || p.tool}`;
  } else if (run && (run.status === "working" || run.status === "starting")) {
    kind = "working"; detail = run.note || "Arbeitet …";
  } else if (claudesTurn && quiet < STALL_MS) {
    kind = "working";
    detail = last.kind === "tool_use" ? `Arbeitet: ${last.tools.slice(0, 3).join(", ")}` : "Antwortet …";
  } else if (claudesTurn) {
    since = st.mtimeMs;
    if (app && app.awaiting) { kind = "needs_you"; detail = `Wartet auf dich${where}`; }
    else if (last.kind === "tool_use" && last.tools.includes("AskUserQuestion")) { kind = "needs_you"; detail = `Claude stellt dir eine Frage${where}` + (s.question ? `: ${s.question.q}` : ""); }
    else if (last.kind === "tool_use") { kind = "needs_you"; detail = `Wartet auf Erlaubnis für ${last.tools.slice(0, 2).join(", ")}${where}`; }
    else if (app && app.cutShort) { kind = "stalled"; detail = "Der letzte Zug wurde abgebrochen"; }
    else { kind = "stalled"; detail = "Deine letzte Nachricht blieb unbeantwortet"; }
  } else if (wrapIsCurrent && s.wrap.ask) {
    kind = "needs_you"; since = endMs; detail = s.wrap.ask;
  } else if (summary && summary.needs_action) {
    kind = "needs_you"; since = endMs; detail = summary.needs_action;
  } else {
    kind = unread ? "done" : "idle";
    detail = (wrapIsCurrent && s.wrap.recap) || (summary && summary.status_detail) || (app && app.report) || s.lastClaude.replace(/\s+/g, " ").slice(0, 220);
    if (summary && summary.status_category === "blocked") { kind = "needs_you"; since = endMs; }
  }
  // Archiviert schlägt alles außer Arbeit und einer Erlaubnis, auf die unser eigener Prozess wartet
  const isArchived = archived.has(s.id) ? archived.get(s.id) >= endMs : !!(app && app.archived);
  if (isArchived && kind !== "working" && !(run && run.pending.size)) { kind = "archived"; since = null; }
  return { kind, detail: String(detail || "").slice(0, 300), unread, since, yourTurn: !claudesTurn, actions: wrapIsCurrent ? s.wrap.actions : [] };
}

function openerOf(s) {
  const from = s.entrypoint === "claude-desktop" ? "app" : s.entrypoint === "claude-vscode" ? "vscode" : "terminal";
  const app = appSessions().get(s.id);
  // Archivierte App-Sessions findet der App-Link nicht mehr – dann ins Terminal
  if (app && !app.archived) return { kind: "app", from };
  return { kind: from === "vscode" ? "vscode" : "terminal", from, archived: !!(app && app.archived) };
}

const commandCache = new Map();
function hasCommand(name) {
  if (!commandCache.has(name)) {
    const r = require("child_process").spawnSync(process.platform === "win32" ? "where" : "which", [name], { windowsHide: true });
    commandCache.set(name, r.status === 0);
  }
  return commandCache.get(name);
}
const detach = { detached: true, stdio: "ignore", windowsHide: true };
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

function openUrl(url) {
  if (process.platform === "win32") spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], detach).unref();
  else spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], detach).unref();
}

function openTerminal(cwd, id) {
  if (process.platform === "win32") {
    if (hasCommand("wt")) spawn("wt.exe", ["-d", cwd, CLAUDE_BIN, "--resume", id], detach).unref();
    else spawn("cmd.exe", ["/d", "/s", "/c", `start "Claude" /D "${cwd}" cmd /k ""${CLAUDE_BIN}" --resume ${id}"`], { ...detach, windowsVerbatimArguments: true }).unref();
  } else if (process.platform === "darwin") {
    const cmd = `cd ${shq(cwd)} && ${shq(CLAUDE_BIN)} --resume ${id}`;
    spawn("osascript", ["-e", `tell application "Terminal" to do script ${JSON.stringify(cmd)}`, "-e", `tell application "Terminal" to activate`], detach).unref();
  } else {
    spawn("x-terminal-emulator", ["-e", "bash", "-lc", `cd ${shq(cwd)} && ${shq(CLAUDE_BIN)} --resume ${id}; exec bash`], detach).unref();
  }
}

function openVsCode(cwd, id) {
  // Erst den Projektordner öffnen (bzw. sein Fenster nach vorn holen), dann die Session darin
  if (hasCommand("code")) {
    if (process.platform === "win32") spawn("cmd.exe", ["/d", "/s", "/c", `"code "${cwd}""`], { ...detach, windowsVerbatimArguments: true }).unref();
    else spawn("code", [cwd], detach).unref();
  }
  setTimeout(() => openUrl(`vscode://anthropic.claude-code/open?session=${id}`), hasCommand("code") ? 2500 : 0);
}

function openSession(id, target) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Ungültige Session-ID.");
  const sess = findSession(id);
  if (!sess) throw new Error("Diese Session gibt es nicht.");
  const r = runs.get(id);
  if (r && (r.status === "working" || r.status === "starting" || r.pending.size)) {
    throw new Error("Claude arbeitet in dieser Session gerade von hier aus. Stoppe oder trenne sie zuerst, sonst schreiben zwei Programme gleichzeitig.");
  }
  if (r) release(id); // unser Prozess gibt die Session frei
  const kind = target === "terminal" ? "terminal" : sess.opener.kind;
  if (kind === "app") {
    openUrl(`claude://code/continue?session=${appSessions().get(id).id}`);
  } else {
    if (!sess.cwd || !fs.existsSync(sess.cwd)) throw new Error(`Den Projektordner gibt es nicht mehr (${sess.cwd || "unbekannt"}).`);
    if (kind === "vscode") openVsCode(sess.cwd, id);
    else openTerminal(sess.cwd, id);
  }
  return kind;
}

// ---------- Schutz ----------
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const hostOk = req => ALLOWED_HOSTS.has(String(req.headers.host || "").toLowerCase()); // gegen DNS-Rebinding
function postOk(req) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, "").toLowerCase())) return false;
  const tok = String(req.headers["x-canvas-token"] || "");
  return tok.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(TOKEN));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", d => { body += d; if (body.length > 200000) { reject(new Error("Nachricht zu groß")); req.destroy(); } });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error("Ungültiges JSON")); } });
  });
}

function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (!hostOk(req)) return send(res, 403, { error: "Nur über localhost erreichbar." });
  try {
    if (req.method === "POST") {
      if (!postOk(req)) return send(res, 403, { error: "Nicht erlaubt." });
      if (url.pathname === "/api/new") {
        const body = await readJson(req);
        return send(res, 200, { ok: true, id: await newSession(body.cwd, body.text, body.mode) });
      }
      const pm = url.pathname.match(/^\/api\/sessions\/([\w-]+)\/(send|permission|interrupt|release|open|open-file|seen|archive|unarchive)$/);
      if (!pm) return send(res, 404, { error: "not found" });
      const [, id, action] = pm;
      const body = await readJson(req);
      if (action === "seen") { markSeen(id); return send(res, 200, { ok: true }); }
      if (action === "archive" || action === "unarchive") {
        if (!findSession(id)) return send(res, 404, { error: "Diese Session gibt es nicht." });
        setArchived(id, action === "archive");
        pushChange();
        return send(res, 200, { ok: true });
      }
      if (action === "open") return send(res, 200, { ok: true, opened: openSession(id, body.target) });
      if (action === "open-file") { openFile(id, String(body.path || "")); return send(res, 200, { ok: true, with: fileOpener() }); }
      if (action === "send") {
        const text = String(body.text || "").trim();
        if (!text) return send(res, 400, { error: "Die Nachricht ist leer." });
        await sendMessage(id, text, body.mode, body.model, body.effort);
      } else if (action === "permission") {
        answerPermission(id, String(body.requestId), !!body.allow, body.answers, body.message);
      } else if (action === "interrupt") interrupt(id);
      else release(id);
      return send(res, 200, { ok: true, run: runs.has(id) ? runInfo(runs.get(id)) : null });
    }

    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`retry: 3000\n\n`);
      listeners.add(res);
      req.on("close", () => listeners.delete(res));
      return;
    }

    if (url.pathname === "/api/sessions") return send(res, 200, { dir: PROJECTS_DIR, now: Date.now(), sessions: allSessions() });

    if (url.pathname === "/api/search") return send(res, 200, { hits: search(url.searchParams.get("q") || "") });

    const m = url.pathname.match(/^\/api\/sessions\/([\w-]+)$/);
    if (m) {
      const raw = findRaw(m[1]);
      if (!raw) return send(res, 404, { error: "not found" });
      const { s, st } = raw;
      const all = url.searchParams.get("all") === "1"; // für Sprünge zu älteren Suchtreffern
      return send(res, 200, {
        ...summarize(s, st),
        messages: all ? s.messages : s.messages.slice(-MAX_MSGS),
        older: all ? 0 : Math.max(0, s.messages.length - MAX_MSGS),
        tools: s.tools,
        files: [...s.files.values()].reverse().slice(0, 150),
        fileOpener: fileOpener(),
      });
    }

    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file)) return send(res, 404, "Not found", "text/plain");
    let content = fs.readFileSync(file);
    if (rel === "index.html") content = content.toString("utf8").replace("__CANVAS_TOKEN__", TOKEN);
    send(res, 200, content, MIME[path.extname(file)] || "application/octet-stream");
  } catch (e) {
    if (req.method !== "POST") console.error(e);
    send(res, req.method === "POST" ? 400 : 500, { error: e.message });
  }
});

// Nur lokal erreichbar – die Transkripte sind privat.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Session Canvas läuft auf http://localhost:${PORT}`);
  console.log(`Lese Sessions aus ${PROJECTS_DIR}`);
});
