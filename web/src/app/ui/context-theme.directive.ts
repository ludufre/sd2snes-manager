import { Directive, inject, input } from '@angular/core';
import { ContextMenuService } from '../core/context-menu.service';
import type { ThemeFile } from '../core/models';

/** Opens the theme-file context menu on right-click (and suppresses the browser's). */
@Directive({
  selector: '[appContextTheme]',
  host: { '(contextmenu)': 'onCtx($event)' },
})
export class ContextTheme {
  readonly theme = input.required<ThemeFile>({ alias: 'appContextTheme' });
  private readonly ctx = inject(ContextMenuService);

  protected onCtx(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.ctx.openTheme(e.clientX, e.clientY, this.theme());
  }
}
