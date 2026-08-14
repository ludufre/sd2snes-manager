import { ChangeDetectionStrategy, Component, OnInit, inject, input, output, signal } from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';

@Component({
  selector: 'app-snes-combo-editor',
  imports: [TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="cancel.emit()"></div>
    <div class="editor" role="dialog" aria-modal="true">
      <h3>{{ title() | transloco }}</h3>
      @if (subtitle()) { <p class="sub">{{ subtitle() | transloco }}</p> }
    <svg class="controller" id="Controller-SNES" viewBox="0 0 462 208" style="background-color:#ffffff00" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" x="0px" y="0px" width="462px" height="208px">
    	<g id="SNES">
    		<!--<path id="Outline" d="M 1 107 C 1 162.2292 45.7708 207 101 207 C 128.9744 207 154.2658 195.5137 172.415 177 L 289.585 177 C 307.7342 195.5137 333.0256 207 361 207 C 416.2292 207 461 162.2292 461 107 C 461 51.7708 416.2292 7 361 7 L 101 7 C 45.7708 7 1 51.7708 1 107 Z" stroke="#000000" stroke-width="2" fill="none"/>-->
    		<g id="A" (click)="toggle('a')">
    			<path id="Button_A" [style.fill]="selected().has('a') ? '#fff' : '#ee3a3c'" d="M 376 108 C 376 94.1927 387.1928 83 401.0001 83 C 414.8073 83 426 94.1927 426 108 C 426 121.8073 414.8073 133 401.0001 133 C 387.1928 133 376 121.8073 376 108 Z" stroke="#000000" stroke-width="2" fill="#ee3a3c"></path>
    			<path id="Text_A" d="M 398.5938 112.6406 L 403.5938 112.6406 L 404.5 115 L 408.4063 115 L 403.0938 101 L 399.0938 101 L 393.7969 115 L 397.7031 115 L 398.5938 112.6406 L 398.5938 112.6406 ZM 401.0938 105.2969 L 402.7031 110 L 399.5 110 L 401.0938 105.2969 L 401.0938 105.2969 Z" stroke="#000000" stroke-width="1" fill="#ffffff"></path>
    		</g>
    		<g id="B" (click)="toggle('b')">
    			<path id="Button_B" [style.fill]="selected().has('b') ? '#fff' : '#fbde33'" d="M 336 146 C 336 132.1927 347.1927 121 361 121 C 374.8073 121 386 132.1927 386 146 C 386 159.8073 374.8073 171 361 171 C 347.1927 171 336 159.8073 336 146 Z" stroke="#000000" stroke-width="2" fill="#fbde33"></path>
    			<path id="Text_B" d="M 354.7031 153 L 363.2969 153 C 364.6094 153 365.5625 152.6875 366.1719 152.0469 C 366.7813 151.4063 367.0938 150.3906 367.0938 149.0156 C 367.0938 148.4531 367.0156 147.9375 366.8906 147.5 C 366.75 147.0625 366.5625 146.7031 366.3438 146.3906 C 366.125 146.0781 365.8594 145.8438 365.5781 145.6563 C 365.2813 145.4688 364.9844 145.3438 364.7031 145.25 C 365.2031 145.0625 365.625 144.7344 365.9688 144.2656 C 366.3125 143.7969 366.5 143.1719 366.5 142.4063 C 366.5 141.2656 366.1875 140.4063 365.5781 139.8438 C 364.9531 139.2813 364 139 362.7031 139 L 354.7031 139 L 354.7031 153 L 354.7031 153 ZM 363.5 148.8594 C 363.5 149.7969 363.0938 150.25 362.2969 150.25 L 358.2969 150.25 L 358.2969 147 L 362.2969 147 C 363.0938 147 363.5 147.4688 363.5 148.3906 L 363.5 148.8594 L 363.5 148.8594 ZM 362.9063 143.1719 C 362.9063 143.8906 362.5 144.25 361.7031 144.25 L 358.2969 144.25 L 358.2969 141.75 L 361.7031 141.75 C 362.5 141.75 362.9063 142.1094 362.9063 142.8281 L 362.9063 143.1719 L 362.9063 143.1719 Z" stroke="#000000" stroke-width="1" fill="#ffffff"></path>
    		</g>
    		<g id="X" (click)="toggle('x')">
    			<path id="Button_X" [style.fill]="selected().has('x') ? '#fff' : '#32c4e9'" d="M 335 69 C 335 55.1927 346.1927 44 360 44 C 373.8073 44 385 55.1927 385 69 C 385 82.8073 373.8073 94 360 94 C 346.1927 94 335 82.8073 335 69 Z" stroke="#000000" stroke-width="2" fill="#32c4e9"></path>
    			<path id="Text_X" d="M 360.0938 66.5469 L 357.375 62 L 353.4063 62 L 357.9063 69.0938 L 353.2969 76 L 357.2969 76 L 360.0938 71.6563 L 362.9063 76 L 366.9063 76 L 362.2969 69.0938 L 366.7969 62 L 362.7969 62 L 360.0938 66.5469 L 360.0938 66.5469 Z" stroke="#000000" stroke-width="1" fill="#ffffff"></path>
    		</g>
    		<g id="Y" (click)="toggle('y')">
    			<path id="Button_Y" [style.fill]="selected().has('y') ? '#fff' : '#6dbf52'" d="M 295 109 C 295 95.1927 306.1927 84 319.9999 84 C 333.8072 84 345 95.1927 345 109 C 345 122.8073 333.8072 134 319.9999 134 C 306.1927 134 295 122.8073 295 109 Z" stroke="#000000" stroke-width="2" fill="#6dbf52"></path>
    			<path id="Text_Y" d="M 318.4063 112.3594 L 318.4063 116 L 322 116 L 322 112.3594 L 327.2969 102 L 323.5 102 L 320.2031 108.9063 L 316.9063 102 L 313.0938 102 L 318.4063 112.3594 L 318.4063 112.3594 Z" stroke="#000000" stroke-width="1" fill="#ffffff"></path>
    		</g>
    		<g id="R" (click)="toggle('R')">
    			<path id="Button_R" [style.fill]="selected().has('R') ? '#fff' : '#afafaf'" d="M 311 1 L 388 1 C 388 1 421 11.4771 421 17 C 421 17 416.5229 37 411 37 L 388 27 L 311 27 C 305.4771 27 301 22.5229 301 17 L 301 11 C 301 5.4771 305.4771 1 311 1 Z" stroke="#000000" stroke-width="2" fill="#afafaf"></path>
    			<path id="Text_R" d="M 354.7031 21 L 358.2969 21 L 358.2969 16.75 L 361.0938 16.75 L 363.4063 21 L 367.2969 21 L 364.7969 16.5625 C 365.5938 16.375 366.1719 15.9688 366.5469 15.3594 C 366.9063 14.75 367.0938 13.8906 367.0938 12.7813 L 367.0938 10.9844 C 367.0938 9.5938 366.7656 8.5781 366.1406 7.9531 C 365.5156 7.3281 364.5 7 363.0938 7 L 354.7031 7 L 354.7031 21 L 354.7031 21 ZM 363.5 12.7813 C 363.5 13.5938 363.0938 14 362.2969 14 L 358.2969 14 L 358.2969 9.75 L 362.2969 9.75 C 363.0938 9.75 363.5 10.1563 363.5 10.9688 L 363.5 12.7813 L 363.5 12.7813 Z" stroke="#000000" stroke-width="1" fill="#ffffff"></path>
    		</g>
    		<g id="L" (click)="toggle('L')">
    			<path id="Button_L" [style.fill]="selected().has('L') ? '#fff' : '#afafaf'" d="M 152 1 L 75 1 C 75 1 42 11.4771 42 17 C 42 17 46.4771 37 52 37 L 75 27 L 152 27 C 157.5229 27 162 22.5229 162 17 L 162 11 C 162 5.4771 157.5229 1 152 1 Z" stroke="#000000" stroke-width="2" fill="#afafaf"></path>
    			<path id="Text_L" d="M 100.1298 7 L 96.5 7 L 96.5 21 L 107.5 21 L 107.5 18.1563 L 100.1298 18.1563 L 100.1298 7 L 100.1298 7 Z" stroke="#000000" stroke-width="1" fill="#ffffff"></path>
    		</g>
    		<path (click)="toggle('S')" [style.fill]="selected().has('S') ? '#fff' : '#6b6b6b'" id="Button_START" d="M 263.2132 87.929 L 234.9289 116.2133 C 231.0236 120.1185 231.0236 126.4501 234.9289 130.3554 L 234.9289 130.3554 C 238.8342 134.2607 245.1658 134.2607 249.071 130.3554 L 277.3553 102.0711 C 281.2606 98.1658 281.2606 91.8343 277.3553 87.929 L 277.3553 87.929 C 273.45 84.0237 267.1185 84.0237 263.2132 87.929 Z" stroke="#000000" stroke-width="2" fill="#6b6b6b"></path>
    		<path (click)="toggle('s')" [style.fill]="selected().has('s') ? '#fff' : '#6b6b6b'" id="Button_SELECT" d="M 213.2132 86.929 L 184.929 115.2133 C 181.0237 119.1185 181.0237 125.4501 184.929 129.3554 L 184.929 129.3554 C 188.8342 133.2607 195.1658 133.2607 199.0711 129.3554 L 227.3553 101.0711 C 231.2606 97.1658 231.2606 90.8343 227.3553 86.929 L 227.3553 86.929 C 223.4501 83.0237 217.1185 83.0237 213.2132 86.929 Z" stroke="#000000" stroke-width="2" fill="#6b6b6b"></path>
    		<g id="Dpad">
          <path id="Pad" d="M 91 47 C 85.4771 47 81 51.4771 81 57 L 81 87 L 51 87 C 45.4771 87 41 91.4771 41 97 L 41 117 C 41 122.5229 45.4771 127 51 127 L 81 127 L 81 157 C 81 162.5229 85.4771 167 91 167 L 111 167 C 116.5229 167 121 162.5229 121 157 L 121 127 L 151 127 C 156.5229 127 161 122.5229 161 117 L 161 97 C 161 91.4771 156.5229 87 151 87 L 121 87 L 121 57 C 121 51.4771 116.5229 47 111 47 L 91 47 Z" stroke="#000000" stroke-width="4" fill="#6b6b6b"></path>
          <g class="dpad-hits" fill="none" pointer-events="all">
            <rect x="81" y="47" width="40" height="48" (click)="toggle('u')"></rect>
            <rect x="81" y="119" width="40" height="48" (click)="toggle('d')"></rect>
            <rect x="41" y="87" width="48" height="40" (click)="toggle('l')"></rect>
            <rect x="113" y="87" width="48" height="40" (click)="toggle('r')"></rect>
          </g>
    			<path (click)="toggle('d')" [style.fill]="selected().has('d') ? '#fff' : '#6b6b6b'" id="Button_DOWN" d="M 81 127 L 81 157 C 81 162.5229 85.4771 167 91 167 L 111 167 C 116.5229 167 121 162.5229 121 157 L 121 127 L 101 107 L 81 127 Z" stroke="#6b6b6b" stroke-width="1" fill="#6b6b6b"></path>
    			<path (click)="toggle('r')" [style.fill]="selected().has('r') ? '#fff' : '#6b6b6b'" id="Button_RIGHT" d="M 121 127 L 151 127 C 156.5229 127 161 122.5229 161 117 L 161 97 C 161 91.4771 156.5229 87 151 87 L 121 87 L 101 107 L 121 127 Z" stroke="#6b6b6b" stroke-width="1" fill="#6b6b6b"></path>
    			<path (click)="toggle('u')" [style.fill]="selected().has('u') ? '#fff' : '#6b6b6b'" id="Button_UP" d="M 91 47 C 85.4771 47 81 51.4771 81 57 L 81 87 L 101 107 L 121 87 L 121 57 C 121 51.4771 116.5229 47 111 47 L 91 47 Z" stroke="#6b6b6b" stroke-width="1" fill="#6b6b6b"></path>
    			<path (click)="toggle('l')" [style.fill]="selected().has('l') ? '#fff' : '#6b6b6b'" id="Button_LEFT" d="M 81 87 L 51 87 C 45.4771 87 41 91.4771 41 97 L 41 117 C 41 122.5229 45.4771 127 51 127 L 81 127 L 101 107 L 81 87 Z" stroke="#6b6b6b" stroke-width="1" fill="#6b6b6b"></path>
          <path id="Arrows" d="M 150.125 106.625 L 132.875 96.6657 L 132.875 116.5843 L 150.125 106.625 ZM 101.5 156.25 L 111.4593 139 L 91.5407 139 L 101.5 156.25 ZM 101.5 58 L 91.5407 75.25 L 111.4593 75.25 L 101.5 58 ZM 52.875 107.625 L 70.125 117.5843 L 70.125 97.6657 L 52.875 107.625 ZM 88.5 107 C 88.5 113.9036 94.0964 119.5 101 119.5 C 107.9036 119.5 113.5 113.9036 113.5 107 C 113.5 100.0964 107.9036 94.5 101 94.5 C 94.0964 94.5 88.5 100.0964 88.5 107 Z" fill="#333333"></path>
    		</g>
    	</g>
    </svg>

      <p class="selected">{{ pretty(selectedString()) }}</p>
      <div class="actions"><button class="btn" type="button" (click)="cancel.emit()">{{ 'config.cancel' | transloco }}</button><button class="btn primary" type="button" (click)="submit()">{{ 'config.apply' | transloco }}</button></div>
    </div>
  `,
  styles: `
    .scrim { position:fixed; inset:0; z-index:60; background:rgba(0,0,0,.5); }
    .editor { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:min(600px,calc(100vw - 32px)); z-index:61; background:var(--panel); border:1px solid var(--line); border-radius:16px; box-shadow:0 24px 60px rgba(0,0,0,.55); padding:18px; }
    h3 { margin:0; font-size:15px; }.sub { color:var(--tx-low); font-size:12px; margin:4px 0 8px; }.controller { display:block; width:100%; max-height:250px; }.controller [id^=Button_],.controller #A,.controller #B,.controller #X,.controller #Y,.controller #L,.controller #R,.controller .dpad-hits rect { cursor:pointer; }.controller .dpad-hits,.controller .dpad-hits rect { fill:none; pointer-events:all; }.controller #Arrows,.controller [id^=Text_] { pointer-events:none; }.selected { text-align:center; font:14px var(--mono); color:var(--accent); min-height:17px; }.actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
  `,
})
export class SnesComboEditor implements OnInit {
  private readonly i18n = inject(TranslocoService);
  readonly value = input('');
  readonly allowDpad = input(true);
  readonly title = input('config.editTitle');
  readonly subtitle = input('');
  readonly apply = output<string>();
  readonly cancel = output<void>();
  protected readonly selected = signal<Set<string>>(new Set());

  ngOnInit(): void { this.selected.set(this.normalized(this.value())); }
  protected selectedString(): string { return this.serialized(this.selected()); }
  protected toggle(key: string): void {
    if (!this.allowDpad() && 'udlr'.includes(key)) return;
    this.selected.update((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else {
        const opposite: Record<string, string> = { u: 'd', d: 'u', l: 'r', r: 'l' };
        if (opposite[key]) next.delete(opposite[key]);
        next.add(key);
      }
      return next;
    });
  }
  protected submit(): void {
    const selected = this.normalized(this.selectedString());
    this.selected.set(selected);
    this.apply.emit(this.serialized(selected));
  }
  private normalized(value: string): Set<string> {
    const result = new Set<string>();
    const opposite: Record<string, string> = { u: 'd', d: 'u', l: 'r', r: 'l' };
    for (const rawKey of value) {
      const key = 'BYAX'.includes(rawKey) ? rawKey.toLowerCase() : rawKey;
      if (opposite[key]) result.delete(opposite[key]);
      result.add(key);
    }
    return result;
  }
  private serialized(value: ReadonlySet<string>): string {
    return [...value].map((key) => 'byax'.includes(key) ? key.toUpperCase() : key).join('');
  }
  protected pretty(value: string): string { const names: Record<string,string> = { s:'select',S:'start',u:'up',d:'down',l:'left',r:'right',L:'L',R:'R',a:'A',b:'B',x:'X',y:'Y' }; return [...value].map((c) => this.i18n.translate(`config.buttons.${names[c] ?? c}`)).join(' + ') || this.i18n.translate('config.none'); }
}
