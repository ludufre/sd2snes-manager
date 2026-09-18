/**
 * The unwritable latch. The thing that stops a bulk run from grinding through hundreds of doomed
 * writes when the card goes full / write-protected / remounted read-only ("trava perto do final").
 *
 * These tests exist for one line of it: which successes are allowed to reset the failure streak. An
 * Isolated op is one whose failure is local and says nothing about the card (a `.cov` into a read-only
 * ROM folder, a `._x` the junk sweep removes, a leftover guide slot the manual pass sweeps), so its
 * Success says nothing either. Letting it clear the counter weakens the latch exactly where it matters
 * most: a run that interleaves isolated ops with real writes, which is what the guide sweep now does on
 * every affected game.
 *
 * QuotaExceededError is used throughout because withRetry treats it as fatal immediately, no retry, no
 * backoff sleeps, so the streak can be driven to the cap without the test waiting seconds for timers.
 */
import { describe, expect, it } from 'vitest';
import { CardWriter } from './card-writer.service';

/** A directory handle whose every file op fails with `name`. */
const failing = (name = 'QuotaExceededError'): FileSystemDirectoryHandle => ({
  getFileHandle: async () => { throw new DOMException('nope', name); },
  removeEntry: async () => { throw new DOMException('nope', name); },
} as unknown as FileSystemDirectoryHandle);

/** A directory handle that accepts everything. `lands(sent, attempt)` is how many bytes the card
 *  ends up holding after a close() (default: all of them). */
const working = (lands: (sent: number, attempt: number) => number = (n) => n): FileSystemDirectoryHandle => {
  let attempt = 0, size = 0;
  return {
    getFileHandle: async () => ({
      createWritable: async () => {
        let sent = 0;
        return {
          write: async (d: Uint8Array | string) => { sent += typeof d === 'string' ? new TextEncoder().encode(d).byteLength : d.byteLength; },
          close: async () => { size = lands(sent, attempt++); },
        };
      },
      getFile: async () => ({ size }),
    }),
    removeEntry: async () => undefined,
  } as unknown as FileSystemDirectoryHandle;
};

const bytes = new Uint8Array(8);
/** Drive one failed write, swallowing whatever it throws. */
const failWrite = async (cw: CardWriter, dir: FileSystemDirectoryHandle): Promise<void> => {
  await cw.write(dir, 'x.cov', bytes).catch(() => undefined);
};

describe('CardWriter — the unwritable latch and what resets its streak', () => {
  it('latches after four consecutive persistent failures', async () => {
    const cw = new CardWriter();
    const dir = failing();
    for (let i = 0; i < 3; i++) { await failWrite(cw, dir); expect(cw.unwritable).toBe(false); }
    await failWrite(cw, dir);
    expect(cw.unwritable).toBe(true);
    expect(cw.lastError).toContain('QuotaExceededError'); // the real error, for a diagnosable report
  });

  it('an ISOLATED success does NOT clear the streak', async () => {
    // The regression this pins: three real failures, then the guide sweep deletes one leftover file
    // successfully, and the fourth real failure has to still be the fourth.
    const cw = new CardWriter();
    const dir = failing();
    for (let i = 0; i < 3; i++) await failWrite(cw, dir);
    expect(cw.unwritable).toBe(false);
    await cw.remove(working(), 'stale.02.man', { isolated: true }); // succeeds, proves nothing card-wide
    await cw.write(working(), 'ok.cov', bytes, { isolated: true }); // ditto
    await failWrite(cw, dir);
    expect(cw.unwritable).toBe(true);
  });

  it('a NORMAL success DOES clear it — a card that is writing again is not failing', async () => {
    const cw = new CardWriter();
    const dir = failing();
    for (let i = 0; i < 3; i++) await failWrite(cw, dir);
    expect(await cw.write(working(), 'ok.yml', 'hello')).toBe(true);
    for (let i = 0; i < 3; i++) { await failWrite(cw, dir); expect(cw.unwritable).toBe(false); }
    await failWrite(cw, dir);
    expect(cw.unwritable).toBe(true); // ...and the fresh streak still reaches the cap on its own
  });

  it('resetWriteHealth un-latches (re-seating the card / a new run)', async () => {
    const cw = new CardWriter();
    const dir = failing();
    for (let i = 0; i < 4; i++) await failWrite(cw, dir);
    expect(cw.unwritable).toBe(true);
    cw.resetWriteHealth();
    expect(cw.unwritable).toBe(false);
    expect(cw.lastError).toBe('');
    expect(await cw.write(working(), 'ok.yml', 'hello')).toBe(true);
  });

  it('does NOT report a write that left the file short as a success, it retries', async () => {
    // The card that had one manual at 0 bytes, recorded installed: close() resolved, nothing landed.
    const cw = new CardWriter();
    expect(await cw.write(working((n, a) => (a === 0 ? 0 : n)), 'Goal! (USA).man', new Uint8Array(64))).toBe(true);
    expect(cw.writtenBytes).toBe(64); // counted once, for the attempt that actually landed
  });

  it('throws when every attempt comes back short, and that counts toward the latch', async () => {
    const cw = new CardWriter();
    await expect(cw.write(working(() => 0), 'x.man', new Uint8Array(64))).rejects.toThrow(/short write/);
    expect(cw.writtenBytes).toBe(0);
    expect(cw.lastError).toContain('short write');
  });

  it('measures a string by its UTF-8 bytes, not its length (a `.yml` with accents is not short)', async () => {
    const cw = new CardWriter();
    expect(await cw.write(working(), 'a.yml', 'title: "Pokémon"\n')).toBe(true);
  });

  it('counts only fully-written bytes', async () => {
    const cw = new CardWriter();
    await cw.write(working(), 'a.cov', new Uint8Array(100));
    await failWrite(cw, failing());
    expect(cw.writtenBytes).toBe(100);
  });
});
