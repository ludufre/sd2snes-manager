import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { UpdateService } from '../../../core/update.service';
import { Icon } from '../../../ui/icon/icon';

/** "New version available → Update" prompt (shown when the SW has a new build). */
@Component({
  selector: 'app-update-banner',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (upd.available()) {
      <div class="upd">
        <app-icon name="spark" [size]="15" />
        <span>{{ 'update.available' | transloco }}</span>
        <button class="btn sm primary" type="button" (click)="upd.activate()">{{ 'update.update' | transloco }}</button>
        <button class="btn ghost sm" type="button" [title]="'update.dismiss' | transloco" (click)="upd.dismiss()">
          <app-icon name="x" [size]="14" />
        </button>
      </div>
    }
  `,
  styles: `
    .upd {
      position: fixed; top: 70px; left: 50%; transform: translateX(-50%); z-index: 62;
      display: flex; align-items: center; gap: 10px;
      background: var(--elevated); border: 1px solid var(--accent-line); border-radius: 11px;
      padding: 7px 7px 7px 14px; box-shadow: 0 12px 34px rgba(0, 0, 0, 0.5);
      font-size: 13px; color: var(--tx); animation: drop 0.18s ease;
    }
    @keyframes drop { from { transform: translate(-50%, -8px); opacity: 0; } }
  `,
})
export class UpdateBanner {
  protected readonly upd = inject(UpdateService);
}
