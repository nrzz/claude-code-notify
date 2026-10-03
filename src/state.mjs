// Per-session state, one small file each: when the current turn started (recorded by the
// UserPromptSubmit hook), and when each channel last pushed (for the rate limit).
// Hooks of one session can run at the same moment (two installs, Notification next to Stop), so the
// read-decide-write step runs under a lock file.
import fs from "node:fs";
import path from "node:path";
import { outboxDir, stateDir } from "./config.mjs";
import { readJson, withLock, writeFileAtomic } from "./fsutil.mjs";

/** A session id as a safe, short file name. */
export const sessionKey = (id) => String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "default";
export const stateFile = (env, id) => path.join(stateDir(env), `${sessionKey(id)}.json`);

export function normalizeState(raw) {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const t = s.turn;
  const turn = t && typeof t === "object" && Number.isFinite(t.at)
    ? { at: t.at, source: typeof t.source === "string" && t.source ? t.source : "user" }
    : null;
  const last = {};
  if (s.last && typeof s.last === "object") for (const [k, v] of Object.entries(s.last)) if (Number.isFinite(v)) last[k] = v;
  return { v: 1, turn, last };
}

export const readState = (env, id) => normalizeState(readJson(stateFile(env, id)));

/** Read the session's state, let fn change it (or return a new one), write it back. All under the lock. */
export function updateState(env, id, fn) {
  const file = stateFile(env, id);
  return withLock(`${file}.lock`, () => {
    const state = normalizeState(readJson(file));
    const next = fn(state) || state;
    writeFileAtomic(file, JSON.stringify(next));
    return next;
  });
}

export function removeState(env, id) {
  const file = stateFile(env, id);
  for (const f of [file, `${file}.lock`]) {
    try { fs.rmSync(f, { force: true }); } catch { /* already gone */ }
  }
}

function pruneFolder(dir, maxAgeMs, threshold) {
  try {
    const names = fs.readdirSync(dir);
    if (names.length <= threshold) return 0;
    const now = Date.now();
    let removed = 0;
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        // lock and temp files are only ever seconds old; anything older was left by a crash
        const limit = /\.(lock|tmp-.*)$/.test(name) ? 3600 * 1000 : maxAgeMs;
        if (st.isFile() && now - st.mtimeMs > limit) { fs.rmSync(file, { force: true }); removed++; }
      } catch { /* a file another process just removed */ }
    }
    return removed;
  } catch {
    return 0;
  }
}

/** Sessions that ended without a SessionEnd hook leave a file behind; sweep the old ones once there are many. */
export const pruneState = (env, { maxAgeMs = 3 * 86400 * 1000, threshold = 25 } = {}) => pruneFolder(stateDir(env), maxAgeMs, threshold);

/** Payload files of workers that crashed before cleaning up. */
export const pruneOutbox = (env) => pruneFolder(outboxDir(env), 3600 * 1000, 0);
