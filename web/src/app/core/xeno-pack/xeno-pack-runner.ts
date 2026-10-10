import type { PackReply, PackRequest } from './xeno-pack.protocol';

type Reply<T extends PackReply['type']> = Extract<PackReply, { type: T }>;

export interface PackHandlers {
  onRefused(reply: Reply<'refused'>): void;
  onProgress(track: number, done: number, total: number): void;
  /** Take one finished track (write it, zip it). The next one is only built once this resolves. */
  onTrack(reply: Reply<'track'>): Promise<void>;
  onDone(): void;
  onError(message: string, track: number | null, rangeMismatch: boolean): void;
}

/** Where the Opus decoder (public/opus/opus.wasm, staged by scripts/setup-opus.sh) is served from. */
export const opusWasmUrl = (): string => new URL('opus/opus.wasm', document.baseURI).href;

/** The worker that builds the pack. The literal `new URL(..., import.meta.url)` is what lets the bundler split it out. */
export const createPackWorker = (): Worker => new Worker(new URL('./xeno-pack.worker', import.meta.url), { type: 'module' });

/**
 * Drives one pack build in a worker: sends the dump, relays progress, hands each finished track to the
 * caller and only then lets the worker go on (so a slow card never piles tracks up in memory).
 */
export class PackRunner {
  private worker: Worker | null = null;

  constructor(private readonly make: () => Worker = createPackWorker) {}

  start(dump: ArrayBuffer, h: PackHandlers, wasmUrl: string = opusWasmUrl()): void {
    this.stop();
    const w = (this.worker = this.make());
    // A run is over once its worker is no longer the current one (cancelled, finished, or replaced by a new start).
    const live = (): boolean => this.worker === w;
    w.onmessage = (ev: MessageEvent<PackReply>) => {
      const m = ev.data;
      switch (m.type) {
        case 'accepted': break;
        case 'refused': this.stop(); h.onRefused(m); break;
        case 'progress': h.onProgress(m.track, m.done, m.total); break;
        case 'track':
          h.onTrack(m).then(
            () => { if (live()) w.postMessage({ type: 'ack' } satisfies PackRequest); },
            (e: unknown) => { this.stop(); h.onError(e instanceof Error ? e.message : String(e), m.track, false); },
          );
          break;
        case 'done': this.stop(); h.onDone(); break;
        case 'error': this.stop(); h.onError(m.message, m.track, m.rangeMismatch); break;
      }
    };
    w.onerror = (ev) => { this.stop(); h.onError(ev.message || 'worker failed', null, false); };
    w.postMessage({ type: 'start', dump, wasmUrl } satisfies PackRequest, [dump]);
  }

  /** Stop now. Safe to call twice and after the build finished. */
  cancel(): void { this.stop(); }

  private stop(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
