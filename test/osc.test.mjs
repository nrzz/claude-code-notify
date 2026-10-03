// The terminal channel: exact bytes, and the allowlist Claude Code applies to a hook's terminalSequence.
import test from "node:test";
import assert from "node:assert/strict";
import { BEL, MAX_SEQUENCE_BYTES, osc777, osc9, oscTitle, terminalSequence } from "../src/osc.mjs";
import { chars, claudeAccepts, parseAllowlisted } from "./helpers.mjs";

const ESC = "\x1b";
const msg = (body, extra = {}) => ({ title: "Claude Code", body, detail: "", ...extra });

// --- the validator itself (it must reject what Claude Code rejects, or the tests below prove nothing) ---

test("the allowlist check accepts BEL and notification or title OSCs ended by BEL or ESC \\", () => {
  assert.ok(claudeAccepts("\x07"));
  assert.ok(claudeAccepts("\x07\x07"));
  for (const ps of [0, 1, 2, 9, 99, 777]) assert.ok(claudeAccepts(`${ESC}]${ps};text${BEL}`), `OSC ${ps}`);
  assert.ok(claudeAccepts(`${ESC}]9;text${ESC}\\`));
  assert.ok(claudeAccepts(`${ESC}]9;one${BEL}${ESC}]2;two${BEL}${BEL}`));
  assert.ok(claudeAccepts(`${ESC}]9;4;1;50${BEL}`), "the 9;4 progress form is allowed");
});

test("the allowlist check rejects everything else", () => {
  for (const bad of [
    "", "plain text", `${ESC}[31mred${ESC}[0m`, `${ESC}]52;c;ZXZpbA==${BEL}`, `${ESC}]8;;http://x${BEL}`, `${ESC}]7;file:///x${BEL}`,
    `${ESC}]9;no terminator`, `${ESC}]9;text${ESC}x`, `${ESC}]9;te${ESC}[1mxt${BEL}`, `${ESC}]x;text${BEL}`, `${ESC}]${BEL}`,
    `${ESC}]9;3 new messages${BEL}`, `${ESC}]9;-3 new messages${BEL}`, `${ESC}]9;  +7 files${BEL}`, `${ESC}]9;4;9${BEL}`,
    `${ESC}]9;${chars(0x663)} files${BEL}`, `${ESC}]9;${chars(0xff13)} files${BEL}`, `${ESC}]9;${chars(0x200b)}5${BEL}`,
    `${ESC}]2;ok${BEL}trailing text`, "x".repeat(4097), `${ESC}]9;${"a".repeat(4100)}${BEL}`,
  ]) {
    assert.equal(claudeAccepts(bad), false, JSON.stringify(bad).slice(0, 60));
  }
});

// --- exact bytes -----------------------------------------------------------------------------------

test("osc9: ESC ] 9 ; text BEL, exactly", () => {
  assert.equal(osc9("Claude Code - Finished in api after 2m 13s"), "\x1b]9;Claude Code - Finished in api after 2m 13s\x07");
});

test("osc777: ESC ] 777 ; notify ; title ; body BEL, exactly", () => {
  assert.equal(osc777("Claude Code", "Finished in api after 2m 13s"), "\x1b]777;notify;Claude Code;Finished in api after 2m 13s\x07");
});

test("oscTitle: ESC ] 2 ; text BEL, exactly", () => {
  assert.equal(oscTitle("✓ Claude: api"), "\x1b]2;✓ Claude: api\x07");
});

test("bell is a lone BEL", () => {
  assert.equal(terminalSequence("bell", msg("x")), "\x07");
});

// --- terminalSequence by mode ----------------------------------------------------------------------

test("terminalSequence osc9 puts the title and the message in one line", () => {
  assert.equal(terminalSequence("osc9", msg("Finished in api after 2m 13s")), "\x1b]9;Claude Code - Finished in api after 2m 13s\x07");
});

test("terminalSequence osc9 and osc777 flatten the last-reply detail into the same line", () => {
  const m = msg("Finished in api", { detail: "Fixed the bug." });
  assert.equal(terminalSequence("osc9", m), "\x1b]9;Claude Code - Finished in api | Fixed the bug.\x07");
  assert.equal(terminalSequence("osc777", m), "\x1b]777;notify;Claude Code;Finished in api | Fixed the bug.\x07");
});

test("terminalSequence title mode: a check mark when finished, an exclamation mark when Claude needs you", () => {
  assert.equal(terminalSequence("title", msg("x"), { kind: "finished", project: "api" }), "\x1b]2;✓ Claude: api\x07");
  assert.equal(terminalSequence("title", msg("x"), { kind: "attention", project: "api" }), "\x1b]2;! Claude: api\x07");
  assert.equal(terminalSequence("title", msg("x", { title: "Build bot" }), { kind: "finished", project: "api" }), "\x1b]2;✓ Build bot: api\x07");
});

test("terminalSequence is empty for the off mode and an unknown mode", () => {
  assert.equal(terminalSequence("off", msg("x")), "");
  assert.equal(terminalSequence("flash", msg("x")), "");
  assert.equal(osc9(""), "");
  assert.equal(osc9("   \n  "), "");
  assert.equal(oscTitle(""), "");
  assert.equal(osc777("", ""), "");
});

// --- the OSC 9 digit rule --------------------------------------------------------------------------

test("an OSC 9 body never starts with a digit: it gets a Claude: prefix instead", () => {
  assert.equal(osc9("3d-viewer: Claude needs your permission"), "\x1b]9;Claude: 3d-viewer: Claude needs your permission\x07");
  assert.equal(osc9("4;1;50"), "\x1b]9;Claude: 4;1;50\x07", "text that looks like the progress form is not sent as one");
  assert.equal(osc9("-3 files changed"), "\x1b]9;Claude: -3 files changed\x07");
  assert.equal(osc9("+1 done"), "\x1b]9;Claude: +1 done\x07");
});

test("the digit rule covers digits of every script, and blanks and zero-width characters before them", () => {
  for (const digit of [chars(0x663), chars(0xff13), chars(0x0967), chars(0x1d7d9)]) {
    const seq = osc9(`${digit} files`);
    assert.ok(claudeAccepts(seq), JSON.stringify(seq));
    assert.ok(seq.startsWith("\x1b]9;Claude: "));
  }
  for (const lead of [" ", chars(0x200b), chars(0x180e), "\t"]) {
    const seq = osc9(`${lead}7 files`);
    assert.ok(claudeAccepts(seq), JSON.stringify(seq));
  }
});

test("a body that starts with a letter or a symbol is left alone", () => {
  assert.equal(osc9("Finished"), "\x1b]9;Finished\x07");
  assert.equal(osc9("(3) done"), "\x1b]9;(3) done\x07");
  assert.equal(osc9("#7 merged"), "\x1b]9;#7 merged\x07");
});

// --- control characters, length --------------------------------------------------------------------

test("control characters are stripped: text cannot close the sequence early or start another", () => {
  const evil = "hi\x07\x1b]0;pwned\x07\x1b[31m there\x9b31m\x00\n\r\x7f";
  for (const seq of [osc9(evil), osc777(evil, evil), oscTitle(evil)]) {
    assert.ok(claudeAccepts(seq), JSON.stringify(seq));
    const inner = seq.slice(2, -1);
    assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(inner), "no control character inside the payload: " + JSON.stringify(inner));
    assert.equal(seq.split("\x1b").length, 2, "exactly one ESC: the opening one");
    assert.equal(seq.split("\x07").length, 2, "exactly one BEL: the closing one");
  }
  assert.equal(osc9("a\x07b\x1bc"), "\x1b]9;abc\x07");
});

test("bidi overrides and zero-width characters are stripped from the text", () => {
  const seq = osc9("Claude " + chars(0x202e, 0x200b, 0x2066) + "done");
  assert.equal(seq, "\x1b]9;Claude done\x07");
});

test("osc777 fields cannot contain ; (it separates them)", () => {
  assert.equal(osc777("a;b", "c;d;e"), "\x1b]777;notify;a,b;c,d,e\x07");
});

test("text is capped at 200 characters (code points), cut with an ellipsis", () => {
  const seq = osc9("x".repeat(500));
  const text = seq.slice("\x1b]9;".length, -1);
  assert.equal([...text].length, 200);
  assert.ok(text.endsWith("…"));
  const body = osc777("T".repeat(300), "y".repeat(500));
  const [, , title, text777] = body.slice(2, -1).split(";");
  assert.equal([...title].length, 100);
  assert.equal([...text777].length, 200);
  assert.equal([...oscTitle("z".repeat(500)).slice(4, -1)].length, 200);
});

test("the cap counts code points, so an emoji is never cut in half", () => {
  const text = chars(0x1f600).repeat(300);
  for (const seq of [osc9(text), osc777("t", text), oscTitle(text)]) {
    assert.ok(claudeAccepts(seq));
    assert.equal(Buffer.from(seq, "utf8").toString("utf8"), seq, "no lone surrogate: the text survives a UTF-8 round trip");
  }
});

test("even the longest possible sequence (4-byte characters everywhere) stays under 4096 bytes", () => {
  const four = chars(0x1f600).repeat(400);
  for (const seq of [osc9(four), osc777(four, four), oscTitle(four)]) {
    assert.ok(Buffer.byteLength(seq, "utf8") <= MAX_SEQUENCE_BYTES, String(Buffer.byteLength(seq, "utf8")));
    assert.ok(claudeAccepts(seq));
  }
});

// --- everything we can build passes the allowlist --------------------------------------------------

test("every mode, for many inputs including hostile ones, produces a sequence Claude Code accepts", () => {
  const texts = [
    "Finished in api after 2m 13s", "7zip: needs you", "-1: negative project", "", "   ", "a;b;c", "line1\nline2", "\x1b]52;c;AAAA\x07",
    "x".repeat(1000), chars(0x1f600).repeat(80), "日本語のプロジェクト: 許可が必要です", chars(0x663, 0x664) + " things", chars(0x202e) + "rtl",
    "\x9d0;title\x9c", "a\x00b", "tab\there",
  ];
  for (const mode of ["osc9", "osc777", "title", "bell"]) {
    for (const text of texts) {
      for (const detail of ["", text]) {
        const seq = terminalSequence(mode, { title: "Claude Code", body: text, detail }, { kind: "attention", project: text });
        if (seq === "") continue;
        const parts = parseAllowlisted(seq);
        assert.ok(parts, `${mode} ${JSON.stringify(text).slice(0, 40)} -> ${JSON.stringify(seq).slice(0, 80)}`);
        for (const p of parts) if (p.kind === "osc") assert.ok([0, 1, 2, 9, 99, 777].includes(p.ps));
      }
    }
  }
});

test("a sequence is JSON-safe: it survives the trip through the hook's JSON output", () => {
  const seq = terminalSequence("osc777", msg('He said "hi" \\ and left'));
  assert.equal(JSON.parse(JSON.stringify({ terminalSequence: seq })).terminalSequence, seq);
});
