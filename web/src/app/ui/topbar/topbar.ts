import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { TranslocoModule } from '@jsverse/transloco';
import { LibraryStore } from '../../core/library-store';
import { VersionService } from '../../core/version.service';
import { LangService, type Lang } from '../../core/lang.service';
import { Icon } from '../icon/icon';

/** Top bar: logo + version + Changelog, connection chip, Firmware, Themes, BIOS, Organize, Eject,
 *  language, gear. */
@Component({
  selector: 'app-topbar',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './topbar.html',
  styleUrl: './topbar.scss',
})
export class Topbar {
  protected readonly lib = inject(LibraryStore);
  protected readonly ver = inject(VersionService);
  protected readonly langs = inject(LangService);
  readonly settingsOn = input(false);
  readonly toggleSettings = output<void>();
  readonly openFirmware = output<void>();
  readonly openBios = output<void>();
  readonly openThemes = output<void>();
  readonly openMigrate = output<void>();
  readonly openChangelog = output<void>();

  protected setLang(lang: Lang): void {
    this.langs.set(lang);
  }
}
