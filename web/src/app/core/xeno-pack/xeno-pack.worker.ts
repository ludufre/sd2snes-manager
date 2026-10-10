/// <reference lib="webworker" />
// Builds the Xeno Crisis MSU-1 pack off the main thread: decoding 26 Opus streams and resampling about
// 25 minutes of audio is tens of seconds of pure CPU. The dump is transferred in, each finished track
// is transferred out (one at a time, the dialog acks every one, so a slow card never makes this pile
// up hundreds of MB), and nothing leaves the browser.
import { buildPcmFile } from './msu-pcm';
import { compileOpus, createOpusDecoder, RangeMismatchError } from './opus-wasm';
import type { PackReply, PackRequest } from './xeno-pack.protocol';
import { buildTrackBody } from './xc-pack';
import { checkDump, TRACK_COUNT } from './xc-streams';

const post = (m: PackReply, transfer: Transferable[] = []): void =>
  (self as unknown as { postMessage(msg: unknown, t: Transferable[]): void }).postMessage(m, transfer);

let ackWaiter: (() => void) | null = null;
const nextAck = (): Promise<void> => new Promise((res) => { ackWaiter = res; });

async function run(buf: ArrayBuffer, wasmUrl: string): Promise<void> {
  const dump = new Uint8Array(buf);
  const check = checkDump(dump);
  if (!check.ok) {
    post(check.reason === 'size' ? { type: 'refused', reason: 'size', actual: check.actual } : { type: 'refused', reason: 'crc' });
    return;
  }
  post({ type: 'accepted' });
  let track: number | null = null;
  try {
    const res = await fetch(wasmUrl);
    if (!res.ok) throw new Error(`could not load the Opus decoder (${res.status})`);
    const mod = await compileOpus(await res.arrayBuffer());
    for (let n = 1; n <= TRACK_COUNT; n++) {
      track = n;
      const body = await buildTrackBody(dump, n, () => createOpusDecoder(mod), (done, total) => post({ type: 'progress', track: n, done, total }));
      const bytes = buildPcmFile(body.samples, 0);
      const ack = nextAck();
      post({ type: 'track', track: n, bytes: bytes.buffer as ArrayBuffer, packets: body.packets, loops: body.loops, rangeChecked: body.rangeChecked }, [bytes.buffer as ArrayBuffer]);
      await ack;
    }
    post({ type: 'done' });
  } catch (e) {
    post({ type: 'error', track, message: e instanceof Error ? e.message : String(e), rangeMismatch: e instanceof RangeMismatchError });
  }
}

addEventListener('message', (ev: MessageEvent<PackRequest>) => {
  const m = ev.data;
  if (m.type === 'start') void run(m.dump, m.wasmUrl);
  else if (m.type === 'ack') { const w = ackWaiter; ackWaiter = null; w?.(); }
});
