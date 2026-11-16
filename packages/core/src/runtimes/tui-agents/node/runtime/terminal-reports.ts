// Replies a terminal emulator sends by itself: focus and mouse reports, and answers to
// cursor-position, device-attribute, mode, colour and size queries. Opening a task replays
// earlier output, so xterm can answer old queries; clicking or scrolling can send mouse
// reports. None of these is the user typing, so they must not count as input after an
// agent's completion signal. They are still written to the PTY unchanged.
const REPORT = new RegExp(
  [
    '\\x1b\\[[IO]', // focus in/out
    '\\x1b\\[<\\d+;\\d+;\\d+[Mm]', // SGR mouse
    '\\x1b\\[M[\\s\\S]{3}', // X10/normal mouse
    '\\x1b\\[\\??\\d+;\\d+R', // cursor position (CPR, DECXCPR)
    '\\x1b\\[[?>=][\\d;]*c', // device attributes (DA1/DA2/DA3)
    '\\x1bP[!>]\\|[^\\x1b]*\\x1b\\\\', // DA3 unit id, XTVERSION
    '\\x1bP[01]\\$r[^\\x1b]*\\x1b\\\\', // DECRQSS reply
    '\\x1b\\[\\??[\\d;]*\\$y', // DECRPM mode report
    '\\x1b\\[\\?\\d+u', // kitty keyboard flags
    '\\x1b\\[\\d+;\\d+;\\d+t', // window and cell size reports
    '\\x1b\\]\\d+;[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)', // OSC replies, e.g. colours
  ].join('|'),
  'y'
);

/** True when `data` is only terminal-generated replies, with no typed input. */
export function isTerminalReport(data: string): boolean {
  if (!data.startsWith('\x1b')) return false;
  let index = 0;
  while (index < data.length) {
    REPORT.lastIndex = index;
    const match = REPORT.exec(data);
    if (!match || match.index !== index || !match[0].length) return false;
    index += match[0].length;
  }
  return true;
}
