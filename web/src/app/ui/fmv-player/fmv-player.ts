import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoModule, TranslocoService } from '@jsverse/transloco';
import { LangService } from '../../core/lang.service';
import { PCM_RATE } from '../../lib/fmv.js';
import * as bandpal from '../../lib/bandpal.js';
import { Icon } from '../icon/icon';

/**
 * Plays back a `.fmv`/`.gss` (+ optional `.pcm`) straight from the SD card, exactly what the console
 * shows in the screenshot box. The frames are paletted (lib/bandpal): each frame = a palette (CGRAM
 * 168..) + an 8bpp tile plane → rgb via the frame's own palette → canvas at the header's fps, looped.
 * The `.pcm` (MSU-1: 8-byte header + s16le stereo) is
 * played through Web Audio. Starts muted (browsers block audible autoplay); a button enables sound.
 */
@Component({
  selector: 'app-fmv-player',
  imports: [Icon, TranslocoModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fmvp" [class.compact]="compact()">
      <div class="fmvp__screen" [class.idle]="!playing()" (click)="onScreenClick()" [title]="screenTitle()">
        <canvas #cv class="fmvp__cv" width="96" height="72"></canvas>
        @if (ready() && !playing()) {
          <div class="fmvp__play"><app-icon name="play" [size]="20" /></div>
        }
        @if (compact() && hasAudio()) {
          <button class="fmvp__sound" type="button" (click)="onSound($event)" [title]="(muted() ? 'fmv.soundOn' : 'fmv.mute') | transloco">
            <app-icon [name]="muted() ? 'mute' : 'sound'" [size]="13" />
          </button>
        }
      </div>
      @if (!compact()) {
        <div class="fmvp__bar">
          @if (hasAudio()) {
            <button class="btn sm" type="button" (click)="toggleMute()">
              <app-icon [name]="muted() ? 'mute' : 'sound'" [size]="13" />{{ (muted() ? 'fmv.sound' : 'fmv.mute') | transloco }}
            </button>
          }
          <span class="fmvp__meta">{{ info() }}</span>
        </div>
      }
    </div>
  `,
  styles: `
    :host { display: block; }
    .fmvp { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
    .fmvp.compact { margin-top: 0; gap: 0; height: 100%; }
    .fmvp__screen { position: relative; cursor: pointer; line-height: 0; align-self: flex-start; }
    .fmvp.compact .fmvp__screen { align-self: stretch; width: 100%; height: 100%; }
    .fmvp__cv { width: 192px; max-width: 100%; height: auto; image-rendering: pixelated;
                border-radius: 8px; border: 1px solid var(--line-soft); background: #000; display: block; }
    .fmvp.compact .fmvp__cv { position: absolute; inset: 0; width: 100%; height: 100%;
                object-fit: contain; border-radius: 0; border: none; }
    .fmvp__screen.idle .fmvp__cv { filter: brightness(0.7); }
    .fmvp__play { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
    .fmvp__play app-icon { background: rgba(0, 0, 0, 0.55); color: #fff; border-radius: 50%; padding: 9px; box-sizing: content-box; }
    .fmvp__sound {
      position: absolute; left: 6px; bottom: 6px; z-index: 3; width: 26px; height: 26px;
      display: grid; place-items: center; border-radius: 7px; color: #fff;
      background: rgba(12, 14, 16, 0.7); border: 1px solid rgba(255, 255, 255, 0.14);
    }
    .fmvp__sound:hover { background: rgba(12, 14, 16, 0.92); }
    .fmvp__bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .fmvp__meta { color: var(--tx-low); font-family: var(--mono); font-size: 11px; }
  `,
})
export class FmvPlayer implements OnDestroy {
  private readonly i18n = inject(TranslocoService);
  private readonly lang = inject(LangService);
  readonly fmv = input.required<Uint8Array>();
  readonly pcm = input<Uint8Array | null>(null);
  /** Start playing (muted) as soon as the clip is ready, used in the detail showcase. */
  readonly autoplay = input(false);
  /** Fill the container, drop the techy meta line (showcase tile look). */
  readonly compact = input(false);
  private readonly cv = viewChild<ElementRef<HTMLCanvasElement>>('cv');

  protected readonly playing = signal(false);
  protected readonly muted = signal(true);
  protected readonly ready = signal(false);
  protected readonly info = signal('');
  protected readonly hasAudio = computed(() => !!this.pcm());
  /** Tooltip for the clickable screen, sound toggle in the compact showcase, play/pause otherwise. */
  protected readonly screenTitle = computed(() => {
    this.lang.ready(); // translate() is not a signal, see LangService.ready
    return this.compact() && this.hasAudio()
      ? this.i18n.translate(this.muted() ? 'fmv.playWithSound' : 'fmv.silence')
      : this.i18n.translate('fmv.playPause');
  });

  private W = 96;
  private H = 72;
  private frameCount = 0;
  private fps = 12;
  private frameI = 0;
  private ctx: CanvasRenderingContext2D | null = null;
  private raf = 0;
  private lastT = 0;
  private accum = 0;

  private audioCtx: AudioContext | null = null;
  private audioBuf: AudioBuffer | null = null;
  private srcNode: AudioBufferSourceNode | null = null;

  constructor() {
    // (re)load whenever the .fmv input changes (a different game selected)
    effect(() => {
      const bytes = this.fmv();
      this.stopPlayback();
      this.frameI = 0;
      this.audioBuf = null; // re-decode audio for the new clip
      try {
        const h = bandpal.decodeFmvHeader(bytes);
        this.W = h.boxW * 8;
        this.H = h.boxH * 8;
        this.frameCount = h.numFrames;
        this.fps = h.fps || 12;
        this.info.set(`${this.W}×${this.H} · ${this.frameCount}f · ${this.fps}fps`);
        this.ready.set(this.frameCount > 0);
        this.drawFrame(0);
        if (this.autoplay() && this.frameCount > 0) this.play();
      } catch (e) {
        console.error('[fmvp] unreadable .fmv', e);
        this.info.set(this.i18n.translate('fmv.unreadable'));
        this.ready.set(false);
      }
    });
    // first paint once the canvas exists
    afterNextRender(() => this.drawFrame(this.frameI));
  }

  private getCtx(): CanvasRenderingContext2D | null {
    if (this.ctx) return this.ctx;
    const el = this.cv()?.nativeElement;
    if (!el) return null;
    el.width = this.W;
    el.height = this.H;
    this.ctx = el.getContext('2d');
    return this.ctx;
  }

  private drawFrame(n: number): void {
    const ctx = this.getCtx();
    if (!ctx || this.frameCount < 1) return;
    const img = ctx.createImageData(this.W, this.H);
    const d = img.data;
    try {
      // paletted: render the box via the frame's own palette (CGRAM 168..)
      const { pal, plane } = bandpal.decodeFmvFrame(this.fmv(), n);
      const cgram = bandpal.composeCgram(null, pal);
      for (let i = 0; i < this.W * this.H; i++) {
        const c = cgram[plane[i]];
        const o = i * 4;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
    } catch {
      return;
    }
    ctx.putImageData(img, 0, 0);
  }

  protected toggle(): void {
    this.playing() ? this.pause() : this.play();
  }

  /** Screen click: in the compact showcase the clip auto-loops, so a click toggles sound; otherwise play/pause. */
  protected onScreenClick(): void {
    if (this.compact() && this.hasAudio()) this.toggleMute();
    else this.toggle();
  }

  private play(): void {
    if (!this.ready()) return;
    this.playing.set(true);
    this.lastT = 0;
    this.accum = 0;
    this.raf = requestAnimationFrame((t) => this.tick(t));
    if (!this.muted()) void this.startAudio();
  }

  private pause(): void {
    this.playing.set(false);
    this.stopPlayback();
  }

  /** Stop the rAF loop + audio without touching the playing/ready signals' meaning. */
  private stopPlayback(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stopAudio();
  }

  private tick(t: number): void {
    if (!this.playing()) return;
    if (this.lastT) {
      this.accum += t - this.lastT;
      const step = 1000 / this.fps;
      while (this.accum >= step) {
        this.accum -= step;
        this.frameI = (this.frameI + 1) % this.frameCount;
        this.drawFrame(this.frameI);
      }
    }
    this.lastT = t;
    this.raf = requestAnimationFrame((tt) => this.tick(tt));
  }

  /** Sound toggle inside the video, stop the click from also toggling play/pause. */
  protected onSound(e: Event): void {
    e.stopPropagation();
    this.toggleMute();
  }

  protected toggleMute(): void {
    this.muted.update((m) => !m);
    if (this.playing()) {
      this.muted() ? this.stopAudio() : void this.startAudio();
    }
  }

  private async startAudio(): Promise<void> {
    const pcm = this.pcm();
    if (!pcm) return;
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
    if (!this.audioBuf) this.audioBuf = this.decodePcm(pcm);
    if (!this.audioBuf || !this.playing()) return;
    this.stopAudio();
    const src = this.audioCtx.createBufferSource();
    src.buffer = this.audioBuf;
    src.loop = true;
    src.connect(this.audioCtx.destination);
    src.start();
    this.srcNode = src;
  }

  private stopAudio(): void {
    if (this.srcNode) {
      try {
        this.srcNode.stop();
      } catch {
        /* already stopped */
      }
      this.srcNode.disconnect();
      this.srcNode = null;
    }
  }

  /** MSU-1 `.pcm` → AudioBuffer. 8-byte header ("MSU1" + u32 loop), then s16le stereo @ PCM_RATE. */
  private decodePcm(pcm: Uint8Array): AudioBuffer | null {
    if (!this.audioCtx || pcm.length <= 8) return null;
    const view = new DataView(pcm.buffer, pcm.byteOffset + 8, pcm.length - 8);
    const frames = Math.floor(view.byteLength / 4); // 2 ch × 2 bytes
    if (frames < 1) return null;
    const buf = this.audioCtx.createBuffer(2, frames, PCM_RATE);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);
    for (let i = 0; i < frames; i++) {
      L[i] = view.getInt16(i * 4, true) / 32768;
      R[i] = view.getInt16(i * 4 + 2, true) / 32768;
    }
    return buf;
  }

  ngOnDestroy(): void {
    this.stopPlayback();
    if (this.audioCtx) void this.audioCtx.close();
  }
}
