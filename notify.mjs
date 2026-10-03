#!/usr/bin/env node
// notify.mjs: the script Claude Code's hooks run, and the same tool's command line.
//
//   node notify.mjs UserPromptSubmit | Stop | Notification   a hook: JSON on stdin; prints nothing the
//                                                            model reads (at most a terminalSequence)
//   node notify.mjs send <payload-file>                      the detached worker a hook starts
//   node notify.mjs <command>                                init, test, set, status, mute ... (see --help)
//
// Everything is loaded on demand, and a hook never fails: any error ends with exit code 0.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [arg, ...rest] = process.argv.slice(2);
const key = String(arg ?? "").toLowerCase().replace(/[^a-z]/g, "");
const HOOKS = ["userpromptsubmit", "stop", "notification", "sessionend"];

// If even src/ is missing, say so in the log: otherwise a broken install would be silent.
function lastResortLog(message) {
  try {
    const dir = path.join(process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), ".claude"), "notify");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "notify.log"), `${new Date().toISOString()} ${String(message).replace(/\s+/g, " ").slice(0, 300)}\n`);
  } catch { /* nothing more to do */ }
}

if (HOOKS.includes(key)) {
  process.on("uncaughtException", (e) => { lastResortLog(`${arg} uncaught: ${e && e.message}`); process.exit(0); });
  process.on("unhandledRejection", (e) => { lastResortLog(`${arg} unhandled: ${e && e.message}`); process.exit(0); });
  try {
    const { runHook } = await import("./src/hook.mjs");
    await runHook(arg);
  } catch (e) {
    lastResortLog(`${arg} could not start: ${e && e.message}`);
  }
  process.exit(0);
} else if (arg === "send") {
  // A stuck DNS lookup cannot be cancelled and would keep this process alive: bound it.
  setTimeout(() => process.exit(0), 15000).unref();
  try {
    const { runSend } = await import("./src/send.mjs");
    await runSend(rest[0]);
  } catch (e) {
    lastResortLog(`send could not start: ${e && e.message}`);
  }
  process.exit(0);
} else {
  const { main } = await import("./src/cli.mjs");
  process.exitCode = await main(process.argv.slice(2));
}
