// covwasm.js, loads the Go-compiled .cov encoder (covgen.wasm) and exposes a byte-identical
// encoder, so the Manager converts covers client-side with the exact native covgen code path
// (no Canvas-resample approximation). The wasm + wasm_exec.js live in public/ and are served
// under the app base-href (/ in dev, /manager/ in prod). CSP already allows 'wasm-unsafe-eval'.

let readyPromise = null;

/** Absolute URL for a public asset, resolved against the app's <base href>. */
function publicUrl(file) {
  return new URL(file, document.baseURI).href;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(s);
  });
}

/** Load + start the wasm once; resolves to the registered global encode function. */
export function ensureCovWasm() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    if (typeof globalThis.Go !== 'function') {
      await loadScript(publicUrl('wasm_exec.js'));
    }
    const go = new globalThis.Go();
    const wasmUrl = publicUrl('covgen.wasm');
    let instance;
    try {
      ({ instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject));
    } catch {
      // fallback when the server doesn't send application/wasm
      const buf = await (await fetch(wasmUrl)).arrayBuffer();
      ({ instance } = await WebAssembly.instantiate(buf, go.importObject));
    }
    go.run(instance); // registers globalThis.covgenEncode, then parks on select{}
    for (let i = 0; i < 200 && typeof globalThis.covgenEncode !== 'function'; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    if (typeof globalThis.covgenEncode !== 'function') {
      throw new Error('covgen wasm did not register covgenEncode');
    }
    return globalThis.covgenEncode;
  })();
  return readyPromise;
}

/**
 * Encode raw cover image bytes → `.cov` v4 Uint8Array (byte-identical to the native covgen).
 * @param {Uint8Array|ArrayBuffer} bytes  the cover image file (JPEG/PNG)
 * @param {{nPalettes?:number, dither?:boolean, fill?:boolean, wSpr?:number, hSpr?:number, autoSize?:boolean}} opts
 */
export async function encodeCovWasm(bytes, opts = {}) {
  const encode = await ensureCovWasm();
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const o = {
    palettes: opts.nPalettes ?? 8,
    dither: opts.dither ?? true,
    fill: opts.fill ?? false,
  };
  if (opts.autoSize === false && opts.wSpr && opts.hSpr) {
    o.wspr = opts.wSpr;
    o.hspr = opts.hSpr;
  }
  const res = encode(u8, o);
  if (!res || !res.ok) throw new Error(`covgen: ${res?.error ?? 'unknown error'}`);
  return res.data; // Uint8Array (.cov v4)
}

// NOTE: the `.gd` DirectColor encoder (encodeGdWasm/gdEncode) was removed, the Manager retired the
// `.gd` info-screen path (ficha cover/snapshot/preview now come from the JS bandpal/ffmpeg encoder),
// so the covgen WASM no longer carries it.
