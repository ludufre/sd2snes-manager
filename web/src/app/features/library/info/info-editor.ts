import { ChangeDetectionStrategy, Component, effect, inject, input, output, signal } from '@angular/core';
import { LibraryStore } from '../../../core/library-store';
import { LangService } from '../../../core/lang.service';
import type { DescLang, Entry } from '../../../core/models';
import { Icon } from '../../../ui/icon/icon';
import { TranslocoModule } from '@jsverse/transloco';

/** Editable game-info fields (mirrors the `.yml` keys buildYml writes). `description` is the
 *  canonical english text; `description_<lang>` carries each translation. The console reads the key
 *  for its menu language and falls back to English when that one is missing or empty. */
interface Ficha {
  title: string;
  developer: string;
  publisher: string;
  release_year: string;
  players: string;
  genre: string;
  special_chip: string;
  description: string;
  description_pt: string;
  description_es: string;
  description_de: string;
  description_fr: string;
  description_it: string;
}
const EMPTY: Ficha = {
  title: '', developer: '', publisher: '', release_year: '', players: '', genre: '', special_chip: '',
  description: '', description_pt: '', description_es: '', description_de: '', description_fr: '', description_it: '',
};

/** Description tabs: English first (it is the canonical text and every other language's fallback),
 *  then the translations. */
type DescTab = 'en' | DescLang;
const DESC_TABS: readonly DescTab[] = ['en', 'pt', 'es', 'de', 'fr', 'it'];

/** Which Ficha field a tab edits. */
function descField(tab: DescTab): keyof Ficha {
  return tab === 'en' ? 'description' : (`description_${tab}` as keyof Ficha);
}

/** Edit the game metadata (the on-card `/sd2snes/info/<C>/<stem>.yml` ficha) in a modal. */
@Component({
  selector: 'app-info-editor',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="close.emit()"></div>
    <div class="ed">
      <div class="eh">
        <h3>{{ 'info.title' | transloco }}</h3>
        <button class="btn ghost sm" type="button" (click)="close.emit()"><app-icon name="x" [size]="16" /></button>
      </div>

      <div class="ebody scroll">
        <div class="grid">
          <label class="fl full"><span>{{ 'info.name' | transloco }}</span><input class="fi" type="text" [value]="form().title" (input)="set('title', $event)" /></label>
          <label class="fl"><span>{{ 'info.developer' | transloco }}</span><input class="fi" type="text" [value]="form().developer" (input)="set('developer', $event)" /></label>
          <label class="fl"><span>{{ 'info.publisher' | transloco }}</span><input class="fi" type="text" [value]="form().publisher" (input)="set('publisher', $event)" /></label>
          <label class="fl"><span>{{ 'info.year' | transloco }}</span><input class="fi" type="text" inputmode="numeric" [value]="form().release_year" (input)="set('release_year', $event)" /></label>
          <label class="fl"><span>{{ 'info.players' | transloco }}</span><input class="fi" type="text" [value]="form().players" (input)="set('players', $event)" /></label>
          <label class="fl"><span>{{ 'info.genre' | transloco }}</span><input class="fi" type="text" [value]="form().genre" (input)="set('genre', $event)" /></label>
          <label class="fl"><span>{{ 'info.specialChip' | transloco }}</span><input class="fi" type="text" [value]="form().special_chip" (input)="set('special_chip', $event)" /></label>
          <div class="fl full">
            <div class="dhead">
              <span>{{ 'info.description' | transloco }}</span>
              <div class="tabs" role="tablist" [attr.aria-label]="'info.descriptionLang' | transloco">
                @for (t of tabs; track t) {
                  <button class="tab" type="button" role="tab" [attr.aria-selected]="descTab() === t"
                          [class.on]="descTab() === t" [class.filled]="!!value(t)" (click)="descTab.set(t)">{{ t.toUpperCase() }}</button>
                }
              </div>
            </div>
            <textarea class="fi" rows="5" [value]="value(descTab())" (input)="set(field(descTab()), $event)"></textarea>
            <small class="hint">{{ (descTab() === 'en' ? 'info.descriptionEnHint' : 'info.descriptionLangHint') | transloco }}</small>
          </div>
        </div>
      </div>

      <div class="ef">
        <div class="grow"></div>
        <button class="btn ghost sm" type="button" (click)="close.emit()">{{ 'info.cancel' | transloco }}</button>
        <button class="btn sm primary" type="button" [disabled]="saving() || !entry().fileHandle" (click)="save()">
          <app-icon name="save" [size]="13" />{{ saving() ? ('info.saving' | transloco) : ('info.save' | transloco) }}
        </button>
      </div>
    </div>
  `,
  styles: `
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 58; }
    .ed {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 59;
      width: min(560px, 95vw); max-height: 88vh; display: flex; flex-direction: column;
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); overflow: hidden;
    }
    .eh { display: flex; align-items: center; justify-content: space-between; padding: 14px 12px 12px 18px; border-bottom: 1px solid var(--line); }
    .eh h3 { margin: 0; font-size: 15px; }
    .ebody { overflow: auto; padding: 16px 18px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 12px; }
    .fl { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
    .fl.full { grid-column: 1 / -1; }
    .fl > span { font-size: 11.5px; color: var(--tx-mid); }
    .fi {
      width: 100%; box-sizing: border-box; font-family: var(--sans); font-size: 13px; padding: 8px 10px;
      color: var(--tx); background: var(--bg); border: 1px solid var(--line); border-radius: 8px; outline: none;
    }
    .fi:focus { border-color: var(--accent); }
    textarea.fi { resize: vertical; min-height: 90px; }
    .dhead { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 5px; }
    .dhead > span { font-size: 11.5px; color: var(--tx-mid); }
    .tabs { display: flex; gap: 3px; flex-wrap: wrap; }
    .tab {
      font-family: var(--sans); font-size: 10.5px; font-weight: 600; letter-spacing: 0.03em; line-height: 1;
      padding: 4px 6px; border-radius: 6px; cursor: pointer;
      color: var(--tx-low); background: transparent; border: 1px solid transparent;
    }
    .tab:hover { color: var(--tx); }
    /* a dot marks a language that already has text, so empty translations are visible at a glance */
    .tab.filled::after { content: '•'; margin-left: 3px; color: var(--accent); }
    .tab.on { color: var(--tx); background: var(--bg); border-color: var(--line); }
    .hint { margin-top: 5px; font-size: 10.5px; color: var(--tx-low); }
    .ef { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--panel-2); }
    .grow { flex: 1; }
  `,
})
export class InfoEditor {
  readonly entry = input.required<Entry>();
  readonly close = output<void>();
  private readonly lib = inject(LibraryStore);
  private readonly langs = inject(LangService);

  protected readonly form = signal<Ficha>(EMPTY);
  protected readonly saving = signal(false);
  protected readonly tabs = DESC_TABS;
  /** Opens on the app's own language (that is the description the user can judge); English otherwise. */
  protected readonly descTab = signal<DescTab>(
    DESC_TABS.includes(this.langs.lang() as DescTab) ? (this.langs.lang() as DescTab) : 'en',
  );
  private seeded = false;

  constructor() {
    effect(() => {
      const g = this.entry();
      if (this.seeded || !g) return;
      this.seeded = true;
      // immediate from the gamedb match, then refine with the on-card .yml if present.
      this.form.set(this.fichaFrom(g, null));
      void this.lib.readInfoYml(g).then((yml) => {
        if (yml && this.entry()?.id === g.id) this.form.set(this.fichaFrom(g, yml));
      });
    });
  }

  private fichaFrom(g: Entry, yml: Record<string, string> | null): Ficha {
    return {
      title: yml?.['title'] ?? g.title ?? '',
      developer: yml?.['developer'] ?? g.developer ?? '',
      publisher: yml?.['publisher'] ?? g.publisher ?? '',
      release_year: yml?.['release_year'] ?? (g.releaseYear != null ? String(g.releaseYear) : ''),
      players: yml?.['players'] ?? g.players ?? '',
      genre: yml?.['genre'] ?? g.genre ?? '',
      special_chip: yml?.['special_chip'] ?? g.specialChip ?? '',
      description: yml?.['description'] ?? g.description ?? '',
      description_pt: yml?.['description_pt'] ?? g.descriptions?.pt ?? '',
      description_es: yml?.['description_es'] ?? g.descriptions?.es ?? '',
      description_de: yml?.['description_de'] ?? g.descriptions?.de ?? '',
      description_fr: yml?.['description_fr'] ?? g.descriptions?.fr ?? '',
      description_it: yml?.['description_it'] ?? g.descriptions?.it ?? '',
    };
  }

  /** The Ficha field a description tab edits, and its current text. */
  protected field(tab: DescTab): keyof Ficha {
    return descField(tab);
  }
  protected value(tab: DescTab): string {
    return this.form()[descField(tab)];
  }

  protected set(key: keyof Ficha, e: Event): void {
    const v = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.form.update((f) => ({ ...f, [key]: v }));
  }

  protected async save(): Promise<void> {
    this.saving.set(true);
    try {
      // every description_<lang> key is passed explicitly (empty = cleared), so this editor is
      // authoritative over the translations and saveInfoYml preserves nothing behind its back.
      await this.lib.saveInfoYml(this.entry(), { ...this.form() });
      this.close.emit();
    } finally {
      this.saving.set(false);
    }
  }
}
