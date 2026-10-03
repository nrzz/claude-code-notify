// What a notification says. Privacy first: by default the text holds the project folder's name,
// how long the turn took, or Claude Code's own short notification message. Nothing you typed, no
// paths, no file names. Claude's last reply is added only when you turn that on.
import path from "node:path";
import { readTail } from "./fsutil.mjs";

// Whitespace-like controls become a space. Every other control character (C0, DEL, C1: these include
// the ESC and CSI that start terminal escape sequences), bidi overrides, zero-width spaces and the
// byte order mark are dropped. Zero-width joiners stay, because emoji and some scripts need them.
// The sets are built from code points, so no invisible character sits in this source file.
const chars = (...codePoints) => codePoints.map((c) => String.fromCharCode(c)).join("");
const SPACEY = new RegExp(`[\\t\\n\\v\\f\\r\\x85${chars(0x2028, 0x2029)}]+`, "g");
const DROP = new RegExp(
  `[\\x00-\\x1f\\x7f-\\x9f${chars(0x180e, 0x200b, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff)}]`,
  "g",
);

/** One line of printable text, at most `max` characters (counted as code points, cut with an ellipsis). */
export function cleanText(value, max = Infinity) {
  let t = String(value ?? "").replace(SPACEY, " ").replace(DROP, "").replace(/\s+/g, " ").trim();
  if (max !== Infinity) {
    const cps = Array.from(t);
    if (cps.length > max) t = cps.slice(0, Math.max(0, max - 1)).join("").trimEnd() + "…";
  }
  return t;
}

/** 133000 -> "2m 13s", 45000 -> "45s", 3900000 -> "1h 5m". */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

/** The project's display name: a name set in .claude/notify.json, else the folder's own name. */
export function projectName({ cwd, root, name }) {
  const chosen = cleanText(name, 60);
  if (chosen) return chosen;
  const dir = String(root || cwd || "");
  const base = path.basename(dir.replace(/[\\/]+$/, ""));
  return cleanText(base || dir, 60) || "project";
}

const FALLBACK = {
  permission_prompt: "Claude needs your permission",
  worker_permission_prompt: "Claude needs your permission",
  idle_prompt: "Claude is waiting for your input",
  agent_needs_input: "An agent needs your input",
};
function fallbackFor(type) {
  if (typeof type === "string" && FALLBACK[type]) return FALLBACK[type];
  if (typeof type === "string" && type.startsWith("elicitation")) return "Claude needs your input";
  return "Claude needs your attention";
}

/**
 * The text of Claude's last reply in a transcript (a JSONL file), read from its tail. "" when the file
 * cannot be read or holds no reply yet. Replies of sub-agents are not "Claude's last reply".
 */
export function lastAssistantText(file, { tailBytes = 256 * 1024 } = {}) {
  if (typeof file !== "string" || !file) return "";
  const lines = readTail(file, tailBytes).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line || !line.includes('"assistant"')) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (!rec || rec.isSidechain === true) continue;
    if (rec.type !== "assistant" && rec.message?.role !== "assistant") continue;
    const content = rec.message?.content;
    let t = "";
    if (typeof content === "string") t = content;
    else if (Array.isArray(content)) t = content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join(" ");
    t = cleanText(t);
    if (t) return t;
  }
  return "";
}

/** The first 120 characters, with an ellipsis when there is more. */
export function snippet(text, n = 120) {
  const cps = Array.from(cleanText(text));
  return cps.slice(0, n).join("").trimEnd() + (cps.length > n ? "…" : "");
}

/**
 * The words for one notification, in two versions: `local` (terminal, desktop, your own command) and
 * `remote` (ntfy, Slack, Discord, Teams). They differ only in `detail`, Claude's last reply, which
 * reaches a remote channel only when both includeLastMessage and includeLastMessageRemote are on.
 * @returns { local: {title, body, detail}, remote: {title, body, detail} }
 */
export function buildMessages({ kind, project, notificationMessage, notificationType, durationMs, lastText, cfg }) {
  let body;
  if (kind === "finished") {
    body = durationMs == null ? `Finished in ${project}` : `Finished in ${project} after ${formatDuration(durationMs)}`;
  } else {
    body = `${project}: ${cleanText(notificationMessage, 200) || fallbackFor(notificationType)}`;
  }
  const detail = cfg.includeLastMessage && lastText ? snippet(lastText) : "";
  return {
    local: { title: cfg.title, body, detail },
    remote: { title: cfg.title, body, detail: cfg.includeLastMessageRemote ? detail : "" },
  };
}
