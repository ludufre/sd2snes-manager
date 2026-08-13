import { Directive, inject, input } from '@angular/core';
import { ContextMenuService } from '../core/context-menu.service';
import type { Entry } from '../core/models';

/** Opens the ROM context menu on right-click (and suppresses the browser's). */
@Directive({
  selector: '[appContextEntry]',
  host: { '(contextmenu)': 'onCtx($event)' },
})
export class ContextEntry {
  readonly entry = input.required<Entry>({ alias: 'appContextEntry' });
  private readonly ctx = inject(ContextMenuService);

  protected onCtx(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    this.ctx.open(e.clientX, e.clientY, this.entry());
  }
}
