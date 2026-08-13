import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { PrefsStore } from './core/prefs-store';
import { LangService } from './core/lang.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<router-outlet />',
})
export class App {
  // Instantiate early so accent/density theming is applied on boot.
  private readonly prefs = inject(PrefsStore);
  // Instantiate early so the saved/browser language is applied before first render.
  private readonly lang = inject(LangService);
}
