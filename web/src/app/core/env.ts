// Dev vs prod base URLs. In dev the Angular dev-server proxy maps /api and
// /cheats to the real hosts, so we use same-origin ('') and sidestep CORS.
// In prod the app must be served same-origin as the API, or the hosts must
// send CORS headers (see the project readme).

export const IS_DEV =
  typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

// The API is reverse-proxied at /api on the main host (same origin as /manager) and the gamedb
// client appends '/api/...', so the base is the bare origin (not '/gamedb'). Same-origin in prod → no
// CORS. (The legacy static /cheats/<CRC>.yml host is gone, cheats now come from the GameDB lookup /
// .s2pkg bundle; see CheatsService + library-store dlCheats.)
// Same-origin ('') everywhere: the app is served on the same host that reverse-proxies /api (prod,
// staging, and (via the dev-server proxy) local dev). Portable: works at sd2snes.ludufre.com/manager
// And sd2snes-test.ludufre.com/manager without a rebuild-per-host. (Was a hardcoded absolute prod URL.)
export const GAMEDB_BASE = '';

// Human-facing GameDB frontend (always absolute, used for "report" deep links that open in a
// new tab). Lives under /gamesdb on the main host now (the gamedb.* subdomain was retired).
export const GAMEDB_WEB = 'https://sd2snes.ludufre.com/gamesdb';

// CDN media (cover/screenshot/video on cdn-sd2snes) is fetched directly from the CDN, Cloudflare's
// free egress, no server bandwidth (host is 100 Mbit/s; never relay media through it). `ngsw-bypass`
// is a safeguard: a healthy Angular service worker passes cross-origin requests through, but a
// Degraded one (SAFE_MODE) 504s them, the flag tells ngsw to never touch these, so media loads
// regardless of SW health. No cache cost (same key, cache hit). blob:/data: pass through untouched.
export function cdnUrl(url: string | null | undefined): string | undefined {
  if (!url || !/^https?:/i.test(url)) return url ?? undefined;
  return url;
  //return url + (url.includes('?') ? '&' : '?') + 'ngsw-bypass=true';
}

