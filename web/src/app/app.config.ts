import {
  ApplicationConfig,
  isDevMode,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { provideHttpClient, withFetch } from '@angular/common/http';
import { provideTransloco } from '@jsverse/transloco';

import { routes } from './app.routes';
import { TranslocoHttpLoader } from './core/transloco-loader';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    // withComponentInputBinding: bind `folder`/`game` query params straight to component inputs.
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch()),
    // i18n, Português (default), English (fallback), Español, Deutsch, Français, Italiano, Русский.
    // Keep this list in lockstep with langs in core/lang.service.ts: nothing derives one from
    // the other, and a language missing here resolves to the fallback with no error.
    // Translations are JSON assets in public/i18n/, loaded under the app's base-href
    // (see TranslocoHttpLoader).
    provideTransloco({
      config: {
        availableLangs: ['pt', 'en', 'es', 'de', 'fr', 'it', 'ru'],
        defaultLang: 'pt',
        fallbackLang: 'en',
        reRenderOnLangChange: true,
        prodMode: !isDevMode(),
      },
      loader: TranslocoHttpLoader,
    }),
    // PWA service worker disabled on purpose.
    // The site sits behind Cloudflare with "JavaScript Detections" enabled, which injects a
    // per-request <script> (.../cdn-cgi/challenge-platform/scripts/jsd/main.js + __CF$cv$params) into
    // every HTML response. That mutates index.html on the fly, so its SHA-1 never matches the hash
    // baked into ngsw.json at build time → ngsw fails every version install ("Hash mismatch ... after
    // cache busting") and pins users to whatever build was cached first, forever (deploys never land).
    // Until JS Detections is turned off at the edge, we don't register a SW, the app then always
    // loads fresh (index.html is served `no-cache`; hashed assets stay fast via the HTTP cache).
    // Provider kept (enabled:false) so SwUpdate stays injectable; main.ts tears down any leftover SW.
    provideServiceWorker('ngsw-worker.js', {
      enabled: false,
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};
