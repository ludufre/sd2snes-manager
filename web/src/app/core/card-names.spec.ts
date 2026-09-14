import { describe, expect, it } from 'vitest';
import { isInsidePath, moveRelation, sameName, samePath } from './card-names';

describe('card-names — FAT treats names that differ only in case as one entry', () => {
  it('compares names and paths without regard to case', () => {
    expect(sameName('Foo.sfc', 'foo.SFC')).toBe(true);
    expect(sameName('Foo.sfc', 'Foo.smc')).toBe(false);
    expect(samePath('Games/SNES', 'games/snes')).toBe(true);
    expect(samePath('Games/SNES', 'Games/SNES2')).toBe(false);
  });

  it('knows what lies inside a folder, case-insensitively', () => {
    expect(isInsidePath('Games/SNES', 'games')).toBe(true);
    expect(isInsidePath('games', 'Games')).toBe(false); // the folder itself is not inside itself
    expect(isInsidePath('GamesX', 'Games')).toBe(false); // a sibling that shares a prefix
    expect(isInsidePath('Games', '')).toBe(true);
    expect(isInsidePath('', '')).toBe(false);
  });

  it('classifies a move: nothing to do, a case-only rename, or a different file', () => {
    expect(moveRelation(true, 'Foo.sfc', 'Foo.sfc')).toBe('identical');
    expect(moveRelation(true, 'Foo.sfc', 'foo.sfc')).toBe('caseOnly');
    expect(moveRelation(true, 'Foo.sfc', 'Bar.sfc')).toBe('distinct');
    expect(moveRelation(false, 'Foo.sfc', 'foo.sfc')).toBe('distinct');
    expect(moveRelation(false, 'Foo.sfc', 'Foo.sfc')).toBe('distinct');
  });
});
