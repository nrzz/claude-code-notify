// Where things live, and reading, validating and writing settings.
//
//   <configDir>/notify.json         your settings, including webhook URLs and tokens (mode 0600)
//   <configDir>/notify/state/       one small file per session: when the turn started, last push per channel
//   <configDir>/notify/notify.log   a capped log, one line per decision
//   <configDir>/notify/app/         the copy of notify.mjs and src/ that `init` registers as the hooks
//   <project>/.claude/notify.json   optional, shared with the team: only name, minTurnSeconds, quiet and
//                                   notifyAutomated are read from it (never a URL, token or command)
//
// <configDir> is $CLAUDE_CONFIG_DIR when set, else ~/.claude, the way Claude Code does it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseQuiet } from "./decide.mjs";
import { readText, writeFileAtomic } from "./fsutil.mjs";

export const VERSION = "1.0.0";
export const REPO_URL = "https://github.com/nrzz/claude-code-notify";
/** The folder this code runs from: the repo, an installed copy, or the plugin folder. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_TITLE = "Claude Code";
export const TERMINAL_MODES = ["osc9", "osc777", "title", "bell", "off"];
export const TEAMS_FORMATS = ["card", "text"];
export const PRIORITY_NAMES = ["min", "low", "default", "high", "max", "urgent"];
/** Settings a project may carry in .claude/notify.json. Nothing that can send data or run a command. */
export const PROJECT_KEYS = ["name", "minTurnSeconds", "quiet", "notifyAutomated"];

export function configDir(env = process.env) {
  const custom = env.CLAUDE_CONFIG_DIR && String(env.CLAUDE_CONFIG_DIR).trim();
  return path.resolve(custom || path.join(os.homedir(), ".claude"));
}
export const notifyDir = (env) => path.join(configDir(env), "notify");
export const userConfigPath = (env) => path.join(configDir(env), "notify.json");
export const stateDir = (env) => path.join(notifyDir(env), "state");
export const outboxDir = (env) => path.join(notifyDir(env), "outbox");
export const logPath = (env) => path.join(notifyDir(env), "notify.log");
export const appDir = (env) => path.join(notifyDir(env), "app");
export const PROJECT_CONFIG = path.join(".claude", "notify.json");

/** How long network sends and desktop commands may take: 5 seconds (CLAUDE_NOTIFY_TIMEOUT_MS overrides it, for tests). */
export function sendTimeout(env = process.env) {
  const n = Number(env.CLAUDE_NOTIFY_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 5000;
}

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------------------------

/** on/off, true/false, yes/no, 1/0 -> boolean, anything else -> null. */
export function parseBool(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (["on", "true", "yes", "y", "1"].includes(v)) return true;
  if (["off", "false", "no", "n", "0"].includes(v)) return false;
  return null;
}
const bool = (v, d) => (typeof v === "boolean" ? v : (parseBool(v) ?? d));
const num = (v, d, min, max) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= min && n <= max ? n : d;
};
const text = (v) => (typeof v === "string" ? v.trim() : "");
// eslint-disable-next-line no-control-regex
const oneLine = (v) => String(v ?? "").replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim();

const isLoopback = (host) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1" || host.endsWith(".localhost");

/** A usable endpoint: https, or http for this machine (and for any host when allowHttp, a self-hosted ntfy). */
export function validUrl(value, { allowHttp = false } = {}) {
  let u;
  try { u = new URL(String(value)); } catch { return false; }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && (allowHttp || isLoopback(u.hostname));
}

/** ntfy accepts names or the numbers 1 to 5. */
export function validPriority(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return PRIORITY_NAMES.includes(s) || /^[1-5]$/.test(s) ? s : "";
}

const validTopic = (t) => /^[A-Za-z0-9_-]{1,64}$/.test(t);

function argv(v) {
  return Array.isArray(v) && v.length && v.every((x) => typeof x === "string") && v[0].trim() ? v.slice() : [];
}

// ---------------------------------------------------------------------------------------------
// The settings, with defaults
// ---------------------------------------------------------------------------------------------

/**
 * What a hand-edited notify.json becomes: every value checked, a bad one replaced by its default,
 * so a typo can never break a hook or silence it by accident.
 */
export function normalizeConfig(raw) {
  const r = isObj(raw) ? raw : {};
  const ntfy = isObj(r.ntfy) ? r.ntfy : {};
  const slack = isObj(r.slack) ? r.slack : {};
  const discord = isObj(r.discord) ? r.discord : {};
  const teams = isObj(r.teams) ? r.teams : {};
  const hook = (o) => (typeof o.url === "string" && validUrl(o.url.trim()) ? o.url.trim() : "");
  const types = {};
  if (isObj(r.types)) for (const [k, v] of Object.entries(r.types)) if (typeof v === "boolean") types[k] = v;
  const terminal = typeof r.terminal === "string" ? r.terminal.trim().toLowerCase() : "";
  return {
    enabled: bool(r.enabled, true),
    title: oneLine(r.title).slice(0, 60) || DEFAULT_TITLE,
    minTurnSeconds: num(r.minTurnSeconds, 30, 0, 86400),
    notifyAutomated: bool(r.notifyAutomated, false),
    quiet: parseQuiet(r.quiet) ? String(r.quiet).trim() : "",
    rateLimitSeconds: num(r.rateLimitSeconds, 20, 0, 3600),
    includeLastMessage: bool(r.includeLastMessage, false),
    includeLastMessageRemote: bool(r.includeLastMessageRemote, false),
    terminal: TERMINAL_MODES.includes(terminal) ? terminal : "osc9",
    desktop: bool(r.desktop, false),
    ntfy: {
      topic: validTopic(text(ntfy.topic)) ? text(ntfy.topic) : "",
      url: typeof ntfy.url === "string" && validUrl(ntfy.url.trim(), { allowHttp: true }) ? ntfy.url.trim() : "https://ntfy.sh",
      token: text(ntfy.token),
      priority: validPriority(ntfy.priority),
    },
    slack: { url: hook(slack) },
    discord: { url: hook(discord) },
    teams: { url: hook(teams), format: TEAMS_FORMATS.includes(teams.format) ? teams.format : "card" },
    command: argv(r.command),
    types,
    mutedProjects: Array.isArray(r.mutedProjects) ? r.mutedProjects.filter((p) => typeof p === "string" && p) : [],
    name: "",
  };
}

/** The user's settings with this project's few allowed overrides on top. */
export function effectiveConfig(userRaw, projectRaw) {
  const cfg = normalizeConfig(userRaw);
  const p = isObj(projectRaw) ? projectRaw : {};
  if (p.minTurnSeconds !== undefined) cfg.minTurnSeconds = num(p.minTurnSeconds, cfg.minTurnSeconds, 0, 86400);
  if (p.notifyAutomated !== undefined) cfg.notifyAutomated = bool(p.notifyAutomated, cfg.notifyAutomated);
  if (p.quiet !== undefined) {
    if (p.quiet === "" || p.quiet === "off") cfg.quiet = "";
    else if (parseQuiet(p.quiet)) cfg.quiet = String(p.quiet).trim();
  }
  if (typeof p.name === "string") cfg.name = oneLine(p.name).slice(0, 60);
  return cfg;
}

/** Plain-language problems in a raw settings object, for `status`. */
export function configProblems(raw) {
  const r = isObj(raw) ? raw : {};
  const out = [];
  const url = (key, value, opts) => {
    if (value !== undefined && value !== "" && !(typeof value === "string" && validUrl(value.trim(), opts))) {
      out.push(`${key} is not a valid URL, so it is ignored (${opts && opts.allowHttp ? "it must start with http:// or https://" : "it must start with https://, or http:// for this machine"})`);
    }
  };
  for (const k of ["slack", "discord", "teams"]) url(`${k}.url`, isObj(r[k]) ? r[k].url : undefined);
  url("ntfy.url", isObj(r.ntfy) ? r.ntfy.url : undefined, { allowHttp: true });
  if (isObj(r.ntfy) && r.ntfy.topic && !validTopic(text(r.ntfy.topic))) out.push("ntfy.topic must be 1 to 64 letters, digits, - or _, so ntfy is off");
  if (r.terminal !== undefined && !TERMINAL_MODES.includes(String(r.terminal).toLowerCase())) out.push(`terminal "${r.terminal}" is not one of ${TERMINAL_MODES.join(", ")}; using osc9`);
  if (r.quiet && !parseQuiet(r.quiet)) out.push(`quiet "${r.quiet}" is not HH:MM-HH:MM, so quiet hours are off`);
  if (r.command !== undefined && !argv(r.command).length) out.push("command must be a list like [\"node\", \"script.js\"], so it is ignored");
  if (r.minTurnSeconds !== undefined && num(r.minTurnSeconds, -1, 0, 86400) < 0) out.push("minTurnSeconds must be a number of seconds; using 30");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reading and writing the files
// ---------------------------------------------------------------------------------------------

// A settings file is a few hundred bytes. The project's one comes from a repository, so a hook must
// not spend its time (or memory) on a huge one.
const MAX_CONFIG_BYTES = 256 * 1024;

function readConfigFile(file) {
  let size;
  try { size = fs.statSync(file).size; } catch { return { status: "missing", data: {}, file }; }
  if (size > MAX_CONFIG_BYTES) return { status: "invalid", data: {}, file };
  const body = readText(file);
  if (body === null) return { status: "missing", data: {}, file };
  if (!body.trim()) return { status: "ok", data: {}, file };
  try {
    const data = JSON.parse(body);
    if (isObj(data)) return { status: "ok", data, file };
  } catch { /* falls through */ }
  return { status: "invalid", data: {}, file };
}

/** { status: "missing" | "ok" | "invalid", data, file }. An invalid file is reported, never overwritten. */
export function readUserConfig(env = process.env) {
  return readConfigFile(userConfigPath(env));
}

/** Settings hold secrets, so the file is private to the owner where the OS has modes. */
export function saveUserConfig(env, data) {
  writeFileAtomic(userConfigPath(env), JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
}

export function readProjectConfig(root) {
  return readConfigFile(path.join(root, PROJECT_CONFIG));
}

export function saveProjectConfig(root, data) {
  writeFileAtomic(path.join(root, PROJECT_CONFIG), JSON.stringify(data, null, 2) + "\n");
}

// ---------------------------------------------------------------------------------------------
// Projects: which one a session belongs to, and muting
// ---------------------------------------------------------------------------------------------

/** The nearest folder at or above `start` that has a .git (a folder, or a file in worktrees and submodules). */
export function findGitRoot(start) {
  let dir = path.resolve(String(start || "."));
  for (let i = 0; i < 64; i++) {
    try { if (fs.existsSync(path.join(dir, ".git"))) return dir; } catch { /* unreadable: keep climbing */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** A comparable form of a project folder: links resolved, no trailing slash, case folded where the file system folds it. */
export function projectKey(p) {
  let r = path.resolve(String(p));
  try { r = fs.realpathSync.native(r); } catch { /* a folder that is gone */ }
  r = r.replace(/[\\/]+$/, "");
  return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
}

export function isMuted(mutedProjects, root) {
  if (!mutedProjects || !mutedProjects.length) return false;
  const key = projectKey(root);
  return mutedProjects.some((p) => projectKey(p) === key);
}

// ---------------------------------------------------------------------------------------------
// Masking, for `status`
// ---------------------------------------------------------------------------------------------

export function maskSecret(value) {
  const t = String(value ?? "");
  if (!t) return "";
  return t.length <= 8 ? "*".repeat(t.length) : `${t.slice(0, 2)}…${t.slice(-2)}`;
}

/** A webhook URL shows its host and the last two characters, nothing that works as a credential. */
export function maskUrl(value) {
  try {
    const u = new URL(String(value));
    const tail = `${u.pathname}${u.search}`;
    return `${u.origin}/…${tail.length > 8 ? tail.slice(-2) : ""}`;
  } catch {
    return maskSecret(value);
  }
}

// ---------------------------------------------------------------------------------------------
// `claude-notify set <key> <value>`
// ---------------------------------------------------------------------------------------------

const BOOL_KEYS = ["enabled", "notifyAutomated", "desktop", "includeLastMessage", "includeLastMessageRemote"];
const ENUM_KEYS = { terminal: TERMINAL_MODES, "teams.format": TEAMS_FORMATS };
const URL_KEYS = { "slack.url": {}, "discord.url": {}, "teams.url": {}, "ntfy.url": { allowHttp: true } };
const NUMBER_KEYS = { minTurnSeconds: [0, 86400], rateLimitSeconds: [0, 3600] };
export const SETTING_KEYS = [
  ...BOOL_KEYS, ...Object.keys(NUMBER_KEYS), "quiet", "terminal", "title",
  "ntfy.topic", "ntfy.url", "ntfy.token", "ntfy.priority", "slack.url", "discord.url", "teams.url", "teams.format",
  "command", "types.<name>",
];
const SECRET_KEYS = new Set(["ntfy.topic", "ntfy.token", "slack.url", "discord.url", "teams.url"]);

const pad2 = (n) => String(n).padStart(2, "0");

function setIn(obj, keyPath, value) {
  const parts = keyPath.split(".");
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(o[parts[i]])) o[parts[i]] = {};
    o = o[parts[i]];
  }
  o[parts[parts.length - 1]] = value;
}

function deleteIn(obj, keyPath) {
  const parts = keyPath.split(".");
  const trail = [obj];
  let o = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(o[parts[i]])) return;
    o = o[parts[i]];
    trail.push(o);
  }
  delete o[parts[parts.length - 1]];
  for (let i = parts.length - 2; i >= 0; i--) { // drop a parent object that became empty
    if (Object.keys(trail[i + 1]).length) break;
    delete trail[i][parts[i]];
  }
}

/**
 * Validate one `set` and apply it to a copy of the raw settings.
 * `args` is the list of words after the key. The word `default` (and `off` for text settings)
 * removes the setting.
 * @returns { ok: true, data, shown } | { ok: false, error }
 */
export function applySetting(raw, key, args, { project = false } = {}) {
  const data = JSON.parse(JSON.stringify(isObj(raw) ? raw : {}));
  const values = Array.isArray(args) ? args.map(String) : [String(args ?? "")];
  const value = values.join(" ").trim();
  const bad = (error) => ({ ok: false, error });
  const done = (shown) => ({ ok: true, data, shown });
  const clear = (shown = "(cleared)") => { deleteIn(data, key); return done(shown); };
  const isClear = /^(default|off|none)$/i.test(value) || value === "";

  const typeKey = /^types\.([A-Za-z0-9_]+)$/.exec(key);
  if (project && !PROJECT_KEYS.includes(key)) {
    return bad(`"${key}" cannot be set per project. A project may set ${PROJECT_KEYS.join(", ")}; everything else, and every URL, token and command, lives in your own settings.`);
  }
  if (!SETTING_KEYS.includes(key) && !typeKey && !(project && key === "name")) {
    return bad(`Unknown setting "${key}". Settings: ${SETTING_KEYS.join(", ")}.`);
  }
  if (key !== "command" && values.length > 1) return bad(`"${key}" takes one value; quote it if it has spaces.`);
  if (value === "" && key !== "command") return bad(`Give "${key}" a value (or "default" to remove it).`);

  if (BOOL_KEYS.includes(key) || typeKey) {
    if (/^default$/i.test(value)) return clear();
    const b = parseBool(value);
    if (b === null) return bad(`"${key}" is on or off.`);
    setIn(data, key, b);
    return done(b ? "on" : "off");
  }
  if (key in NUMBER_KEYS) {
    if (/^default$/i.test(value)) return clear();
    const [min, max] = NUMBER_KEYS[key];
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) return bad(`"${key}" is a number of seconds from ${min} to ${max}.`);
    setIn(data, key, n);
    return done(String(n));
  }
  if (key in ENUM_KEYS) {
    if (/^default$/i.test(value)) return clear();
    const v = value.toLowerCase();
    if (!ENUM_KEYS[key].includes(v)) return bad(`"${key}" is one of: ${ENUM_KEYS[key].join(", ")}.`);
    setIn(data, key, v);
    return done(v);
  }
  switch (key) {
    case "quiet": {
      if (isClear) return clear("off");
      const q = parseQuiet(value);
      if (!q) return bad('"quiet" looks like 22:00-08:00 (local time, may cross midnight), or "off".');
      const hh = (m) => pad2(Math.floor(m / 60));
      const mm = (m) => pad2(m % 60);
      setIn(data, key, `${hh(q.start)}:${mm(q.start)}-${hh(q.end)}:${mm(q.end)}`);
      return done(data.quiet);
    }
    case "name": {
      if (isClear) return clear();
      setIn(data, key, oneLine(value).slice(0, 60));
      return done(data.name);
    }
    case "title": {
      if (isClear) return clear(`${DEFAULT_TITLE} (default)`);
      setIn(data, key, oneLine(value).slice(0, 60));
      return done(data.title);
    }
    case "ntfy.topic": {
      if (isClear) return clear();
      const generated = /^auto$/i.test(value);
      const topic = generated ? `claude-${randomBytes(9).toString("base64url")}` : value;
      if (!validTopic(topic)) return bad('"ntfy.topic" is 1 to 64 letters, digits, - or _ (or "auto" for a random one). Anyone who knows a topic on ntfy.sh can read it, so pick a long one.');
      setIn(data, key, topic);
      // A topic you typed is shown masked like any secret. A generated one is shown once in full: you need it to subscribe.
      if (generated) {
        return { ok: true, data, shown: topic, note: "Generated just now. Subscribe to this exact name in the ntfy app. Anyone who knows it can read your notifications on a public ntfy server, so keep it private; status shows it masked." };
      }
      return done(maskSecret(topic));
    }
    case "ntfy.token": {
      if (isClear) return clear();
      if (/\s/.test(value)) return bad('"ntfy.token" has no spaces.');
      setIn(data, key, value);
      return done(maskSecret(value));
    }
    case "ntfy.priority": {
      if (/^(default|none|off)$/i.test(value)) return clear("by event (high for needs-you, default for finished)");
      const p = validPriority(value);
      if (!p) return bad(`"ntfy.priority" is one of ${PRIORITY_NAMES.join(", ")} or 1 to 5.`);
      setIn(data, key, p);
      return done(p);
    }
    case "command": {
      if (values.length === 1 && isClear) return clear();
      let list = values;
      if (values.length === 1 && values[0].trim().startsWith("[")) {
        try { list = JSON.parse(values[0]); } catch { return bad('"command" is a JSON list like ["node","script.js"], or the words of the command.'); }
      }
      if (!argv(list).length) return bad('"command" needs at least the program to run, for example: set command node C:\\scripts\\ping.js');
      setIn(data, key, list.slice());
      return done(JSON.stringify(list));
    }
    default:
      break;
  }
  if (key in URL_KEYS) {
    if (isClear) return clear();
    if (!validUrl(value, URL_KEYS[key])) {
      return bad(`"${key}" must be a full https:// URL${key === "ntfy.url" ? " (http:// works for a server on your own network)" : ""}.`);
    }
    setIn(data, key, value);
    return done(SECRET_KEYS.has(key) ? maskUrl(value) : value);
  }
  return bad(`Unknown setting "${key}".`);
}
