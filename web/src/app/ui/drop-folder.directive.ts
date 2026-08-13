import { Directive, ElementRef, inject, input } from '@angular/core';
import { LibraryStore } from '../core/library-store';

/**
 * Marks the host element as a drop target for a folder path. Highlights with
 * `.drop-hot` while a valid drag hovers and moves the dragged ROMs on drop.
 * Usage: `<div [appDropFolder]="node.path"> ... </div>`.
 */
@Directive({
  selector: '[appDropFolder]',
  host: {
    '(dragover)': 'onOver($event)',
    '(dragleave)': 'onLeave($event)',
    '(drop)': 'onDrop($event)',
  },
})
export class DropFolder {
  readonly path = input.required<string>({ alias: 'appDropFolder' });
  private readonly lib = inject(LibraryStore);
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected onOver(e: DragEvent): void {
    if (!this.lib.dragActive() || !this.lib.canDropOn(this.path())) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    this.el.classList.add('drop-hot');
  }

  protected onLeave(e: DragEvent): void {
    // ignore leaving into a child element
    if (!this.el.contains(e.relatedTarget as Node | null)) this.el.classList.remove('drop-hot');
  }

  protected onDrop(e: DragEvent): void {
    this.el.classList.remove('drop-hot');
    if (!this.lib.dragActive() || !this.lib.canDropOn(this.path())) return;
    e.preventDefault();
    e.stopPropagation();
    const folder = this.lib.draggingFolder();
    if (folder !== null) void this.lib.moveFolder(folder, this.path());
    else void this.lib.moveEntries(this.lib.dragging(), this.path());
  }
}
