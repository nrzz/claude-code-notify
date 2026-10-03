// The decision table: which events ping, through which channels, and why not.
import test from "node:test";
import assert from "node:assert/strict";
import { CHANNELS, NEEDS_YOU_TYPES, decide, enabledChannels, inQuiet, parseQuiet, typeAllowed } from "../src/decide.mjs";
import { normalizeConfig } from "../src/config.mjs";
import { T0, localTime } from "./helpers.mjs";

const cfg = (over = {}) => normalizeConfig(over);
const notification = (type, config = cfg()) => decide({ event: "Notification", input: { notification_type: type }, config, now: T0 });
const stop = (seconds, { config = cfg(), input = {}, source = "user", noTurn = false, last = {} } = {}) =>
  decide({ event: "Stop", input, config, now: T0 + seconds * 1000, turn: noTurn ? null : { at: T0, source }, last });

// --- Notification types -------------------------------------------------------------------------

for (const type of ["permission_prompt", "idle_prompt", "agent_needs_input", "worker_permission_prompt", "elicitation_dialog", "elicitation_response"]) {
  test(`Notification ${type} pings`, () => {
    const d = notification(type);
    assert.equal(d.send, true);
    assert.equal(d.kind, "attention");
    assert.deepEqual(d.channels, ["terminal"]);
  });
}

for (const type of ["elicitation_complete", "auth_success", "computer_use_exit", "agent_completed", "push_notification", "something_new_in_2_2"]) {
  test(`Notification ${type} is skipped by default`, () => {
    assert.deepEqual(notification(type), { send: false, reason: `type:${type}` });
  });
}

test("a Notification with no type (an older Claude Code) pings", () => {
  assert.equal(decide({ event: "Notification", input: {}, config: cfg(), now: T0 }).send, true);
  assert.equal(decide({ event: "Notification", input: { notification_type: "" }, config: cfg(), now: T0 }).send, true);
});

test("types.<name> overrides the table in both directions", () => {
  assert.equal(notification("agent_completed", cfg({ types: { agent_completed: true } })).send, true);
  assert.equal(notification("push_notification", cfg({ types: { push_notification: true } })).send, true);
  assert.equal(notification("permission_prompt", cfg({ types: { permission_prompt: false } })).send, false);
  assert.equal(notification("elicitation_complete", cfg({ types: { elicitation_complete: true } })).send, true);
});

test("typeAllowed: the needs-you list is exactly the four types, plus elicitation except its completion", () => {
  assert.deepEqual(NEEDS_YOU_TYPES, ["permission_prompt", "idle_prompt", "agent_needs_input", "worker_permission_prompt"]);
  assert.equal(typeAllowed("elicitation_anything"), true);
  assert.equal(typeAllowed("elicitation_complete"), false);
  assert.equal(typeAllowed(undefined), true);
  assert.equal(typeAllowed(42), true, "a non-string type is treated as no type");
});

test("automated sessions still get Notification pings: someone is needed", () => {
  assert.equal(decide({ event: "Notification", input: { notification_type: "permission_prompt" }, config: cfg(), now: T0, turn: { at: T0, source: "loop_wakeup" } }).send, true);
});

// --- Stop: turn length, start time, continuation, automated sources -----------------------------

test("Stop pings once the turn took minTurnSeconds (default 30), measured from the recorded start", () => {
  assert.equal(stop(31).send, true);
  assert.equal(stop(30).send, true, "exactly the threshold counts");
  assert.equal(stop(600).send, true);
  const d = stop(133);
  assert.equal(d.kind, "finished");
  assert.equal(d.durationMs, 133000);
});

test("Stop is quiet for a quick turn", () => {
  assert.deepEqual(stop(29.999), { send: false, reason: "short-turn:30s" });
  assert.deepEqual(stop(2), { send: false, reason: "short-turn:2s" });
  assert.deepEqual(stop(0), { send: false, reason: "short-turn:0s" });
});

test("minTurnSeconds is configurable, and 0 means every turn", () => {
  assert.equal(stop(59, { config: cfg({ minTurnSeconds: 60 }) }).send, false);
  assert.equal(stop(60, { config: cfg({ minTurnSeconds: 60 }) }).send, true);
  assert.equal(stop(1, { config: cfg({ minTurnSeconds: 0 }) }).send, true);
  assert.equal(stop(0, { config: cfg({ minTurnSeconds: 0 }) }).send, true);
});

test("Stop with no recorded start is skipped, because its length is unknown", () => {
  assert.deepEqual(stop(999, { noTurn: true }), { send: false, reason: "no-start-time" });
});

test("with minTurnSeconds 0, a Stop with no recorded start pings and has no duration", () => {
  const d = stop(0, { noTurn: true, config: cfg({ minTurnSeconds: 0 }) });
  assert.equal(d.send, true);
  assert.equal(d.durationMs, null);
});

test("a clock that moved backwards counts as a zero-length turn, not a negative one", () => {
  const d = decide({ event: "Stop", input: {}, config: cfg({ minTurnSeconds: 0 }), now: T0 - 5000, turn: { at: T0, source: "user" } });
  assert.equal(d.durationMs, 0);
});

test("Stop with stop_hook_active is skipped, even after a long turn", () => {
  assert.deepEqual(stop(300, { input: { stop_hook_active: true } }), { send: false, reason: "stop_hook_active" });
  assert.deepEqual(stop(300, { input: { stop_hook_active: "true" } }), { send: false, reason: "stop_hook_active" });
  assert.equal(stop(300, { input: { stop_hook_active: false } }).send, true);
});

for (const source of ["sdk", "system", "loop_wakeup", "schedule_wakeup", "poll_event"]) {
  test(`Stop after an automated prompt (source ${source}) is skipped by default`, () => {
    assert.deepEqual(stop(300, { source }), { send: false, reason: `automated:${source}` });
  });
}

test("notifyAutomated: true pings for automated turns too", () => {
  for (const source of ["sdk", "system", "loop_wakeup", "schedule_wakeup", "poll_event"]) {
    assert.equal(stop(300, { source, config: cfg({ notifyAutomated: true }) }).send, true, source);
  }
});

test("a turn that has no recorded source counts as typed by the person", () => {
  const d = decide({ event: "Stop", input: {}, config: cfg(), now: T0 + 60000, turn: { at: T0 } });
  assert.equal(d.send, true);
});

test("automated turns are still held to the length threshold when notifyAutomated is on", () => {
  assert.equal(stop(5, { source: "loop_wakeup", config: cfg({ notifyAutomated: true }) }).send, false);
});

// --- gates: enabled, muted, other events --------------------------------------------------------

test("enabled: false silences everything", () => {
  const off = cfg({ enabled: false });
  assert.deepEqual(stop(300, { config: off }), { send: false, reason: "disabled" });
  assert.deepEqual(notification("permission_prompt", off), { send: false, reason: "disabled" });
});

test("a muted project is silent for both events", () => {
  assert.deepEqual(stop(300, { config: cfg() }).send, true);
  assert.deepEqual(decide({ event: "Stop", input: {}, config: cfg(), muted: true, now: T0 + 300000, turn: { at: T0, source: "user" } }), { send: false, reason: "muted" });
  assert.deepEqual(decide({ event: "Notification", input: { notification_type: "permission_prompt" }, config: cfg(), muted: true, now: T0 }), { send: false, reason: "muted" });
});

test("UserPromptSubmit and SessionEnd never send", () => {
  assert.deepEqual(decide({ event: "UserPromptSubmit", input: {}, config: cfg(), now: T0 }), { send: false, reason: "event:UserPromptSubmit" });
  assert.deepEqual(decide({ event: "SessionEnd", input: {}, config: cfg(), now: T0 }), { send: false, reason: "event:SessionEnd" });
});

// --- channels ------------------------------------------------------------------------------------

const everything = () => cfg({
  desktop: true,
  ntfy: { topic: "my-topic" },
  slack: { url: "https://example.test/s" },
  discord: { url: "https://example.test/d" },
  teams: { url: "https://example.test/t" },
  command: ["node", "x.js"],
});

test("by default only the terminal channel is on", () => {
  assert.deepEqual(enabledChannels(cfg()), ["terminal"]);
});

test("every channel turns on from its own setting, in a fixed order", () => {
  assert.deepEqual(enabledChannels(everything()), CHANNELS);
  assert.deepEqual(enabledChannels(cfg({ terminal: "off", desktop: true })), ["desktop"]);
  assert.deepEqual(enabledChannels(cfg({ ntfy: { topic: "x" } })), ["terminal", "ntfy"]);
});

test("with every channel off nothing is sent", () => {
  assert.deepEqual(notification("permission_prompt", cfg({ terminal: "off" })), { send: false, reason: "no-channels" });
});

// --- quiet hours ---------------------------------------------------------------------------------

test("parseQuiet reads HH:MM-HH:MM and refuses everything else", () => {
  assert.deepEqual(parseQuiet("22:00-08:00"), { start: 1320, end: 480 });
  assert.deepEqual(parseQuiet(" 9:30 - 17:05 "), { start: 570, end: 1025 });
  assert.deepEqual(parseQuiet("22:00-24:00"), { start: 1320, end: 1440 });
  for (const bad of ["", "off", "22:00", "22-08", "25:00-08:00", "22:60-08:00", "22:00-24:30", "08:00-08:00", "a-b", null, undefined, 5]) {
    assert.equal(parseQuiet(bad), null, String(bad));
  }
});

test("quiet hours that cross midnight", () => {
  const q = "22:00-08:00";
  assert.equal(inQuiet(q, new Date(localTime(22, 0))), true, "22:00 is the first quiet minute");
  assert.equal(inQuiet(q, new Date(localTime(23, 59))), true);
  assert.equal(inQuiet(q, new Date(localTime(0, 0))), true);
  assert.equal(inQuiet(q, new Date(localTime(3, 30))), true);
  assert.equal(inQuiet(q, new Date(localTime(7, 59))), true);
  assert.equal(inQuiet(q, new Date(localTime(8, 0))), false, "08:00 is the first loud minute");
  assert.equal(inQuiet(q, new Date(localTime(12, 0))), false);
  assert.equal(inQuiet(q, new Date(localTime(21, 59))), false);
});

test("quiet hours inside one day, and ending at 24:00", () => {
  assert.equal(inQuiet("13:00-14:00", new Date(localTime(13, 0))), true);
  assert.equal(inQuiet("13:00-14:00", new Date(localTime(13, 59))), true);
  assert.equal(inQuiet("13:00-14:00", new Date(localTime(14, 0))), false);
  assert.equal(inQuiet("13:00-14:00", new Date(localTime(12, 59))), false);
  assert.equal(inQuiet("22:00-24:00", new Date(localTime(23, 59))), true);
  assert.equal(inQuiet("22:00-24:00", new Date(localTime(0, 0))), false);
  assert.equal(inQuiet("", new Date(localTime(3, 0))), false);
  assert.equal(inQuiet("nonsense", new Date(localTime(3, 0))), false);
});

test("in quiet hours only the terminal channel is used", () => {
  const config = { ...everything(), quiet: "22:00-08:00" };
  const d = decide({ event: "Notification", input: { notification_type: "permission_prompt" }, config, now: localTime(23, 30) });
  assert.equal(d.send, true);
  assert.deepEqual(d.channels, ["terminal"]);
  assert.equal(d.quiet, true);
});

test("outside quiet hours every enabled channel is used", () => {
  const config = { ...everything(), quiet: "22:00-08:00" };
  const d = decide({ event: "Notification", input: { notification_type: "permission_prompt" }, config, now: localTime(12, 0) });
  assert.deepEqual(d.channels, CHANNELS);
  assert.equal(d.quiet, false);
});

test("quiet hours with the terminal channel off send nothing", () => {
  const config = { ...everything(), terminal: "off", quiet: "22:00-08:00" };
  assert.deepEqual(decide({ event: "Notification", input: {}, config, now: localTime(2, 0) }), { send: false, reason: "quiet" });
});

test("quiet hours apply to Stop pings as well", () => {
  const config = { ...everything(), quiet: "22:00-08:00" };
  const now = localTime(23, 0);
  const d = decide({ event: "Stop", input: {}, config, now, turn: { at: now - 120000, source: "user" } });
  assert.deepEqual(d.channels, ["terminal"]);
});

// --- rate limit ----------------------------------------------------------------------------------

test("at most one push per channel per 20 seconds", () => {
  const last = { terminal: T0 };
  const within = decide({ event: "Notification", input: {}, config: everything(), now: T0 + 19999, last });
  assert.ok(!within.channels.includes("terminal"), "the terminal pushed 19.999 s ago");
  assert.ok(within.channels.includes("desktop") && within.channels.includes("ntfy"), "other channels have their own clock");
  const after = decide({ event: "Notification", input: {}, config: everything(), now: T0 + 20000, last });
  assert.ok(after.channels.includes("terminal"), "20 s later it may push again");
});

test("when every channel is inside its window the ping is dropped", () => {
  const d = decide({ event: "Notification", input: {}, config: cfg(), now: T0 + 5000, last: { terminal: T0 } });
  assert.deepEqual(d, { send: false, reason: "rate-limited" });
});

test("rateLimitSeconds is configurable and 0 turns it off", () => {
  const last = { terminal: T0 };
  assert.equal(decide({ event: "Notification", input: {}, config: cfg({ rateLimitSeconds: 5 }), now: T0 + 4000, last }).send, false);
  assert.equal(decide({ event: "Notification", input: {}, config: cfg({ rateLimitSeconds: 5 }), now: T0 + 5000, last }).send, true);
  assert.equal(decide({ event: "Notification", input: {}, config: cfg({ rateLimitSeconds: 0 }), now: T0 + 1, last }).send, true);
});

test("a last-push time in the future (the clock moved) does not block pings", () => {
  assert.equal(decide({ event: "Notification", input: {}, config: cfg(), now: T0, last: { terminal: T0 + 60000 } }).send, true);
});

test("a Stop whose channels are all inside their window is dropped", () => {
  const d = decide({ event: "Stop", input: {}, config: cfg(), now: T0 + 100000, turn: { at: T0, source: "user" }, last: { terminal: T0 + 95000 } });
  assert.deepEqual(d, { send: false, reason: "rate-limited" });
});
