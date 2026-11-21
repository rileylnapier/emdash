import { expect, it } from 'vitest';
import { studioRoute } from './studio-routing';

it('answers for this Mac’s apps locally while other Taixu calls go to Studio', () => {
  expect(studioRoute('taixu.localApps')).toBe('local');
  expect(studioRoute('taixu.localAppAction')).toBe('local');
  expect(studioRoute('taixu.apps')).toBe('remote');
  expect(studioRoute('taixu.appAction')).toBe('remote');
  // Installing on this Mac: the release and its pieces come from Studio; receiving and installing stay here.
  expect(studioRoute('taixu.appRelease')).toBe('remote');
  expect(studioRoute('taixu.appChunk')).toBe('remote');
  expect(studioRoute('taixu.localAppReceive')).toBe('local');
  expect(studioRoute('taixu.localAppInstall')).toBe('local');
});
