// Package gd converts cover + screenshot images into the sd2snes ".gd" DirectColor band
// (the pre-launch game-info screen). It composites the cover (left dedicated space, letterbox,
// right-aligned) and the optional screenshot (the FMV box, fill-crop) onto a 256x128 black band,
// Floyd-Steinberg dithers to 3-3-2 DirectColor, and bank-separates the tiles so the firmware can
// overlay a `.fmv` on window-1 while the cover (window-0) stays:
//
//   cover + transparent margins -> bank0 (file tiles 0..255 -> VRAM window-0 $2000)
//   the snapshot box            -> bank1 (file tiles 256..  -> VRAM window-1 $6000)
//
// bank0 is padded to 256 so bank1 starts at file index 256, matching the firmware's +256/+512
// remap (snes/gameinfo.a65). The .gd byte layout matches gd-encoder.ts / gd.js (the TS/JS port).
// Resize uses CatmullRom (golang.org/x/image/draw), the same kernel internal/cov uses.
package gd

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"math"

	xdraw "golang.org/x/image/draw"
)

const (
	ScreenW        = 256
	ScreenH        = 128
	WTiles         = ScreenW / 8 // 32
	HTiles         = ScreenH / 8 // 16
	CoverBankTiles = 256         // per-window VRAM tile capacity
)

type boxT struct{ X, Y, W, H int }

// Placement boxes. Must match COVER_BOX/SHOT_BOX in gd-encoder.ts/gd.js and GI_FMV_* in
// snes/gameinfo.a65 (SHOT_BOX = the FMV box: 12x9 tiles @ col19,row3).
var (
	CoverBox = boxT{X: 8, Y: 0, W: 136, H: 128}
	ShotBox  = boxT{X: 152, Y: 24, W: 96, H: 72}
)

// Encode composites cover (required) + shot (optional, may be nil) and returns a `.gd` blob.
// The canvas starts transparent (not black): untouched margins stay transparent so the firmware
// shows the menu wallpaper through them, while applyOpacity keeps the drawn cover/snapshot pixels
// opaque (their black is bumped off DirectColor 0, which the SNES bg layer renders transparent).
func Encode(cover, shot image.Image) ([]byte, error) {
	if cover == nil {
		return nil, errors.New("no cover image for a .gd")
	}
	canvas := image.NewNRGBA(image.Rect(0, 0, ScreenW, ScreenH)) // zero value = fully transparent
	drawCover(canvas, cover, CoverBox)
	if shot != nil {
		drawShot(canvas, shot, ShotBox)
	}
	rgb, opaque := nrgbaToRGBMasked(canvas)
	dc, pal := ditherPaletteBits(rgb, opaque)
	applyOpacity(dc, opaque)
	tilemap, coverTiles, shotTiles := buildTiles(dc, pal)
	return writeGd(tilemap, coverTiles, shotTiles)
}

// --- DirectColor + per-tile palette bits ------------------------------------
// In SNES direct-color mode the 3 tilemap palette bits become extra low bits of
// the colour (per 8x8 tile): R/G gain a 4th bit, B a 3rd -- so blue goes from 4
// to 8 levels, killing the green cast plain 3-3-2 gives dark pixels. We pick the
// best palette per tile and quantise against its offset levels, then store that
// palette in the tilemap entry (firmware passes it through; the hardware applies
// the LSBs for free -- no CGRAM, no extra cost). Worst case the optimiser picks
// palette 0 == the old plain 3-3-2, so output is never worse than before.

// hwColor reconstructs the 15-bit BGR555 the SNES actually shows for an 8-bit
// direct-colour value (BBGGGRRR) under palette `pal` (bits p0,p1,p2 -> R,G,B LSB).
func hwColor(v byte, pal int) (int, int, int) {
	r3 := int(v & 0x07)
	g3 := int((v >> 3) & 0x07)
	b2 := int((v >> 6) & 0x03)
	r5 := (r3 << 2) | ((pal & 1) << 1)
	g5 := (g3 << 2) | (((pal >> 1) & 1) << 1)
	b5 := (b2 << 3) | (((pal >> 2) & 1) << 2)
	return (r5<<3)|(r5>>2), (g5<<3)|(g5>>2), (b5<<3)|(b5>>2)
}

// quantPix picks the 8-bit direct-colour value closest to (r,g,b) given palette pal.
func quantPix(r, g, b, pal int) byte {
	tr5 := (r*31 + 127) / 255
	tg5 := (g*31 + 127) / 255
	tb5 := (b*31 + 127) / 255
	r3 := clampI((tr5-(pal&1)*2+2)/4, 0, 7)
	g3 := clampI((tg5-((pal>>1)&1)*2+2)/4, 0, 7)
	b2 := clampI((tb5-((pal>>2)&1)*4+4)/8, 0, 3)
	return byte((b2 << 6) | (g3 << 3) | r3)
}

// ditherPaletteBits: (1) pick the best palette per 8x8 tile (over its opaque pixels;
// all-transparent tiles -> palette 0), then (2) Floyd-Steinberg dither the whole
// plane quantising each pixel against its tile's palette. Returns the per-pixel
// direct-colour plane plus the per-tile palette (len WTiles*HTiles).
func ditherPaletteBits(rgb []byte, opaque []bool) (dc, pal []byte) {
	const W, H = ScreenW, ScreenH
	pal = make([]byte, WTiles*HTiles)
	for ty := 0; ty < HTiles; ty++ {
		for tx := 0; tx < WTiles; tx++ {
			best, bestErr := 0, -1.0
			for p := 0; p < 8; p++ {
				e, any := 0.0, false
				for y := ty * 8; y < ty*8+8; y++ {
					for x := tx * 8; x < tx*8+8; x++ {
						if !opaque[y*W+x] {
							continue
						}
						any = true
						i := (y*W + x) * 3
						r, g, b := int(rgb[i]), int(rgb[i+1]), int(rgb[i+2])
						hr, hg, hb := hwColor(quantPix(r, g, b, p), p)
						dr, dg, db := r-hr, g-hg, b-hb
						e += float64(dr*dr + dg*dg + db*db)
					}
				}
				if !any {
					break // fully transparent tile -> palette 0
				}
				if bestErr < 0 || e < bestErr {
					bestErr, best = e, p
				}
			}
			pal[ty*WTiles+tx] = byte(best)
		}
	}
	work := make([]float64, W*H*3)
	for i := range work {
		work[i] = float64(rgb[i])
	}
	dc = make([]byte, W*H)
	neighbors := [4][3]int{{1, 0, 7}, {-1, 1, 3}, {0, 1, 5}, {1, 1, 1}}
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			p := int(pal[(y/8)*WTiles+(x/8)])
			idx := (y*W + x) * 3
			r := clampI(int(work[idx]), 0, 255)
			g := clampI(int(work[idx+1]), 0, 255)
			b := clampI(int(work[idx+2]), 0, 255)
			v := quantPix(r, g, b, p)
			dc[y*W+x] = v
			hr, hg, hb := hwColor(v, p)
			er, eg, eb := float64(r-hr), float64(g-hg), float64(b-hb)
			for _, n := range neighbors {
				nx, ny := x+n[0], y+n[1]
				if nx >= 0 && nx < W && ny >= 0 && ny < H {
					nidx := (ny*W + nx) * 3
					f := float64(n[2])
					work[nidx] += er * f / 16
					work[nidx+1] += eg * f / 16
					work[nidx+2] += eb * f / 16
				}
			}
		}
	}
	return dc, pal
}

// drawCover: letterbox-fit into the box, horizontally + vertically centered.
func drawCover(dst *image.NRGBA, src image.Image, b boxT) {
	iw, ih := src.Bounds().Dx(), src.Bounds().Dy()
	if iw < 1 {
		iw = 1
	}
	if ih < 1 {
		ih = 1
	}
	scale := math.Min(float64(b.W)/float64(iw), float64(b.H)/float64(ih))
	nw := maxI(1, int(math.Round(float64(iw)*scale)))
	nh := maxI(1, int(math.Round(float64(ih)*scale)))
	offX := (b.W - nw) / 2 // horizontal center
	offY := (b.H - nh) / 2 // vertical center
	dr := image.Rect(b.X+offX, b.Y+offY, b.X+offX+nw, b.Y+offY+nh)
	xdraw.CatmullRom.Scale(dst, dr, src, src.Bounds(), xdraw.Over, nil)
}

// drawShot: fill-crop into the box (scale to cover, centered crop) -- matches how the firmware
// renders the FMV in the same box.
func drawShot(dst *image.NRGBA, src image.Image, b boxT) {
	sb := src.Bounds()
	sw, sh := sb.Dx(), sb.Dy()
	if sw < 1 {
		sw = 1
	}
	if sh < 1 {
		sh = 1
	}
	boxAspect := float64(b.W) / float64(b.H)
	cropW, cropH := sw, sh
	if float64(sw)/float64(sh) > boxAspect {
		cropW = int(math.Round(float64(sh) * boxAspect)) // too wide -> crop sides
	} else {
		cropH = int(math.Round(float64(sw) / boxAspect)) // too tall -> crop top/bottom
	}
	cropW = clampI(cropW, 1, sw)
	cropH = clampI(cropH, 1, sh)
	srcRect := image.Rect(sb.Min.X+(sw-cropW)/2, sb.Min.Y+(sh-cropH)/2, 0, 0)
	srcRect.Max = image.Pt(srcRect.Min.X+cropW, srcRect.Min.Y+cropH)
	dr := image.Rect(b.X, b.Y, b.X+b.W, b.Y+b.H)
	xdraw.CatmullRom.Scale(dst, dr, src, srcRect, xdraw.Over, nil)
}

// nrgbaToRGBMasked: premultiply each pixel over black (so anti-aliased edges blend down to black,
// not to grey) and return that RGB plane plus an opacity mask (alpha >= 128). The untouched
// transparent margins come back as opaque=false so applyOpacity can keep them see-through.
func nrgbaToRGBMasked(img *image.NRGBA) (rgb []byte, opaque []bool) {
	rgb = make([]byte, ScreenW*ScreenH*3)
	opaque = make([]bool, ScreenW*ScreenH)
	j := 0
	for y := 0; y < ScreenH; y++ {
		for x := 0; x < ScreenW; x++ {
			i := img.PixOffset(x, y)
			a := int(img.Pix[i+3])
			rgb[j] = byte(int(img.Pix[i]) * a / 255)
			rgb[j+1] = byte(int(img.Pix[i+1]) * a / 255)
			rgb[j+2] = byte(int(img.Pix[i+2]) * a / 255)
			opaque[y*ScreenW+x] = a >= 128
			j += 3
		}
	}
	return rgb, opaque
}

// applyOpacity enforces the SNES bg-tile transparency rule on the DirectColor plane: pixel value 0
// is transparent (the wallpaper shows through). So force every transparent pixel to 0 (the margins)
// and bump every opaque pixel that quantised to 0 up to 1 -- the darkest non-transparent value
// (~RGB(36,0,0)) -- so genuine black art/snapshot pixels stay opaque instead of vanishing.
func applyOpacity(dc []byte, opaque []bool) {
	for i := range dc {
		if !opaque[i] {
			dc[i] = 0
		} else if dc[i] == 0 {
			dc[i] = 1
		}
	}
}

// (r,g,b) 0..255 -> 8-bit DirectColor byte BBGGGRRR (3-3-2).
func toDirectColor(r, g, b int) byte {
	R := (r*7 + 127) / 255
	G := (g*7 + 127) / 255
	B := (b*3 + 127) / 255
	return byte((B << 6) | (G << 3) | R)
}

func dcToRgb(v byte) (int, int, int) {
	R := int(v & 0x07)
	G := int((v >> 3) & 0x07)
	B := int((v >> 6) & 0x03)
	return R * 255 / 7, G * 255 / 7, B * 255 / 3
}

// Floyd-Steinberg dither an RGB plane (len W*H*3) into 3-3-2 DirectColor (len W*H).
func dither(rgb []byte) []byte {
	const W, H = ScreenW, ScreenH
	work := make([]float64, W*H*3)
	for i := range work {
		work[i] = float64(rgb[i])
	}
	out := make([]byte, W*H)
	neighbors := [4][3]int{{1, 0, 7}, {-1, 1, 3}, {0, 1, 5}, {1, 1, 1}}
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			idx := (y*W + x) * 3
			r := clampI(int(work[idx]), 0, 255) // int() truncates toward zero == Math.trunc
			g := clampI(int(work[idx+1]), 0, 255)
			b := clampI(int(work[idx+2]), 0, 255)
			v := toDirectColor(r, g, b)
			out[y*W+x] = v
			qr, qg, qb := dcToRgb(v)
			er, eg, eb := float64(r-qr), float64(g-qg), float64(b-qb)
			for _, n := range neighbors {
				nx, ny := x+n[0], y+n[1]
				if nx >= 0 && nx < W && ny >= 0 && ny < H {
					nidx := (ny*W + nx) * 3
					f := float64(n[2])
					work[nidx] += er * f / 16
					work[nidx+1] += eg * f / 16
					work[nidx+2] += eb * f / 16
				}
			}
		}
	}
	return out
}

// encodeTile: the 8x8 block at (tx,ty) -> 64-byte 8bpp SNES planar tile.
func encodeTile(dc []byte, tx, ty int) [64]byte {
	var out [64]byte
	o := 0
	for pp := 0; pp < 4; pp++ {
		pLo, pHi := uint(pp*2), uint(pp*2+1)
		for row := 0; row < 8; row++ {
			var lo, hi byte
			for col := 0; col < 8; col++ {
				v := dc[(ty*8+row)*ScreenW+(tx*8+col)]
				lo |= ((v >> pLo) & 1) << uint(7-col)
				hi |= ((v >> pHi) & 1) << uint(7-col)
			}
			out[o], out[o+1] = lo, hi
			o += 2
		}
	}
	return out
}

func cellInShot(tx, ty int) bool {
	x0, y0 := ShotBox.X/8, ShotBox.Y/8
	x1, y1 := (ShotBox.X+ShotBox.W)/8, (ShotBox.Y+ShotBox.H)/8
	return tx >= x0 && tx < x1 && ty >= y0 && ty < y1
}

// buildTiles: bank-separated dedup. tilemap entries 0..255 -> bank0 (window-0); 256.. -> bank1.
// The per-tile palette (pal, len WTiles*HTiles) is or'd into bits 10-12 of each entry; dedup is
// still by tile bytes (two cells with identical pixels but different palettes share the tile char
// and only differ by their tilemap palette bits).
func buildTiles(dc, pal []byte) (tilemap []int, coverTiles, shotTiles [][64]byte) {
	coverIdx := map[string]int{}
	shotIdx := map[string]int{}
	for ty := 0; ty < HTiles; ty++ {
		for tx := 0; tx < WTiles; tx++ {
			t := encodeTile(dc, tx, ty)
			key := string(t[:])
			pbits := int(pal[ty*WTiles+tx]) << 10
			if cellInShot(tx, ty) {
				id, ok := shotIdx[key]
				if !ok {
					id = len(shotTiles)
					shotIdx[key] = id
					shotTiles = append(shotTiles, t)
				}
				tilemap = append(tilemap, (CoverBankTiles+id)|pbits)
			} else {
				id, ok := coverIdx[key]
				if !ok {
					id = len(coverTiles)
					coverIdx[key] = id
					coverTiles = append(coverTiles, t)
				}
				tilemap = append(tilemap, id|pbits)
			}
		}
	}
	return
}

// writeGd: bank0 (cover) padded to CoverBankTiles, then bank1 (snapshot). Throws on a window overflow.
func writeGd(tilemap []int, coverTiles, shotTiles [][64]byte) ([]byte, error) {
	if len(coverTiles) > CoverBankTiles {
		return nil, fmt.Errorf("cover needs %d tiles > %d (window-0); reduce cover detail", len(coverTiles), CoverBankTiles)
	}
	if len(shotTiles) > CoverBankTiles {
		return nil, fmt.Errorf("snapshot needs %d tiles > %d (window-1)", len(shotTiles), CoverBankTiles)
	}
	all := make([][64]byte, 0, CoverBankTiles+len(shotTiles))
	all = append(all, coverTiles...)
	for len(all) < CoverBankTiles {
		all = append(all, [64]byte{}) // pad so bank1 starts at file index 256
	}
	all = append(all, shotTiles...)
	n := len(all)

	buf := new(bytes.Buffer)
	hdr := make([]byte, 12)
	hdr[0], hdr[1], hdr[2], hdr[3] = 'G', 'D', 1, 0
	hdr[4], hdr[5] = WTiles, HTiles
	binary.LittleEndian.PutUint16(hdr[6:], uint16(n))
	buf.Write(hdr)
	tm := make([]byte, len(tilemap)*2)
	for i, t := range tilemap {
		// bits 0-9 tile index (bank-relative), bits 10-12 palette (direct-colour LSBs)
		binary.LittleEndian.PutUint16(tm[i*2:], uint16(t&0x1fff))
	}
	buf.Write(tm)
	for i := range all {
		buf.Write(all[i][:])
	}
	return buf.Bytes(), nil
}

func maxI(a, b int) int {
	if a > b {
		return a
	}
	return b
}
func clampI(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
