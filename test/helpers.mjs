// Shared test helpers. Every test that touches settings, config, state or logs runs against a throwaway
// folder passed through CLAUDE_CONFIG_DIR (and a throwaway HOME / USERPROFILE), never the real ~/.claude.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NOTIFY = path.join(ROOT, "notify.mjs");
export const CLI = path.join(ROOT, "bin", "claude-notify.mjs");
export const IS_WIN = process.platform === "win32";

const tmpBase = () => fs.realpathSync(os.tmpdir());
function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* a detached child may still hold a file; the OS temp folder is cleaned later */ }
}

// A safety net for the whole test process: anything that forgets to pass its own environment resolves
// the Claude config folder and the home folder inside a throwaway folder, not the real ones.
const GUARD = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), "cn-g-")));
process.env.CLAUDE_CONFIG_DIR = path.join(GUARD, "cfg");
process.env.HOME = path.join(GUARD, "home");
process.env.USERPROFILE = path.join(GUARD, "home");
for (const k of Object.keys(process.env)) if (k.startsWith("CLAUDE_NOTIFY_")) delete process.env[k];
// Every sandbox is removed when the test process exits too, so a test that does not call cleanup() leaves nothing behind.
const made = [];
process.on("exit", () => { for (const dir of [GUARD, ...made]) removeDir(dir); });

/** A throwaway world: a config folder, a home folder, a project folder (with a .git folder) and an env that points at them. */
export function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpBase(), "cn-")));
  made.push(root);
  const cfg = path.join(root, "c");
  const home = path.join(root, "h");
  const proj = path.join(root, "myproj");
  fs.mkdirSync(cfg);
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, HOME: home, USERPROFILE: home };
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDE_NOTIFY_")) delete env[k];
  const box = {
    root, cfg, home, proj, env,
    path: (...p) => path.join(cfg, ...p),
    settingsFile: path.join(cfg, "settings.json"),
    configFile: path.join(cfg, "notify.json"),
    logFile: path.join(cfg, "notify", "notify.log"),
    /** Write the user settings file (notify.json). */
    config(obj) {
      fs.writeFileSync(box.configFile, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
      return box.configFile;
    },
    readConfig: () => JSON.parse(fs.readFileSync(box.configFile, "utf8")),
    log: () => { try { return fs.readFileSync(box.logFile, "utf8"); } catch { return ""; } },
    stateOf: (sid) => { try { return JSON.parse(fs.readFileSync(path.join(cfg, "notify", "state", `${sid}.json`), "utf8")); } catch { return null; } },
    writeSettings(obj) {
      fs.writeFileSync(box.settingsFile, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) + "\n");
      return box.settingsFile;
    },
    readSettings: () => JSON.parse(fs.readFileSync(box.settingsFile, "utf8")),
    /** Run a hook as Claude Code does: a child process with JSON on stdin. */
    hook(event, input = {}, { env, cwd, arg } = {}) {
      const body = { session_id: "s-test-1234", cwd: proj, hook_event_name: event, ...input };
      const t0 = process.hrtime.bigint();
      const r = spawnSync(process.execPath, [NOTIFY, arg ?? event], {
        input: typeof input === "string" ? input : JSON.stringify(body), env: childEnv(env2(box.env, env)), cwd, encoding: "utf8", timeout: 60000, windowsHide: true,
      });
      return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", ms: Number(process.hrtime.bigint() - t0) / 1e6 };
    },
    /** Run `claude-notify <args>` as a child process. */
    cli(args, { env, cwd, input } = {}) {
      const r = spawnSync(process.execPath, [CLI, ...args], {
        env: childEnv(env2(box.env, env)), cwd: cwd || proj, input, encoding: "utf8", timeout: 60000, windowsHide: true,
      });
      return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", out: (r.stdout || "") + (r.stderr || "") };
    },
    /**
     * Like hook(), but without blocking this process: a test that runs a local HTTP server in this process
     * needs the event loop free to answer while the child (run with CLAUDE_NOTIFY_INLINE=1) waits for it.
     */
    hookAsync(event, input = {}, { env, cwd, arg } = {}) {
      const body = { session_id: "s-test-1234", cwd: proj, hook_event_name: event, ...input };
      return runAsync([NOTIFY, arg ?? event], { input: typeof input === "string" ? input : JSON.stringify(body), env: childEnv(env2(box.env, env)), cwd });
    },
    /** Like cli(), without blocking this process. */
    cliAsync(args, { env, cwd, input } = {}) {
      return runAsync([CLI, ...args], { input, env: childEnv(env2(box.env, env)), cwd: cwd || proj });
    },
    cleanup() { removeDir(root); },
  };
  return box;
}

const env2 = (base, extra) => ({ ...base, ...(extra || {}) });

function runAsync(args, { input = "", env, cwd } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdin.on("error", () => {});
    child.on("close", (status) => resolve({ status, stdout, stderr, out: stdout + stderr, ms: Date.now() - t0 }));
    child.stdin.end(input);
  });
}
// Overrides with the value `undefined` remove the variable from the child's environment.
function childEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
}

/** The time a hook sees (CLAUDE_NOTIFY_NOW): a fixed epoch plus seconds. */
export const T0 = 1_800_000_000_000;
export const at = (seconds) => ({ CLAUDE_NOTIFY_NOW: String(T0 + seconds * 1000) });

/** What a hook printed, parsed. null for no output. */
export function parseHookOutput(stdout) {
  if (stdout === "") return null;
  return JSON.parse(stdout);
}

/** A local HTTP server that records every request. `handler(hit)` may return { status, headers, body }. */
export async function captureServer(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const hit = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      hits.push(hit);
      const r = (handler && handler(hit)) || { status: 200, body: "ok" };
      res.writeHead(r.status || 200, r.headers || {});
      res.end(r.body || "");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    hits,
    close: () => new Promise((resolve) => { server.close(() => resolve()); if (server.closeAllConnections) server.closeAllConnections(); }),
  };
}

/** A local TCP server that accepts connections and never answers: a stand-in for an unreachable service. */
export async function blackHole() {
  const sockets = new Set();
  const server = net.createServer((sock) => { sockets.add(sock); sock.on("error", () => {}); sock.on("close", () => sockets.delete(sock)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

/** A port that nothing listens on (connection refused). */
export async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export async function waitFor(predicate, ms = 8000, step = 25) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await predicate();
    if (v) return v;
    if (Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, step));
  }
}

/** Run a hook as a child and resolve when its stdio closes (what Claude Code waits for). */
export function hookClose(box, event, input, { env } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [NOTIFY, event], { env: childEnv(env2(box.env, env)), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.on("close", (code) => resolve({ code, stdout, ms: Date.now() - t0 }));
    child.stdin.end(JSON.stringify({ session_id: "s-close", cwd: box.proj, hook_event_name: event, ...input }));
  });
}

// ---------------------------------------------------------------------------------------------
// The terminalSequence allowlist, as Claude Code 2.1.286 applies it (read from its own code, then
// written down here independently of src/osc.mjs): at most 4096 bytes; a run of BELs and OSC
// sequences `ESC ] <digits> ; <payload>` ended by BEL or `ESC \`; the digits one of 0 1 2 9 99 777;
// no other ESC anywhere; the payload stripped of C0, DEL and C1 controls; and for OSC 9 a payload
// that is the 9;4 progress form or does not begin (after blanks) with an optional sign and a digit.
// ---------------------------------------------------------------------------------------------
const cp = (n) => String.fromCharCode(n);
const DIGIT_START = new RegExp(`^[\\s${cp(0x180e)}${cp(0x200b)}]*[+-]?\\p{Nd}`, "u");
const PROGRESS = /^4;[0-4](;(100|\d{1,2})?)?$/;

/** @returns null when Claude Code would drop the sequence, else the list of accepted parts */
export function parseAllowlisted(seq) {
  if (typeof seq !== "string" || seq.length === 0) return null;
  if (Buffer.byteLength(seq, "utf8") > 4096) return null;
  const parts = [];
  let i = 0;
  while (i < seq.length) {
    const ch = seq[i];
    if (ch === "\x07") { parts.push({ kind: "bel" }); i++; continue; }
    if (ch !== "\x1b" || seq[i + 1] !== "]") return null;
    let j = i + 2;
    let end = -1;
    let termLen = 0;
    while (j < seq.length) {
      if (seq[j] === "\x07") { end = j; termLen = 1; break; }
      if (seq[j] === "\x1b" && seq[j + 1] === "\\") { end = j; termLen = 2; break; }
      if (seq[j] === "\x1b") return null;
      j++;
    }
    if (end === -1) return null;
    const body = seq.slice(i + 2, end);
    const semi = body.indexOf(";");
    const ps = semi === -1 ? body : body.slice(0, semi);
    const rawPayload = semi === -1 ? "" : body.slice(semi + 1);
    if (!/^\d+$/.test(ps)) return null;
    if (![0, 1, 2, 9, 99, 777].includes(Number(ps))) return null;
    let payload = "";
    for (const c of rawPayload) {
      const code = c.codePointAt(0);
      if (code >= 32 && code !== 127 && !(code >= 128 && code <= 159)) payload += c;
    }
    if (Number(ps) === 9 && !PROGRESS.test(payload) && DIGIT_START.test(payload)) return null;
    parts.push({ kind: "osc", ps: Number(ps), payload, rawPayload });
    i = end + termLen;
  }
  return parts;
}

export const claudeAccepts = (seq) => parseAllowlisted(seq) !== null;

/** A string of the given code points, for hostile-input tests (source files cannot hold escapes for these safely). */
export const chars = (...codePoints) => codePoints.map((c) => String.fromCodePoint(c)).join("");

/** A local-time epoch in ms. */
export const localTime = (h, m = 0, s = 0) => new Date(2026, 9, 4, h, m, s).getTime();
