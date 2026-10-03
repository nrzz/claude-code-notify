// A capped log, one line per decision and per failure. Lines carry reasons and channel names, never
// message text, webhook URLs or tokens. `claude-notify status` shows the latest lines, which answers
// "why did I not get a ping?".
import { logPath } from "./config.mjs";
import { appendCapped, readTail } from "./fsutil.mjs";
import { cleanText } from "./message.mjs";

export function log(env, line) {
  appendCapped(logPath(env), `${new Date().toISOString()} ${cleanText(line, 400)}\n`);
}

export function readLog(env, n = 8) {
  return readTail(logPath(env), 64 * 1024).split("\n").filter(Boolean).slice(-n);
}
