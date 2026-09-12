import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { PrefsStore } from './prefs-store';
import { DEFAULT_PREFS } from './models';

/**
 * What the appearance prefs read back from localStorage, and the one field they deliberately do not.
 *
 * The folder tree defaults to open, and until 1.32.0 the layout wrote into that same saved flag
 * whenever the window was narrow, so a single visit on a small screen left `sidebarOpen: false`
 * behind and the desktop opened with no tree from then on. The `v` stamp is what lets the store tell
 * a value written by that bug (no stamp, or an older one) from a real choice, so these pin both
 * halves: the stale flag is dropped, everything else in the file still survives a version bump.
 */
const LS_KEY = 'sd2snes-covers:prefs';

const store = (): PrefsStore => {
  TestBed.configureTestingModule({});
  return TestBed.inject(PrefsStore);
};

describe('PrefsStore, the saved sidebar flag', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
  });

  it('opens the tree when nothing has been saved yet (the first run)', () => {
    expect(DEFAULT_PREFS.sidebarOpen).toBe(true);
    expect(store().sidebarOpen()).toBe(true);
  });

  it('reads the flag back when it carries the current version stamp', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ v: 2, sidebarOpen: false }));
    expect(store().sidebarOpen()).toBe(false); // a real choice on a wide window, respected
  });

  it('drops a flag written before the stamp existed (what the narrow-window bug left behind)', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ sidebarOpen: false }));
    expect(store().sidebarOpen()).toBe(true);
  });

  it('drops a flag stamped with an older version', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, sidebarOpen: false }));
    expect(store().sidebarOpen()).toBe(true);
  });

  it('keeps every other preference across the version bump', () => {
    localStorage.setItem(LS_KEY, JSON.stringify({ view: 'gallery', density: 'compact', accent: '#22c1c3', sidebarOpen: false, boardOpen: true }));
    const s = store();
    expect(s.view()).toBe('gallery');
    expect(s.density()).toBe('compact');
    expect(s.accent()).toBe('#22c1c3');
    expect(s.boardOpen()).toBe(true);
    expect(s.sidebarOpen()).toBe(true); // the only field the bump discards
  });

  it('survives a corrupt file with the defaults', () => {
    localStorage.setItem(LS_KEY, '{not json');
    expect(store().sidebarOpen()).toBe(true);
  });
});
