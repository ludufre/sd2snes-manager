import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type IconName =
  | 'search' | 'folder' | 'folderOpen' | 'panelLeft' | 'sd' | 'list' | 'grid'
  | 'split' | 'image' | 'download' | 'refresh' | 'trash' | 'edit' | 'x'
  | 'chevron' | 'check' | 'save' | 'settings' | 'spark' | 'plus' | 'moreHorizontal' | 'folderPlus' | 'move'
  | 'play' | 'pause' | 'sound' | 'mute'
  | 'monitor' | 'film' | 'info' | 'upload' | 'cheats' | 'eject' | 'palette' | 'book' | 'eye';

/** Lucide-style stroked icons (ported from the prototype's Icon set). */
@Component({
  selector: 'app-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      @switch (name()) {
        @case ('search') { <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /> }
        @case ('folder') { <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /> }
        @case ('folderOpen') { <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2H6a2 2 0 0 0-1.9 1.4L3 18zM3 18l1.6-5.2A2 2 0 0 1 6.5 11H22l-2.1 6.3a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-2z" /> }
        @case ('panelLeft') { <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /> }
        @case ('sd') { <path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M10 3v4M13 3v4M16 4v3" /> }
        @case ('list') { <path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" /> }
        @case ('grid') { <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /> }
        @case ('split') { <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16" /> }
        @case ('image') { <rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-5-5L5 21" /> }
        @case ('download') { <path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 21h14" /> }
        @case ('refresh') { <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v4h-4" /> }
        @case ('eject') { <path d="M5 17h14" /><path d="M12 4 5 13h14L12 4z" /> }
        @case ('trash') { <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v12a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7" /> }
        @case ('edit') { <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /> }
        @case ('x') { <path d="M18 6 6 18M6 6l12 12" /> }
        @case ('chevron') { <path d="m9 6 6 6-6 6" /> }
        @case ('check') { <path d="M20 6 9 17l-5-5" /> }
        @case ('save') { <path d="M5 3h11l3 3v15H5z" /><path d="M8 3v5h7M8 21v-7h8v7" /> }
        @case ('settings') { <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /> }
        @case ('spark') { <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /> }
        @case ('plus') { <path d="M12 5v14M5 12h14" /> }
        @case ('moreHorizontal') { <circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /> }
        @case ('folderPlus') { <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M12 11v5M9.5 13.5h5" /> }
        @case ('move') { <path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" /> }
        @case ('play') { <path d="M7 4v16l13-8z" /> }
        @case ('pause') { <rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /> }
        @case ('sound') { <path d="M11 5 6 9H2v6h4l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /> }
        @case ('mute') { <path d="M11 5 6 9H2v6h4l5 4z" /><path d="m23 9-6 6M17 9l6 6" /> }
        @case ('monitor') { <rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /> }
        @case ('film') { <rect x="2" y="3" width="20" height="18" rx="2" /><path d="M2 9h20M2 15h20M7 3v18M17 3v18" /> }
        @case ('info') { <circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" /> }
        @case ('upload') { <path d="M12 16V4m0 0-4 4m4-4 4 4" /><path d="M4 20h16" /> }
        @case ('cheats') { <rect x="2" y="7" width="20" height="10" rx="5" /><path d="M7 11v2M6 12h2" /><circle cx="15.5" cy="11.5" r="1" /><circle cx="18" cy="13.5" r="1" /> }
        @case ('palette') { <path d="M12 3a9 9 0 1 0 0 18c1 0 1.7-.8 1.7-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H16a5 5 0 0 0 5-5c0-3.9-4-7-9-7z" /><circle cx="7.5" cy="10.5" r="1" /><circle cx="12" cy="7.5" r="1" /><circle cx="16.5" cy="10.5" r="1" /> }
        @case ('book') { <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /> }
        @case ('eye') { <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /> }
      }
    </svg>
  `,
  styles: `:host { display: inline-grid; place-items: center; line-height: 0; }`,
})
export class Icon {
  readonly name = input.required<IconName>();
  readonly size = input(16);
}
