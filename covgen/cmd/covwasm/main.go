//go:build js && wasm

// covwasm exposes the .cov v4 encoder (internal/cov) to the browser via WebAssembly, so the Manager
// converts covers client-side with the exact same code path as the native covgen, no server
// round-trip. It registers the global `covgenEncode(bytes, opts)`.
// (The .gd DirectColor encoder is intentionally not exposed: the Manager retired the .gd info-screen
// path. The game info cover/snapshot/preview are now built by the JS bandpal/ffmpeg encoder.)
package main

import (
	"bytes"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"syscall/js"

	_ "golang.org/x/image/bmp"  // decode support
	_ "golang.org/x/image/webp" // decode support (screenshots are often .webp)

	"github.com/ludufre/sd2snes-manager/covgen/internal/cov"
)

func result(ok bool, data js.Value, errMsg string) any {
	r := map[string]any{"ok": ok}
	if ok {
		r["data"] = data
	} else {
		r["error"] = errMsg
	}
	return r
}

// covgenEncode(imageBytes: Uint8Array, opts?: {palettes?, dither?, fill?, wspr?, hspr?})
//   → { ok: true, data: Uint8Array } | { ok: false, error: string }
func covgenEncode(this js.Value, args []js.Value) any {
	if len(args) < 1 || args[0].IsNull() || args[0].IsUndefined() {
		return result(false, js.Undefined(), "missing image bytes")
	}
	src := args[0]
	buf := make([]byte, src.Get("length").Int())
	js.CopyBytesToGo(buf, src)

	img, _, err := image.Decode(bytes.NewReader(buf))
	if err != nil {
		return result(false, js.Undefined(), "decode: "+err.Error())
	}

	o := cov.DefaultOptions()
	if len(args) > 1 && args[1].Type() == js.TypeObject {
		opt := args[1]
		if v := opt.Get("palettes"); v.Type() == js.TypeNumber {
			o.NPalettes = v.Int()
		}
		if v := opt.Get("dither"); v.Type() == js.TypeBoolean {
			o.Dither = v.Bool()
		}
		if v := opt.Get("fill"); v.Type() == js.TypeBoolean {
			o.Fill = v.Bool()
		}
		w, h := opt.Get("wspr"), opt.Get("hspr")
		if w.Type() == js.TypeNumber && h.Type() == js.TypeNumber && w.Int() > 0 && h.Int() > 0 {
			o.AutoSize = false
			o.WSpr, o.HSpr = w.Int(), h.Int()
		}
	}

	blob, err := cov.Encode(img, o)
	if err != nil {
		return result(false, js.Undefined(), "encode: "+err.Error())
	}
	out := js.Global().Get("Uint8Array").New(len(blob))
	js.CopyBytesToJS(out, blob)
	return result(true, out, "")
}

func main() {
	js.Global().Set("covgenEncode", js.FuncOf(covgenEncode))
	select {} // keep the Go runtime alive so the exported func stays callable
}
