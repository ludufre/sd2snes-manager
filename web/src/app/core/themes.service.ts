import { Injectable } from '@angular/core';

/** One menu theme from the Landing gallery (sd2snes.ludufre.com/gallery). A theme is a single
 *  binary `.thm` file (FXTHEME1 container) that the firmware applies to the SNES menu. */
export interface Theme {
  name: string;
  brand: string;    // group/author, used as the filter tab
  file: string;     // the .thm filename (relative to /gallery/themes/)
  preview: string;  // the preview PNG filename (relative to /gallery/previews/)
  full?: boolean;   // true → full-width logo, needs firmware v2.14+ ("fw 2.14+" badge)
}

// Same-origin in prod (the Manager is served under /manager on the same host as /gallery); in dev the
// Angular proxy maps /gallery to the live host (see proxy.config.json). Root-relative → no CORS.
const GALLERY_BASE = '/gallery';

declare global {
  interface Window {
    GALLERY?: Theme[];
  }
}

@Injectable({ providedIn: 'root' })
export class ThemesService {
  /** Load the gallery index. The Landing ships the list as a JS file that assigns `window.GALLERY`
   *  (not JSON. It has unquoted keys + trailing commas), so we execute it via a <script> tag, the
   *  exact contract the gallery page itself uses, and read the global back, then clean up. */
  listThemes(): Promise<Theme[]> {
    return new Promise<Theme[]>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${GALLERY_BASE}/themes-full.js?t=${Date.now()}`;
      s.async = true;
      s.referrerPolicy = 'no-referrer'; // Cloudflare hotlink protection 403s a cross-origin Referer (dev)
      const done = (fn: () => void): void => { s.remove(); fn(); };
      s.onload = () => {
        const list = Array.isArray(window.GALLERY) ? window.GALLERY.slice() : [];
        window.GALLERY = undefined;
        done(() => resolve(list));
      };
      s.onerror = () => done(() => reject(new Error('themes-full.js failed to load')));
      document.head.appendChild(s);
    });
  }

  /** Download a theme's raw `.thm` bytes (~7.7 KB, or ~15 KB for `full` themes). */
  async fetchTheme(file: string): Promise<Uint8Array> {
    const res = await fetch(`${GALLERY_BASE}/themes/${encodeURIComponent(file)}`, { referrerPolicy: 'no-referrer' });
    if (!res.ok) throw new Error(`theme fetch ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Preview PNG URL (512×448) for an <img src>. */
  previewUrl(preview: string): string {
    return `${GALLERY_BASE}/previews/${encodeURIComponent(preview)}`;
  }
}
