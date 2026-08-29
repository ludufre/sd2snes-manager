import { Injectable, signal } from '@angular/core';

/**
 * Viewport shape as signals, the single source of truth for the layout breakpoints.
 *
 * Backed by matchMedia rather than a resize listener: it fires only when a threshold is actually
 * crossed, not on every pixel of a drag. The ladder is the one documented in styles/_tokens.scss,
 * and each query here has a matching `@media` in the components' own styles -- this service exists
 * for the decisions CSS cannot make (which component to render, whether a row is draggable).
 */
@Injectable({ providedIn: 'root' })
export class ViewportService {
  /** <= 860px: the sidebar floats over the list and the split view degrades to the drawer. */
  readonly narrow = signal(false);
  /** <= 640px: phone. One column, card actions move into the settings sheet. */
  readonly phone = signal(false);
  /** Touch (or any imprecise pointer). Independent of width: a tablet is coarse and wide. */
  readonly coarse = signal(false);

  constructor() {
    this.bind('(max-width: 860px)', this.narrow);
    this.bind('(max-width: 640px)', this.phone);
    this.bind('(pointer: coarse)', this.coarse);
  }

  private bind(query: string, target: { set(v: boolean): void }): void {
    const mq = window.matchMedia(query);
    target.set(mq.matches);
    mq.addEventListener('change', (e) => target.set(e.matches));
  }
}
