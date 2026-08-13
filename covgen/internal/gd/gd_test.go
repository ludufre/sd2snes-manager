package gd

import (
	"image"
	_ "image/jpeg"
	"image/png"
	"os"
	"testing"

	_ "golang.org/x/image/webp"
)

func loadImg(t *testing.T, path string) image.Image {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Skipf("asset missing (%s) — run the Manager asset download first", path)
		return nil
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return img
}

func TestEncodeReal(t *testing.T) {
	cases := []struct{ name, cover, shot string }{
		{"zelda", "/tmp/z_cover_us.jpg", "/tmp/z_shot.webp"},
		{"jp", "/tmp/jp_cover.jpg", "/tmp/jp_shot.webp"},
	}
	for _, c := range cases {
		cover := loadImg(t, c.cover)
		shot := loadImg(t, c.shot)
		if cover == nil || shot == nil {
			continue
		}

		// Inspect the banks (same steps as Encode, but expose the counts).
		canvas := image.NewNRGBA(image.Rect(0, 0, ScreenW, ScreenH)) // transparent (margins stay see-through)
		drawCover(canvas, cover, CoverBox)
		drawShot(canvas, shot, ShotBox)
		rgb, opaque := nrgbaToRGBMasked(canvas)
		dc, pal := ditherPaletteBits(rgb, opaque)
		applyOpacity(dc, opaque)
		tilemap, coverTiles, shotTiles := buildTiles(dc, pal)

		blob, err := Encode(cover, shot)
		if err != nil {
			t.Fatalf("%s: Encode: %v", c.name, err)
		}
		if blob[0] != 'G' || blob[1] != 'D' || blob[2] != 1 || blob[4] != WTiles || blob[5] != HTiles {
			t.Fatalf("%s: bad header % x", c.name, blob[:8])
		}
		n := int(blob[6]) | int(blob[7])<<8
		if n != CoverBankTiles+len(shotTiles) {
			t.Fatalf("%s: ntiles=%d, want %d", c.name, n, CoverBankTiles+len(shotTiles))
		}
		// bank split: shot-box cells >= 256, others < 256
		for ty := 0; ty < HTiles; ty++ {
			for tx := 0; tx < WTiles; tx++ {
				idx := tilemap[ty*WTiles+tx]
				if cellInShot(tx, ty) != (idx >= CoverBankTiles) {
					t.Fatalf("%s: bank mismatch at (%d,%d) idx=%d", c.name, tx, ty, idx)
				}
			}
		}
		if len(coverTiles) > CoverBankTiles || len(shotTiles) > CoverBankTiles {
			t.Fatalf("%s: bank overflow cover=%d shot=%d", c.name, len(coverTiles), len(shotTiles))
		}
		t.Logf("%s: cover=%d shot=%d ntiles=%d size=%dB", c.name, len(coverTiles), len(shotTiles), n, len(blob))

		_ = os.WriteFile("/tmp/gd-go-"+c.name+".gd", blob, 0o644)

		// also dump the composited (pre-dither) band as a PNG sanity image
		_ = dumpPNG("/tmp/gd-go-"+c.name+"-band.png", canvas)
	}
}

// decodeGd unpacks a `.gd` blob back into its ScreenW*ScreenH DirectColor plane (mirrors gd.js).
func decodeGd(blob []byte) []byte {
	wT, hT := int(blob[4]), int(blob[5])
	nT := int(blob[6]) | int(blob[7])<<8
	W := wT * 8
	tmOff := 12
	tOff := 12 + wT*hT*2
	dc := make([]byte, W*hT*8)
	for ty := 0; ty < hT; ty++ {
		for tx := 0; tx < wT; tx++ {
			tIdx := (int(blob[tmOff+(ty*wT+tx)*2]) | int(blob[tmOff+(ty*wT+tx)*2+1])<<8) & 0x3ff
			if tIdx >= nT {
				tIdx = 0
			}
			to := tOff + tIdx*64
			for pp := 0; pp < 4; pp++ {
				for row := 0; row < 8; row++ {
					lo, hi := blob[to+(pp*8+row)*2], blob[to+(pp*8+row)*2+1]
					for col := 0; col < 8; col++ {
						bL := (lo >> uint(7-col)) & 1
						bH := (hi >> uint(7-col)) & 1
						dc[(ty*8+row)*W+(tx*8+col)] |= (bL << uint(pp*2)) | (bH << uint(pp*2+1))
					}
				}
			}
		}
	}
	return dc
}

// A solid opaque-black cover must encode opaque (DirectColor value >= 1) inside the drawn art so the
// SNES bg layer doesn't render it transparent, while the untouched margins stay value 0 (the firmware
// shows the menu wallpaper through them). Guards the black->transparent fix on every WASM rebuild.
func TestEncodeBlackArtOpaque(t *testing.T) {
	cover := image.NewNRGBA(image.Rect(0, 0, 100, 100))
	for i := 3; i < len(cover.Pix); i += 4 {
		cover.Pix[i] = 255 // opaque black
	}
	blob, err := Encode(cover, nil)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	dc := decodeGd(blob)
	W := ScreenW
	// (80,64) is inside the cover art (scaled to 128x128, right-aligned in the 136-wide box → x16..144).
	if v := dc[64*W+80]; v == 0 {
		t.Errorf("cover-art black pixel is transparent (value 0), want >= 1")
	}
	// (250,2) is a true margin: outside both the cover box (x8..144) and the shot box (y24..96).
	if v := dc[2*W+250]; v != 0 {
		t.Errorf("margin pixel = %d, want 0 (transparent)", v)
	}
}

func dumpPNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}
