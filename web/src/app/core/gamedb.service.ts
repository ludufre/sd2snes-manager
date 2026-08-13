import { Injectable } from '@angular/core';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- ported JS module (allowJs), no type declarations
import { GameDb, resolveMatch } from '../lib/gamedb.js';
import { GAMEDB_BASE } from './env';
import type { GameMatch } from './models';

/** Thin wrapper around the ported gamedb client. The two halves are deliberately separate: `lookupRaw*`
 *  does the I/O and returns the server's payload untouched (so it can be cached as-is), `resolveRaw`
 *  is the pure projection into a flat, render-ready match.
 *
 *  NOTE: the lookups deliberately send no `?lang=`. That parameter replaces the response's
 *  `description` with the translation, which would pin each card to whatever language this app was
 *  in when it wrote it. The `.yml` instead carries the canonical English `description` plus one
 *  `description_<lang>` per translation (`match.descriptions`, from the response's `translations`),
 *  and the console picks by its own menu language, so the card serves every language at once. */
@Injectable({ providedIn: 'root' })
export class GameDbService {
  private readonly db = new GameDb(GAMEDB_BASE);

  /** Raw single lookup: the server's `GameWithRelations` JSON, or null when the CRC has no game (404).
   *  A throw means the request itself failed, never a no-match. */
  async lookupRaw(crc: string): Promise<unknown | null> {
    return (await this.db.lookupByCrc(crc)) ?? null;
  }

  /** Raw batch lookup: the server's response as-is, `{ [crcUpper]: GameWithRelations }`, containing
   *  Only the CRCs that matched. One request per chunk (IDENTIFY_BATCH=50; the API caps at 100);
   *  distinct CRCs are de-duped.
   *
   *  Raw rather than resolved so callers can cache what the server actually said (see
   *  lib/gamedb-cache.js). The resolved GameMatch is a projection of this payload that changes with
   *  the app; the payload doesn't, so caching the raw form means an app update re-derives better
   *  matches from the same cache instead of invalidating it. */
  async lookupRawMany(crcs: string[], opts: { signal?: AbortSignal } = {}): Promise<Record<string, unknown>> {
    if (!crcs.length) return {};
    const distinct = [...new Set(crcs.map((c) => c.toUpperCase()))];
    return (await this.db.lookupByCrcs(distinct, opts)) as Record<string, unknown>;
  }

  /** Public wrapper over the pure `resolveMatch`: raw game JSON (fresh or from the cache) → flat,
   *  render-ready match. No network, no state, the same input always resolves the same way. */
  resolveRaw(game: unknown, region: string | null | undefined, crc: string): GameMatch | null {
    return (resolveMatch(this.db, game, region ?? null, crc) as GameMatch | null) ?? null;
  }
}
