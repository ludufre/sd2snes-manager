import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Kill-switch for the (now disabled) PWA service worker. A previously-registered ngsw can be pinned
// to an old build forever, Cloudflare's JS-Detections injects a per-request script into index.html,
// so ngsw's hash check fails on every update and it keeps serving the stale cache. We no longer
// register a SW (see app.config), so actively unregister any leftover one and drop its caches; once
// a client loads this build it sheds the stuck worker and from then on always loads fresh.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations()
    .then((regs) => regs.forEach((r) => r.unregister()))
    .catch(() => { /* nothing to clean up */ });
  if (typeof caches !== 'undefined') {
    caches.keys()
      .then((keys) => keys.filter((k) => k.startsWith('ngsw:')).forEach((k) => caches.delete(k)))
      .catch(() => { /* */ });
  }
}

bootstrapApplication(App, appConfig)
  .catch((err) => console.error(err));
