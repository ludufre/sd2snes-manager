/**
 * Cheats, saves, states and everything under /sd2snes/info are named after the ROM instead of sitting beside it.
 *
 * Two rules follow, and a slip in either loses data without an error:
 * - a rename has to carry every file named after the ROM, guides included, or the guide stays behind under the
 *   old name where the renamed game never finds it;
 * - a delete must leave the files a same-named ROM elsewhere on the card still reads. Deleting a copy in
 *   another folder used to take the original game's game info, preview, guides and cheats with it.
 */
import { describe, expect, it } from 'vitest';
import { assetKeysInUse, guideNames, infoIndexKey, infoSiblingNames } from './library-store';
import { assetKeyOf } from './sd-layout';

describe('infoSiblingNames, the files under /sd2snes/info that belong to a stem', () => {
  it('lists game info, cover, snapshot, preview and every guide slot', () => {
    expect(infoSiblingNames('Chrono Trigger (USA)')).toEqual([
      'Chrono Trigger (USA).yml',
      'Chrono Trigger (USA).gcv',
      'Chrono Trigger (USA).gss',
      'Chrono Trigger (USA).fmv',
      'Chrono Trigger (USA).pcm',
      'Chrono Trigger (USA).man',
      'Chrono Trigger (USA).02.man',
      'Chrono Trigger (USA).03.man',
      'Chrono Trigger (USA).04.man',
      'Chrono Trigger (USA).05.man',
      'Chrono Trigger (USA).06.man',
      'Chrono Trigger (USA).07.man',
      'Chrono Trigger (USA).08.man',
    ]);
  });

  it('ends with the guides, which a ROM delete removes on their own', () => {
    expect(guideNames('Tetris (USA)')).toEqual([
      'Tetris (USA).man', 'Tetris (USA).02.man', 'Tetris (USA).03.man', 'Tetris (USA).04.man',
      'Tetris (USA).05.man', 'Tetris (USA).06.man', 'Tetris (USA).07.man', 'Tetris (USA).08.man',
    ]);
    expect(infoSiblingNames('Tetris (USA)').slice(-guideNames('Tetris (USA)').length)).toEqual(guideNames('Tetris (USA)'));
  });

  it('names the same file at the same index for any stem, so a rename keeps each guide in its slot', () => {
    const from = infoSiblingNames('captain commando (usa)');
    const to = infoSiblingNames('Captain Commando (U)');
    expect(to).toHaveLength(from.length);
    from.forEach((name, i) => expect(to[i]).toBe('Captain Commando (U)' + name.slice('captain commando (usa)'.length)));
  });
});

describe('assetKeysInUse, the files a delete has to leave for the ROMs that stay', () => {
  const keyOf = (file: string) => assetKeyOf(file, 'namespaces');
  const yoshi = "super mario world 2 - yoshi's island (usa).sfc";

  it('keeps the files of a same-named ROM in another folder when only the copy goes', () => {
    const entries = [{ id: 'original', file: yoshi }, { id: 'copy', file: yoshi }, { id: 'other', file: 'Bar (USA).sfc' }];
    const inUse = assetKeysInUse(entries, new Set(['copy']), keyOf);
    expect(inUse.has(infoIndexKey(keyOf(yoshi)))).toBe(true);
  });

  it('lets the files go once every ROM with that name is removed', () => {
    const entries = [{ id: 'original', file: yoshi }, { id: 'copy', file: yoshi }, { id: 'other', file: 'Bar (USA).sfc' }];
    const inUse = assetKeysInUse(entries, new Set(['original', 'copy']), keyOf);
    expect(inUse.has(infoIndexKey(keyOf(yoshi)))).toBe(false);
    expect(inUse.has(infoIndexKey(keyOf('Bar (USA).sfc')))).toBe(true);
  });

  it('matches names the way FAT does, so a ROM differing only in letter case still holds the files', () => {
    const entries = [{ id: 'kept', file: 'Tetris Attack (USA).sfc' }, { id: 'gone', file: 'TETRIS ATTACK (USA).sfc' }];
    const inUse = assetKeysInUse(entries, new Set(['gone']), keyOf);
    expect(inUse.has(infoIndexKey(keyOf('TETRIS ATTACK (USA).sfc')))).toBe(true);
  });

  it('keeps systems apart: a Game Boy ROM does not hold on to the files of the SNES game with its name', () => {
    const entries = [{ id: 'gb', file: 'Tetris (USA).gb' }, { id: 'snes', file: 'Tetris (USA).sfc' }];
    const inUse = assetKeysInUse(entries, new Set(['snes']), keyOf);
    expect(inUse.has(infoIndexKey(keyOf('Tetris (USA).sfc')))).toBe(false);
    expect(inUse.has(infoIndexKey(keyOf('Tetris (USA).gb')))).toBe(true);
  });
});
