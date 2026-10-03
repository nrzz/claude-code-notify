// Terminal escape sequences, for the `terminal` channel. The hook prints {"terminalSequence": "..."}
// and Claude Code writes the sequence to your terminal. Claude Code drops a sequence unless every part
// of it is a notification or title OSC (0, 1, 2, 9, 99, 777) or a BEL, ends in BEL or ESC \, is at most
// 4096 bytes, and, for OSC 9, has a body that does not start with a digit (a leading digit means one
// of ConEmu's commands, such as the 9;4 progress form). These builders follow that rule exactly.
import { cleanText } from "./message.mjs";

const ESC = "\x1b";
export const BEL = "\x07";
export const ALLOWED_OSC = [0, 1, 2, 9, 99, 777];
export const MAX_SEQUENCE_BYTES = 4096;

/**
 * What Claude Code rejects at the start of an OSC 9 body: optional blanks (including U+180E and U+200B),
 * an optional sign, then a digit in any script. Built from code points so the source has no invisible characters.
 */
export const OSC9_DIGIT_START = new RegExp(`^[\\s${String.fromCharCode(0x180e)}${String.fromCharCode(0x200b)}]*[+-]?\\p{Nd}`, "u");

/** OSC 9: one line of text. Notification text in iTerm2, WezTerm, kitty, Ghostty and others. */
export function osc9(text) {
  let t = cleanText(text, 200);
  if (!t) return "";
  if (OSC9_DIGIT_START.test(t)) t = cleanText(`Claude: ${t}`, 200);
  return `${ESC}]9;${t}${BEL}`;
}

/** OSC 777 notify: a title and a body. foot, WezTerm, Ghostty and others. `;` separates the fields, so it is removed from them. */
export function osc777(title, body) {
  const t = cleanText(title, 100).replace(/;/g, ",");
  const b = cleanText(body, 200).replace(/;/g, ",");
  if (!t && !b) return "";
  return `${ESC}]777;notify;${t};${b}${BEL}`;
}

/** OSC 2: the window or tab title. */
export function oscTitle(text) {
  const t = cleanText(text, 200);
  return t ? `${ESC}]2;${t}${BEL}` : "";
}

/** The sequence for a terminal mode, or "" when the mode is off or has nothing to say. */
export function terminalSequence(mode, message, { kind = "finished", project = "" } = {}) {
  const flat = (m) => (m.detail ? `${m.body} | ${m.detail}` : m.body);
  switch (mode) {
    case "osc9": return osc9(`${message.title} - ${flat(message)}`);
    case "osc777": return osc777(message.title, flat(message));
    case "title": return oscTitle(`${kind === "finished" ? "✓" : "!"} ${message.title === "Claude Code" ? "Claude" : message.title}: ${project}`);
    case "bell": return BEL;
    default: return "";
  }
}
