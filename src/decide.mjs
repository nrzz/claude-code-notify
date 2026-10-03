// The decision table: given an event, the hook's input, the settings and what was recorded for the
// session, should anything be sent, and through which channels? Pure: no files, no clock, no process.
// Everything that touches the outside world lives elsewhere, so every row of the table is testable.

/** Channels in the order they are tried. `terminal` goes through Claude Code itself. */
export const CHANNELS = ["terminal", "desktop", "ntfy", "slack", "discord", "teams", "command"];

/** Channels that leave the machine. Claude's last reply goes to these only when asked for twice. */
export const REMOTE_CHANNELS = ["ntfy", "slack", "discord", "teams"];

/** Notification types that mean "Claude needs you". Every elicitation* type is added except elicitation_complete. */
export const NEEDS_YOU_TYPES = ["permission_prompt", "idle_prompt", "agent_needs_input", "worker_permission_prompt"];

/** Types Claude Code 2.1.286 sends that are skipped by default (and can be turned on with `types.<name> on`). */
export const SKIPPED_TYPES = ["auth_success", "computer_use_exit", "elicitation_complete", "agent_completed", "push_notification"];

/**
 * Whether a Notification of this type should ping. A hand-set override (`types: { agent_completed: true }`)
 * wins. No type at all (an older Claude Code) pings: every Notification then meant "needs you".
 * A type this table does not know is skipped, and the log says so.
 */
export function typeAllowed(type, overrides = {}) {
  if (typeof type !== "string" || !type) return true;
  if (overrides && typeof overrides[type] === "boolean") return overrides[type];
  if (NEEDS_YOU_TYPES.includes(type)) return true;
  if (type.startsWith("elicitation")) return type !== "elicitation_complete";
  return false;
}

/** "22:00-08:00" -> { start, end } in minutes after midnight, or null. The end may be 24:00. */
export function parseQuiet(value) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(value ?? ""));
  if (!m) return null;
  const [h1, m1, h2, m2] = m.slice(1).map(Number);
  if (h1 > 23 || m1 > 59 || m2 > 59) return null;
  if (h2 > 24 || (h2 === 24 && m2 !== 0)) return null;
  const start = h1 * 60 + m1;
  const end = h2 * 60 + m2;
  return start === end ? null : { start, end };
}

/** True when the local time of `date` falls inside the range. Ranges that cross midnight work. */
export function inQuiet(range, date) {
  const q = typeof range === "string" ? parseQuiet(range) : range;
  if (!q) return false;
  const minute = date.getHours() * 60 + date.getMinutes();
  return q.start < q.end ? minute >= q.start && minute < q.end : minute >= q.start || minute < q.end;
}

/** The channels the settings turn on. */
export function enabledChannels(cfg) {
  const on = [];
  if (cfg.terminal !== "off") on.push("terminal");
  if (cfg.desktop) on.push("desktop");
  if (cfg.ntfy.topic) on.push("ntfy");
  if (cfg.slack.url) on.push("slack");
  if (cfg.discord.url) on.push("discord");
  if (cfg.teams.url) on.push("teams");
  if (cfg.command.length) on.push("command");
  return on;
}

const skip = (reason) => ({ send: false, reason });

/**
 * @param event   "Stop" | "Notification" (anything else never sends)
 * @param input   the hook's JSON input
 * @param config  the effective, normalized settings
 * @param muted   this project is muted
 * @param now     epoch milliseconds
 * @param turn    { at, source } recorded at the last UserPromptSubmit of this session, or null
 * @param last    { <channel>: epoch ms of the last push on it } for this session
 * @returns { send: false, reason } or { send: true, kind, channels, quiet, durationMs, reason }
 */
export function decide({ event, input = {}, config, muted = false, now, turn = null, last = {} }) {
  if (!config.enabled) return skip("disabled");
  if (event !== "Stop" && event !== "Notification") return skip(`event:${event}`);
  if (muted) return skip("muted");

  let kind;
  let durationMs = null;
  if (event === "Stop") {
    kind = "finished";
    if (input.stop_hook_active === true || input.stop_hook_active === "true") return skip("stop_hook_active");
    const min = config.minTurnSeconds * 1000;
    const startedAt = turn && Number.isFinite(turn.at) ? turn.at : null;
    if (startedAt === null) {
      // No recorded start (hooks installed mid-turn, state cleaned): the length is unknown, so only
      // `minTurnSeconds: 0` ("always") may ping.
      if (min > 0) return skip("no-start-time");
    } else {
      const source = typeof turn.source === "string" && turn.source ? turn.source : "user";
      if (source !== "user" && !config.notifyAutomated) return skip(`automated:${source}`);
      durationMs = Math.max(0, now - startedAt);
      if (durationMs < min) return skip(`short-turn:${Math.round(durationMs / 1000)}s`);
    }
  } else {
    kind = "attention";
    const type = input.notification_type;
    if (!typeAllowed(type, config.types)) return skip(`type:${type}`);
  }

  let channels = enabledChannels(config);
  if (!channels.length) return skip("no-channels");

  const quiet = inQuiet(config.quiet, new Date(now));
  if (quiet) channels = channels.filter((c) => c === "terminal");
  if (!channels.length) return skip("quiet");

  const limit = config.rateLimitSeconds * 1000;
  if (limit > 0) {
    channels = channels.filter((c) => {
      const elapsed = now - last[c];
      return !(Number.isFinite(elapsed) && elapsed >= 0 && elapsed < limit);
    });
    if (!channels.length) return skip("rate-limited");
  }

  return { send: true, kind, channels, quiet, durationMs, reason: quiet ? "quiet-terminal-only" : "ok" };
}
