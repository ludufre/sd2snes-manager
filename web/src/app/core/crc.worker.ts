/// <reference lib="webworker" />
// ROM checksums (CRC32), computed in a dedicated Web Worker, the read half of the identify pass, the
// same move autofill.worker.ts makes for the write half. Three reasons, none of them "JS is slow":
//
//  1. Background tabs. Chromium/Edge throttle an inactive tab's main thread (timers clamped, work
//     starved) but not worker threads. Analyzing a 32 GB card takes minutes; the user switches away and
//     the pass used to slow to a crawl. Here it keeps full speed.
//  2. No jank. A 64 MB ROM is a ~200 ms uninterruptible loop on the main thread, six of them in flight,
//     the UI froze in bursts for the whole pass. Off-thread, the UI never sees them.
//  3. Flat memory. The main-thread path called `arrayBuffer()` on the whole ROM (× 6 concurrent).
//     Here each file is streamed through the incremental CRC (lib/crc32.js), so peak memory is a few
//     stream chunks no matter how big the ROM is.
//
// The card is the bottleneck, not the CPU: only READ_CONCURRENCY files are read at once, because more
// parallel readers just make the SD controller seek and the whole pass gets slower.

import { crcBegin, crcUpdate, crcEnd, headerOffset } from '../lib/crc32.js';

/** Post a message back to the main thread. Cast avoids the dom-vs-webworker `postMessage` overload clash
 *  when this file is type-checked under the app's (dom) tsconfig. */
const post = (m: unknown): void => (self as unknown as { postMessage(msg: unknown): void }).postMessage(m);

/** How many ROMs are read at once. Mirrors the main-thread fallback pool, the SD card thrashes above
 *  this, and the CRC itself is never the limit. */
const READ_CONCURRENCY = 3;

/** One ROM to checksum. `id` is the main thread's correlation token (not the cache key: two entries
 *  could share a path in a malformed scan, and a duplicated key would strand a waiter forever).
 *  `name` is the ROM's filename, its extension gates the NES header rule (see lib/crc32.js). */
interface Job {
  id: number;
  name: string;
  fileHandle: FileSystemFileHandle;
}

async function doJob(job: Job): Promise<void> {
  try {
    const file = await job.fileHandle.getFile();
    // The header decision needs the first bytes before anything is streamed (the iNES magic), so read a
    // 16-byte slice up front, not the whole ROM, which is the entire point of streaming.
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const off = headerOffset(head, file.size, job.name);
    let state = crcBegin();
    const reader = file.slice(off).stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      state = crcUpdate(state, value);
    }
    // size/mtime come from the same File the bytes were read from, so the (size, mtime) the main thread
    // caches always describes the bytes this CRC covers.
    post({ id: job.id, crc: crcEnd(state), size: file.size, mtime: file.lastModified });
  } catch (e) {
    // One unreadable ROM (deleted mid-scan, permission lost, I/O error) is its problem: report it and
    // keep the queue moving. The main thread just leaves that game unidentified, as it always did.
    post({ id: job.id, error: `${(e as { name?: string })?.name || 'Error'}: ${((e as { message?: string })?.message || '').slice(0, 200)}` });
  }
}

const queue: Job[] = [];
let running = 0;

function pump(): void {
  while (running < READ_CONCURRENCY && queue.length) {
    const job = queue.shift() as Job;
    running++;
    // doJob never rejects (it reports errors as results), so this can't leave `running` stuck.
    void doJob(job).finally(() => { running--; pump(); });
  }
}

self.onmessage = (ev: MessageEvent): void => {
  const m = ev.data;
  // One batch at a time: the producer awaits a chunk's results before submitting the next, so the
  // queue drains between batches (the tail of each chunk idles readers. Accepted; cross-batch
  // pipelining is a registered follow-up). Cancellation is terminate(), never a message.
  if (m?.type === 'jobs') { queue.push(...(m.jobs as Job[])); pump(); }
};
