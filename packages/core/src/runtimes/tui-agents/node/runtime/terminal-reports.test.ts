import { describe, expect, it } from 'vitest';
import { isTerminalReport } from './terminal-reports';

describe('isTerminalReport', () => {
  it.each([
    ['focus in and out', '\x1b[I\x1b[O'],
    ['SGR mouse click and wheel', '\x1b[<0;12;5M\x1b[<0;12;5m\x1b[<64;12;5M'],
    ['X10 mouse', '\x1b[M !!'],
    ['cursor position', '\x1b[6;10R'],
    ['device attributes', '\x1b[?1;2c\x1b[>0;276;0c'],
    ['XTVERSION', '\x1bP>|XTerm(380)\x1b\\'],
    ['mode report', '\x1b[?2004;1$y'],
    ['OSC colour replies', '\x1b]11;rgb:1e1e/1e1e/1e1e\x07\x1b]10;rgb:ffff/ffff/ffff\x1b\\'],
    ['size report', '\x1b[8;30;120t'],
    ['kitty keyboard flags', '\x1b[?0u'],
  ])('treats %s as a terminal reply', (_name, data) => {
    expect(isTerminalReport(data)).toBe(true);
  });

  it.each([
    ['text', 'hello'],
    ['Enter', '\r'],
    ['arrow keys', '\x1b[A\x1b[B'],
    ['Escape', '\x1b'],
    ['shift-tab', '\x1b[Z'],
    ['bracketed paste', '\x1b[200~text\x1b[201~'],
    ['a reply followed by typing', '\x1b[Ihello'],
    ['typing followed by a reply', 'a\x1b[I'],
    ['empty input', ''],
  ])('treats %s as typed input', (_name, data) => {
    expect(isTerminalReport(data)).toBe(false);
  });
});
