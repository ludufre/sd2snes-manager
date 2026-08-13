import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { PlatformLocation } from '@angular/common';
import { Translation, TranslocoLoader } from '@jsverse/transloco';

@Injectable({ providedIn: 'root' })
export class TranslocoHttpLoader implements TranslocoLoader {
  private http = inject(HttpClient);
  // Translations are SPA assets, served under the app's base-href ("/" in dev, "/manager/" in
  // prod), not the site root. Prefix with the real base-href so it works in both.
  private baseHref = inject(PlatformLocation).getBaseHrefFromDOM() || '/';
  getTranslation(lang: string) {
    return this.http.get<Translation>(`${this.baseHref}i18n/${lang}.json`);
  }
}
