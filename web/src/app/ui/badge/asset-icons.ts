import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { Icon, type IconName } from '../icon/icon';
import type { Entry } from '../../core/models';

type AssetState = 'has' | 'available' | 'none' | 'busy';
interface AssetInd { key: string; icon: IconName; color: string; state: AssetState; title: string; }

/** Compact status row, one coloured icon per asset (Capa · Snapshot · Prévia · Cheats · Guias):
 *  lit when present, dimmed when only available to generate, faint when there's no source,
 *  pulsing while that asset is being generated. Replaces the old text badges in the list/gallery.
 *  Icons/colours mirror BOARD_COLS so a row and the statbar board read as the same vocabulary. */
@Component({
  selector: 'app-asset-icons',
  imports: [Icon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ai">
      @for (a of assets(); track a.key) {
        <span class="ic" [class]="a.state" [style.--c]="a.color" [title]="a.title">
          <app-icon [name]="a.icon" [size]="15" />
        </span>
      }
    </div>
  `,
  styles: `
    .ai { display: inline-flex; align-items: center; gap: 7px; }
    .ic { display: inline-grid; place-items: center; color: var(--tx-low); opacity: 0.3; transition: opacity 0.12s, color 0.12s; }
    .ic.has { color: var(--c); opacity: 1; }
    /* available but not generated yet: tinted + faded so it reads as "could add" */
    .ic.available { color: var(--c); opacity: 0.5; }
    .ic.busy { color: var(--accent); opacity: 1; animation: aip 1s ease-in-out infinite; }
    @keyframes aip { 50% { opacity: 0.35; } }
  `,
})
export class AssetIcons {
  private readonly i18n = inject(TranslocoService);
  readonly entry = input.required<Entry>();

  protected readonly assets = computed<AssetInd[]>(() => {
    const g = this.entry();
    const t = (k: string) => this.i18n.translate(k);
    const word = (s: AssetState, has: string, avail: string, none: string, busy: string) =>
      s === 'busy' ? t(busy) : s === 'has' ? t(has) : s === 'available' ? t(avail) : t(none);

    const capaState: AssetState =
      g.busy === 'cover' ? 'busy' : g.cover === 'has' || g.cover === 'custom' ? 'has' : g.cover === 'available' ? 'available' : 'none';
    const snapState: AssetState =
      g.busy === 'cover' || g.busy === 'snapshot' ? 'busy' : g.snapshot === 'has' ? 'has' : g.screenshotUrl ? 'available' : 'none';
    const previaState: AssetState =
      g.busy === 'fmv' ? 'busy' : g.fmv === 'has' ? 'has' : g.videoUrl ? 'available' : 'none';
    const cheatsState: AssetState =
      g.busy === 'cheats' ? 'busy' : g.cheats === 'has' ? 'has' : g.cheats === 'available' ? 'available' : 'none';
    // Any `.man` on the card counts (slot 0 + the user's 2..8), same question the board's `guias`
    // column asks, not just the official manual auto-fill owns.
    const guiasState: AssetState =
      g.busy === 'guide' ? 'busy' : (g.guides ?? 0) > 0 ? 'has' : g.manualUrl || g.manuals?.length ? 'available' : 'none';

    return [
      { key: 'capa', icon: 'image', color: 'var(--accent)', state: capaState,
        title: t('badge.coverLabel') + word(capaState, 'badge.generatedF', 'badge.availToGen', 'badge.noSource', 'badge.generatingF') },
      { key: 'snap', icon: 'monitor', color: 'var(--info)', state: snapState,
        title: t('badge.snapshotLabel') + word(snapState, 'badge.generatedM', 'badge.availToGen', 'badge.noSource', 'badge.generatingM') },
      { key: 'previa', icon: 'film', color: '#ff5c8a', state: previaState,
        title: t('badge.previewLabel') + word(previaState, 'badge.generatedF', 'badge.availToGen', 'badge.noSource', 'badge.generatingF') },
      { key: 'cheats', icon: 'cheats', color: 'var(--ok)', state: cheatsState,
        title: t('badge.cheatsLabel') + word(cheatsState, 'badge.installed', 'badge.available', 'badge.noCheats', 'badge.downloading') },
      // Doesn't go through `word()`: "has" says how many, a game with 3 guides and one with 1 look
      // identical otherwise, and the count is the whole point of the slot-based `.man` layout.
      { key: 'guias', icon: 'book', color: '#c98cff', state: guiasState,
        title: t('badge.guidesLabel') + (
          guiasState === 'busy' ? t('badge.guidesBusy')
          : guiasState === 'has' ? this.i18n.translate('badge.guidesOnCard', { count: g.guides })
          : guiasState === 'available' ? t('badge.guidesAvail')
          : t('badge.noGuides')) },
    ];
  });
}
