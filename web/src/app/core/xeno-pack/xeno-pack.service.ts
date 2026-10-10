import { Injectable, signal } from '@angular/core';

/** Opens and closes the Xeno Crisis pack dialog from anywhere (the game's detail panel, the settings
 *  popover); the library screen hosts the one dialog. `entryId` preselects the ROM it belongs to. */
@Injectable({ providedIn: 'root' })
export class XenoPackService {
  private readonly _request = signal<{ entryId: string | null } | null>(null);
  readonly request = this._request.asReadonly();

  /** Bumped whenever the dialog closes, so the status shown beside the game re-reads the card. */
  readonly rev = signal(0);

  /** Re-read the card status shown beside the game (after something changed the files). */
  refresh(): void { this.rev.update((n) => n + 1); }

  open(entryId: string | null = null): void { this._request.set({ entryId }); }
  close(): void { this._request.set(null); this.rev.update((n) => n + 1); }
}
