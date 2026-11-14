import { expect, it } from 'vitest';
import { finalWorkReply } from './work-reply';

it('returns only the latest completed turn’s final assistant message', () => {
  const done = {
    outcome: { kind: 'done' },
    items: [{ kind: 'message', role: 'assistant', text: 'Old reply' }],
  };
  const transcript = {
    active: null,
    committed: [
      done,
      {
        ...done,
        items: [
          { kind: 'message', role: 'user', text: 'Private request' },
          { kind: 'thinking', text: 'Private reasoning' },
          { kind: 'message', role: 'assistant', text: 'Result' },
          { kind: 'tool', text: 'Private output' },
        ],
      },
    ],
  };
  expect(finalWorkReply(JSON.stringify(transcript))).toBe('Result');
  expect(finalWorkReply(JSON.stringify({ ...transcript, active: done }))).toBeUndefined();
  for (const kind of ['cancelled', 'error']) {
    expect(
      finalWorkReply(
        JSON.stringify({ active: null, committed: [done, { ...done, outcome: { kind } }] })
      )
    ).toBeUndefined();
  }
  expect(
    finalWorkReply(JSON.stringify({ active: null, committed: [done, { ...done, items: [] }] }))
  ).toBeUndefined();
  expect(finalWorkReply('invalid')).toBeUndefined();
});
