/*  Validation for IngameButtonsMenu, mirroring cfg_check_menu_combo() (_repo/src/cfg.c:121-158).
 *
 *  This key is YAML only: the firmware has no menu entry for it, so config.yml is the only place
 *  it can be set (_repo/src/cfg.h:152-169). It is also the only combo the firmware silently
 *  rewrites: cfg_load() replaces a rejected combo with the default and the cfg_save() that
 *  follows at boot writes the correction back to the card. Catching it here means the user finds
 *  out now, instead of finding their setting reverted after the next boot. */

/** Bit per button, in the order of the firmware's button_names "BYsSudlrAXLR" (cfg.c:102),
 *  starting at bit 15 (cfg_buttons_string2bits, cfg.c:1054-1062). */
const BUTTON_BITS: Record<string, number> = {
  B: 0x8000, Y: 0x4000, s: 0x2000, S: 0x1000,
  u: 0x0800, d: 0x0400, l: 0x0200, r: 0x0100,
  A: 0x0080, X: 0x0040, L: 0x0020, R: 0x0010,
};

/** Pad gestures the FPGA decodes by exact equality of the whole pad word (snes.h:177-182). */
const RESERVED_GESTURES = [0x3030, 0x2070, 0x10b0, 0x9030, 0x5030, 0x1070];

/** CFG_MENU_COMBO_MIN_BUTTONS (cfg.h:85). */
const MIN_BUTTONS = 3;

/** CFG_DEFAULT.ingame_buttons_menu: L+R+Y+Left, i.e. 0x4230 (cfg.c:96). */
export const MENU_COMBO_DEFAULT = 'YlLR';

export function comboToBits(combo: string): number {
  let bits = 0;
  for (const key of combo) bits |= BUTTON_BITS[key] ?? 0;
  return bits;
}

function bitCount(value: number): number {
  let n = 0;
  for (let v = value; v; v >>>= 1) n += v & 1;
  return n;
}

/** Why the firmware would reject this menu combo, or null when it would keep it. */
export function menuComboError(combo: string): 'empty' | 'few' | 'reserved' | null {
  const bits = comboToBits(combo);
  if (!bits) return 'empty';
  if (bitCount(bits) < MIN_BUTTONS) return 'few';
  // A subset of a reserved gesture fires one frame before the gesture is complete, so the
  // handler never runs to decline it. This also rejects a bare L+R.
  if (RESERVED_GESTURES.some((gesture) => (gesture & bits) === bits)) return 'reserved';
  return null;
}

/** True when the menu combo shadows `other`: the menu probe runs first, so `other` never fires.
 *  The firmware only warns about this (cfg.c:148-156), and so do we. */
export function menuComboShadows(menu: string, other: string): boolean {
  const menuBits = comboToBits(menu);
  const otherBits = comboToBits(other);
  return menuBits !== 0 && (otherBits & menuBits) === menuBits;
}
