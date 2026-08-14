/**
 * IngameButtonsMenu is the one config.yml key the firmware rewrites on its own: cfg_load()
 * runs cfg_check_menu_combo(), and a combo it rejects is replaced by the default and written
 * back to the card by the cfg_save() that follows at boot (_repo/src/cfg.h:160-164). Saving a
 * rejected combo therefore looks like it worked and then reverts, so these pin the three
 * rejection rules to the firmware's.
 */
import { describe, expect, it } from 'vitest';
import { MENU_COMBO_DEFAULT, comboToBits, menuComboError, menuComboShadows } from './menu-combo';

describe('comboToBits: the firmware button alphabet', () => {
  it('matches cfg_buttons_string2bits, bit 15 down in "BYsSudlrAXLR" order', () => {
    expect(comboToBits('B')).toBe(0x8000);
    expect(comboToBits('Y')).toBe(0x4000);
    expect(comboToBits('s')).toBe(0x2000); // select is lowercase
    expect(comboToBits('S')).toBe(0x1000); // start is uppercase
    expect(comboToBits('u')).toBe(0x0800);
    expect(comboToBits('d')).toBe(0x0400);
    expect(comboToBits('l')).toBe(0x0200);
    expect(comboToBits('r')).toBe(0x0100);
    expect(comboToBits('A')).toBe(0x0080);
    expect(comboToBits('X')).toBe(0x0040);
    expect(comboToBits('L')).toBe(0x0020);
    expect(comboToBits('R')).toBe(0x0010);
  });

  it('gives the shipped default the value cfg.c hardcodes', () => {
    expect(comboToBits(MENU_COMBO_DEFAULT)).toBe(0x4230); // L|R|Y|LEFT, cfg.c:96
  });

  it('ignores characters outside the alphabet, as strchr does', () => {
    expect(comboToBits('Y!l?LR')).toBe(0x4230);
  });
});

describe('menuComboError: what cfg_check_menu_combo would reject', () => {
  it('accepts the shipped default', () => {
    expect(menuComboError(MENU_COMBO_DEFAULT)).toBeNull();
  });

  it('rejects an empty combo, which would match every pad read', () => {
    expect(menuComboError('')).toBe('empty');
    expect(menuComboError('???')).toBe('empty'); // nothing in the alphabet
  });

  it('rejects fewer than three buttons, which fire during normal play', () => {
    expect(menuComboError('L')).toBe('few');
    expect(menuComboError('LR')).toBe('few');
  });

  it('rejects every reserved FPGA gesture', () => {
    expect(menuComboError('sSLR')).toBe('reserved');  // L+R+Select+Start
    expect(menuComboError('sXLR')).toBe('reserved');  // L+R+Select+X
    expect(menuComboError('SALR')).toBe('reserved');  // L+R+Start+A
    expect(menuComboError('BSLR')).toBe('reserved');  // L+R+Start+B
    expect(menuComboError('YSLR')).toBe('reserved');  // L+R+Start+Y
    expect(menuComboError('SXLR')).toBe('reserved');  // L+R+Start+X
  });

  it('rejects a SUBSET of a reserved gesture too: the probe fires a frame early', () => {
    expect(menuComboError('SLR')).toBe('reserved');   // L+R+Start, subset of four of them
    expect(menuComboError('sLR')).toBe('reserved');   // L+R+Select
    expect(menuComboError('YLR')).toBe('reserved');   // L+R+Y, subset of L+R+Start+Y
    expect(menuComboError('XLR')).toBe('reserved');   // L+R+X
  });

  it('accepts a combo that merely overlaps a reserved gesture without being inside it', () => {
    expect(menuComboError('YlLR')).toBeNull();  // adds Left, so no longer a subset
    expect(menuComboError('BYX')).toBeNull();
    expect(menuComboError('sSud')).toBeNull();
  });
});

describe('menuComboShadows: the warning the firmware only prints', () => {
  it('flags a menu combo contained in a save state combo, which then never fires', () => {
    expect(menuComboShadows('YlLR', 'SYlLR')).toBe(true); // Start added on top of the menu combo
    expect(menuComboShadows('SLR', 'SLR')).toBe(true);    // identical
  });

  it('does not flag combos that merely share buttons', () => {
    expect(menuComboShadows('YlLR', 'SR')).toBe(false);
    expect(menuComboShadows('YlLR', 'XR')).toBe(false);
  });

  it('never flags anything for an empty menu combo', () => {
    expect(menuComboShadows('', 'SR')).toBe(false);
  });
});
