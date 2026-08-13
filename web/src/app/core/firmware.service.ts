import { Injectable } from '@angular/core';
import { marked } from 'marked';
import { unzipSync } from 'fflate';
import { GAMEDB_BASE } from './env';

/** A downloadable firmware archive (a release asset). */
export interface FwAsset {
  id: number; // GitHub asset id, sent to the proxy (preserves GitHub's counter)
  name: string;
  size: number;
  ghUrl: string; // GitHub download URL (manual fallback link)
}

/** A sd2snes+ release: notes + the two zips (core "update" + "full"). */
export interface FwRelease {
  tag: string;
  name: string;
  publishedAt: string;
  prerelease: boolean;
  bodyHtml: string; // release notes (Markdown → sanitized HTML)
  update?: FwAsset;
  full?: FwAsset;
}

interface GhAsset { id: number; name: string; size: number; browser_download_url: string; }
interface GhRelease {
  tag_name: string; name: string | null; published_at: string;
  prerelease: boolean; body: string | null; assets: GhAsset[];
}

const GH_API = 'https://api.github.com/repos/ludufre/sd2snes/releases?per_page=20';
/** GamesDB API proxy that streams a release asset by id, same origin as the Manager (no CORS)
 *  and keeps GitHub's download counter. Called as `${FW_PROXY}?id=<assetId>`. */
const FW_PROXY = `${GAMEDB_BASE}/api/firmware`;

/** GitHub user-attachments / githubusercontent images don't hotlink cross-origin (they 302 to a
 *  short-lived signed S3 URL that fails from another origin). Rewrite changelog <img> srcs to the
 *  same-origin API image proxy so they load. */
function proxyChangelogImages(html: string): string {
  return html.replace(
    /(<img\b[^>]*?\bsrc=")(https:\/\/(?:github\.com\/user-attachments\/|[a-z0-9.-]*\.githubusercontent\.com\/)[^"]+)(")/gi,
    (_m, pre, url, post) => `${pre}${FW_PROXY}/image?url=${encodeURIComponent(url)}${post}`,
  );
}

@Injectable({ providedIn: 'root' })
export class FirmwareService {
  /** Releases + notes from the GitHub API (api.github.com sends CORS headers). */
  async listReleases(): Promise<FwRelease[]> {
    const res = await fetch(GH_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    const raw = (await res.json()) as GhRelease[];
    return raw.map((r) => {
      let update: FwAsset | undefined;
      let full: FwAsset | undefined;
      for (const a of r.assets ?? []) {
        if (!a.name.toLowerCase().endsWith('.zip')) continue;
        const asset: FwAsset = { id: a.id, name: a.name, size: a.size, ghUrl: a.browser_download_url };
        if (/-full\.zip$/i.test(a.name)) full = asset;
        else update = asset;
      }
      return {
        tag: r.tag_name,
        name: r.name || r.tag_name,
        publishedAt: r.published_at,
        prerelease: r.prerelease,
        bodyHtml: proxyChangelogImages(marked.parse(r.body || '_No release notes._', { async: false }) as string),
        update,
        full,
      };
    });
  }

  /** Download a firmware zip through the proxy (by GitHub asset id). */
  async fetchZip(assetId: number): Promise<Uint8Array> {
    const res = await fetch(`${FW_PROXY}?id=${assetId}`);
    if (!res.ok) throw new Error(`Proxy returned ${res.status} for asset ${assetId}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Unzip into file entries (directory entries dropped). */
  unzip(bytes: Uint8Array): { path: string; data: Uint8Array }[] {
    const map = unzipSync(bytes);
    const out: { path: string; data: Uint8Array }[] = [];
    for (const [path, data] of Object.entries(map)) {
      if (path.endsWith('/')) continue; // directory entry
      out.push({ path, data });
    }
    return out;
  }
}
