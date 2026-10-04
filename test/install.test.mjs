// init and uninstall in throwaway config and project folders: the copy, the settings.json merge,
// the backup, dedupe on re-run, invalid JSON, both scopes, the plugin conflict, and a clean round trip.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { HOOK_EVENTS, PROJECT_SCRIPT, hookEntry, hooksFor, hooksIn, install, isOurHook, mergeHooks, pluginEnabled, readSettings, removeHooks, uninstall } from "../src/install.mjs";
import { ROOT, at, sandbox } from "./helpers.mjs";

// An io that records what was said.
function capture() {
  const out = [];
  const err = [];
  return { log: (s = "") => out.push(String(s)), error: (s = "") => err.push(String(s)), out, err, text: () => [...out, ...err].join("\n") };
}
const runInstall = (box, opts = {}) => {
  const io = capture();
  const code = install({ cwd: box.proj, env: box.env, ...opts }, io);
  return { code, io };
};
const runUninstall = (box, opts = {}) => {
  const io = capture();
  const code = uninstall({ cwd: box.proj, env: box.env, ...opts }, io);
  return { code, io };
};
const appScript = (box) => path.join(box.cfg, "notify", "app", "notify.mjs");
const backups = (dir) => fs.readdirSync(dir).filter((f) => f.startsWith("settings.json.bak-notify-"));
const listTree = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listTree(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join("/")])).sort();

// The user's own settings.json, with hooks of their own that init must leave alone.
const THEIRS = {
  permissions: { allow: ["Bash(npm test)"], deny: ["Read(.env)"] },
  env: { FOO: "bar" },
  statusLine: { type: "command", command: "node status.js" },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["guard.js"] }] }],
    Stop: [{ hooks: [{ type: "command", command: "node", args: ["their-stop.js"], timeout: 5 }] }],
    Notification: [{ matcher: "idle_prompt", hooks: [{ type: "command", command: "say done" }] }],
  },
};

// --- user scope ------------------------------------------------------------------------------------

test("init (user scope) copies notify.mjs and src/ into <config>/notify/app and registers three exec-form hooks", () => {
  const box = sandbox();
  try {
    const { code, io } = runInstall(box);
    assert.equal(code, 0, io.text());
    assert.ok(fs.existsSync(appScript(box)));
    assert.deepEqual(listTree(path.join(box.cfg, "notify", "app", "src")), listTree(path.join(ROOT, "src")));
    assert.equal(fs.readFileSync(appScript(box), "utf8"), fs.readFileSync(path.join(ROOT, "notify.mjs"), "utf8"));
    const settings = box.readSettings();
    assert.deepEqual(Object.keys(settings), ["hooks"]);
    assert.deepEqual(Object.keys(settings.hooks), ["UserPromptSubmit", "Stop", "Notification"]);
    for (const event of HOOK_EVENTS) {
      assert.deepEqual(settings.hooks[event], [{ hooks: [{ type: "command", command: "node", args: [appScript(box), event], timeout: 10 }] }], event);
    }
    assert.ok(path.isAbsolute(settings.hooks.Stop[0].hooks[0].args[0]));
    assert.match(io.text(), /the installed copy starts and loads every module/);
  } finally {
    box.cleanup();
  }
});

test("the registered hook command works as Claude Code will run it", () => {
  const box = sandbox();
  try {
    assert.equal(runInstall(box).code, 0);
    const [script, ...rest] = box.readSettings().hooks.UserPromptSubmit[0].hooks[0].args;
    assert.equal(rest[0], "UserPromptSubmit");
    const run = (event, now) => spawnSync(process.execPath, [script, event], {
      input: JSON.stringify({ session_id: "inst-1", cwd: box.proj }), env: { ...box.env, ...at(now) }, encoding: "utf8",
    });
    assert.equal(run("UserPromptSubmit", 0).stdout, "");
    const stop = run("Stop", 125);
    assert.equal(stop.status, 0);
    assert.equal(stop.stdout, JSON.stringify({ terminalSequence: "\x1b]9;Claude Code - Finished in myproj after 2m 5s\x07" }));
  } finally {
    box.cleanup();
  }
});

test("init writes nothing outside the config folder (HOME stays untouched)", () => {
  const box = sandbox();
  try {
    assert.equal(runInstall(box).code, 0);
    assert.deepEqual(fs.readdirSync(box.home), [], "no ~/.claude was created in the sandbox home");
    assert.ok(!fs.existsSync(path.join(box.proj, ".claude")), "no project files for the user scope");
  } finally {
    box.cleanup();
  }
});

test("init with no settings.json writes none to back up", () => {
  const box = sandbox();
  try {
    runInstall(box);
    assert.deepEqual(backups(box.cfg), []);
  } finally {
    box.cleanup();
  }
});

test("init keeps every other setting and hook, and backs settings.json up first", () => {
  const box = sandbox();
  try {
    box.writeSettings(THEIRS);
    const before = fs.readFileSync(box.settingsFile, "utf8");
    const { code, io } = runInstall(box);
    assert.equal(code, 0, io.text());
    const after = box.readSettings();
    assert.deepEqual(after.permissions, THEIRS.permissions);
    assert.deepEqual(after.env, THEIRS.env);
    assert.deepEqual(after.statusLine, THEIRS.statusLine);
    assert.deepEqual(after.hooks.PreToolUse, THEIRS.hooks.PreToolUse);
    assert.deepEqual(after.hooks.Stop[0], THEIRS.hooks.Stop[0], "their Stop hook is first and unchanged");
    assert.deepEqual(after.hooks.Notification[0], THEIRS.hooks.Notification[0], "their Notification group (with its matcher) is unchanged");
    for (const event of HOOK_EVENTS) {
      const ours = after.hooks[event].flatMap((g) => g.hooks).filter(isOurHook);
      assert.equal(ours.length, 1, event);
    }
    const found = backups(box.cfg);
    assert.equal(found.length, 1);
    assert.match(found[0], /^settings\.json\.bak-notify-\d{8}-\d{6}$/);
    assert.equal(fs.readFileSync(path.join(box.cfg, found[0]), "utf8"), before, "the backup is the file as it was, byte for byte");
    assert.ok(io.text().includes(found[0]), "the backup's name is printed");
  } finally {
    box.cleanup();
  }
});

test("running init again changes nothing: no new backup, no second set of hooks", () => {
  const box = sandbox();
  try {
    box.writeSettings(THEIRS);
    runInstall(box);
    const settled = fs.readFileSync(box.settingsFile, "utf8");
    const nBackups = backups(box.cfg).length;
    const again = runInstall(box);
    assert.equal(again.code, 0);
    assert.equal(fs.readFileSync(box.settingsFile, "utf8"), settled);
    assert.equal(backups(box.cfg).length, nBackups);
    assert.match(again.io.text(), /already has the three hooks/);
    const twice = box.readSettings();
    for (const event of HOOK_EVENTS) assert.equal(twice.hooks[event].flatMap((g) => g.hooks).filter(isOurHook).length, 1, event);
  } finally {
    box.cleanup();
  }
});

test("init replaces stale and duplicated entries of its own, and nobody else's", () => {
  const box = sandbox();
  try {
    const stale = (dir, event) => ({ type: "command", command: "node", args: [path.join(dir, "notify", "app", "notify.mjs"), event], timeout: 10 });
    box.writeSettings({
      hooks: {
        UserPromptSubmit: [{ hooks: [stale("/old/home/.claude", "UserPromptSubmit")] }, { hooks: [stale("C:\\Users\\old\\.claude", "UserPromptSubmit")] }],
        Stop: [{ hooks: [{ type: "command", command: "node", args: ["their.js"] }, stale("/old/.claude", "Stop")] }],
        SessionEnd: [{ hooks: [stale("/old/.claude", "SessionEnd")] }],
      },
    });
    assert.equal(runInstall(box).code, 0);
    const s = box.readSettings();
    assert.equal(s.hooks.UserPromptSubmit.length, 1);
    assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].args[0], appScript(box));
    assert.deepEqual(s.hooks.Stop[0].hooks, [{ type: "command", command: "node", args: ["their.js"] }], "their hook in a shared group is kept");
    assert.equal(s.hooks.Stop[1].hooks[0].args[0], appScript(box));
    assert.deepEqual(s.hooks.SessionEnd, [{ hooks: [stale("/old/.claude", "SessionEnd")] }], "an old entry under another event is left for uninstall, init only manages its own three");
  } finally {
    box.cleanup();
  }
});

test("a settings.json that is not valid JSON is left alone: snippet printed, exit 1", () => {
  for (const bad of ["{ \"hooks\": ", "this is not json", "[1, 2, 3]", "null", "\"text\""]) {
    const box = sandbox();
    try {
      box.writeSettings(bad);
      const { code, io } = runInstall(box);
      assert.equal(code, 1, bad);
      assert.equal(fs.readFileSync(box.settingsFile, "utf8"), bad, "the file is untouched");
      assert.deepEqual(backups(box.cfg), [], "no backup of a file that was not changed");
      const said = io.text();
      assert.match(said, /not valid JSON/);
      assert.ok(said.includes('"UserPromptSubmit"') && said.includes('"Notification"') && said.includes("notify.mjs"), "the hooks to add by hand are printed");
      assert.ok(fs.existsSync(appScript(box)), "the files the snippet points at are in place");
    } finally {
      box.cleanup();
    }
  }
});

test("a settings.json with a byte order mark, and an empty one, are both fine", () => {
  const box = sandbox();
  try {
    fs.writeFileSync(box.settingsFile, String.fromCharCode(0xfeff) + JSON.stringify({ env: { A: "1" } }));
    assert.equal(runInstall(box).code, 0);
    assert.deepEqual(box.readSettings().env, { A: "1" });
    fs.writeFileSync(box.settingsFile, "");
    assert.equal(runInstall(box).code, 0);
    assert.equal(Object.keys(box.readSettings().hooks).length, 3);
  } finally {
    box.cleanup();
  }
});

test("settings.json is written as indented JSON with a final newline", () => {
  const box = sandbox();
  try {
    runInstall(box);
    const text = fs.readFileSync(box.settingsFile, "utf8");
    assert.ok(text.endsWith("}\n"));
    assert.ok(text.startsWith('{\n  "hooks": {'));
  } finally {
    box.cleanup();
  }
});

test("a settings.json that is a symbolic link (kept in a dotfiles repo) stays a link: the file it points to is what changes", (t) => {
  const box = sandbox();
  try {
    const real = path.join(box.root, "dotfiles", "settings.json");
    fs.mkdirSync(path.dirname(real));
    fs.writeFileSync(real, JSON.stringify(THEIRS, null, 2) + "\n");
    try {
      fs.symlinkSync(real, box.settingsFile, "file");
    } catch (e) {
      t.skip(`symbolic links are not available here (${e.code})`);
      return;
    }
    assert.equal(runInstall(box).code, 0);
    assert.ok(fs.lstatSync(box.settingsFile).isSymbolicLink(), "still a link after init");
    const viaTarget = JSON.parse(fs.readFileSync(real, "utf8"));
    assert.equal(viaTarget.hooks.Stop.flatMap((g) => g.hooks).filter(isOurHook).length, 1, "the real file has the hooks");
    assert.deepEqual(viaTarget.permissions, THEIRS.permissions);
    assert.equal(runUninstall(box).code, 0);
    assert.ok(fs.lstatSync(box.settingsFile).isSymbolicLink(), "still a link after uninstall");
    assert.deepEqual(JSON.parse(fs.readFileSync(real, "utf8")), THEIRS);
  } finally {
    box.cleanup();
  }
});

test("--dry-run writes nothing", () => {
  const box = sandbox();
  try {
    box.writeSettings(THEIRS);
    const before = fs.readFileSync(box.settingsFile, "utf8");
    const { code, io } = runInstall(box, { dryRun: true });
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(box.settingsFile, "utf8"), before);
    assert.deepEqual(fs.readdirSync(box.cfg), ["settings.json"]);
    assert.match(io.text(), /would copy notify\.mjs and src\//);
    assert.match(io.text(), /would back up/);
  } finally {
    box.cleanup();
  }
});

test("init refuses an unknown scope and the CLI reports it", () => {
  const box = sandbox();
  try {
    const r = box.cli(["init", "--scope", "everywhere"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--scope is user or project/);
    assert.ok(!fs.existsSync(box.settingsFile));
  } finally {
    box.cleanup();
  }
});

// --- the plugin and init together -------------------------------------------------------------------

test("init stops when the notify plugin is switched on, since every ping would arrive twice", () => {
  const box = sandbox();
  try {
    const original = { enabledPlugins: { "nudge@claude-code-notify": true, "other@market": true } };
    box.writeSettings(original);
    const before = fs.readFileSync(box.settingsFile, "utf8");
    const { code, io } = runInstall(box);
    assert.equal(code, 1);
    assert.match(io.text(), /plugin \(nudge\) is switched on/);
    assert.equal(fs.readFileSync(box.settingsFile, "utf8"), before);
    assert.ok(!fs.existsSync(appScript(box)), "nothing was copied");
  } finally {
    box.cleanup();
  }
});

test("init --force installs anyway, and a plugin that is switched off is no obstacle", () => {
  const box = sandbox();
  try {
    box.writeSettings({ enabledPlugins: { "nudge@claude-code-notify": false } });
    assert.equal(runInstall(box).code, 0);
    box.writeSettings({ enabledPlugins: { "nudge@claude-code-notify": true } });
    assert.equal(runInstall(box).code, 1);
    assert.equal(runInstall(box, { force: true }).code, 0);
    assert.equal(box.readSettings().hooks.Stop.length, 1);
  } finally {
    box.cleanup();
  }
});

test("pluginEnabled", () => {
  assert.equal(pluginEnabled({ enabledPlugins: { "nudge@claude-code-notify": true } }), true);
  assert.equal(pluginEnabled({ enabledPlugins: { "nudge@claude-code-toolkit": true } }), true);
  assert.equal(pluginEnabled({ enabledPlugins: { "nudge@elsewhere": true } }), true);
  assert.equal(pluginEnabled({ enabledPlugins: { "nudge@claude-code-notify": false } }), false);
  // The name until 1.0.1 still counts from this tool's own marketplaces, and only from them.
  assert.equal(pluginEnabled({ enabledPlugins: { "notify@claude-code-notify": true } }), true);
  assert.equal(pluginEnabled({ enabledPlugins: { "notify@claude-code-toolkit": true } }), true);
  assert.equal(pluginEnabled({ enabledPlugins: { "notify@elsewhere": true } }), false);
  assert.equal(pluginEnabled({ enabledPlugins: { "glow@claude-code-glow": true } }), false);
  assert.equal(pluginEnabled({ enabledPlugins: { "notifier@x": true } }), false);
  assert.equal(pluginEnabled({}), false);
  assert.equal(pluginEnabled(null), false);
});

// --- uninstall -------------------------------------------------------------------------------------

test("uninstall removes exactly what init added: the settings round trip is exact", () => {
  const box = sandbox();
  try {
    box.writeSettings(THEIRS);
    runInstall(box);
    const { code, io } = runUninstall(box);
    assert.equal(code, 0, io.text());
    assert.deepEqual(box.readSettings(), THEIRS);
    assert.ok(!fs.existsSync(path.join(box.cfg, "notify", "app")), "the installed copy is gone");
    assert.ok(!fs.existsSync(path.join(box.cfg, "notify")), "and so is the folder init made for it, when nothing else is in it");
    assert.ok(!io.text().includes("Kept your settings"), "nothing was kept, so it does not say so");
    assert.deepEqual(fs.readdirSync(box.cfg).filter((f) => !f.startsWith("settings.json")), [], "nothing else is left in the config folder");
    assert.equal(backups(box.cfg).length, 2, "one backup from init, one from uninstall");
  } finally {
    box.cleanup();
  }
});

test("uninstall from a file that had no hooks leaves no hooks key behind", () => {
  const box = sandbox();
  try {
    const original = { permissions: { allow: ["Bash(ls)"] } };
    box.writeSettings(original);
    runInstall(box);
    runUninstall(box);
    assert.deepEqual(box.readSettings(), original);
  } finally {
    box.cleanup();
  }
});

test("uninstall keeps your notify.json, state and log, and --purge deletes them", () => {
  const box = sandbox();
  try {
    runInstall(box);
    box.config({ ntfy: { topic: "my-topic" } });
    box.hook("UserPromptSubmit", {}, { env: at(0) });
    assert.ok(fs.existsSync(box.path("notify", "state")));
    const plain = runUninstall(box);
    assert.equal(plain.code, 0);
    assert.ok(fs.existsSync(box.configFile));
    assert.ok(fs.existsSync(box.path("notify", "state")));
    assert.match(plain.io.text(), /Kept your settings/);
    const purged = runUninstall(box, { purge: true });
    assert.equal(purged.code, 0);
    assert.ok(!fs.existsSync(box.configFile));
    assert.ok(!fs.existsSync(box.path("notify")));
  } finally {
    box.cleanup();
  }
});

test("uninstall --dry-run changes nothing", () => {
  const box = sandbox();
  try {
    runInstall(box);
    const before = [fs.readFileSync(box.settingsFile, "utf8"), listTree(box.cfg).join("|")];
    const { code, io } = runUninstall(box, { dryRun: true, purge: true });
    assert.equal(code, 0);
    assert.deepEqual([fs.readFileSync(box.settingsFile, "utf8"), listTree(box.cfg).join("|")], before);
    assert.match(io.text(), /would back up/);
    assert.match(io.text(), /would delete/);
  } finally {
    box.cleanup();
  }
});

test("uninstall when nothing is installed says so", () => {
  const box = sandbox();
  try {
    const { code, io } = runUninstall(box);
    assert.equal(code, 0);
    assert.match(io.text(), /nothing to remove/);
    assert.ok(!fs.existsSync(box.settingsFile));
  } finally {
    box.cleanup();
  }
});

test("uninstall with an invalid settings.json changes nothing and exits 1", () => {
  const box = sandbox();
  try {
    runInstall(box);
    fs.writeFileSync(box.settingsFile, "{ broken");
    const { code } = runUninstall(box);
    assert.equal(code, 1);
    assert.equal(fs.readFileSync(box.settingsFile, "utf8"), "{ broken");
    assert.ok(fs.existsSync(appScript(box)));
  } finally {
    box.cleanup();
  }
});

// --- project scope ---------------------------------------------------------------------------------

test("init --scope project copies into .claude/notify and registers ${CLAUDE_PROJECT_DIR} paths", () => {
  const box = sandbox();
  try {
    const { code, io } = runInstall(box, { scope: "project" });
    assert.equal(code, 0, io.text());
    assert.ok(fs.existsSync(path.join(box.proj, ".claude", "notify", "notify.mjs")));
    assert.deepEqual(listTree(path.join(box.proj, ".claude", "notify", "src")), listTree(path.join(ROOT, "src")));
    const settings = JSON.parse(fs.readFileSync(path.join(box.proj, ".claude", "settings.json"), "utf8"));
    for (const event of HOOK_EVENTS) {
      assert.deepEqual(settings.hooks[event], [{ hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/.claude/notify/notify.mjs", event], timeout: 10 }] }], event);
    }
    assert.equal(PROJECT_SCRIPT, "${CLAUDE_PROJECT_DIR}/.claude/notify/notify.mjs");
    assert.ok(!fs.existsSync(box.settingsFile), "the user's settings.json is not touched");
    assert.ok(!fs.existsSync(path.join(box.cfg, "notify")), "nor is the user's notify folder");
    // the vendored copy runs, and is also a command line
    const r = spawnSync(process.execPath, [path.join(box.proj, ".claude", "notify", "notify.mjs"), "--version"], { encoding: "utf8", env: box.env });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "1.0.1");
  } finally {
    box.cleanup();
  }
});

test("project scope from a subfolder installs at the git top level", () => {
  const box = sandbox();
  try {
    const sub = path.join(box.proj, "packages", "web");
    fs.mkdirSync(sub, { recursive: true });
    assert.equal(install({ scope: "project", cwd: sub, env: box.env }, capture()), 0);
    assert.ok(fs.existsSync(path.join(box.proj, ".claude", "notify", "notify.mjs")));
    assert.ok(!fs.existsSync(path.join(sub, ".claude")));
  } finally {
    box.cleanup();
  }
});

test("project scope merges into an existing .claude/settings.json and backs it up", () => {
  const box = sandbox();
  try {
    fs.mkdirSync(path.join(box.proj, ".claude"));
    const file = path.join(box.proj, ".claude", "settings.json");
    fs.writeFileSync(file, JSON.stringify(THEIRS, null, 2) + "\n");
    assert.equal(runInstall(box, { scope: "project" }).code, 0);
    assert.deepEqual(backups(path.join(box.proj, ".claude")).length, 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")).permissions, THEIRS.permissions);
  } finally {
    box.cleanup();
  }
});

test("uninstall --scope project removes its hooks and its copy but keeps other files in the folder", () => {
  const box = sandbox();
  try {
    fs.mkdirSync(path.join(box.proj, ".claude"));
    const file = path.join(box.proj, ".claude", "settings.json");
    fs.writeFileSync(file, JSON.stringify(THEIRS, null, 2) + "\n");
    runInstall(box, { scope: "project" });
    fs.writeFileSync(path.join(box.proj, ".claude", "notify", "keep-me.txt"), "mine");
    fs.writeFileSync(path.join(box.proj, ".claude", "notify.json"), '{"name":"X"}');
    const { code } = runUninstall(box, { scope: "project" });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), THEIRS);
    assert.ok(!fs.existsSync(path.join(box.proj, ".claude", "notify", "notify.mjs")));
    assert.ok(!fs.existsSync(path.join(box.proj, ".claude", "notify", "src")));
    assert.ok(fs.existsSync(path.join(box.proj, ".claude", "notify", "keep-me.txt")), "files init did not write are kept");
    assert.ok(fs.existsSync(path.join(box.proj, ".claude", "notify.json")), "the project's own notify.json is kept");
  } finally {
    box.cleanup();
  }
});

test("uninstall of an empty project folder removes the folder init made", () => {
  const box = sandbox();
  try {
    runInstall(box, { scope: "project" });
    runUninstall(box, { scope: "project" });
    assert.ok(!fs.existsSync(path.join(box.proj, ".claude", "notify")));
  } finally {
    box.cleanup();
  }
});

test("a user-scope uninstall points at project hooks it cannot remove", () => {
  const box = sandbox();
  try {
    runInstall(box, { scope: "project" });
    const { code, io } = runUninstall(box);
    assert.equal(code, 0);
    assert.match(io.text(), /This project has the hooks: run claude-notify uninstall --scope project/);
  } finally {
    box.cleanup();
  }
});

// --- recognising our own hooks -----------------------------------------------------------------------

test("isOurHook recognises the user copy, the project copy and a checkout, on either kind of slash", () => {
  const h = (script) => ({ type: "command", command: "node", args: [script, "Stop"] });
  assert.equal(isOurHook(h("/home/me/.claude/notify/app/notify.mjs")), true);
  assert.equal(isOurHook(h("C:\\Users\\me\\.claude\\notify\\app\\notify.mjs")), true);
  assert.equal(isOurHook(h("${CLAUDE_PROJECT_DIR}/.claude/notify/notify.mjs")), true);
  assert.equal(isOurHook(h("D:\\Projects\\claude-code-notify\\notify.mjs")), true);
  assert.equal(isOurHook({ type: "command", command: 'node "/home/me/.claude/notify/app/notify.mjs" Stop' }), true, "a shell-form command too");
});

test("isOurHook does not claim anyone else's hooks", () => {
  const h = (script) => ({ type: "command", command: "node", args: [script] });
  for (const other of ["/x/notify.mjs", "/x/my-notify.js", "C:\\tools\\notify\\notify.mjs", "/x/claude-team.mjs", "/x/.claude/team-sync/claude-team.mjs", "notify-send"]) {
    assert.equal(isOurHook(h(other)), false, other);
  }
  assert.equal(isOurHook({ type: "command", command: "say done" }), false);
  assert.equal(isOurHook({ type: "http", url: "https://example.test/notify/app/notify.mjs" }), false);
  assert.equal(isOurHook(null), false);
  assert.equal(isOurHook("notify.mjs"), false);
});

test("mergeHooks does not modify what it is given, and reports whether anything changed", () => {
  const input = JSON.parse(JSON.stringify(THEIRS));
  const merged = mergeHooks(input, "/a/notify/app/notify.mjs");
  assert.deepEqual(input, THEIRS);
  assert.equal(merged.changed, true);
  assert.equal(mergeHooks(merged.settings, "/a/notify/app/notify.mjs").changed, false);
  assert.equal(mergeHooks(merged.settings, "/b/notify/app/notify.mjs").changed, true, "a new path replaces the old one");
  assert.deepEqual(mergeHooks(undefined, "/a/notify/app/notify.mjs").settings, { hooks: hooksFor("/a/notify/app/notify.mjs") });
});

test("mergeHooks leaves groups of an unknown shape alone", () => {
  const odd = { hooks: { Stop: ["a string", { matcher: "x" }, { hooks: "nope" }, null] } };
  const merged = mergeHooks(odd, "/a/notify/app/notify.mjs").settings;
  assert.deepEqual(merged.hooks.Stop.slice(0, 4), odd.hooks.Stop);
  assert.equal(merged.hooks.Stop.length, 5);
});

test("removeHooks counts what it removes and drops what that leaves empty", () => {
  const withOurs = mergeHooks(THEIRS, "/a/notify/app/notify.mjs").settings;
  const r = removeHooks(withOurs);
  assert.equal(r.removed, 3);
  assert.deepEqual(r.settings, THEIRS);
  assert.deepEqual(removeHooks({ hooks: hooksFor("/a/notify/app/notify.mjs") }), { settings: {}, removed: 3 });
  assert.deepEqual(removeHooks({ a: 1 }), { settings: { a: 1 }, removed: 0 });
  assert.deepEqual(removeHooks(null), { settings: {}, removed: 0 });
});

test("hooksIn lists the events that carry our hook and the script they run", () => {
  assert.deepEqual(hooksIn({}), { events: [], scripts: [] });
  const s = mergeHooks(THEIRS, "/a/notify/app/notify.mjs").settings;
  assert.deepEqual(hooksIn(s), { events: ["Stop", "Notification", "UserPromptSubmit"], scripts: ["/a/notify/app/notify.mjs"] });
  assert.deepEqual(hooksIn(THEIRS).events, []);
});

test("hookEntry is exec form with a 10 second timeout", () => {
  assert.deepEqual(hookEntry("/x/notify.mjs", "Stop"), { type: "command", command: "node", args: ["/x/notify.mjs", "Stop"], timeout: 10 });
});

test("readSettings: missing, ok, invalid", () => {
  const box = sandbox();
  try {
    assert.deepEqual(readSettings(box.settingsFile), { status: "missing", data: {}, raw: null });
    box.writeSettings({ a: 1 });
    assert.equal(readSettings(box.settingsFile).status, "ok");
    box.writeSettings("{");
    assert.equal(readSettings(box.settingsFile).status, "invalid");
    assert.equal(readSettings(box.cfg).status, "invalid", "a folder where a file should be is not readable settings");
  } finally {
    box.cleanup();
  }
});
