import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { LibraryStore } from '../../../core/library-store';
import { MENU_COMBO_DEFAULT, menuComboError as checkMenuCombo, menuComboShadows } from '../../../lib/menu-combo';
import { Icon } from '../../../ui/icon/icon';
import { SnesComboEditor } from '../../../ui/snes-combo-editor/snes-combo-editor';

type SettingField = { key: string; type: 'boolean' | 'select' | 'number' | 'text' | 'datetime'; options?: Array<{ value: string; label: string }>; min?: number; max?: number };
type SettingGroup = { label: string; fields: SettingField[] };
const bool = (key: string): SettingField => ({ key, type: 'boolean' });
const num = (key: string, min?: number, max?: number): SettingField => ({ key, type: 'number', min, max });
const text = (key: string): SettingField => ({ key, type: 'text' });
const datetime = (key: string): SettingField => ({ key, type: 'datetime' });
const select = (key: string, options: Array<[string, string]>): SettingField => ({ key, type: 'select', options: options.map(([value, label]) => ({ value, label })) });
const normalizeCombo = (value: string): string => { const result = new Set<string>(); const opposite: Record<string,string> = { u:'d', d:'u', l:'r', r:'l' }; for (const key of value) { if (opposite[key]) result.delete(opposite[key]); result.add(key); } return [...result].join(''); };

@Component({
  selector: 'app-config-dialog',
  imports: [Icon, SnesComboEditor, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="config-scrim" (click)="close.emit()"></div>
    <div class="config-pop" role="dialog" aria-modal="true" aria-labelledby="config-title">
      <div class="head"><div><h3 id="config-title">{{ 'config.title' | transloco }}</h3><span>/sd2snes/config.yml</span></div>
        <button class="btn ghost sm" type="button" (click)="close.emit()"><app-icon name="x" [size]="16" /></button>
      </div>
      @if (loading()) { <p class="state">{{ 'config.loading' | transloco }}</p> }
      @else if (error()) { <p class="state warn">{{ error() }}</p> }
      @else {
        <div class="formscroll scroll">
          @for (group of groups; track group.label) {
            <section class="setting-group" [class.open]="openGroup() === group.label">
              <button class="group-head" type="button" (click)="toggleGroup(group.label)" [attr.aria-expanded]="openGroup() === group.label">
                <span>{{ group.label | transloco }}</span><app-icon name="chevron" [size]="15" />
              </button>
              @if (openGroup() === group.label) { <div class="group-body">
                @for (field of group.fields; track field.key) {
                  <label class="setting"><span>{{ ('config.settings.' + field.key) | transloco }}</span>
                    @if (field.type === 'boolean') { <input type="checkbox" [checked]="values()[field.key] === 'true'" (change)="setValue(field.key, $any($event.target).checked ? 'true' : 'false')" /> }
                    @else if (field.type === 'select') { <select [value]="values()[field.key]" (change)="setValue(field.key, $any($event.target).value)">@for (option of field.options; track option.value) { <option [value]="option.value">{{ option.label | transloco }}</option> }</select> }
                    @else if (field.type === 'number') { <input type="number" [min]="field.min ?? null" [max]="field.max ?? null" [value]="values()[field.key]" (input)="setValue(field.key, $any($event.target).value)" /> }
                    @else if (field.type === 'datetime') { <input type="datetime-local" step="1" [value]="toDateTimeLocal(values()[field.key])" (input)="setValue(field.key, fromDateTimeLocal($any($event.target).value))" /> }
                    @else { <input type="text" [value]="values()[field.key]" (input)="setValue(field.key, $any($event.target).value)" /> }
                  </label>
                }
              </div> }
            </section>
          }
          <section class="setting-group" [class.open]="openGroup() === 'combos'">
            <button class="group-head" type="button" (click)="toggleGroup('combos')" [attr.aria-expanded]="openGroup() === 'combos'"><span>{{ 'config.groups.combos' | transloco }}</span><app-icon name="chevron" [size]="15" /></button>
            @if (openGroup() === 'combos') { <div class="group-body">
              @for (field of fields; track field.key) { <button class="combo" type="button" (click)="edit(field.key)"><span>{{ field.label | transloco }}</span><strong>{{ pretty(values()[field.key]) }}</strong><app-icon name="chevron" [size]="15" /></button> }
              @if (menuComboError(); as reason) {
                <p class="hint warn">{{ ('config.menuComboError.' + reason) | transloco }}</p>
              } @else if (menuComboShadowed()) {
                <p class="hint warn">{{ 'config.menuComboShadows' | transloco }}</p>
              }
              <p class="hint">{{ 'config.hint' | transloco }}</p>
            </div> }
          </section>
        </div>
        <div class="actions"><button class="btn" type="button" (click)="close.emit()">{{ 'config.cancel' | transloco }}</button><button class="btn primary" type="button" [disabled]="saving() || !!menuComboError()" (click)="save()"><app-icon name="save" [size]="14" />{{ saving() ? ('config.saving' | transloco) : ('config.save' | transloco) }}</button></div>
      }
    </div>
    @if (editing()) {
      <app-snes-combo-editor [value]="values()[editing()]" [subtitle]="editingLabel()" [allowDpad]="editing() !== 'IngameButtonsChangeState'" (cancel)="editing.set('')" (apply)="applyCombo($event)" />
    }
  `,
  styles: `
    .config-pop { width:min(760px,calc(100vw - 32px)) !important; max-height:calc(100vh - 48px); display:flex; flex-direction:column; }
    .formscroll { overflow:auto; margin:10px -6px 0; padding:0 6px 10px; }
    .setting-group { border-top:1px solid var(--line); }
    .group-head { display:flex; align-items:center; justify-content:space-between; width:100%; padding:14px 4px; border:0; background:none; color:var(--tx-mid); cursor:pointer; font:600 11px var(--sans); text-transform:uppercase; letter-spacing:1px; text-align:left; }
    .group-head:hover { color:var(--tx); }.group-head app-icon { transition:transform .15s ease; }.setting-group.open .group-head app-icon { transform:rotate(90deg); }.group-body { padding:0 4px 12px; }
    .setting-group h4 { margin:0 0 10px; color:var(--tx-low); text-transform:uppercase; letter-spacing:1px; font-size:11px; }
    .setting { display:grid; grid-template-columns:minmax(220px,1fr) minmax(180px,280px); align-items:center; gap:16px; min-height:38px; color:var(--tx-mid); font-size:12px; }
    .setting input:not([type=checkbox]),.setting select { box-sizing:border-box; width:100%; padding:7px 9px; color:var(--tx); background:var(--bg); border:1px solid var(--line); border-radius:7px; font:12px var(--sans); }
    .setting input[type=checkbox] { justify-self:end; width:18px; height:18px; accent-color:var(--accent); }
    .config-scrim { position: fixed; inset: 0; z-index: 49; }
    .config-pop { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: min(390px, calc(100vw - 32px)); z-index: 59; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 24px 60px rgba(0,0,0,.55); padding: 14px 18px 18px; animation: popin .16s ease; }
    @keyframes popin { from { opacity: 0; transform: translate(-50%, calc(-50% - 8px)); } }
    .head { display:flex; justify-content:space-between; align-items:flex-start; }.head h3 { margin:0; font-size:14px; }.head span { color:var(--tx-low); font:11px var(--mono); }.combo { width:100%; display:flex; align-items:center; gap:10px; margin-top:9px; padding:11px 12px; border:1px solid var(--line); border-radius:9px; color:var(--tx); background:var(--bg); text-align:left; cursor:pointer; }.combo:hover { border-color:var(--accent-line); }.combo span { color:var(--tx-mid); font-size:12px; }.combo strong { margin-left:auto; font:13px var(--mono); color:var(--accent); }.state,.hint { color:var(--tx-low); font-size:12px; }.warn { color:var(--warn, #e6a85c); }.hint { margin:16px 0 0; }.actions { display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }.editor { position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:min(600px,calc(100vw - 32px)); z-index:61; background:var(--panel); border:1px solid var(--line); border-radius:16px; box-shadow:0 24px 60px rgba(0,0,0,.55); padding:18px; }.editor h3 { margin:0; font-size:15px; }.editor-sub { color:var(--tx-low); font-size:12px; margin:4px 0 8px; }.controller { display:block; width:100%; max-height:250px; }.shell { fill:var(--bg); stroke:var(--line); stroke-width:4; }.svg-button { cursor:pointer; fill:var(--elevated); stroke:var(--line); stroke-width:2; }.svg-button:hover,.svg-button.active { fill:var(--accent); color:var(--panel); stroke:var(--accent); }.svg-button text { fill:currentColor; stroke:none; font:700 12px var(--sans); text-anchor:middle; pointer-events:none; }.svg-label { fill:var(--tx-low); font:10px var(--mono); text-anchor:middle; }.selected { text-align:center; font:14px var(--mono); color:var(--accent); min-height:17px; }
  `,
})
export class ConfigDialog {
  protected readonly lib = inject(LibraryStore);
  private readonly i18n = inject(TranslocoService);
  readonly close = output<void>();
  protected readonly loading = signal(true);
  protected readonly saving = signal(false);
  protected readonly error = signal('');
  protected readonly openGroup = signal('');
  protected readonly values = signal<Record<string, string>>({});
  protected readonly fields = [
    { key: 'IngameButtonsSaveState', label: 'config.saveState' },
    { key: 'IngameButtonsLoadState', label: 'config.loadState' },
    { key: 'IngameButtonsChangeState', label: 'config.changeState' },
    { key: 'IngameButtonsMenu', label: 'config.menuCombo' },
  ];

  /*  IngameButtonsMenu is the one combo the firmware rewrites behind the user's back: a combo
   *  cfg_check_menu_combo() rejects is replaced by the default and written back to the card at
   *  the next boot (cfg.h:160-164). Flag it here so the setting does not quietly revert. */
  protected readonly menuComboError = computed(() => checkMenuCombo(this.values()['IngameButtonsMenu'] ?? ''));

  /** Non-fatal, and non-fatal in the firmware too: the menu probe runs before the save/load
   *  matcher, so a menu combo contained in one of them shadows it (cfg.c:148-156). */
  protected readonly menuComboShadowed = computed(() => {
    const menu = this.values()['IngameButtonsMenu'] ?? '';
    if (!menu || this.menuComboError()) return false;
    return ['IngameButtonsSaveState', 'IngameButtonsLoadState', 'IngameButtonsChangeState']
      .some((key) => menuComboShadows(menu, this.values()[key] ?? ''));
  });
  protected readonly groups: SettingGroup[] = [
    { label: 'config.groups.video', fields: [bool('PairModeAllowed'), select('VideoModeMenu', [['0','config.options.60hz'],['1','config.options.50hz'],['2','config.options.auto']]), select('VideoModeGame', [['0','config.options.60hz'],['1','config.options.50hz'],['2','config.options.auto']]), bool('R213fOverride'), bool('1CHIPTransientFixes'), num('BrightnessLimit', 0, 15), select('ShortReset2Menu', [['0','config.options.off'],['1','config.options.menu'],['2','config.options.lastFolder'],['3','config.options.preselectRom']]), bool('ClearPpuOnBoot'), bool('BusCompat')] },
    { label: 'config.groups.satellaview', fields: [bool('BSXUseUsertime'), datetime('BSXTime')] },
    { label: 'config.groups.hooks', fields: [bool('EnableCheats'), bool('EnableIngameHook'), bool('EnableIngameButtons'), bool('EnableHookHoldoff'), bool('ResetPatch'), select('EnableIngameSavestate', [['0','config.options.disabled'],['1','config.options.enabled']]), num('LoadstateDelay', 0), bool('EnableSavestateSlots'), bool('EnableCheatOverlay')] },
    { label: 'config.groups.sgb', fields: [bool('SGBEnableIngameHook'), bool('SGBEnableState'), select('SGBVolumeBoost', [['0','config.options.none'],['1','config.options.boost35'],['2','config.options.boost6'],['3','config.options.boost95'],['4','config.options.boost12']]), bool('SGBEnhOverride'), bool('SGBSprIncrease'), bool('SGBClockFix'), num('SGBBiosVersion', 1)] },
    { label: 'config.groups.interface', fields: [bool('EnableScreensaver'), bool('SortDirectories'), bool('HideExtensions'), num('LEDBrightness',0,15), select('ShowCovers', [['0','config.options.off'],['1','config.options.large'],['2','config.options.small']]), bool('ShowCoversInLists'), select('Language', [['0','config.options.english'],['1','config.options.portuguese'],['2','config.options.spanish'],['3','config.options.german'],['4','config.options.french'],['5','config.options.italian']]), bool('EnableMenuMusic'), bool('EnableMenuSFX'), bool('SortFavorites'), bool('EnableGameManual')] },
    { label: 'config.groups.chips', fields: [select('Cx4Speed', [['0','config.options.original'],['1','config.options.fast']]), select('GSUSpeed', [['0','config.options.original'],['1','config.options.fast']]), select('MSUVolumeBoost', [['0','config.options.none'],['1','config.options.boost35'],['2','config.options.boost6'],['3','config.options.boost95'],['4','config.options.boost12']])] },
    { label: 'config.groups.saves', fields: [bool('EnableAutoSave'), bool('EnableMSU1AutoSave')] },
    { label: 'config.groups.patches', fields: [bool('PatchVerifyIntegrity'), bool('EnableBpsCopier')] },
    { label: 'config.groups.gameInfo', fields: [select('ShowGameInfo', [['0','config.options.off'],['1','config.options.on'],['2','config.options.contextOnly']]), bool('GameInfoVideo'), bool('GameInfoMusic')] },
    { label: 'config.groups.files', fields: [text('SkinName'), text('MenuMusicFile')] },
    { label: 'config.groups.network', fields: [bool('EnableWifi')] },
  ];
  protected readonly editing = signal('');
  protected readonly selected = signal<Set<string>>(new Set());
  protected readonly faceButtons = [{ key: 'b', x: 361, y: 146, color: '#fbde33' }, { key: 'a', x: 401, y: 108, color: '#ee3a3c' }, { key: 'y', x: 320, y: 109, color: '#6dbf52' }, { key: 'x', x: 360, y: 69, color: '#32c4e9' }];
  protected readonly shoulderButtons = [{ key: 'L', x: 184 }, { key: 'R', x: 374 }];

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    const result = await this.lib.readConfigSettings();
    if (result == null) this.error.set(this.i18n.translate('config.readError'));
    // IngameButtonsMenu is YAML only and newer than some cards' config.yml. When the line is
    // absent the firmware runs on CFG_DEFAULT, so show that instead of an empty combo, which
    // would read as "no buttons" and trip the validation on a perfectly fine card.
    else this.values.set({ IngameButtonsMenu: MENU_COMBO_DEFAULT, ...result });
    this.loading.set(false);
  }

  protected setValue(key: string, value: string): void { this.values.update((current) => ({ ...current, [key]: value })); }
  protected toDateTimeLocal(value: string): string { return /^\d{14}$/.test(value) ? `${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(8,10)}:${value.slice(10,12)}:${value.slice(12,14)}` : ''; }
  protected fromDateTimeLocal(value: string): string { return value.replace(/[-:T]/g, '').padEnd(14, '0').slice(0, 14); }
  protected toggleGroup(group: string): void { this.openGroup.update((current) => current === group ? '' : group); }
  protected pretty(value: string): string {
    const names: Record<string, string> = { s: 'select', S: 'start', u: 'up', d: 'down', l: 'left', r: 'right', L: 'L', R: 'R', a: 'A', b: 'B', x: 'X', y: 'Y' };
    return [...(value || '')].map((c) => this.i18n.translate(`config.buttons.${names[c] ?? c}`)).join(' + ') || this.i18n.translate('config.none');
  }
  protected selectedString(): string { return [...this.selected()].join(''); }
  protected editingLabel(): string { return this.fields.find((f) => f.key === this.editing())?.label ?? ''; }
  protected edit(key: string): void { this.editing.set(key); this.selected.set(new Set(this.values()[key] || '')); }
  protected toggle(key: string): void {
    if (this.editing() === 'IngameButtonsChangeState' && 'udlr'.includes(key)) return;
    this.selected.update((set) => { const next = new Set(set); next.has(key) ? next.delete(key) : next.add(key); return next; });
  }
  protected applyEdit(): void { this.setValue(this.editing(), this.selectedString()); this.editing.set(''); }
  protected applyCombo(value: string): void { this.setValue(this.editing(), normalizeCombo(value)); this.editing.set(''); }

  protected async save(): Promise<void> {
    if (this.menuComboError()) return;
    this.saving.set(true);
    const ok = await this.lib.saveConfigSettings(this.values());
    this.saving.set(false);
    if (ok) this.close.emit();
    else this.error.set(this.i18n.translate('config.saveError'));
  }
}
