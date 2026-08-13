import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { marked } from 'marked';
import { VersionService } from '../../../core/version.service';
import { parseChangelog, type ChangelogEntry } from '../../../core/changelog';
import { Icon } from '../../../ui/icon/icon';

/** "What's new": release list + Markdown notes, read from the changelog shipped with the app. */
@Component({
  selector: 'app-changelog-dialog',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'close.emit()' },
  template: `
    <div class="scrim" (click)="close.emit()"></div>
    <div class="cl">
      <div class="clh">
        <h3>{{ 'changelog.heading' | transloco }}</h3>
        <span class="now">{{ ver.label() }}</span>
        <div class="grow"></div>
        <button class="btn ghost sm" type="button" [title]="'changelog.close' | transloco" (click)="close.emit()">
          <app-icon name="x" [size]="16" />
        </button>
      </div>

      @if (error()) {
        <div class="clmsg err">{{ 'changelog.loadError' | transloco: { error: error() } }}</div>
      } @else if (!entries()) {
        <div class="clmsg">{{ 'changelog.loading' | transloco }}</div>
      } @else if (entries()!.length === 0) {
        <div class="clmsg">{{ 'changelog.empty' | transloco }}</div>
      } @else {
        <div class="clbody">
          <div class="vlist scroll">
            @for (e of entries(); track e.version) {
              <button class="vitem" [class.on]="e.version === sel()?.version" type="button" (click)="sel.set(e)">
                <span class="vname">
                  {{ e.version }}
                  @if (e.version === running()) { <i class="cur">{{ 'changelog.current' | transloco }}</i> }
                </span>
                @if (e.date) { <span class="vmeta">{{ e.date }}</span> }
              </button>
            }
          </div>
          <div class="vnotes scroll">
            @if (sel(); as e) {
              <h4 class="vtitle">{{ e.version }}@if (e.date) { <span class="vdate">· {{ e.date }}</span> }</h4>
              <div class="md" [innerHTML]="html()"></div>
            }
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 58; }
    .cl {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 59;
      width: min(820px, 94vw); height: min(620px, 88vh); display: flex; flex-direction: column;
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); overflow: hidden;
    }
    .clh { display: flex; align-items: center; gap: 12px; padding: 13px 12px 12px 18px; border-bottom: 1px solid var(--line); }
    .clh h3 { margin: 0; font-size: 15px; }
    .clh .now { font-family: var(--mono); font-size: 11px; color: var(--tx-low); }
    .grow { flex: 1; }
    .clmsg { flex: 1; display: grid; place-items: center; color: var(--tx-low); font-family: var(--mono); font-size: 13px; padding: 20px; text-align: center; }
    .clmsg.err { color: var(--danger); }
    .clbody { flex: 1; min-height: 0; display: flex; }
    .vlist { width: 190px; flex: 0 0 190px; border-right: 1px solid var(--line); overflow: auto; padding: 8px; }
    .vitem {
      display: flex; flex-direction: column; gap: 3px; width: 100%; text-align: left; border: none; cursor: pointer;
      background: none; color: var(--tx); padding: 9px 10px; border-radius: 8px;
    }
    .vitem:hover { background: var(--elevated); }
    .vitem.on { background: var(--accent-soft); }
    .vitem .vname { font-family: var(--mono); font-size: 13px; font-weight: 500; display: flex; align-items: center; gap: 6px; }
    .vitem .cur {
      font-style: normal; font-size: 9px; text-transform: uppercase; letter-spacing: 0.4px;
      background: var(--accent-soft); color: var(--accent); padding: 1px 5px; border-radius: 4px;
    }
    .vitem .vmeta { font-family: var(--mono); font-size: 10.5px; color: var(--tx-low); }
    .vnotes { flex: 1; min-width: 0; overflow: auto; padding: 16px 20px; }
    .vtitle { margin: 0 0 14px; font-family: var(--mono); font-size: 15px; color: var(--tx); }
    .vtitle .vdate { font-size: 11px; color: var(--tx-low); font-weight: 400; margin-left: 6px; }

    /* Narrow window: the version list becomes a scrollable strip on top, so the notes keep the full
       width instead of being squeezed into a column too thin to read. */
    @media (max-width: 640px) {
      .clbody { flex-direction: column; }
      .vlist {
        width: auto; flex: 0 0 auto; border-right: none; border-bottom: 1px solid var(--line);
        display: flex; gap: 6px; overflow-x: auto; overflow-y: hidden; scrollbar-width: none;
      }
      .vlist::-webkit-scrollbar { display: none; }
      .vitem { width: auto; flex: 0 0 auto; padding: 7px 10px; }
      .vitem .vmeta { display: none; }
    }

    /* The rendered Markdown itself is styled globally (styles/_markdown.scss) — [innerHTML] nodes
       are out of reach of this component's scoped rules. */
  `,
})
export class ChangelogDialog {
  readonly close = output<void>();
  protected readonly ver = inject(VersionService);

  protected readonly entries = signal<ChangelogEntry[] | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly sel = signal<ChangelogEntry | null>(null);

  /** Version of the running build, so its entry can be badged. Absent under `ng serve`. */
  protected readonly running = computed(() => this.ver.info()?.version ?? null);

  protected readonly html = computed(() => {
    const e = this.sel();
    return e ? (marked.parse(e.body, { async: false }) as string) : '';
  });

  constructor() {
    // `changelog.txt`, not `.md`: the production host answers 404 to any `.md`/`.yml`/`.html` request
    // (by extension, before the SPA fallback), so a file named CHANGELOG.md is unreachable there even
    // though the deploy copies it. The content is still Markdown, only the extension is negotiable.
    // Relative URL → respects <base href> (the app is served under /manager/).
    fetch('changelog.txt')
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((md) => {
        // A missing file does not 404 here, the SPA fallback answers 200 with index.html. Without
        // this check that lands as "no versions recorded", which reads like an empty changelog
        // instead of a broken deploy.
        if (/^\s*</.test(md)) throw new Error('changelog.txt not served (SPA fallback returned HTML)');
        const list = parseChangelog(md);
        this.entries.set(list);
        // Newest first in the file, so the top entry is the one to show. Not the running version:
        // the point of opening this is usually "what changed since I last updated".
        this.sel.set(list[0] ?? null);
      })
      .catch((e: unknown) => this.error.set(e instanceof Error ? e.message : String(e)));
  }
}
