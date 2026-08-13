import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { LibraryStore } from '../../../core/library-store';
import type { Cheat, Entry } from '../../../core/models';
import { stemOf } from '../../../core/format';
import { Icon } from '../../../ui/icon/icon';
import { Toggle } from '../../../ui/toggle/toggle';
import { TranslocoModule } from '@jsverse/transloco';

interface EditRow { id: number; name: string; on: boolean; codesText: string; }

const CODE_RE = /^[0-9A-Fa-f]{8}$/;
const codesOf = (text: string): string[] => text.split(/[\s,]+/).filter(Boolean);

/** Add / remove / edit cheats and save them to /sd2snes/cheats/<stem>.yml. */
@Component({
  selector: 'app-cheat-editor',
  imports: [Icon, Toggle, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="scrim" (click)="close.emit()"></div>
    <div class="ed">
      <div class="eh">
        <div>
          <h3>{{ 'cheats.title' | transloco }}</h3>
          <span class="sub">{{ entry().title }} · /sd2snes/cheats/{{ stem() }}.yml</span>
        </div>
        <button class="btn ghost sm" type="button" (click)="close.emit()"><app-icon name="x" [size]="16" /></button>
      </div>

      <div class="cols"><span></span><span>{{ 'cheats.colName' | transloco }}</span><span>{{ 'cheats.colCodes' | transloco }}</span><span></span></div>

      <div class="elist scroll">
        @for (c of rows(); track c.id; let i = $index) {
          <div class="crow" [class.invalid]="!valid(c)">
            <app-toggle [on]="c.on" (toggled)="toggle(i)" />
            <input class="cn" [value]="c.name" (input)="setName(i, $event)" [placeholder]="'cheats.namePlaceholder' | transloco" />
            <input class="cc mono" [value]="c.codesText" (input)="setCodes(i, $event)" placeholder="7E17D7FF" />
            <button class="btn ghost sm del" type="button" [title]="'cheats.remove' | transloco" (click)="remove(i)">
              <app-icon name="trash" [size]="14" />
            </button>
          </div>
        }
        @if (rows().length === 0) {
          <div class="empty">{{ 'cheats.empty' | transloco }}</div>
        }
      </div>

      <div class="ef">
        <button class="btn sm" type="button" (click)="add()"><app-icon name="plus" [size]="13" />{{ 'cheats.add' | transloco }}</button>
        <div class="grow"></div>
        @if (invalid() > 0) { <span class="warnt">{{ 'cheats.invalidCount' | transloco: { count: invalid() } }}</span> }
        <button class="btn ghost sm" type="button" (click)="close.emit()">{{ 'cheats.cancel' | transloco }}</button>
        <button class="btn sm primary" type="button" [disabled]="invalid() > 0" (click)="save()">
          <app-icon name="save" [size]="13" />{{ 'cheats.save' | transloco }}{{ rows().length ? ' (' + rows().length + ')' : '' }}
        </button>
      </div>
    </div>
  `,
  styles: `
    .scrim { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 58; }
    .ed {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); z-index: 59;
      width: min(640px, 95vw); height: min(640px, 88vh); display: flex; flex-direction: column;
      background: var(--panel); border: 1px solid var(--line); border-radius: 14px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55); overflow: hidden;
    }
    .eh { display: flex; align-items: flex-start; justify-content: space-between; padding: 14px 12px 12px 18px; border-bottom: 1px solid var(--line); }
    .eh h3 { margin: 0; font-size: 15px; }
    .eh .sub { font-family: var(--mono); font-size: 11px; color: var(--tx-low); }
    .cols {
      display: grid; grid-template-columns: 40px 1fr 200px 34px; gap: 10px; align-items: center;
      padding: 8px 18px 4px; font-family: var(--mono); font-size: 10px; text-transform: uppercase;
      letter-spacing: 1px; color: var(--tx-low);
    }
    .elist { overflow: auto; padding: 4px 18px 8px; display: flex; flex-direction: column; gap: 6px; }
    .crow { display: grid; grid-template-columns: 40px 1fr 200px 34px; gap: 10px; align-items: center; }
    .crow input {
      background: var(--bg); border: 1px solid var(--line); border-radius: 7px; color: var(--tx);
      font-family: var(--sans); font-size: 13px; padding: 7px 9px; outline: none; min-width: 0;
    }
    .crow input.cc { font-family: var(--mono); text-transform: uppercase; }
    .crow input:focus { border-color: var(--accent); }
    .crow.invalid input.cc { border-color: var(--danger); }
    .crow .del { color: var(--tx-low); }
    .crow .del:hover { color: var(--danger); }
    .empty { color: var(--tx-low); font-family: var(--mono); font-size: 13px; padding: 24px; text-align: center; }
    .ef { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--line); background: var(--panel-2); }
    .grow { flex: 1; }
    .warnt { font-family: var(--mono); font-size: 11px; color: var(--danger); }
  `,
})
export class CheatEditor {
  readonly entry = input.required<Entry>();
  readonly close = output<void>();
  private readonly lib = inject(LibraryStore);

  protected readonly stem = computed(() => stemOf(this.entry().file));
  protected readonly rows = signal<EditRow[]>([]);
  protected readonly invalid = computed(() => this.rows().filter((c) => !this.valid(c)).length);

  private seq = 0;
  private seeded = false;

  constructor() {
    effect(() => {
      const g = this.entry();
      if (this.seeded || !g) return;
      this.seeded = true;
      this.rows.set(
        (g.cheatList ?? []).map((c) => ({ id: ++this.seq, name: c.name, on: c.on, codesText: (c.codes ?? []).join(' ') })),
      );
    });
  }

  protected valid(c: EditRow): boolean {
    const codes = codesOf(c.codesText);
    return !!c.name.trim() && codes.length > 0 && codes.every((x) => CODE_RE.test(x));
  }

  protected toggle(i: number): void {
    this.rows.update((rs) => rs.map((c, j) => (j === i ? { ...c, on: !c.on } : c)));
  }
  protected setName(i: number, e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.rows.update((rs) => rs.map((c, j) => (j === i ? { ...c, name: v } : c)));
  }
  protected setCodes(i: number, e: Event): void {
    const v = (e.target as HTMLInputElement).value;
    this.rows.update((rs) => rs.map((c, j) => (j === i ? { ...c, codesText: v } : c)));
  }
  protected add(): void {
    this.rows.update((rs) => [...rs, { id: ++this.seq, name: '', on: true, codesText: '' }]);
  }
  protected remove(i: number): void {
    this.rows.update((rs) => rs.filter((_, j) => j !== i));
  }

  protected async save(): Promise<void> {
    const cheats: Cheat[] = this.rows().map((c) => ({
      name: c.name.trim(),
      on: c.on,
      codes: codesOf(c.codesText).map((x) => x.toUpperCase()),
    }));
    await this.lib.saveCheats(this.entry(), cheats);
    this.close.emit();
  }
}
