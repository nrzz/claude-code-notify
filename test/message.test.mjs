// What a notification says: durations, project names, text cleaning, privacy defaults, and Claude's
// last reply read from a transcript's tail.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildMessages, cleanText, formatDuration, lastAssistantText, projectName, snippet } from "../src/message.mjs";
import { findGitRoot, normalizeConfig } from "../src/config.mjs";
import { chars, sandbox } from "./helpers.mjs";

const cfg = (over = {}) => normalizeConfig(over);

// --- durations and project names -------------------------------------------------------------------

test("formatDuration", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(45000), "45s");
  assert.equal(formatDuration(59499), "59s");
  assert.equal(formatDuration(60000), "1m");
  assert.equal(formatDuration(125000), "2m 5s");
  assert.equal(formatDuration(133000), "2m 13s");
  assert.equal(formatDuration(3600000), "1h");
  assert.equal(formatDuration(3900000), "1h 5m");
  assert.equal(formatDuration(7384000), "2h 3m");
  assert.equal(formatDuration(-5000), "0s");
});

test("projectName is the folder's own name: the git top level, else the working folder", () => {
  assert.equal(projectName({ cwd: path.join("x", "api", "src"), root: path.join("x", "api") }), "api");
  assert.equal(projectName({ cwd: path.join("x", "scratch") }), "scratch");
  assert.equal(projectName({ cwd: path.join("x", "scratch") + path.sep }), "scratch");
  assert.equal(projectName({ cwd: path.join("x", "api"), root: path.join("x", "api"), name: "Billing API" }), "Billing API");
  assert.equal(projectName({}), "project");
});

test("projectName never exceeds 60 characters and carries no control characters", () => {
  const name = projectName({ cwd: path.join("x", "a".repeat(100)) });
  assert.ok([...name].length <= 60);
  assert.equal(projectName({ cwd: path.join("x", "my\nproj\x07") }), "my proj");
});

test("findGitRoot finds a .git folder or a .git file (worktrees) above the working folder, and null outside a repository", () => {
  const box = sandbox();
  try {
    const deep = path.join(box.proj, "src", "deep");
    fs.mkdirSync(deep, { recursive: true });
    assert.equal(findGitRoot(deep), box.proj);
    const wt = path.join(box.root, "worktree");
    fs.mkdirSync(path.join(wt, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(wt, ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    assert.equal(findGitRoot(path.join(wt, "pkg")), wt);
    const outside = findGitRoot(path.join(box.root, "h"));
    assert.ok(outside === null || !outside.startsWith(box.root), "nothing inside the sandbox folder counts as a repository");
  } finally {
    box.cleanup();
  }
});

// --- cleanText -------------------------------------------------------------------------------------

test("cleanText: one line, no control characters, blanks collapsed", () => {
  assert.equal(cleanText("  a \n b\t\tc\r\n d  "), "a b c d");
  assert.equal(cleanText("a\x00b\x07c\x1bd\x7fe"), "abcde");
  assert.equal(cleanText("a" + chars(0x85) + "b" + chars(0x9b) + "c" + chars(0x9d) + "d"), "a bcd", "NEL becomes a space, CSI and OSC introducers vanish");
  assert.equal(cleanText(null), "");
  assert.equal(cleanText(undefined), "");
  assert.equal(cleanText(12), "12");
});

test("cleanText removes bidi overrides, zero-width spaces, line separators and the byte order mark", () => {
  const hostile = "a" + chars(0x202e, 0x2066, 0x2069, 0x200b, 0x2060, 0xfeff, 0x180e, 0x200e) + "b" + chars(0x2028) + "c" + chars(0x2029) + "d";
  assert.equal(cleanText(hostile), "ab c d");
});

test("cleanText keeps zero-width joiners, so emoji sequences and some scripts survive", () => {
  const family = chars(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  assert.equal(cleanText(family), family);
});

test("cleanText cuts at max code points with an ellipsis and never splits an emoji", () => {
  const emoji = chars(0x1f600);
  const t = cleanText(emoji.repeat(50), 10);
  assert.equal([...t].length, 10);
  assert.equal(t, emoji.repeat(9) + "…");
  assert.equal(cleanText("short", 10), "short");
  assert.equal(cleanText("exactly10!", 10), "exactly10!");
  assert.equal(cleanText("abcdefghijk", 10), "abcdefghi…");
});

// --- snippet ---------------------------------------------------------------------------------------

test("snippet is the first 120 characters, with an ellipsis only when there is more", () => {
  const long = "abcdef ".repeat(60); // 7 characters a word: the 120th character is not a space
  const s = snippet(long);
  assert.equal([...s].length, 120 + 1);
  assert.ok(s.endsWith("…"));
  assert.equal(s.slice(0, -1), cleanText(long).slice(0, 120));
  assert.equal(snippet("word ".repeat(60)), "word ".repeat(23) + "word…", "a space at the cut is dropped, so the ellipsis follows the last word");
  assert.equal(snippet("A short reply."), "A short reply.");
  assert.equal(snippet("x".repeat(120)), "x".repeat(120));
  assert.equal(snippet("x".repeat(121)), "x".repeat(120) + "…");
});

// --- buildMessages: bodies and privacy defaults ----------------------------------------------------

test("Stop body: Finished in <project> after <duration>", () => {
  const m = buildMessages({ kind: "finished", project: "api", durationMs: 133000, cfg: cfg() });
  assert.deepEqual(m.local, { title: "Claude Code", body: "Finished in api after 2m 13s", detail: "" });
  assert.deepEqual(m.remote, m.local);
});

test("Stop body without a known duration", () => {
  assert.equal(buildMessages({ kind: "finished", project: "api", durationMs: null, cfg: cfg() }).local.body, "Finished in api");
});

test("Notification body: <project>: <Claude Code's own message>", () => {
  const m = buildMessages({ kind: "attention", project: "api", notificationMessage: "Claude needs your permission to use Bash", notificationType: "permission_prompt", cfg: cfg() });
  assert.equal(m.local.body, "api: Claude needs your permission to use Bash");
  assert.equal(m.remote.body, "api: Claude needs your permission to use Bash");
});

test("a Notification without a message falls back to words that fit its type", () => {
  const body = (type) => buildMessages({ kind: "attention", project: "p", notificationMessage: "", notificationType: type, cfg: cfg() }).local.body;
  assert.equal(body("permission_prompt"), "p: Claude needs your permission");
  assert.equal(body("worker_permission_prompt"), "p: Claude needs your permission");
  assert.equal(body("idle_prompt"), "p: Claude is waiting for your input");
  assert.equal(body("agent_needs_input"), "p: An agent needs your input");
  assert.equal(body("elicitation_dialog"), "p: Claude needs your input");
  assert.equal(body(undefined), "p: Claude needs your attention");
});

test("a long or multi-line Notification message becomes one line of at most 200 characters", () => {
  const m = buildMessages({ kind: "attention", project: "p", notificationMessage: "line one\nline two " + "x".repeat(400), cfg: cfg() });
  assert.ok(!m.local.body.includes("\n"));
  assert.ok([...m.local.body].length <= "p: ".length + 200);
});

test("title is configurable", () => {
  assert.equal(buildMessages({ kind: "finished", project: "p", durationMs: 1000, cfg: cfg({ title: "Build bot" }) }).local.title, "Build bot");
});

test("privacy: by default nothing from the prompt, the paths or Claude's reply is in the message", () => {
  const secretPrompt = "my-very-secret-prompt";
  const m = buildMessages({ kind: "finished", project: "api", durationMs: 90000, lastText: "Claude said something private", cfg: cfg() });
  const all = JSON.stringify(m);
  assert.ok(!all.includes("private"), "the last reply is only included when asked for");
  assert.ok(!all.includes(secretPrompt));
  assert.deepEqual(Object.keys(m.local).sort(), ["body", "detail", "title"]);
  assert.equal(m.local.detail, "");
  assert.equal(m.remote.detail, "");
});

test("includeLastMessage adds the first 120 characters to the local message only", () => {
  const reply = "Fixed the null check in auth and added two tests. " + "More words. ".repeat(20);
  const m = buildMessages({ kind: "finished", project: "api", durationMs: 90000, lastText: reply, cfg: cfg({ includeLastMessage: true }) });
  assert.equal(m.local.detail, snippet(reply));
  assert.equal(m.remote.detail, "", "remote channels need includeLastMessageRemote as well");
});

test("includeLastMessageRemote on top of includeLastMessage sends the snippet to remote channels too", () => {
  const m = buildMessages({ kind: "finished", project: "api", durationMs: 90000, lastText: "Done and dusted.", cfg: cfg({ includeLastMessage: true, includeLastMessageRemote: true }) });
  assert.equal(m.local.detail, "Done and dusted.");
  assert.equal(m.remote.detail, "Done and dusted.");
});

test("includeLastMessageRemote alone adds nothing anywhere", () => {
  const m = buildMessages({ kind: "finished", project: "api", durationMs: 90000, lastText: "Done and dusted.", cfg: cfg({ includeLastMessageRemote: true }) });
  assert.equal(m.local.detail, "");
  assert.equal(m.remote.detail, "");
});

// --- lastAssistantText -----------------------------------------------------------------------------

const rec = (type, content, extra = {}) => JSON.stringify({ type, message: { role: type, content }, ...extra });
const textBlock = (text) => ({ type: "text", text });

test("lastAssistantText returns the text of the last assistant record", () => {
  const box = sandbox();
  try {
    const file = path.join(box.root, "t.jsonl");
    fs.writeFileSync(file, [
      rec("user", "please do the thing"),
      rec("assistant", [textBlock("First reply.")]),
      rec("user", "and another"),
      rec("assistant", [textBlock("The final reply, with  extra   spaces.\nSecond line.")]),
    ].join("\n") + "\n");
    assert.equal(lastAssistantText(file), "The final reply, with extra spaces. Second line.");
  } finally {
    box.cleanup();
  }
});

test("lastAssistantText skips records with no text (tool calls, thinking) and sub-agent records", () => {
  const box = sandbox();
  try {
    const file = path.join(box.root, "t.jsonl");
    fs.writeFileSync(file, [
      rec("assistant", [textBlock("The real last reply.")]),
      rec("assistant", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }]),
      rec("assistant", [{ type: "thinking", thinking: "hmm" }]),
      rec("user", [{ type: "tool_result", tool_use_id: "t1", content: "files" }]),
      rec("assistant", [textBlock("A sub-agent said this.")], { isSidechain: true }),
    ].join("\n") + "\n");
    assert.equal(lastAssistantText(file), "The real last reply.");
  } finally {
    box.cleanup();
  }
});

test("lastAssistantText joins several text blocks, accepts string content and ignores broken lines", () => {
  const box = sandbox();
  try {
    const file = path.join(box.root, "t.jsonl");
    fs.writeFileSync(file, [rec("assistant", "plain string reply"), "{not json at all", rec("assistant", [textBlock("part one"), textBlock("part two")]), "{\"type\":\"assistant\",\"truncated"].join("\n"));
    assert.equal(lastAssistantText(file), "part one part two");
    fs.writeFileSync(file, rec("assistant", "plain string reply"));
    assert.equal(lastAssistantText(file), "plain string reply");
  } finally {
    box.cleanup();
  }
});

test("lastAssistantText reads only the tail of a big transcript", () => {
  const box = sandbox();
  try {
    const file = path.join(box.root, "big.jsonl");
    const filler = rec("user", "x".repeat(2000));
    const lines = [rec("assistant", [textBlock("An old reply that is far outside the tail.")])];
    for (let i = 0; i < 400; i++) lines.push(filler);
    lines.push(rec("assistant", [textBlock("The newest reply.")]));
    fs.writeFileSync(file, lines.join("\n") + "\n");
    assert.ok(fs.statSync(file).size > 700 * 1024);
    assert.equal(lastAssistantText(file), "The newest reply.");
    fs.writeFileSync(file, [lines[0], ...lines.slice(1, 401)].join("\n") + "\n");
    assert.equal(lastAssistantText(file), "", "the only reply is older than the 256 KB tail that is read");
  } finally {
    box.cleanup();
  }
});

test("lastAssistantText is empty for a missing file, an empty path and a transcript without replies", () => {
  const box = sandbox();
  try {
    assert.equal(lastAssistantText(path.join(box.root, "nope.jsonl")), "");
    assert.equal(lastAssistantText(""), "");
    assert.equal(lastAssistantText(undefined), "");
    const file = path.join(box.root, "t.jsonl");
    fs.writeFileSync(file, rec("user", "hello") + "\n");
    assert.equal(lastAssistantText(file), "");
  } finally {
    box.cleanup();
  }
});

test("lastAssistantText strips terminal escapes that a reply might carry", () => {
  const box = sandbox();
  try {
    const file = path.join(box.root, "t.jsonl");
    fs.writeFileSync(file, rec("assistant", [textBlock("hi \x1b]0;pwned\x07 there \x1b[31mred")]) + "\n");
    const t = lastAssistantText(file);
    assert.ok(!t.includes("\x1b") && !t.includes("\x07"));
  } finally {
    box.cleanup();
  }
});
