// The hooks as Claude Code runs them: `node notify.mjs <event>` as a child process with JSON on stdin.
// Time comes from CLAUDE_NOTIFY_NOW. Stdout must be exactly the terminalSequence JSON, or empty.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { NOTIFY, T0, at, captureServer, chars, claudeAccepts, hookClose, parseHookOutput, sandbox } from "./helpers.mjs";

const seqJson = (seq) => JSON.stringify({ terminalSequence: seq });
const INLINE = { CLAUDE_NOTIFY_INLINE: "1", CLAUDE_NOTIFY_TIMEOUT_MS: "4000" };

// Run `fn(box)` in a fresh sandbox and clean up after.
async function withBox(fn) {
  const box = sandbox();
  try { return await fn(box); } finally { box.cleanup(); }
}

/**
 * UserPromptSubmit at T0 + base, then Stop `seconds` later. Returns the Stop result. Tests that run
 * several turns in one session space them with `base`: pings of one session are 20 s apart at least.
 */
function turn(box, seconds, { base = 0, prompt = {}, stop = {}, env = {} } = {}) {
  box.hook("UserPromptSubmit", { prompt: "do the thing", ...prompt }, { env: { ...at(base), ...env } });
  return box.hook("Stop", { stop_hook_active: false, ...stop }, { env: { ...at(base + seconds), ...env } });
}

/** The same, without blocking this process (for tests that run a local server in it). */
async function turnAsync(box, seconds, { base = 0, prompt = {}, stop = {}, env = {} } = {}) {
  await box.hookAsync("UserPromptSubmit", { prompt: "do the thing", ...prompt }, { env: { ...at(base), ...env } });
  return box.hookAsync("Stop", { stop_hook_active: false, ...stop }, { env: { ...at(base + seconds), ...env } });
}

// --- UserPromptSubmit ------------------------------------------------------------------------------

test("UserPromptSubmit prints nothing and records only the start time and the source", async () => {
  await withBox((box) => {
    const r = box.hook("UserPromptSubmit", { prompt: "my private prompt text", transcript_path: "/x/y.jsonl" }, { env: at(0) });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    const st = box.stateOf("s-test-1234");
    assert.deepEqual(st.turn, { at: T0, source: "user" });
    const raw = JSON.stringify(st);
    assert.ok(!raw.includes("private") && !raw.includes("y.jsonl") && !raw.includes(box.proj), "the prompt, the transcript path and the folder are not stored");
  });
});

test("UserPromptSubmit records the prompt source (automated turns are told apart)", async () => {
  await withBox((box) => {
    box.hook("UserPromptSubmit", { source: "loop_wakeup" }, { env: at(0) });
    assert.equal(box.stateOf("s-test-1234").turn.source, "loop_wakeup");
    box.hook("UserPromptSubmit", { source: "user" }, { env: at(5) });
    assert.deepEqual(box.stateOf("s-test-1234").turn, { at: T0 + 5000, source: "user" });
  });
});

// --- Stop ------------------------------------------------------------------------------------------

test("Stop after a long turn prints exactly the terminalSequence JSON (OSC 9 by default)", async () => {
  await withBox((box) => {
    const r = turn(box, 125);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
    assert.equal(r.stdout, seqJson("\x1b]9;Claude Code - Finished in myproj after 2m 5s\x07"));
  });
});

test("Stop after a quick turn prints nothing", async () => {
  await withBox((box) => {
    const r = turn(box, 12);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.match(box.log(), /Stop myproj s-test-1 skip short-turn:12s/);
  });
});

test("the threshold is exact: 29 s is quiet, 30 s pings", async () => {
  await withBox((box) => {
    assert.equal(turn(box, 29).stdout, "");
    assert.notEqual(turn(box, 30).stdout, "");
  });
});

test("Stop with no recorded start prints nothing", async () => {
  await withBox((box) => {
    assert.equal(box.hook("Stop", {}, { env: at(500) }).stdout, "");
    assert.match(box.log(), /skip no-start-time/);
  });
});

test("Stop with stop_hook_active prints nothing", async () => {
  await withBox((box) => {
    assert.equal(turn(box, 300, { stop: { stop_hook_active: true } }).stdout, "");
    assert.match(box.log(), /skip stop_hook_active/);
  });
});

test("a second Stop without a new prompt prints nothing: the turn was already reported", async () => {
  await withBox((box) => {
    assert.notEqual(turn(box, 100).stdout, "");
    assert.equal(box.hook("Stop", {}, { env: at(200) }).stdout, "");
  });
});

test("Stop after an automated prompt is quiet, unless notifyAutomated is on", async () => {
  await withBox((box) => {
    for (const source of ["sdk", "system", "loop_wakeup", "schedule_wakeup", "poll_event"]) {
      assert.equal(turn(box, 300, { prompt: { source } }).stdout, "", source);
    }
    box.config({ notifyAutomated: true });
    assert.notEqual(turn(box, 300, { prompt: { source: "schedule_wakeup" } }).stdout, "");
  });
});

test("minTurnSeconds comes from settings", async () => {
  await withBox((box) => {
    box.config({ minTurnSeconds: 5 });
    assert.notEqual(turn(box, 6).stdout, "");
    box.config({ minTurnSeconds: 600 });
    assert.equal(turn(box, 300).stdout, "");
  });
});

test("minTurnSeconds 0 pings for every turn, even without a recorded start (and then has no duration)", async () => {
  await withBox((box) => {
    box.config({ minTurnSeconds: 0 });
    assert.equal(box.hook("Stop", {}, { env: at(1) }).stdout, seqJson("\x1b]9;Claude Code - Finished in myproj\x07"));
  });
});

// --- Notification ----------------------------------------------------------------------------------

test("Notification prints the project and Claude Code's own message", async () => {
  await withBox((box) => {
    const r = box.hook("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }, { env: at(0) });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, seqJson("\x1b]9;Claude Code - myproj: Claude needs your permission to use Bash\x07"));
  });
});

test("Notification types: the needs-you ones ping, the informational ones do not", async () => {
  await withBox((box) => {
    const ping = (type, n) => box.hook("Notification", { notification_type: type, message: "m" }, { env: at(n * 100) }).stdout !== "";
    assert.equal(ping("permission_prompt", 1), true);
    assert.equal(ping("idle_prompt", 2), true);
    assert.equal(ping("agent_needs_input", 3), true);
    assert.equal(ping("worker_permission_prompt", 4), true);
    assert.equal(ping("elicitation_dialog", 5), true);
    assert.equal(ping("auth_success", 6), false);
    assert.equal(ping("computer_use_exit", 7), false);
    assert.equal(ping("elicitation_complete", 8), false);
    assert.equal(ping("agent_completed", 9), false);
    assert.equal(ping("push_notification", 10), false);
    assert.match(box.log(), /skip type:auth_success/);
  });
});

test("types.agent_completed on in settings makes that Notification ping", async () => {
  await withBox((box) => {
    box.config({ types: { agent_completed: true } });
    assert.notEqual(box.hook("Notification", { notification_type: "agent_completed", message: "Agent finished" }, { env: at(0) }).stdout, "");
  });
});

test("a Notification from an older Claude Code, with no type, pings", async () => {
  await withBox((box) => {
    assert.notEqual(box.hook("Notification", { message: "Claude is waiting for your input" }, { env: at(0) }).stdout, "");
  });
});

test("a Notification pings even when the turn was started by an automated prompt", async () => {
  await withBox((box) => {
    box.hook("UserPromptSubmit", { source: "loop_wakeup" }, { env: at(0) });
    assert.notEqual(box.hook("Notification", { notification_type: "permission_prompt", message: "m" }, { env: at(1) }).stdout, "");
  });
});

// --- terminal modes --------------------------------------------------------------------------------

test("terminal modes: osc777, title, bell and off", async () => {
  await withBox((box) => {
    let base = 0;
    const stopOut = () => turn(box, 125, { base: (base += 1000) }).stdout;
    box.config({ terminal: "osc777" });
    assert.equal(stopOut(), seqJson("\x1b]777;notify;Claude Code;Finished in myproj after 2m 5s\x07"));
    box.config({ terminal: "title" });
    assert.equal(stopOut(), seqJson("\x1b]2;✓ Claude: myproj\x07"));
    assert.equal(box.hook("Notification", { notification_type: "permission_prompt", message: "m" }, { env: at(base + 1000) }).stdout, seqJson("\x1b]2;! Claude: myproj\x07"));
    box.config({ terminal: "bell" });
    assert.equal(stopOut(), seqJson("\x07"));
    box.config({ terminal: "off" });
    assert.equal(stopOut(), "");
  });
});

test("a custom title that starts with a digit does not break the OSC 9 rule", async () => {
  await withBox((box) => {
    box.config({ title: "2 Claude" });
    const out = parseHookOutput(turn(box, 125).stdout);
    assert.equal(out.terminalSequence, "\x1b]9;Claude: 2 Claude - Finished in myproj after 2m 5s\x07");
    assert.ok(claudeAccepts(out.terminalSequence));
  });
});

test("the printed sequence always passes Claude Code's allowlist, whatever the message says", async () => {
  await withBox((box) => {
    const hostile = ["\x1b]52;c;AAAA\x07 pay attention", "7 files need you", chars(0x202e) + "evil", "x".repeat(900), "line1\nline2\x00"];
    let n = 0;
    for (const message of hostile) {
      const out = parseHookOutput(box.hook("Notification", { notification_type: "permission_prompt", message }, { env: at(100 * ++n) }).stdout);
      assert.ok(out && claudeAccepts(out.terminalSequence), JSON.stringify(out).slice(0, 80));
    }
  });
});

// --- gates: enabled, mute, quiet hours, rate limit ----------------------------------------------------

test("enabled: false silences the hooks", async () => {
  await withBox((box) => {
    box.config({ enabled: false });
    assert.equal(turn(box, 300).stdout, "");
    assert.equal(box.hook("Notification", { notification_type: "permission_prompt" }, { env: at(400) }).stdout, "");
    assert.match(box.log(), /skip disabled/);
  });
});

test("mute and unmute apply to the project the session is in", async () => {
  await withBox((box) => {
    assert.notEqual(turn(box, 100).stdout, "");
    assert.equal(box.cli(["mute"]).status, 0);
    assert.equal(turn(box, 100, { base: 1000 }).stdout, "", "muted: no Stop ping");
    assert.equal(box.hook("Notification", { notification_type: "permission_prompt", message: "m" }, { env: at(5000) }).stdout, "", "muted: no Notification ping");
    assert.match(box.log(), /skip muted/);
    // another project is not muted
    const other = path.join(box.root, "other");
    fs.mkdirSync(path.join(other, ".git"), { recursive: true });
    box.hook("UserPromptSubmit", { cwd: other, session_id: "s-other" }, { env: at(0) });
    assert.notEqual(box.hook("Stop", { cwd: other, session_id: "s-other" }, { env: at(100) }).stdout, "");
    assert.equal(box.cli(["unmute"]).status, 0);
    assert.notEqual(turn(box, 100, { base: 10000 }).stdout, "");
  });
});

test("quiet hours across midnight: terminal only, and the other channels stay silent", async () => {
  const srv = await captureServer();
  await withBox(async (box) => {
    box.config({ quiet: "22:00-08:00", ntfy: { topic: "t", url: srv.url } });
    const ping = (sid, now) => box.hookAsync("Notification", { notification_type: "permission_prompt", message: "m", session_id: sid }, { env: { ...INLINE, CLAUDE_NOTIFY_NOW: now } });
    const r = await ping("s-a", "2026-10-04T23:30:00");
    assert.notEqual(r.stdout, "", "the terminal channel still pings in quiet hours");
    assert.equal(srv.hits.length, 0, "ntfy does not");
    assert.match(box.log(), /send \[terminal\].*quiet-hours/);
    await ping("s-b", "2026-10-05T03:00:00");
    assert.equal(srv.hits.length, 0, "03:00 is still quiet");
    await ping("s-d", "2026-10-05T07:59:00");
    assert.equal(srv.hits.length, 0, "07:59 is still quiet");
    await ping("s-c", "2026-10-05T12:00:00");
    assert.equal(srv.hits.length, 1, "at noon ntfy pings");
  }).finally(() => srv.close());
});

test("a project may switch the user's quiet hours off for itself", async () => {
  const srv = await captureServer();
  await withBox(async (box) => {
    box.config({ quiet: "00:00-24:00", ntfy: { topic: "t", url: srv.url } }); // quiet all day
    const env = { ...INLINE, CLAUDE_NOTIFY_NOW: "2026-10-04T10:00:00" };
    const ping = (sid) => box.hookAsync("Notification", { notification_type: "permission_prompt", message: "m", session_id: sid }, { env });
    assert.notEqual((await ping("s-1")).stdout, "", "quiet hours still let the terminal channel ping");
    assert.equal(srv.hits.length, 0, "but ntfy is held back");
    fs.mkdirSync(path.join(box.proj, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(box.proj, ".claude", "notify.json"), JSON.stringify({ quiet: "off" }));
    await ping("s-2");
    assert.equal(srv.hits.length, 1, "this project has no quiet hours");
  }).finally(() => srv.close());
});

test("rate limit: one push per channel per 20 seconds per session", async () => {
  await withBox((box) => {
    const n = (s) => box.hook("Notification", { notification_type: "permission_prompt", message: "m" }, { env: at(s) }).stdout;
    assert.notEqual(n(0), "");
    assert.equal(n(5), "", "5 s later: dropped");
    assert.equal(n(19), "", "19 s after the push: dropped");
    assert.notEqual(n(20), "", "20 s after the push: allowed");
    assert.equal(n(25), "", "the window restarted at the push that went out");
    assert.match(box.log(), /skip rate-limited/);
  });
});

test("rate limit is per session: another session pings straight away", async () => {
  await withBox((box) => {
    const n = (sid, s) => box.hook("Notification", { notification_type: "permission_prompt", message: "m", session_id: sid }, { env: at(s) }).stdout;
    assert.notEqual(n("s-one", 0), "");
    assert.equal(n("s-one", 1), "");
    assert.notEqual(n("s-two", 1), "");
  });
});

test("rateLimitSeconds 0 turns the rate limit off", async () => {
  await withBox((box) => {
    box.config({ rateLimitSeconds: 0 });
    const n = (s) => box.hook("Notification", { notification_type: "permission_prompt", message: "m" }, { env: at(s) }).stdout;
    assert.notEqual(n(0), "");
    assert.notEqual(n(1), "");
  });
});

test("the rate limit counts only pings that went out: a skipped Stop does not start a window", async () => {
  await withBox((box) => {
    assert.equal(turn(box, 5).stdout, "");
    assert.notEqual(box.hook("Notification", { notification_type: "permission_prompt", message: "m" }, { env: at(6) }).stdout, "");
  });
});

// --- projects and project settings -------------------------------------------------------------------

test("the project name is the git top level, even when Claude Code works in a subfolder", async () => {
  await withBox((box) => {
    const sub = path.join(box.proj, "packages", "web");
    fs.mkdirSync(sub, { recursive: true });
    box.hook("UserPromptSubmit", { cwd: sub }, { env: at(0) });
    const out = parseHookOutput(box.hook("Stop", { cwd: sub }, { env: at(100) }).stdout);
    assert.ok(out.terminalSequence.includes("Finished in myproj after 1m 40s"));
  });
});

test("without a git repository the working folder's name is used", async () => {
  await withBox((box) => {
    const plain = path.join(box.root, "plain-folder");
    fs.mkdirSync(plain);
    box.hook("UserPromptSubmit", { cwd: plain }, { env: at(0) });
    const out = parseHookOutput(box.hook("Stop", { cwd: plain }, { env: at(100) }).stdout);
    assert.ok(out.terminalSequence.includes("Finished in plain-folder after"), out.terminalSequence);
  });
});

test(".claude/notify.json in a project may set name, minTurnSeconds, quiet and notifyAutomated", async () => {
  await withBox((box) => {
    fs.mkdirSync(path.join(box.proj, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(box.proj, ".claude", "notify.json"), JSON.stringify({ name: "Billing API", minTurnSeconds: 5, notifyAutomated: true }));
    const out = parseHookOutput(turn(box, 6, { prompt: { source: "loop_wakeup" } }).stdout);
    assert.equal(out.terminalSequence, "\x1b]9;Claude Code - Finished in Billing API after 6s\x07");
  });
});

test("a huge .claude/notify.json in a repository is ignored without being read", async () => {
  await withBox((box) => {
    fs.mkdirSync(path.join(box.proj, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(box.proj, ".claude", "notify.json"), JSON.stringify({ name: "x".repeat(20 * 1024 * 1024) }));
    const r = turn(box, 125);
    assert.equal(r.stdout, seqJson("\x1b]9;Claude Code - Finished in myproj after 2m 5s\x07"), "defaults and the folder's own name");
    assert.ok(r.ms < 1500, `${r.ms} ms`);
  });
});

test("a project file can never add a channel, a URL, a token or a command", async () => {
  const srv = await captureServer();
  await withBox(async (box) => {
    const canary = path.join(box.root, "ran.txt");
    fs.mkdirSync(path.join(box.proj, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(box.proj, ".claude", "notify.json"), JSON.stringify({
      minTurnSeconds: 0,
      slack: { url: `${srv.url}/slack` }, discord: { url: `${srv.url}/discord` }, teams: { url: `${srv.url}/teams` },
      // (no `desktop: true` here: if a bug ever honoured this file, the test must not pop a real toast;
      // that the desktop switch is ignored in a project file is covered in config.test.mjs)
      ntfy: { topic: "stolen", url: srv.url }, terminal: "off", enabled: false,
      command: [process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(canary)}, 'x')`],
      mutedProjects: ["x"], includeLastMessage: true, includeLastMessageRemote: true,
    }));
    const r = await box.hookAsync("Stop", {}, { env: { ...at(100), ...INLINE } });
    assert.equal(r.stdout, seqJson("\x1b]9;Claude Code - Finished in myproj\x07"), "still the user's own settings: terminal only, enabled");
    assert.equal(srv.hits.length, 0, "no request was made");
    assert.equal(fs.existsSync(canary), false, "no command was run");
  }).finally(() => srv.close());
});

// --- last reply ------------------------------------------------------------------------------------

function transcript(box, text) {
  const file = path.join(box.root, "session.jsonl");
  fs.writeFileSync(file, [
    JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }),
  ].join("\n") + "\n");
  return file;
}

test("includeLastMessage adds the first 120 characters of the last reply to the terminal text only", async () => {
  const srv = await captureServer();
  await withBox(async (box) => {
    const reply = "Fixed the null check in auth.ts and added two tests for the empty token case. " + "Then I ran the whole suite and it passed. ".repeat(5);
    const file = transcript(box, reply);
    box.config({ includeLastMessage: true, ntfy: { topic: "t", url: srv.url } });
    const r = await turnAsync(box, 125, { stop: { transcript_path: file }, env: INLINE });
    const seq = parseHookOutput(r.stdout).terminalSequence;
    assert.ok(seq.includes(" | Fixed the null check in auth.ts"), seq);
    assert.ok(seq.includes(reply.slice(0, 60)));
    assert.equal(srv.hits.length, 1);
    assert.ok(!srv.hits[0].body.includes("Fixed the null check"), "the remote channel gets no last reply by default");
  }).finally(() => srv.close());
});

test("includeLastMessageRemote on top sends it to remote channels as well", async () => {
  const srv = await captureServer();
  await withBox(async (box) => {
    const file = transcript(box, "Fixed the null check.");
    box.config({ includeLastMessage: true, includeLastMessageRemote: true, ntfy: { topic: "t", url: srv.url } });
    await turnAsync(box, 125, { stop: { transcript_path: file }, env: INLINE });
    assert.equal(srv.hits[0].body, "Finished in myproj after 2m 5s\nFixed the null check.");
  }).finally(() => srv.close());
});

test("without includeLastMessage the transcript is never opened", async () => {
  await withBox((box) => {
    const missing = path.join(box.root, "this-file-does-not-exist.jsonl");
    const r = turn(box, 125, { stop: { transcript_path: missing } });
    assert.equal(r.stdout, seqJson("\x1b]9;Claude Code - Finished in myproj after 2m 5s\x07"));
  });
});

test("includeLastMessage with an unreadable transcript still pings, without the reply", async () => {
  await withBox((box) => {
    box.config({ includeLastMessage: true });
    const r = turn(box, 125, { stop: { transcript_path: path.join(box.root, "gone.jsonl") } });
    assert.equal(r.stdout, seqJson("\x1b]9;Claude Code - Finished in myproj after 2m 5s\x07"));
  });
});

// --- other channels, run inline for the test --------------------------------------------------------

test("a Stop with ntfy set delivers to the server and still prints the terminal sequence", async () => {
  const srv = await captureServer();
  await withBox(async (box) => {
    box.config({ ntfy: { topic: "my-topic", url: srv.url } });
    const r = await turnAsync(box, 125, { env: INLINE });
    assert.equal(r.stdout, seqJson("\x1b]9;Claude Code - Finished in myproj after 2m 5s\x07"));
    assert.equal(srv.hits.length, 1);
    assert.equal(srv.hits[0].url, "/my-topic");
    assert.equal(srv.hits[0].body, "Finished in myproj after 2m 5s");
    assert.equal(srv.hits[0].headers.title, "Claude Code");
  }).finally(() => srv.close());
});

test("a failing channel is logged without its URL, and the hook still succeeds", async () => {
  const srv = await captureServer(() => ({ status: 500, body: "server on fire" }));
  await withBox(async (box) => {
    box.config({ slack: { url: `${srv.url}/services/TSECRET/BSECRET/shhhhhh` }, terminal: "off" });
    const r = await turnAsync(box, 125, { env: INLINE });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    const log = box.log();
    assert.match(log, /Stop slack failed: HTTP 500: server on fire/);
    assert.ok(!log.includes("shhhhhh") && !log.includes("TSECRET"), "no part of the URL is logged");
  }).finally(() => srv.close());
});

test("the rate limit applies to each channel on its own", async () => {
  const srv = await captureServer();
  await withBox(async (box) => {
    box.config({ ntfy: { topic: "t", url: srv.url } });
    const n = (s) => box.hookAsync("Notification", { notification_type: "permission_prompt", message: "m" }, { env: { ...at(s), ...INLINE } });
    await n(0);
    await n(5);
    await n(21);
    assert.equal(srv.hits.length, 2);
  }).finally(() => srv.close());
});

// --- robustness: a hook never fails and never prints anything else ------------------------------------

const MATRIX = [
  ["UserPromptSubmit", {}], ["UserPromptSubmit", { prompt: "hi", source: "user" }], ["UserPromptSubmit", { source: 5 }],
  ["Stop", {}], ["Stop", { stop_hook_active: true }], ["Stop", { transcript_path: 12 }], ["Stop", { cwd: 42 }], ["Stop", { session_id: null }],
  ["Notification", {}], ["Notification", { notification_type: "permission_prompt" }], ["Notification", { notification_type: ["x"], message: { a: 1 } }],
  ["Notification", { notification_type: "idle_prompt", message: "waiting\u0007\n" }], ["SessionEnd", { reason: "clear" }],
];

test("for every event and a spread of odd inputs: exit 0, empty stderr, stdout empty or exactly one terminalSequence", async () => {
  await withBox((box) => {
    box.config({ minTurnSeconds: 0 });
    let n = 0;
    for (const [event, input] of MATRIX) {
      const r = box.hook(event, input, { env: at(1000 * ++n) });
      assert.equal(r.status, 0, `${event} ${JSON.stringify(input)}`);
      assert.equal(r.stderr, "", `${event} ${JSON.stringify(input)}: ${r.stderr}`);
      if (r.stdout !== "") {
        const out = JSON.parse(r.stdout);
        assert.deepEqual(Object.keys(out), ["terminalSequence"], r.stdout);
        assert.ok(claudeAccepts(out.terminalSequence));
        assert.equal(r.stdout, JSON.stringify(out), "no extra whitespace or text around the JSON");
      }
      if (event === "UserPromptSubmit" || event === "SessionEnd") assert.equal(r.stdout, "", `${event} must print nothing`);
    }
  });
});

test("garbage on stdin: exit 0 and nothing printed", async () => {
  await withBox((box) => {
    for (const raw of ["", "not json", "{", "[]", "null", "42", '"a string"', "\u0000\u0001", "{\"session_id\":"]) {
      const r = box.hook("Stop", raw);
      assert.equal(r.status, 0, JSON.stringify(raw));
      assert.equal(r.stdout, "", JSON.stringify(raw));
      assert.equal(r.stderr, "", JSON.stringify(raw));
    }
  });
});

test("with minTurnSeconds 0, empty stdin still works: a ping about the current folder", async () => {
  await withBox((box) => {
    box.config({ minTurnSeconds: 0 });
    const r = box.hook("Stop", "", { cwd: box.proj });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, seqJson("\x1b]9;Claude Code - Finished in myproj\x07"));
  });
});

test("a hook registered under a wrong event name prints nothing on stdout (the error goes to stderr)", async () => {
  await withBox((box) => {
    for (const wrong of ["Whatever", "PreToolUse", "Stopp", "SessionStart"]) {
      const r = spawnSync(process.execPath, [NOTIFY, wrong], { input: "{}", env: box.env, encoding: "utf8" });
      assert.equal(r.stdout, "", wrong);
      assert.match(r.stderr, /Unknown command/, wrong);
      assert.notEqual(r.status, 2, "exit code 2 would block the session");
    }
  });
});

test("event names are accepted in any case and with dashes", async () => {
  await withBox((box) => {
    box.hook("UserPromptSubmit", {}, { env: at(0), arg: "user-prompt-submit" });
    assert.equal(box.stateOf("s-test-1234").turn.at, T0);
    const r = box.hook("Stop", {}, { env: at(100), arg: "STOP" });
    assert.notEqual(r.stdout, "");
    assert.notEqual(box.hook("Notification", { notification_type: "idle_prompt" }, { env: at(500), arg: "notification" }).stdout, "");
  });
});

test("a notify.json that is not valid JSON falls back to defaults, and the log says so", async () => {
  await withBox((box) => {
    box.config("{ this is not json");
    const r = turn(box, 125);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, seqJson("\x1b]9;Claude Code - Finished in myproj after 2m 5s\x07"));
    assert.match(box.log(), /notify\.json is not valid JSON/);
  });
});

test("a config folder that cannot be written does not break the hook", async () => {
  await withBox((box) => {
    const blocker = path.join(box.root, "blocker");
    fs.writeFileSync(blocker, "a file where a folder should be");
    const env = { CLAUDE_CONFIG_DIR: path.join(blocker, "cfg"), ...at(0) };
    for (const event of ["UserPromptSubmit", "Stop", "Notification"]) {
      const r = box.hook(event, { notification_type: "permission_prompt", message: "m" }, { env });
      assert.equal(r.status, 0, event);
      assert.equal(r.stderr, "", event);
    }
  });
});

test("a broken install (src/ missing) still exits 0 and prints nothing", async () => {
  await withBox((box) => {
    const lone = path.join(box.root, "lone");
    fs.mkdirSync(lone);
    fs.copyFileSync(NOTIFY, path.join(lone, "notify.mjs"));
    for (const event of ["UserPromptSubmit", "Stop", "Notification"]) {
      const r = spawnSync(process.execPath, [path.join(lone, "notify.mjs"), event], { input: "{}", env: box.env, encoding: "utf8" });
      assert.equal(r.status, 0, event);
      assert.equal(r.stdout, "", event);
      assert.equal(r.stderr, "", event);
    }
    assert.match(box.log(), /could not start/);
  });
});

test("a session id that tries to climb out of the state folder is made safe", async () => {
  await withBox((box) => {
    box.hook("UserPromptSubmit", { session_id: "../../evil/../x" }, { env: at(0) });
    const dir = box.path("notify", "state");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);
    assert.ok(!files[0].includes("/") && !files[0].includes("\\") && !files[0].includes(".."), files[0]);
    assert.ok(!fs.existsSync(path.join(box.root, "evil")));
    assert.ok(!fs.existsSync(path.join(box.cfg, "evil")));
  });
});

test("SessionEnd deletes the session's state and prints nothing", async () => {
  await withBox((box) => {
    box.hook("UserPromptSubmit", {}, { env: at(0) });
    assert.ok(box.stateOf("s-test-1234"));
    const r = box.hook("SessionEnd", { reason: "other" }, { env: at(10) });
    assert.equal(r.stdout, "");
    assert.equal(box.stateOf("s-test-1234"), null);
  });
});

test("old state files are swept once there are many", async () => {
  await withBox((box) => {
    const dir = box.path("notify", "state");
    fs.mkdirSync(dir, { recursive: true });
    const old = (Date.now() - 10 * 86400 * 1000) / 1000;
    for (let i = 0; i < 40; i++) {
      const f = path.join(dir, `old-${i}.json`);
      fs.writeFileSync(f, "{}");
      fs.utimesSync(f, old, old);
    }
    box.hook("UserPromptSubmit", {}, { env: at(0) });
    const left = fs.readdirSync(dir);
    assert.deepEqual(left.filter((f) => f.startsWith("old-")), [], "all ten-day-old files are gone");
    assert.ok(left.includes("s-test-1234.json"), "the live session's file stays");
  });
});

// --- two hooks at once (for example the plugin and init both installed) -----------------------------------

test("hooks of one session that run at the same moment send one ping, not several", async () => {
  const box = sandbox();
  try {
    const runs = await Promise.all(Array.from({ length: 6 }, () => hookClose(box, "Notification", { notification_type: "permission_prompt", message: "m" }, { env: at(0) })));
    const printed = runs.filter((r) => r.stdout !== "");
    assert.equal(runs.every((r) => r.code === 0), true);
    assert.equal(printed.length, 1, `printed by ${printed.length} of ${runs.length} hooks`);
  } finally {
    box.cleanup();
  }
});

test("two Stop hooks for one turn (two installs) send one ping", async () => {
  const box = sandbox();
  try {
    box.hook("UserPromptSubmit", {}, { env: at(0) });
    const runs = await Promise.all([1, 2, 3].map(() => hookClose(box, "Stop", { session_id: "s-test-1234" }, { env: at(125) })));
    assert.equal(runs.filter((r) => r.stdout !== "").length, 1);
  } finally {
    box.cleanup();
  }
});
