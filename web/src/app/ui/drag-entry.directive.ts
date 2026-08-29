import { Directive, inject, input } from '@angular/core';
import { LibraryStore } from '../core/library-store';
import { ViewportService } from '../core/viewport.service';

/**
 * Makes a ROM row/card draggable. On dragstart it begins the entry drag (the
 * whole selection if the row is checked) and, for a multi-drag, swaps the native
 * single-element drag image for a "N ROMs" badge.
 */
@Directive({
  selector: '[appDragEntry]',
  host: {
    '[draggable]': 'vp.coarse() ? null : true',
    '(dragstart)': 'onStart($event)',
    '(dragend)': 'lib.endDrag()',
  },
})
export class DragEntry {
  readonly id = input.required<string>({ alias: 'appDragEntry' });
  protected readonly lib = inject(LibraryStore);
  /**
   * Not draggable under a coarse pointer. HTML5 drag-and-drop never fires from touch, so the
   * attribute buys nothing there — and it actively costs: on Android a draggable element swallows
   * the long-press, which is the gesture that has to open the context menu. That menu is the only
   * way to reach Identify, Move, and every delete, so leaving this on made them unreachable.
   */
  protected readonly vp = inject(ViewportService);

  protected onStart(e: DragEvent): void {
    this.lib.beginDragEntry(this.id());
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    const n = this.lib.dragging().length;
    if (n > 1 && e.dataTransfer) {
      const ghost = document.createElement('div');
      ghost.className = 'drag-ghost';
      ghost.textContent = `${n} ROMs`;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 16, 16);
      setTimeout(() => ghost.remove(), 0);
    }
  }
}
