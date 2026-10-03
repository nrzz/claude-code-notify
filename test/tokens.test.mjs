// The token budget is zero, and these tests hold it there: no hook may print anything but an
// optional terminalSequence (which Claude Code writes to the terminal and never shows the model),
// the source may not use any field that puts text in front of the model, and the plugin ships no
// skill, command, agent or MCP server that would add to Claude's context.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, at, captureServer, claudeAccepts, sandbox } from "./helpers.mjs";

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const srcFiles = fs.readdirSync(path.join(ROOT, "src")).filter((f) => f.endsWith(".mjs"));

// Every Claude Code hook output field that can reach the model, or change what Claude does.
const MODEL_VISIBLE_FIELDS = ["additionalContext", "hookSpecificOutput", "systemMessage", "stopReason", "suppressOriginalPrompt", "updatedInput", "updatedMCPToolOutput", "permissionDecision", "rewakeSummary"];

test("no source file uses a hook output field that reaches the model or changes Claude's behaviour", () => {
  for (const file of ["notify.mjs", ...srcFiles.map((f) => `src/${f}`)]) {
    const code = read(file);
    for (const field of MODEL_VISIBLE_FIELDS) assert.ok(!code.includes(field), `${file} mentions ${field}`);
  }
});

test("the only field a hook ever prints is terminalSequence", () => {
  const printed = [...read("src", "hook.mjs").matchAll(/JSON\.stringify\(\{\s*([A-Za-z]+)/g)].map((m) => m[1]);
  assert.deepEqual(printed.filter((f) => f !== "v"), ["terminalSequence"], "the JSON.stringify calls in hook.mjs: " + printed.join(", "));
  assert.equal(read("src", "hook.mjs").match(/write\(JSON\.stringify/g).length, 1, "one place prints");
});

test("the code a hook runs never prints with console or process.stdout, except the one synchronous writer", () => {
  const hookPath = ["notify.mjs", "src/hook.mjs", "src/decide.mjs", "src/message.mjs", "src/osc.mjs", "src/state.mjs", "src/log.mjs", "src/config.mjs", "src/fsutil.mjs"];
  for (const file of hookPath) {
    const code = read(file);
    assert.ok(!/console\.(log|info|warn|error|debug|trace)/.test(code), `${file} uses console`);
    assert.ok(!/process\.stderr/.test(code), `${file} writes to stderr`);
    if (file !== "src/hook.mjs") assert.ok(!/process\.stdout|writeSync\(1/.test(code), `${file} writes to stdout`);
  }
  assert.equal((read("src", "hook.mjs").match(/writeSync\(1/g) || []).length, 1);
});

test("the hook path loads only what it needs: the web channels, the installer and the command line load on demand", () => {
  const staticImports = [...read("src", "hook.mjs").matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
  for (const heavy of ["./channels.mjs", "./send.mjs", "./install.mjs", "./cli.mjs", "node:http", "node:https"]) {
    assert.ok(!staticImports.includes(heavy), `hook.mjs imports ${heavy} up front`);
  }
  assert.ok(!/^import /m.test(read("notify.mjs").replace(/^import (fs|os|path) from "node:\1";$/gm, "")), "notify.mjs imports only fs, os and path up front");
});

test("the plugin's hooks are exactly the three silent ones, and it adds no skill, command, agent or MCP server", () => {
  const hooks = JSON.parse(read("hooks", "hooks.json")).hooks;
  assert.deepEqual(Object.keys(hooks), ["UserPromptSubmit", "Stop", "Notification"]);
  for (const dir of ["skills", "commands", "agents", "output-styles"]) assert.ok(!fs.existsSync(path.join(ROOT, dir)), dir);
  assert.ok(!fs.existsSync(path.join(ROOT, ".mcp.json")));
});

// --- run every hook against every channel and mode, and look at stdout and stderr ---------------------

const CHANNEL_CONFIGS = (srv) => [
  {},
  { terminal: "osc777" }, { terminal: "title" }, { terminal: "bell" }, { terminal: "off" },
  { ntfy: { topic: "t", url: srv.url } },
  { slack: { url: `${srv.url}/s` }, discord: { url: `${srv.url}/d` }, teams: { url: `${srv.url}/t` } },
  { includeLastMessage: true, includeLastMessageRemote: true, ntfy: { topic: "t", url: srv.url } },
];

test("whatever channels are on, stdout is empty or exactly one terminalSequence, and stderr is empty", async () => {
  const srv = await captureServer((hit) => ({ status: 500, body: "this error text must never reach a hook's output" }));
  const box = sandbox();
  try {
    const transcript = path.join(box.root, "t.jsonl");
    fs.writeFileSync(transcript, JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "A reply." }] } }) + "\n");
    let n = 0;
    for (const config of CHANNEL_CONFIGS(srv)) {
      box.config({ minTurnSeconds: 0, rateLimitSeconds: 0, ...config });
      for (const [event, input] of [
        ["UserPromptSubmit", { prompt: "p" }], ["Stop", { transcript_path: transcript }], ["Notification", { notification_type: "permission_prompt", message: "needs you" }],
        ["Notification", { notification_type: "auth_success" }], ["SessionEnd", {}],
      ]) {
        const r = await box.hookAsync(event, { session_id: `matrix-${++n}`, ...input }, { env: { ...at(n * 100), CLAUDE_NOTIFY_INLINE: "1", CLAUDE_NOTIFY_TIMEOUT_MS: "3000" } });
        const label = `${event} with ${JSON.stringify(config).slice(0, 60)}`;
        assert.equal(r.status, 0, label);
        assert.equal(r.stderr, "", label);
        if (r.stdout !== "") {
          const out = JSON.parse(r.stdout);
          assert.deepEqual(Object.keys(out), ["terminalSequence"], label);
          assert.ok(claudeAccepts(out.terminalSequence), label);
          assert.equal(r.stdout, JSON.stringify(out), label);
        }
        if (event === "UserPromptSubmit" || event === "SessionEnd") assert.equal(r.stdout, "", label);
      }
    }
    assert.ok(srv.hits.length > 0, "the web channels did run (and failed with a 500, silently)");
  } finally {
    await srv.close();
    box.cleanup();
  }
});

test("a custom command that prints a lot cannot put anything on the hook's output", async () => {
  const box = sandbox();
  try {
    const script = path.join(box.root, "chatty.js");
    fs.writeFileSync(script, 'console.log("CHATTY STDOUT ".repeat(200)); console.error("CHATTY STDERR ".repeat(200));');
    box.config({ minTurnSeconds: 0, terminal: "off", command: [process.execPath, script] });
    const r = await box.hookAsync("Stop", {}, { env: { CLAUDE_NOTIFY_INLINE: "1", CLAUDE_NOTIFY_TIMEOUT_MS: "5000" } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  } finally {
    box.cleanup();
  }
});

test("the detached worker path prints nothing either", async () => {
  const srv = await captureServer();
  const box = sandbox();
  try {
    box.config({ minTurnSeconds: 0, terminal: "off", ntfy: { topic: "t", url: srv.url } });
    const r = await box.hookAsync("Stop", {}, {});
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
  } finally {
    await srv.close();
    box.cleanup();
  }
});

test("a hook input of any size is handled without output (a 5 MB stdin)", async () => {
  const box = sandbox();
  try {
    const big = JSON.stringify({ session_id: "big", cwd: box.proj, prompt: "x".repeat(5 * 1024 * 1024) });
    const r = await box.hookAsync("UserPromptSubmit", big, { env: at(0) });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    assert.deepEqual(box.stateOf("big").turn, { at: at(0).CLAUDE_NOTIFY_NOW * 1, source: "user" });
    assert.ok(!JSON.stringify(box.stateOf("big")).includes("xxxx"), "the prompt is not stored");
  } finally {
    box.cleanup();
  }
});
