// The detached worker: `node notify.mjs send <payload-file>`. The hook writes what to send into
// <configDir>/notify/outbox/ and starts this in the background, so the hook itself returns at once.
// Settings (URLs, tokens) are read here from the user config, so no secret is ever copied into the
// payload file. Each send has a 5-second timeout. Failures go to the log, never to Claude Code.
import fs from "node:fs";
import path from "node:path";
import { normalizeConfig, outboxDir, readUserConfig, sendTimeout } from "./config.mjs";
import { sendAll } from "./channels.mjs";
import { readJson } from "./fsutil.mjs";
import { log } from "./log.mjs";

const inside = (dir, file) => {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
};

/** @returns 0 when every channel delivered, 1 otherwise */
export async function runSend(file, env = process.env) {
  if (!file) return 1;
  const payload = readJson(file);
  // Only payloads the hook wrote into the outbox are deleted afterwards, whatever path was passed.
  const ours = inside(outboxDir(env), file);
  try {
    if (!payload || !Array.isArray(payload.channels) || !payload.local || !payload.remote) {
      log(env, `send: ${path.basename(file)} is not a notification payload`);
      return 1;
    }
    const cfg = normalizeConfig(readUserConfig(env).data);
    const results = await sendAll(payload, cfg, { timeoutMs: sendTimeout(env) });
    for (const r of results) if (!r.ok) log(env, `${payload.event} ${r.channel} failed: ${r.detail}`);
    return results.every((r) => r.ok) ? 0 : 1;
  } catch (e) {
    log(env, `send error: ${e && e.message ? e.message : e}`);
    return 1;
  } finally {
    if (ours) { try { fs.rmSync(file, { force: true }); } catch { /* a stale file is swept later */ } }
  }
}
