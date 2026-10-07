import { inject, Injectable, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';

/** Interface languages. Japanese and Simplified Chinese are interface-only: the firmware menu has
 *  neither, so they are NOT in the firmware Language selector (config-dialog.ts) nor in DescLang. */
export type Lang = 'pt' | 'en' | 'es' | 'de' | 'fr' | 'it' | 'ru' | 'nl' | 'ja' | 'zh';

export const LANGS: readonly Lang[] = ['pt', 'en', 'es', 'de', 'fr', 'it', 'ru', 'nl', 'ja', 'zh'] as const;

/** Each language's name in itself, for the topbar picker: someone stuck in a UI language they do not
 *  read still has to recognize their own. */
export const LANG_NAMES: Readonly<Record<Lang, string>> = {
  pt: 'Português', en: 'English', es: 'Español', de: 'Deutsch', fr: 'Français',
  it: 'Italiano', ru: 'Русский', nl: 'Nederlands', ja: '日本語', zh: '简体中文',
};

const LS_KEY = 'sd2snes-covers:lang';

/**
 * Active-language store. Wraps TranslocoService with localStorage persistence and a one-time
 * browser-language guess, exposed as a signal so the topbar switcher re-renders on change.
 *
 * Resolution order on boot: saved choice → browser language (if supported) → default ('pt').
 */
@Injectable({ providedIn: 'root' })
export class LangService {
  private readonly transloco = inject(TranslocoService);
  private readonly _lang = signal<Lang>('pt');
  readonly lang = this._lang.asReadonly();
  readonly available = LANGS;

  /**
   * Read this inside any `computed()` that calls `translate()`.
   *
   * `translate()` is a plain method call, not a signal, so a computed built on it has nothing to
   * depend on: Angular caches the first result and never recomputes it. The text then stays in
   * whichever language happened to be active when it was first read, while every `| transloco`
   * pipe around it switches correctly, which is what makes the bug look like "some things just
   * don't translate".
   *
   * Keyed off the load event and not off `lang`: `langChanges$` fires before the new language's
   * JSON has been fetched, so a computed woken by it would briefly translate to the raw key.
   */
  readonly ready = toSignal(
    this.transloco.events$.pipe(filter((e) => e.type === 'translationLoadSuccess' || e.type === 'langChanged')),
    { initialValue: null },
  );

  constructor() {
    const initial = this.resolveInitial();
    this.transloco.setActiveLang(initial);
    this._lang.set(initial);
    this.applyLang(initial);
  }

  set(lang: Lang): void {
    if (!LANGS.includes(lang)) return;
    this.transloco.setActiveLang(lang);
    this._lang.set(lang);
    this.applyLang(lang);
    try {
      localStorage.setItem(LS_KEY, lang);
    } catch {
      // storage may be unavailable (private mode); non-fatal
    }
  }

  /**
   * Keep `<html lang>` honest.
   *
   * index.html ships `lang="en"` because it has to say something, but the app defaults to 'pt' and
   * switches at runtime — so without this the document claimed English while rendering Portuguese.
   * That mismatch is exactly what makes Chrome offer to translate the page, on top of a UI that
   * already ships seven languages. (`translate="no"` in index.html stops the offer; this stops the
   * lie, which also matters for screen readers picking a voice and for `:lang()` rules.)
   *
   * Mirrors how PrefsStore writes accent/density onto <html>.
   */
  private applyLang(lang: Lang): void {
    // zh is Simplified Chinese: the BCP-47 tag makes the browser pick Simplified glyphs/fonts.
    document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : lang;
  }

  private resolveInitial(): Lang {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved && LANGS.includes(saved as Lang)) return saved as Lang;
    } catch {
      // ignore; fall through to browser/default
    }
    const nav = (navigator.language || '').slice(0, 2).toLowerCase();
    if (LANGS.includes(nav as Lang)) return nav as Lang;
    return 'pt';
  }
}
