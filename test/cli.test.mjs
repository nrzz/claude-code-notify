// The command line: set, status, mute, unmute, test, help. Run as child processes in a throwaway
// config folder. `test` runs against local HTTP servers, never a real service.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { main, parseArgs } from "../src/cli.mjs";
import { IS_WIN, at, captureServer, sandbox } from "./helpers.mjs";

const SLACK_URL = "https://hooks.sl" + "ack.com/services/" + "T0FAKE000/B0FAKE000/" + "x".repeat(24);
const PKG = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

async function withBox(fn) {
  const box = sandbox();
  try { return await fn(box); } finally { box.cleanup(); }
}

// --- help, version, errors -------------------------------------------------------------------------

test("--version prints the package version", async () => {
  await withBox((box) => {
    for (const flag of ["--version", "version"]) {
      const r = box.cli([flag]);
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), PKG.version);
    }
  });
});

test("--help and no arguments print the commands", async () => {
  await withBox((box) => {
    for (const args of [["--help"], ["help"], [], ["-h"], ["set", "--help"]]) {
      const r = box.cli(args);
      assert.equal(r.status, 0, args.join(" "));
      for (const word of ["init", "uninstall", "test", "status", "set", "mute", "unmute", "ntfy.topic", "slack.url", "quiet"]) assert.ok(r.stdout.includes(word), `${word} in help for ${args.join(" ")}`);
    }
  });
});

test("an unknown command is an error on stderr and prints nothing on stdout", async () => {
  await withBox((box) => {
    const r = box.cli(["frobnicate"]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /Unknown command "frobnicate"/);
  });
});

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["a", "--scope", "project", "--dry-run", "b", "--channel=ntfy"]), { _: ["a", "b"], flags: { scope: "project", "dry-run": true, channel: "ntfy" } });
  assert.deepEqual(parseArgs(["set", "command", "--", "node", "--flag"]), { _: ["set", "command", "node", "--flag"], flags: {} });
  assert.deepEqual(parseArgs(["-h"]).flags, { help: true });
  assert.deepEqual(parseArgs(["--project", "x"]), { _: ["x"], flags: { project: true } });
  assert.deepEqual(parseArgs(["--scope"]).flags, { scope: true });
});

test("main runs in process with an injected io (no child process needed)", async () => {
  await withBox(async (box) => {
    const out = [];
    const code = await main(["--version"], { env: box.env, cwd: box.proj, io: { log: (s) => out.push(s), error: () => {} } });
    assert.equal(code, 0);
    assert.deepEqual(out, [PKG.version]);
  });
});

// --- set -------------------------------------------------------------------------------------------

test("set writes <config>/notify.json, keeps what was there, and confirms", async () => {
  await withBox((box) => {
    const a = box.cli(["set", "minTurnSeconds", "60"]);
    assert.equal(a.status, 0, a.out);
    assert.match(a.stdout, /^minTurnSeconds = 60 /);
    assert.ok(a.stdout.includes(box.configFile));
    assert.equal(box.cli(["set", "quiet", "22:00-08:00"]).status, 0);
    assert.equal(box.cli(["set", "terminal", "osc777"]).status, 0);
    assert.equal(box.cli(["set", "desktop", "on"]).status, 0);
    assert.equal(box.cli(["set", "ntfy.topic", "my-topic"]).status, 0);
    assert.deepEqual(box.readConfig(), { minTurnSeconds: 60, quiet: "22:00-08:00", terminal: "osc777", desktop: true, ntfy: { topic: "my-topic" } });
  });
});

test("set keeps keys it does not know, and rewrites the file as indented JSON", async () => {
  await withBox((box) => {
    box.config({ somethingElse: { nested: [1, 2] } });
    assert.equal(box.cli(["set", "enabled", "off"]).status, 0);
    assert.deepEqual(box.readConfig(), { somethingElse: { nested: [1, 2] }, enabled: false });
    assert.ok(fs.readFileSync(box.configFile, "utf8").endsWith("}\n"));
  });
});

test("set creates the config file private to its owner where the OS has modes", { skip: IS_WIN }, async () => {
  await withBox((box) => {
    box.cli(["set", "slack.url", SLACK_URL]);
    assert.equal(fs.statSync(box.configFile).mode & 0o777, 0o600);
    fs.chmodSync(box.configFile, 0o644);
    box.cli(["set", "minTurnSeconds", "10"]);
    assert.equal(fs.statSync(box.configFile).mode & 0o777, 0o600, "a loosened file is tightened again on the next write");
  });
});

test("set never prints a secret in full", async () => {
  await withBox((box) => {
    const url = box.cli(["set", "slack.url", SLACK_URL]);
    assert.equal(url.status, 0);
    assert.ok(!url.out.includes("T0FAKE000") && !url.out.includes("B0FAKE000"), url.out);
    const token = box.cli(["set", "ntfy.token", "tk_abcdefghijklmnop"]);
    assert.ok(!token.out.includes("abcdefghij"), token.out);
    const topic = box.cli(["set", "ntfy.topic", "my-long-secret-topic"]);
    assert.ok(!topic.out.includes("secret"), topic.out);
    assert.deepEqual(box.readConfig(), { slack: { url: SLACK_URL }, ntfy: { token: "tk_abcdefghijklmnop", topic: "my-long-secret-topic" } }, "but they are stored");
  });
});

test("set ntfy.topic auto stores a random topic and prints it once, in full, so it can be subscribed to", async () => {
  await withBox((box) => {
    const r = box.cli(["set", "ntfy.topic", "auto"]);
    assert.equal(r.status, 0);
    const topic = box.readConfig().ntfy.topic;
    assert.match(topic, /^claude-[A-Za-z0-9_-]{12}$/);
    assert.ok(r.stdout.includes(topic), r.stdout);
    assert.match(r.stdout, /Subscribe to this exact name in the ntfy app/);
    assert.ok(!box.cli(["status"]).stdout.includes(topic), "status shows it masked");
  });
});

test("set rejects bad input with a reason, exit 1, and no change", async () => {
  await withBox((box) => {
    box.config({ minTurnSeconds: 12 });
    const before = fs.readFileSync(box.configFile, "utf8");
    for (const args of [
      ["set", "minTurnSeconds", "soon"], ["set", "terminal", "flash"], ["set", "quiet", "late"], ["set", "slack.url", "http://example.test/x"], ["set", "ntfy.topic", "bad topic"],
      ["set", "nonsense", "1"], ["set"], ["set", "desktop"], ["set", "desktop", "maybe"], ["set", "minTurnSeconds", "1", "2"],
    ]) {
      const r = box.cli(args);
      assert.equal(r.status, 1, args.join(" "));
      assert.equal(r.stdout, "", args.join(" "));
      assert.ok(r.stderr.length > 10, args.join(" "));
    }
    assert.equal(fs.readFileSync(box.configFile, "utf8"), before);
  });
});

test("set does not overwrite a notify.json that is not valid JSON", async () => {
  await withBox((box) => {
    box.config("{ my careful notes, not json");
    const r = box.cli(["set", "desktop", "on"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(fs.readFileSync(box.configFile, "utf8"), "{ my careful notes, not json");
  });
});

test("a file that cannot be written ends in one sentence and exit code 1, not a stack trace", async () => {
  await withBox((box) => {
    fs.mkdirSync(box.configFile); // a folder where notify.json should be: writing it must fail
    const r = box.cli(["set", "desktop", "on"]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /^set failed: /);
    assert.ok(!/\n\s+at /.test(r.stderr), "no stack trace by default:\n" + r.stderr);
    const debug = box.cli(["set", "desktop", "on"], { env: { CLAUDE_NOTIFY_DEBUG: "1" } });
    assert.match(debug.stderr, /\n\s+at /, "CLAUDE_NOTIFY_DEBUG=1 adds the stack");
  });
});

test("set command: the words of a command, a JSON list, and -- for arguments that start with -", async () => {
  await withBox((box) => {
    assert.equal(box.cli(["set", "command", "node", "ping.js"]).status, 0);
    assert.deepEqual(box.readConfig().command, ["node", "ping.js"]);
    assert.equal(box.cli(["set", "command", '["python","-u","x.py"]']).status, 0);
    assert.deepEqual(box.readConfig().command, ["python", "-u", "x.py"]);
    assert.equal(box.cli(["set", "command", "--", "node", "--no-warnings", "ping.js"]).status, 0);
    assert.deepEqual(box.readConfig().command, ["node", "--no-warnings", "ping.js"]);
    assert.equal(box.cli(["set", "command", "off"]).status, 0);
    assert.equal(box.readConfig().command, undefined);
  });
});

test("set <key> default removes the setting", async () => {
  await withBox((box) => {
    box.cli(["set", "minTurnSeconds", "5"]);
    box.cli(["set", "desktop", "on"]);
    box.cli(["set", "minTurnSeconds", "default"]);
    assert.deepEqual(box.readConfig(), { desktop: true });
  });
});

test("set --project writes .claude/notify.json at the git top level, and only for the four project keys", async () => {
  await withBox((box) => {
    const sub = path.join(box.proj, "src");
    fs.mkdirSync(sub);
    assert.equal(box.cli(["set", "--project", "name", "Billing API"], { cwd: sub }).status, 0);
    assert.equal(box.cli(["set", "--project", "minTurnSeconds", "10"], { cwd: sub }).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(box.proj, ".claude", "notify.json"), "utf8")), { name: "Billing API", minTurnSeconds: 10 });
    assert.ok(!fs.existsSync(box.configFile), "the user's settings are not touched");
    const refused = box.cli(["set", "--project", "slack.url", SLACK_URL]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /cannot be set per project/);
    assert.ok(!fs.readFileSync(path.join(box.proj, ".claude", "notify.json"), "utf8").includes("slack"));
  });
});

// --- mute and unmute -------------------------------------------------------------------------------

test("mute records the project in your settings; unmute removes it", async () => {
  await withBox((box) => {
    const m = box.cli(["mute"]);
    assert.equal(m.status, 0, m.out);
    assert.match(m.stdout, /Muted myproj/);
    assert.deepEqual(box.readConfig(), { mutedProjects: [box.proj] });
    assert.ok(!fs.existsSync(path.join(box.proj, ".claude")), "nothing is written into the project: a mute is personal");
    const u = box.cli(["unmute"]);
    assert.equal(u.status, 0);
    assert.match(u.stdout, /Unmuted myproj/);
    assert.deepEqual(box.readConfig(), {});
  });
});

test("mute from a subfolder mutes the project; muting twice lists it once; unmute when not muted is harmless", async () => {
  await withBox((box) => {
    const sub = path.join(box.proj, "packages", "web");
    fs.mkdirSync(sub, { recursive: true });
    box.cli(["mute"], { cwd: sub });
    box.cli(["mute"]);
    assert.deepEqual(box.readConfig().mutedProjects, [box.proj]);
    assert.equal(box.cli(["unmute"], { cwd: sub }).status, 0);
    assert.equal(box.cli(["unmute"]).status, 0);
    assert.equal(box.readConfig().mutedProjects, undefined);
  });
});

test("mute keeps the rest of your settings and other muted projects", async () => {
  await withBox((box) => {
    const other = path.join(box.root, "other");
    fs.mkdirSync(path.join(other, ".git"), { recursive: true });
    box.config({ desktop: true, mutedProjects: [other] });
    box.cli(["mute"]);
    assert.deepEqual(box.readConfig(), { desktop: true, mutedProjects: [other, box.proj] });
    box.cli(["unmute"]);
    assert.deepEqual(box.readConfig(), { desktop: true, mutedProjects: [other] });
  });
});

test("mute uses the project's name from .claude/notify.json in its message", async () => {
  await withBox((box) => {
    fs.mkdirSync(path.join(box.proj, ".claude"));
    fs.writeFileSync(path.join(box.proj, ".claude", "notify.json"), '{"name":"Billing API"}');
    assert.match(box.cli(["mute"]).stdout, /Muted Billing API/);
  });
});

test("mute does not overwrite a notify.json that is not valid JSON", async () => {
  await withBox((box) => {
    box.config("{ nope");
    assert.equal(box.cli(["mute"]).status, 1);
    assert.equal(fs.readFileSync(box.configFile, "utf8"), "{ nope");
  });
});

// --- status ----------------------------------------------------------------------------------------

test("status on a fresh install shows the defaults and what to do next", async () => {
  await withBox((box) => {
    const r = box.cli(["status"]);
    assert.equal(r.status, 0, r.out);
    for (const bit of [
      `claude-notify ${PKG.version}`, "not created yet: defaults apply", "No hooks are installed", "terminal      on (osc9)", "desktop       off", "ntfy          off",
      "Stop pings only after 30s of work", "scheduled and loop turns do not ping", "quiet hours   off", "one ping per channel per 20s per session", "never included", "not muted", "nothing logged yet",
    ]) assert.ok(r.stdout.includes(bit), `${bit}\n${r.stdout}`);
  });
});

test("status masks every secret", async () => {
  await withBox((box) => {
    box.config({
      ntfy: { topic: "my-long-secret-topic", token: "tk_abcdefghijklmnop" }, slack: { url: SLACK_URL },
      discord: { url: "https://disc" + "ord.com/api/webhooks/" + "123456789012345678/" + "y".repeat(40) },
      teams: { url: "https://prod-00.westus.logic." + "azure.com/workflows/" + "z".repeat(32) + "/triggers/manual/paths/invoke" },
    });
    const r = box.cli(["status"]);
    assert.equal(r.status, 0);
    for (const secret of ["my-long-secret-topic", "tk_abcdefghijklmnop", "T0FAKE000", "B0FAKE000", "xxxxxxxxxxxxxxxx", "123456789012345678", "yyyyyyyy", "zzzzzzzz", "workflows/"]) {
      assert.ok(!r.stdout.includes(secret), `${secret} leaked:\n${r.stdout}`);
    }
    assert.match(r.stdout, /ntfy\s+on: topic my…ic at https:\/\/ntfy\.sh, token tk…op/);
    assert.match(r.stdout, /slack\s+on: https:\/\/hooks\.slack\.com\/…xx/);
    assert.match(r.stdout, /discord\s+on: https:\/\/discord\.com\/…yy/);
    assert.match(r.stdout, /teams\s+on: https:\/\/prod-00\.westus\.logic\.azure\.com\/…ke \(card\)/);
  });
});

test("status masks secret-looking arguments of your command, and shows the rest as they are", async () => {
  await withBox((box) => {
    const key = "A".repeat(10) + "b".repeat(10) + "9".repeat(10); // looks like an API key
    box.config({ command: ["curl", "-s", "-d", "ping", "https://api.example.test/v1/hooks/abcdefghijkl", `--key=${key}`, key, "C:\\scripts\\ping-the-phone-and-the-watch.ps1", "/usr/local/bin/some-rather-long-script-name.sh"] });
    const r = box.cli(["status"]);
    assert.equal(r.status, 0, r.out);
    assert.ok(!r.stdout.includes("abcdefghijkl"), "the URL's path is masked");
    assert.ok(!r.stdout.includes(key), "the key-like argument is masked");
    const line = r.stdout.split("\n").find((l) => l.includes("command") && l.includes("curl"));
    assert.ok(line, r.stdout);
    for (const plain of ['"curl"', '"-s"', '"ping"', "C:\\\\scripts\\\\ping-the-phone-and-the-watch.ps1", "/usr/local/bin/some-rather-long-script-name.sh"]) assert.ok(line.includes(plain), plain + "\n" + line);
    assert.deepEqual(box.readConfig().command[5], `--key=${key}`, "the stored value is not changed");
  });
});

test("status shows the settings in force", async () => {
  await withBox((box) => {
    box.config({ minTurnSeconds: 90, notifyAutomated: true, quiet: "22:00-08:00", rateLimitSeconds: 0, includeLastMessage: true, includeLastMessageRemote: true, desktop: true, command: ["node", "x.js"], types: { agent_completed: true } });
    const r = box.cli(["status"]);
    for (const bit of ["Stop pings only after 90s", "scheduled and loop turns ping too", "22:00-08:00", "rate limit    off", "in local channels and remote ones", "desktop       on", 'command       on: ["node","x.js"]', "agent_completed on"]) {
      assert.ok(r.stdout.includes(bit), `${bit}\n${r.stdout}`);
    }
  });
});

test("status says whether this project is muted and counts all muted projects", async () => {
  await withBox((box) => {
    box.cli(["mute"]);
    const r = box.cli(["status"]);
    assert.match(r.stdout, /MUTED/);
    assert.match(r.stdout, /1 project in all/);
  });
});

test("status reports the problems it finds in a hand-edited settings file", async () => {
  await withBox((box) => {
    box.config({ slack: { url: "http://example.test/x" }, terminal: "flash", quiet: "late" });
    const r = box.cli(["status"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Problems/);
    for (const bit of ["slack.url is not a valid URL", 'terminal "flash"', 'quiet "late"']) assert.ok(r.stdout.includes(bit), bit);
    box.config("{ broken");
    assert.match(box.cli(["status"]).stdout, /is NOT valid JSON: defaults apply/);
  });
});

test("status shows what is installed, and flags the plugin and init together", async () => {
  await withBox((box) => {
    assert.equal(box.cli(["init"]).status, 0);
    let r = box.cli(["status"]);
    assert.match(r.stdout, /user\s+UserPromptSubmit, Stop, Notification, running .*notify[\\/]app[\\/]notify\.mjs/);
    assert.match(r.stdout, /this project\s+not installed/);
    assert.ok(!r.stdout.includes("No hooks are installed"));
    const settings = box.readSettings();
    settings.enabledPlugins = { "nudge@claude-code-notify": true };
    box.writeSettings(settings);
    r = box.cli(["status"]);
    assert.match(r.stdout, /plugin\s+nudge plugin is switched on/);
    assert.match(r.stdout, /both on: pings are sent twice/);
  });
});

test("status shows the latest decisions from the log", async () => {
  await withBox((box) => {
    box.hook("UserPromptSubmit", {}, { env: at(0) });
    box.hook("Stop", {}, { env: at(5) });
    box.hook("Stop", {}, { env: at(99) });
    const r = box.cli(["status"]);
    assert.match(r.stdout, /Stop myproj s-test-1 skip short-turn:5s/);
    assert.match(r.stdout, /Stop myproj s-test-1 skip no-start-time/);
  });
});

// --- test ------------------------------------------------------------------------------------------

test("test with only the terminal channel explains why nothing was written (output is not a terminal)", async () => {
  await withBox((box) => {
    const r = box.cli(["test"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /terminal \(osc9\): skipped, because output is not a terminal/);
    assert.equal(r.stdout.includes("\x1b"), false, "no escape sequence is written to a pipe");
  });
});

test("test sends one notification through every enabled web channel and reports each", async () => {
  const srv = await captureServer();
  await withBox(async (box) => {
    box.config({ ntfy: { topic: "t", url: srv.url }, slack: { url: `${srv.url}/slack` }, discord: { url: `${srv.url}/discord` }, teams: { url: `${srv.url}/teams` } });
    const r = await box.cliAsync(["test"]);
    assert.equal(r.status, 0, r.out);
    for (const name of ["ntfy", "slack", "discord", "teams"]) assert.match(r.stdout, new RegExp(`${name}: sent \\(HTTP 200\\)`));
    assert.deepEqual(srv.hits.map((h) => h.url).sort(), ["/discord", "/slack", "/t", "/teams"]);
    assert.ok(srv.hits.every((h) => h.body.includes("Test from claude-notify") && h.body.includes("myproj")));
  }).finally(() => srv.close());
});

test("test --channel sends through that channel only", async () => {
  const srv = await captureServer();
  await withBox(async (box) => {
    box.config({ ntfy: { topic: "t", url: srv.url }, slack: { url: `${srv.url}/slack` } });
    const r = await box.cliAsync(["test", "--channel", "slack"]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(srv.hits.map((h) => h.url), ["/slack"]);
    assert.ok(!r.stdout.includes("ntfy"));
  }).finally(() => srv.close());
});

test("test exits 1 and shows the reason when a channel fails, without leaking the URL", async () => {
  const srv = await captureServer(() => ({ status: 410, body: "gone" }));
  await withBox(async (box) => {
    box.config({ slack: { url: `${srv.url}/services/TSECRET/BSECRET/shhhhhh` } });
    const r = await box.cliAsync(["test", "--channel", "slack"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /slack: FAILED \(HTTP 410: gone\)/);
    assert.ok(!r.out.includes("shhhhhh"));
  }).finally(() => srv.close());
});

test("test --channel for a channel that is not set up says how to set it up", async () => {
  await withBox((box) => {
    const cases = [["ntfy", /claude-notify set ntfy\.topic/], ["slack", /set slack\.url/], ["discord", /set discord\.url/], ["teams", /set teams\.url/], ["command", /set command/]];
    for (const [channel, pattern] of cases) {
      const r = box.cli(["test", "--channel", channel]);
      assert.equal(r.status, 1, channel);
      assert.match(r.stderr, pattern, channel);
    }
    const unknown = box.cli(["test", "--channel", "pager"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown channel "pager"\. Channels: terminal, desktop, ntfy, slack, discord, teams, command/);
  });
});

test("test runs your command with the test message in its environment", async () => {
  await withBox(async (box) => {
    const out = path.join(box.root, "seen.txt");
    const script = path.join(box.root, "seen.js");
    fs.writeFileSync(script, `require("fs").writeFileSync(${JSON.stringify(out)}, process.env.CLAUDE_NOTIFY_TITLE + "|" + process.env.CLAUDE_NOTIFY_BODY);`);
    box.config({ command: [process.execPath, script] });
    const r = await box.cliAsync(["test", "--channel", "command"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /command: sent \(ok\)/);
    assert.match(fs.readFileSync(out, "utf8"), /^Claude Code\|Test from claude-notify .* in myproj$/);
  });
});

test("test refuses to run on a notify.json that is not valid JSON, instead of quietly testing the defaults", async () => {
  await withBox((box) => {
    box.config("{ nope");
    const r = box.cli(["test"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
  });
});

test("a --scope with no value is an error, not a quiet default", async () => {
  await withBox((box) => {
    for (const cmd of ["init", "uninstall"]) {
      const r = box.cli([cmd, "--scope"]);
      assert.equal(r.status, 1, cmd);
      assert.match(r.stderr, /--scope is user or project/);
    }
    assert.ok(!fs.existsSync(box.settingsFile));
  });
});

test("test with a muted project or quiet hours still sends: it is a test", async () => {
  const srv = await captureServer();
  await withBox(async (box) => {
    box.config({ quiet: "00:00-24:00", enabled: true, ntfy: { topic: "t", url: srv.url } });
    box.cli(["mute"]);
    const r = await box.cliAsync(["test", "--channel", "ntfy"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(srv.hits.length, 1);
  }).finally(() => srv.close());
});
