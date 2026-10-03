// The repository itself: package metadata, plugin files, house rules (no dependencies, no complete
// webhook URLs in source, same LICENSE and workflow as the other repos), and the README's structure.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SETTING_KEYS, VERSION } from "../src/config.mjs";
import { ROOT, chars } from "./helpers.mjs";

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const json = (...p) => JSON.parse(read(...p));
const pkg = json("package.json");
const README = read("README.md");

function listFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, out);
    else out.push(full);
  }
  return out;
}
const allFiles = listFiles(ROOT);
const sourceFiles = allFiles.filter((f) => /\.mjs$/.test(f));
const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");

// --- package.json ----------------------------------------------------------------------------------

test("package.json has the family's fields", () => {
  assert.equal(pkg.name, "claude-code-notify");
  assert.equal(pkg.version, "1.0.0");
  assert.equal(pkg.type, "module");
  assert.deepEqual(pkg.bin, { "claude-notify": "bin/claude-notify.mjs" });
  assert.deepEqual(pkg.engines, { node: ">=18" });
  assert.equal(pkg.scripts.test, "node --test", "no arguments: the same command works on every Node version");
  assert.equal(pkg.repository, "github:nrzz/claude-code-notify");
  assert.equal(pkg.homepage, "https://github.com/nrzz/claude-code-notify#readme");
  assert.equal(pkg.bugs, "https://github.com/nrzz/claude-code-notify/issues");
  assert.equal(pkg.author, "Naresh Prabu");
  assert.equal(pkg.license, "MIT");
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.includes("claude-code") && pkg.keywords.length >= 5);
  assert.ok(pkg.description.length > 40);
});

test("zero npm dependencies of any kind", () => {
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "bundledDependencies"]) {
    assert.equal(pkg[key], undefined, key);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, "package-lock.json")));
  assert.ok(!fs.existsSync(path.join(ROOT, "node_modules")));
});

test("every file a package.json entry points at exists, and what the package ships is listed in `files`", () => {
  assert.ok(fs.existsSync(path.join(ROOT, pkg.bin["claude-notify"])));
  for (const f of pkg.files) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  for (const needed of ["bin", "src", "hooks", ".claude-plugin", "notify.mjs", "README.md", "LICENSE"]) assert.ok(pkg.files.includes(needed), needed);
  assert.ok(!pkg.files.includes("test"), "tests are not shipped");
});

test("the version is the same in package.json, the code and the plugin manifest", () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(json(".claude-plugin", "plugin.json").version, pkg.version);
});

test("the shebang files start with a node shebang", () => {
  for (const f of ["notify.mjs", "bin/claude-notify.mjs"]) assert.equal(read(f).split("\n")[0], "#!/usr/bin/env node", f);
});

// --- the plugin ------------------------------------------------------------------------------------

test("plugin.json", () => {
  const p = json(".claude-plugin", "plugin.json");
  assert.equal(p.name, "notify");
  assert.deepEqual(p.author, { name: "Naresh Prabu" });
  assert.equal(p.homepage, "https://github.com/nrzz/claude-code-notify");
  assert.equal(p.repository, "https://github.com/nrzz/claude-code-notify");
  assert.equal(p.license, "MIT");
  assert.ok(Array.isArray(p.keywords) && p.keywords.length >= 3);
  assert.ok(p.description.includes("0 tokens"));
});

test("marketplace.json lists the notify plugin from the repository root", () => {
  const m = json(".claude-plugin", "marketplace.json");
  assert.equal(m.$schema, "https://anthropic.com/claude-code/marketplace.schema.json");
  assert.equal(m.name, "claude-code-notify");
  assert.deepEqual(m.owner, { name: "Naresh Prabu" });
  assert.equal(m.plugins.length, 1);
  assert.deepEqual(m.plugins[0], {
    name: "notify",
    description: m.plugins[0].description,
    author: { name: "Naresh Prabu" },
    category: "productivity",
    source: "./",
    homepage: "https://github.com/nrzz/claude-code-notify",
  });
});

test("hooks/hooks.json registers UserPromptSubmit, Stop and Notification in exec form with a 10 second timeout", () => {
  const h = json("hooks", "hooks.json");
  assert.deepEqual(Object.keys(h), ["hooks"]);
  assert.deepEqual(Object.keys(h.hooks), ["UserPromptSubmit", "Stop", "Notification"]);
  for (const [event, groups] of Object.entries(h.hooks)) {
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0], { hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/notify.mjs", event], timeout: 10 }] }, event);
  }
});

test("the plugin ships no skills, commands, agents or MCP servers (so it adds nothing to Claude's context)", () => {
  for (const dir of ["skills", "commands", "agents", "output-styles"]) assert.ok(!fs.existsSync(path.join(ROOT, dir)), dir);
  assert.ok(!fs.existsSync(path.join(ROOT, ".mcp.json")));
  const p = json(".claude-plugin", "plugin.json");
  for (const key of ["skills", "commands", "agents", "mcpServers", "outputStyles"]) assert.equal(p[key], undefined, key);
});

// --- house rules -----------------------------------------------------------------------------------

test("LICENSE is the family's MIT license", () => {
  const sibling = path.resolve(ROOT, "..", "claude-code-handover", "LICENSE");
  if (fs.existsSync(sibling)) assert.equal(read("LICENSE"), fs.readFileSync(sibling, "utf8"));
  assert.match(read("LICENSE"), /^MIT License\n\nCopyright \(c\) 2026 Naresh Prabu/);
});

test(".gitattributes and .gitignore", () => {
  assert.equal(read(".gitattributes"), "* text=auto eol=lf\n");
  const ignore = read(".gitignore").split("\n");
  for (const line of ["node_modules/", "*.log", ".DS_Store"]) assert.ok(ignore.includes(line), line);
});

test("the CI workflow is the family's: Ubuntu, Windows and macOS on Node 20, 22 and 24, running npm test", () => {
  const wf = read(".github", "workflows", "test.yml");
  const sibling = path.resolve(ROOT, "..", "claude-code-team-sync", ".github", "workflows", "test.yml");
  if (fs.existsSync(sibling)) assert.equal(wf, fs.readFileSync(sibling, "utf8"));
  assert.match(wf, /os: \[ubuntu-latest, windows-latest, macos-latest\]/);
  assert.match(wf, /node: \[20, 22, 24\]/);
  assert.match(wf, /- run: npm test/);
});

test("only Node's own modules and our own files are imported: no dependencies in code either", () => {
  let found = 0;
  for (const file of sourceFiles) {
    const code = fs.readFileSync(file, "utf8");
    const specs = [
      ...[...code.matchAll(/^(?:import|export)\s[^;]*?\sfrom\s+["']([^"']+)["']/gm)].map((m) => m[1]),
      ...[...code.matchAll(/^import\s+["']([^"']+)["']/gm)].map((m) => m[1]),
      ...[...code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
    ];
    for (const spec of specs) assert.ok(spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../"), `${rel(file)} imports ${spec}`);
    found += specs.length;
  }
  assert.ok(found > 40, `the scan found ${found} imports: it must be reading the files`);
});

test("no complete webhook URL or token appears in any file (GitHub push protection)", () => {
  const patterns = [
    /hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,}/,
    /discord(?:app)?\.com\/api\/webhooks\/\d{15,}\/[\w-]{30,}/,
    /logic\.azure\.com(?::\d+)?\/workflows\/[0-9a-f]{20,}/,
    /webhook\.office\.com\/webhookb2\/[0-9a-f-]{20,}/,
    /xox[abprs]-[A-Za-z0-9-]{10,}/,
    /\btk_[A-Za-z0-9]{20,}/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}/,
    /sk-ant-[A-Za-z0-9_-]{20,}/,
  ];
  for (const file of allFiles) {
    const text = fs.readFileSync(file, "utf8");
    for (const p of patterns) assert.ok(!p.test(text), `${rel(file)} matches ${p}`);
  }
});

test("nothing in the repository names this machine's user, or reaches for the real Claude config or transcripts", () => {
  // The user is read at run time, so no name is written into the repository itself.
  const me = os.userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const personal = new RegExp(`C:\\\\Users\\\\${me}|/Users/${me}|/home/${me}`, "i");
  for (const file of allFiles) {
    if (rel(file) === "test/repo.test.mjs") continue; // this file names the strings it looks for
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!personal.test(text), `${rel(file)} has a personal path`);
    assert.ok(!/\.claude\.json/.test(text), `${rel(file)} mentions ~/.claude.json`);
    if (rel(file).startsWith("src/") || rel(file) === "notify.mjs") {
      assert.ok(!/["'`]projects["'`]/.test(text), `${rel(file)} reaches into a projects folder`);
    }
  }
});

test("source files hold no invisible or look-alike characters (build them from code points instead)", () => {
  const bad = chars(0x00ad, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2066, 0x2067, 0x2068, 0x2069, 0xfeff);
  for (const file of [...sourceFiles, path.join(ROOT, "README.md"), path.join(ROOT, "package.json")]) {
    const text = fs.readFileSync(file, "utf8");
    for (const ch of text) assert.ok(!bad.includes(ch), `${rel(file)} contains U+${ch.codePointAt(0).toString(16)}`);
  }
});

test("nothing needs a newer Node than 18", () => {
  const newer = [/import\.meta\.(dirname|filename)/, /\.toSorted\(/, /\.toReversed\(/, /\.toSpliced\(/, /Object\.groupBy/, /Map\.groupBy/, /Promise\.withResolvers/, /Array\.fromAsync/, /\.isWellFormed\(/, /new Set\([^)]*\)\.(union|intersection|difference)\(/, /import\s+.*\s+with\s*\{/, /require\(\s*["'][^"']+\.mjs["']\s*\)/];
  for (const file of sourceFiles) {
    const code = fs.readFileSync(file, "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    for (const p of newer) assert.ok(!p.test(code), `${rel(file)} uses ${p}`);
  }
});

// --- README ----------------------------------------------------------------------------------------

test("README follows the family template", () => {
  const headings = [...README.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  const wanted = ["What it costs in tokens", "Install", "Use", "Channels", "Settings", "How it works", "What was verified, and how", "Files", "Contributing", "Part of the Claude Code toolkit", "License"];
  assert.deepEqual(headings, wanted);
  assert.ok(README.startsWith("# Claude Code notify\n"));
  assert.ok(README.includes("[![test](https://github.com/nrzz/claude-code-notify/actions/workflows/test.yml/badge.svg)](https://github.com/nrzz/claude-code-notify/actions/workflows/test.yml)"));
});

test("README intro is two sentences", () => {
  const intro = README.split("\n").slice(1).find((l) => l.trim() && !l.startsWith("[!["));
  const sentences = intro.split(/(?<=[.!?])\s+(?=[A-Z])/);
  assert.equal(sentences.length, 2, intro);
});

test("README token table says 0, and its install section has both routes", () => {
  const tokens = README.slice(README.indexOf("## What it costs in tokens"), README.indexOf("## Install"));
  const rows = tokens.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| ---") && !l.startsWith("| Part"));
  assert.ok(rows.length >= 4);
  for (const row of rows) assert.equal(row.split("|")[2].trim(), "0", row);
  assert.ok(README.includes("npx -y github:nrzz/claude-code-notify init"));
  assert.ok(README.includes("/plugin marketplace add nrzz/claude-code-notify"));
  assert.ok(README.includes("/plugin install notify@claude-code-notify"));
});

test("README has a subsection for every channel, each with set-up steps", () => {
  const channels = README.slice(README.indexOf("## Channels"), README.indexOf("## Settings"));
  const subs = [...channels.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(subs, ["Terminal (on by default)", "Desktop", "Phone: ntfy", "Slack", "Discord", "Microsoft Teams", "Your own command"]);
  for (const cmd of ["set terminal", "set desktop on", "set ntfy.topic", "set slack.url", "set discord.url", "set teams.url", "set command"]) assert.ok(channels.includes(cmd), cmd);
});

test("README documents every setting the command line accepts", () => {
  const settings = README.slice(README.indexOf("## Settings"), README.indexOf("## How it works"));
  for (const key of SETTING_KEYS) assert.ok(settings.includes(`\`${key}\``), `${key} is not in the Settings section`);
});

test("README has no emoji (a plain check mark in a code sample is fine)", () => {
  const emoji = /\p{Extended_Pictographic}/u;
  for (const ch of README) assert.ok(!emoji.test(ch), `emoji U+${ch.codePointAt(0).toString(16)}`);
});

test("README's honest-limits section names what was not verified", () => {
  const verified = README.slice(README.indexOf("## What was verified, and how"), README.indexOf("## Files"));
  assert.ok(verified.includes("Not verified:"));
  for (const word of ["terminal", "macOS and Linux", "real services", "live Claude Code session", "CI"]) assert.ok(verified.toLowerCase().includes(word.toLowerCase()), word);
});

test("README lists every source file", () => {
  const files = README.slice(README.indexOf("## Files"), README.indexOf("## License"));
  for (const file of sourceFiles.map(rel).filter((f) => f.startsWith("src/") || f === "notify.mjs" || f.startsWith("bin/"))) {
    assert.ok(files.includes(`\`${file}\``), `${file} is not in the Files table`);
  }
});
