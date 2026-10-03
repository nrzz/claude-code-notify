// The three hooks, run as `node notify.mjs <event>` with Claude Code's JSON on stdin.
//
//   UserPromptSubmit  records when the turn started. Prints nothing.
//   Stop              the turn finished: ping if it took long enough.
//   Notification      Claude needs you: ping.
//   SessionEnd        deletes the session's state file. Not registered by `init`. Prints nothing.
//
// The only thing a hook ever prints is {"terminalSequence": "..."}, which Claude Code writes to your
// terminal and never shows the model, so the whole tool costs no tokens. Everything else (desktop,
// ntfy, Slack, Discord, Teams, your command) runs in a detached child process, so the hook returns
// at once. A hook never throws and never fails: any error goes to the log and the exit code stays 0.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  ROOT, effectiveConfig, findGitRoot, isMuted, normalizeConfig, notifyDir, outboxDir, readProjectConfig, readUserConfig, sendTimeout,
} from "./config.mjs";
import { decide } from "./decide.mjs";
import { sleepSync, writeFileAtomic } from "./fsutil.mjs";
import { log } from "./log.mjs";
import { buildMessages, formatDuration, lastAssistantText, projectName } from "./message.mjs";
import { terminalSequence } from "./osc.mjs";
import { pruneOutbox, pruneState, removeState, sessionKey, updateState } from "./state.mjs";

const EVENT_NAMES = { userpromptsubmit: "UserPromptSubmit", stop: "Stop", notification: "Notification", sessionend: "SessionEnd" };

/** "Stop", "stop", "user-prompt-submit" -> the event's canonical name, or null. */
export function normalizeEvent(arg) {
  return EVENT_NAMES[String(arg ?? "").toLowerCase().replace(/[^a-z]/g, "")] || null;
}

/** Now in epoch milliseconds. CLAUDE_NOTIFY_NOW (epoch ms, or an ISO date; without an offset it is local time) overrides it, for tests. */
export function nowMs(env = process.env) {
  const v = env.CLAUDE_NOTIFY_NOW;
  if (v !== undefined && String(v).trim() !== "") {
    const s = String(v).trim();
    const n = /^\d+(\.\d+)?$/.test(s) ? Number(s) : Date.parse(s);
    if (Number.isFinite(n)) return n;
  }
  return Date.now();
}

/** All of stdin as text, without ever blocking on a terminal. */
export function readStdinSync(maxWaitMs = 1500) {
  try { if (fs.fstatSync(0).isCharacterDevice()) return ""; } catch { return ""; }
  const chunks = [];
  const buf = Buffer.alloc(65536);
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, buf, 0, buf.length, null);
    } catch (e) {
      if (e && e.code === "EAGAIN" && Date.now() < deadline) { sleepSync(5); continue; }
      break; // EOF on a closed pipe (Windows reports it as an error), or nothing to read
    }
    if (n === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Write to stdout synchronously, so the process can exit right after. */
export function writeStdout(text) {
  const buf = Buffer.from(text, "utf8");
  let off = 0;
  try {
    while (off < buf.length) {
      try {
        off += fs.writeSync(1, buf, off, buf.length - off);
      } catch (e) {
        if (e && e.code === "EAGAIN") { sleepSync(2); continue; }
        throw e;
      }
    }
  } catch {
    try { process.stdout.write(text); } catch { /* the pipe is gone */ }
  }
}

function parseInput(raw) {
  try {
    const v = JSON.parse(String(raw || "").trim() || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function recordPrompt(env, input, now) {
  const source = typeof input.source === "string" && input.source ? input.source : "user";
  updateState(env, input.session_id, (st) => { st.turn = { at: now, source }; return st; });
  pruneState(env);
}

// The slow channels run in a detached child (`notify.mjs send <file>`), so this process can exit.
// CLAUDE_NOTIFY_INLINE=1 runs them here instead and waits (the tests do).
async function dispatch(env, payload) {
  if (env.CLAUDE_NOTIFY_INLINE === "1") {
    const { sendAll } = await import("./channels.mjs");
    const results = await sendAll(payload, normalizeConfig(readUserConfig(env).data), { timeoutMs: sendTimeout(env) });
    for (const r of results) if (!r.ok) log(env, `${payload.event} ${r.channel} failed: ${r.detail}`);
    return;
  }
  const file = path.join(outboxDir(env), `${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
  writeFileAtomic(file, JSON.stringify(payload), { mode: 0o600 });
  pruneOutbox(env);
  // The worker runs from our own folder, not the project's: a program it starts is never looked up in a
  // repository, and the project folder is not held open (Windows cannot delete a folder some process is in).
  const child = spawn(process.execPath, [path.join(ROOT, "notify.mjs"), "send", file], {
    detached: true, stdio: "ignore", windowsHide: true, env, cwd: notifyDir(env),
  });
  child.on("error", () => {});
  child.unref();
}

async function notifyEvent(event, input, env, now, io) {
  const write = io.write || writeStdout;
  const sid = sessionKey(input.session_id);
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const root = findGitRoot(cwd);
  const projectDir = root || cwd;
  const user = readUserConfig(env);
  const cfg = effectiveConfig(user.data, readProjectConfig(projectDir).data);
  const muted = isMuted(cfg.mutedProjects, projectDir);
  const project = projectName({ cwd, root, name: cfg.name });
  const tag = `${event} ${project} ${sid.slice(0, 8)}`;
  if (user.status === "invalid") log(env, `${tag} notify.json is not valid JSON, so defaults are used`);

  let decision = null;
  try {
    updateState(env, sid, (st) => {
      decision = decide({ event, input, config: cfg, muted, now, turn: st.turn, last: st.last });
      if (event === "Stop") st.turn = null; // the turn is over; a second Stop without a new prompt has no start
      if (decision.send) for (const c of decision.channels) st.last[c] = now;
      return st;
    });
  } catch (e) {
    log(env, `${tag} state not available (${e && e.message ? e.message : e})`);
    if (!decision) decision = decide({ event, input, config: cfg, muted, now, turn: null, last: {} });
  }
  if (!decision.send) { log(env, `${tag} skip ${decision.reason}`); return; }

  const { channels, kind, durationMs, quiet } = decision;
  log(env, `${tag} send [${channels.join(",")}]${durationMs != null ? ` ${formatDuration(durationMs)}` : ""}${quiet ? " quiet-hours" : ""}`);

  const lastText = cfg.includeLastMessage ? lastAssistantText(input.transcript_path) : "";
  const msgs = buildMessages({
    kind, project, notificationMessage: input.message, notificationType: input.notification_type, durationMs, lastText, cfg,
  });

  if (channels.includes("terminal")) {
    const sequence = terminalSequence(cfg.terminal, msgs.local, { kind, project });
    if (sequence) write(JSON.stringify({ terminalSequence: sequence }));
  }
  const rest = channels.filter((c) => c !== "terminal");
  if (rest.length) {
    await dispatch(env, { v: 1, event, kind, project, sid: sid.slice(0, 8), channels: rest, local: msgs.local, remote: msgs.remote });
  }
}

/**
 * Run one hook. Always resolves to 0.
 * @param io { env, stdin (text), write (function) }, all optional
 */
export async function runHook(eventArg, io = {}) {
  const event = normalizeEvent(eventArg);
  if (!event) return 0;
  const env = io.env || process.env;
  try {
    const input = parseInput(io.stdin !== undefined ? io.stdin : readStdinSync());
    const now = nowMs(env);
    if (event === "UserPromptSubmit") recordPrompt(env, input, now);
    else if (event === "SessionEnd") removeState(env, input.session_id);
    else await notifyEvent(event, input, env, now, io);
  } catch (e) {
    try { log(env, `${event} error: ${e && e.message ? e.message : e}`); } catch { /* nothing more to do */ }
  }
  return 0;
}
