import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
} from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { LangService } from '../../core/lang.service';
import type { Entry } from '../../core/models';
import { coverTitle } from '../../core/format';
import { LibraryStore } from '../../core/library-store';
import { Icon } from '../icon/icon';

/** Box-art tile. Shows the live on-card thumbnail (decoded from the `.cov` lazily
 *  when scrolled into view), else the gamedb image (after Identify), else the
 *  mock gradient (demo), else a placeholder. */
@Component({
  selector: 'app-cover-art',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let g = entry();
    @let url = g.thumbUrl;
    @if (url) {
      <div class="cover image" [style.aspect-ratio]="aspect()">
        <img class="art-img" [src]="url" alt="" loading="lazy" crossorigin="anonymous" />
        @if (showFmt() && g.cover === 'custom') {
          <div class="badge-fmt">{{ 'cover.personal' | transloco }}</div>
        }
      </div>
    } @else if (hasGradient()) {
      <div class="cover" [style.aspect-ratio]="aspect()" [style.--cc1]="g.c1" [style.--cc2]="g.c2">
        <div class="art"></div>
        <div class="scan"></div>
        <div class="ttl">{{ title() }}</div>
        @if (showFmt() && g.cover === 'custom') {
          <div class="badge-fmt">{{ 'cover.personal' | transloco }}</div>
        }
      </div>
    } @else {
      <div class="cover placeholder" [style.aspect-ratio]="aspect()">
        <div class="ph">
          <app-icon name="image" [size]="18" />
          <span>{{ label() }}</span>
        </div>
      </div>
    }
  `,
  styles: `
    :host { display: block; width: 100%; }
    .cover {
      position: relative; aspect-ratio: 4 / 3; border-radius: 4px; overflow: hidden;
      display: grid; place-items: center; width: 100%;
      image-rendering: pixelated; background: #0c0e10;
    }
    .cover.image { image-rendering: auto; }
    .art-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
    .cover .art {
      position: absolute; inset: 0;
      background-image:
        radial-gradient(120% 90% at 50% 12%, color-mix(in oklab, var(--cc1) 75%, white 10%), transparent 60%),
        linear-gradient(160deg, var(--cc1), var(--cc2));
    }
    .cover .scan {
      position: absolute; inset: 0;
      background: repeating-linear-gradient(0deg, transparent 0 2px, rgba(0, 0, 0, 0.16) 2px 3px);
      mix-blend-mode: multiply;
    }
    .cover .ttl {
      position: relative; z-index: 2; text-align: center; padding: 0 8%;
      font-family: var(--mono); font-weight: 700; color: #fff; line-height: 1.05;
      text-transform: uppercase; letter-spacing: 0.5px;
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.5), 0 0 12px rgba(0, 0, 0, 0.35);
      font-size: clamp(8px, 2.4cqw, 15px);
    }
    .cover.placeholder { background: var(--panel); border: 1px dashed var(--line); }
    .cover .ph {
      position: absolute; inset: 0; z-index: 2; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 6px; text-align: center; padding: 4px;
      color: var(--tx-low); font-family: var(--mono); font-size: 10px; text-transform: uppercase; letter-spacing: 1px;
    }
    /* In tight cells (the 44px list thumbnail) drop the label and just centre the icon. */
    @container (max-width: 90px) {
      .cover .ph span { display: none; }
      .cover .ph { gap: 0; }
    }
    .cover .badge-fmt {
      position: absolute; bottom: 5px; right: 5px; z-index: 3;
      font-family: var(--mono); font-size: 8px; letter-spacing: 1px; padding: 1px 4px; border-radius: 3px;
      background: rgba(0, 0, 0, 0.55); color: #fff;
    }
  `,
})
export class CoverArt {
  readonly entry = input.required<Entry>();
  readonly showFmt = input(false);
  /** Override the tile aspect ratio (default 4/3); the detail showcase uses a portrait ratio. */
  readonly aspect = input('4 / 3');

  private readonly lib = inject(LibraryStore);
  private readonly host = inject(ElementRef);
  private readonly i18n = inject(TranslocoService);
  private readonly lang = inject(LangService);

  protected readonly hasGradient = computed(() => {
    const c = this.entry();
    return !!c.c1 && (c.cover === 'has' || c.cover === 'custom');
  });
  protected readonly title = computed(() => coverTitle(this.entry()));
  protected readonly label = computed(() => {
    this.lang.ready(); // translate() is not a signal, see LangService.ready
    return this.i18n.translate(this.entry().cover === 'available' ? 'cover.available' : 'cover.none');
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    // Decode the on-card .cov into a thumbnail only when scrolled into view.
    afterNextRender(() => {
      const obs = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting)) this.lib.ensureThumb(this.entry());
        },
        { rootMargin: '200px' },
      );
      obs.observe(this.host.nativeElement);
      destroyRef.onDestroy(() => obs.disconnect());
    });
  }
}
