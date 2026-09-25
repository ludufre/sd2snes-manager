import { describe, it, expect } from 'vitest';
import { CheatsService } from './cheats.service';

describe('CheatsService.serialize', () => {
  const svc = new CheatsService();

  it('matches the GameDB package member byte for byte, notes included', () => {
    // The mirror of the GameDB's buildCheatYml: auto-fill writes this text in place of the `.s2pkg`
    // member, so anything it drops (the notes were) is missing from the card.
    const text = svc.serialize([
      { name: 'Say "hi"', on: true, codes: ['7e0000:01', 'd4b1-5f07'], note: 'GG: AAAA-BBBB\nhint' },
      { name: 'Two\nlines', on: false, codes: ['7E0001:02'] },
    ]);
    expect(text).toBe([
      '---',
      '- Name: "Say \'hi\'"',
      '  Enabled: true',
      '  Code:',
      '  - "7E0000:01"',
      '  - "D4B1-5F07"',
      '# GG: AAAA-BBBB',
      '# hint',
      '- Name: "Two lines"',
      '  Enabled: false',
      '  Code:',
      '  - "7E0001:02"',
      '',
    ].join('\n'));
  });

  it('round-trips through parse', () => {
    const cheats = [{ name: 'Infinite lives', on: true, codes: ['7E0DBE:63'], note: 'a note' }];
    expect(svc.parse(svc.serialize(cheats, 'Game'))).toEqual([{ name: 'Infinite lives', on: true, codes: ['7E0DBE:63'] }]);
  });
});
