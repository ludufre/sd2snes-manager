package cov

import (
	"image"
	"image/color"
	"testing"
)

// decodeTile4bppRef mirrors the decode side of the 4bpp planar layout for tests.
func decodeTile4bppRef(tile []byte) [8][8]int {
	var out [8][8]int
	for row := 0; row < 8; row++ {
		p0, p1 := tile[row*2], tile[row*2+1]
		p2, p3 := tile[16+row*2], tile[16+row*2+1]
		for col := 0; col < 8; col++ {
			bit := uint(7 - col)
			v := int((p0>>bit)&1) | int((p1>>bit)&1)<<1 |
				int((p2>>bit)&1)<<2 | int((p3>>bit)&1)<<3
			out[row][col] = v
		}
	}
	return out
}

func TestEncodeTile4bppRoundTrip(t *testing.T) {
	// An 8x8 block covering the full 4bpp range (0..15).
	idx := make([][]uint8, 8)
	var want [8][8]int
	for y := 0; y < 8; y++ {
		idx[y] = make([]uint8, 8)
		for x := 0; x < 8; x++ {
			v := (y*8 + x) % 16
			idx[y][x] = uint8(v)
			want[y][x] = v
		}
	}
	tile := encodeTile4bpp(idx, 0, 0)
	if len(tile) != 32 {
		t.Fatalf("tile len = %d, want 32", len(tile))
	}
	got := decodeTile4bppRef(tile)
	if got != want {
		t.Errorf("planar 4bpp round-trip mismatch\n got=%v\nwant=%v", got, want)
	}
}

func TestEncodeHeaderAndSize(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 64, 48))
	for y := 0; y < 48; y++ {
		for x := 0; x < 64; x++ {
			img.Set(x, y, color.RGBA{uint8(x * 4), uint8(y * 5), 64, 255})
		}
	}
	o := Options{WSpr: 4, HSpr: 3, NPalettes: 8, Dither: false}
	blob, err := Encode(img, o)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}

	if blob[0] != 'C' || blob[1] != 'V' {
		t.Errorf("magic = %q%q, want CV", blob[0], blob[1])
	}
	checks := map[string][2]int{
		"version": {2, version},
		"flags":   {3, 0}, // dither off
		"w_spr":   {4, 4},
		"h_spr":   {5, 3},
		"bpp":     {8, bpp},
		"rsvd9":   {9, 0},
	}
	for name, c := range checks {
		if int(blob[c[0]]) != c[1] {
			t.Errorf("header %s @%d = %d, want %d", name, c[0], blob[c[0]], c[1])
		}
	}
	nEmit := int(blob[6])
	if nEmit < 1 || nEmit > o.NPalettes {
		t.Errorf("n_palettes = %d, want 1..%d", nEmit, o.NPalettes)
	}
	wantLen := headerSize + nEmit*16*2 + o.WSpr*o.HSpr + (2*o.HSpr)*16*32
	if len(blob) != wantLen {
		t.Errorf("blob len = %d, want %d", len(blob), wantLen)
	}
}

func TestEncodeDecodeRoundTrip(t *testing.T) {
	// A colourful gradient (128x96 = the 8x6 frame exactly, so no letterbox bars).
	img := image.NewRGBA(image.Rect(0, 0, 128, 96))
	for y := 0; y < 96; y++ {
		for x := 0; x < 128; x++ {
			img.Set(x, y, color.RGBA{uint8(x * 2), uint8(y * 2), uint8(x + y), 255})
		}
	}
	o := DefaultOptions() // 8x6
	blob, err := Encode(img, o)
	if err != nil {
		t.Fatalf("Encode: %v", err)
	}
	d, err := Decode(blob)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if d.WSpr != 8 || d.HSpr != 6 {
		t.Errorf("dims = %dx%d sprites, want 8x6", d.WSpr, d.HSpr)
	}
	if !d.Dithered {
		t.Errorf("expected dithered")
	}
	if d.NPalettes < 1 || d.NPalettes > 8 {
		t.Errorf("npalettes = %d, want 1..8", d.NPalettes)
	}
	if len(d.Blockmap) != o.WSpr*o.HSpr {
		t.Errorf("blockmap len = %d, want %d", len(d.Blockmap), o.WSpr*o.HSpr)
	}
	for i, b := range d.Blockmap {
		if int(b) >= d.NPalettes {
			t.Errorf("blockmap[%d] = %d >= npalettes %d", i, b, d.NPalettes)
		}
	}
	if len(d.Tiles) != (2*o.HSpr)*8 || len(d.Tiles[0]) != 16*8 {
		t.Fatalf("tiles dims = %dx%d, want %dx%d", len(d.Tiles[0]), len(d.Tiles), 16*8, (2*o.HSpr)*8)
	}
}

func TestValidate(t *testing.T) {
	bad := []Options{
		{WSpr: 0, HSpr: 6, NPalettes: 8}, // wspr < 1
		{WSpr: 9, HSpr: 6, NPalettes: 8}, // wspr > 8
		{WSpr: 8, HSpr: 9, NPalettes: 8}, // hspr > 8
		{WSpr: 8, HSpr: 6, NPalettes: 9}, // npalettes > 8
		{WSpr: 8, HSpr: 6, NPalettes: 0}, // npalettes < 1
	}
	for i, o := range bad {
		if err := o.validate(); err == nil {
			t.Errorf("case %d: expected validation error, got nil", i)
		}
	}
	if err := DefaultOptions().validate(); err != nil {
		t.Errorf("DefaultOptions invalid: %v", err)
	}
}
