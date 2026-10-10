/** Messages between the pack dialog and its worker (see xeno-pack.worker.ts). */

export type PackRequest =
  | { type: 'start'; dump: ArrayBuffer; wasmUrl: string }
  /** The dialog has taken the last `track` message: the worker may build the next one (backpressure). */
  | { type: 'ack' };

export type PackReply =
  /** The dump is the v1.00 flash and the build begins. */
  | { type: 'accepted' }
  | { type: 'refused'; reason: 'size'; actual: number }
  | { type: 'refused'; reason: 'crc' }
  | { type: 'progress'; track: number; done: number; total: number }
  /** One finished .pcm (header included). `bytes` is transferred, not copied. */
  | { type: 'track'; track: number; bytes: ArrayBuffer; packets: number; loops: boolean; rangeChecked: boolean }
  | { type: 'done' }
  | { type: 'error'; track: number | null; message: string; rangeMismatch: boolean };
