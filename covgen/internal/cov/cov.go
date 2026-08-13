// Package cov converts cover images into the sd2snes ".cov v4" OBJ (sprite)
// cover format. The cover is drawn by the firmware with 16x16 OBJ sprites floating
// over the file list (so the list keeps its full Mode-5 hi-res rows): a w_spr x
// h_spr grid of 16x16 sprites, 4bpp, up to 8 OBJ palettes (one per 16x16 block,
// the blockmap). The on-disk format (header / BGR555 palettes / blockmap / 4bpp
// name-grid tiles) is reproduced exactly from utils/cover_conv.py (convert_image_v4)
// so the firmware reads it; the image pipeline (resize + per-block median-cut +
// 8-palette clustering + cross-block Floyd-Steinberg) is an independent Go
// implementation, so output is format-compatible and visually equivalent but not
// byte-identical to the Python tool.
package cov

import (
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"math"
	"os"
	"sort"

	_ "image/jpeg" // decode support
	_ "image/png"  // decode support

	_ "golang.org/x/image/bmp" // decode support
	xdraw "golang.org/x/image/draw"
)

const (
	magic0     = 'C'
	magic1     = 'V'
	version    = 4
	bpp        = 4
	headerSize = 12
)

// Options controls a .cov v4 conversion. DefaultOptions mirrors the sd2snes fork
// (utils/gencovers.py make_cov).
type Options struct {
	WSpr      int  // cover width  in 16x16 sprites (1..8); ignored when AutoSize
	HSpr      int  // cover height in 16x16 sprites (1..8; (2*HSpr)*16 <= 256 OBJ tiles)
	NPalettes int  // OBJ palettes (1..8)
	Dither    bool // cross-block Floyd-Steinberg dithering
	Fill      bool // crop-to-fill instead of letterbox-fit (letterbox keeps proportion)
	AutoSize  bool // derive WSpr/HSpr from the source aspect (within 8x8), so portrait
	// (Japanese) art becomes a tall narrow cover and landscape art a wide one, the
	// firmware right-/top-aligns by w_spr/h_spr, no baked-in empty space.
}

// DefaultOptions returns the sd2snes fork defaults: a fixed 8x6 landscape frame
// (128x96 px) matching the libretro box aspect, letterboxed (whole box, no crop),
// 8 OBJ palettes, dithered. The cover fills cols 16..31 (right of the menu logo).
func DefaultOptions() Options {
	return Options{WSpr: 8, HSpr: 6, NPalettes: 8, Dither: true, Fill: false, AutoSize: true}
}

// autoDims picks (w,h) in 16px sprites matching the source aspect, maximised within
// maxW x maxH: landscape art -> wide cover, portrait/Japanese art -> tall & narrow,
// so the cover fits its own box with minimal bars. The firmware right-/top-aligns by
// w/h, so each cover sits in the top-right corner.
func autoDims(img image.Image, maxW, maxH int) (w, h int) {
	b := img.Bounds()
	sw, sh := b.Dx(), b.Dy()
	aspect := 1.0
	if sh > 0 {
		aspect = float64(sw) / float64(sh)
	}
	clamp := func(v, lo, hi int) int {
		if v < lo {
			return lo
		}
		if v > hi {
			return hi
		}
		return v
	}
	if aspect >= 1.0 {
		w = maxW
		h = clamp(int(math.Round(float64(maxW)/aspect)), 1, maxH)
	} else {
		h = maxH
		w = clamp(int(math.Round(float64(maxH)*aspect)), 1, maxW)
	}
	return
}

func (o Options) validate() error {
	if o.WSpr < 1 || o.WSpr > 8 {
		return fmt.Errorf("wspr must be 1..8 (16-wide OBJ name grid), got %d", o.WSpr)
	}
	if o.HSpr < 1 || o.HSpr > 8 {
		return fmt.Errorf("hspr must be 1..8 ((2*hspr)*16 <= 256 OBJ tiles), got %d", o.HSpr)
	}
	if o.NPalettes < 1 || o.NPalettes > 8 {
		return fmt.Errorf("npalettes must be 1..8 (OBJ palettes), got %d", o.NPalettes)
	}
	return nil
}

// ConvertFile decodes the image at srcImage and writes a .cov file to dstCov.
func ConvertFile(srcImage, dstCov string, o Options) error {
	f, err := os.Open(srcImage)
	if err != nil {
		return err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	if err != nil {
		return fmt.Errorf("decoding %s: %w", srcImage, err)
	}
	blob, err := Encode(img, o)
	if err != nil {
		return err
	}
	tmp := dstCov + ".tmp"
	if err := os.WriteFile(tmp, blob, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, dstCov)
}

// Encode renders img into a .cov v4 byte blob.
func Encode(img image.Image, o Options) ([]byte, error) {
	if o.AutoSize {
		o.WSpr, o.HSpr = autoDims(img, 8, 8)
	}
	if err := o.validate(); err != nil {
		return nil, err
	}
	wpx, hpx := o.WSpr*16, o.HSpr*16
	// keepAlpha=true so the letterbox bars stay transparent (index 0) and the
	// floating sprite cover is a clean box (the list shows through the bars).
	// topAlign=true: art touches the top, the (small) letterbox bar goes to the bottom
	rgb, opaque := buildCanvas(img, wpx, hpx, o.Fill, true, true)

	// snap to the SNES 15-bit lattice before clustering (matches cover_conv.py)
	for y := 0; y < hpx; y++ {
		for x := 0; x < wpx; x++ {
			rgb[y][x][0] = snap555(rgb[y][x][0])
			rgb[y][x][1] = snap555(rgb[y][x][1])
			rgb[y][x][2] = snap555(rgb[y][x][2])
		}
	}

	// gather each 16x16 block's opaque pixels (row-major: sy*WSpr+sx)
	blocks := make([][][3]int, o.WSpr*o.HSpr)
	for sy := 0; sy < o.HSpr; sy++ {
		for sx := 0; sx < o.WSpr; sx++ {
			var pix [][3]int
			for dy := 0; dy < 16; dy++ {
				for dx := 0; dx < 16; dx++ {
					y, x := sy*16+dy, sx*16+dx
					if opaque[y][x] {
						pix = append(pix, rgb[y][x])
					}
				}
			}
			blocks[sy*o.WSpr+sx] = pix
		}
	}

	palettes, blockmap := clusterBlockPalettes(blocks, o.WSpr, o.HSpr, o.NPalettes)
	nEmit := len(palettes)
	idx := quantiseImageCrossblock(rgb, opaque, palettes, blockmap, o.WSpr, o.HSpr, o.Dither)

	palBlock := encodePalettesV4(palettes)
	tileBlock := encodeTilesNameGrid(idx, o.WSpr, o.HSpr)

	flags := byte(0)
	if o.Dither {
		flags = 0x01
	}
	out := make([]byte, 0, headerSize+len(palBlock)+len(blockmap)+len(tileBlock))
	// Header (12 bytes): magic, ver=4, flags, w_spr, h_spr, n_palettes, rsvd, bpp=4, rsvd*3
	out = append(out,
		magic0, magic1, version, flags,
		byte(o.WSpr), byte(o.HSpr), byte(nEmit), 0, bpp,
		0, 0, 0,
	)
	out = append(out, palBlock...)  // palettes (n_palettes * 16 BGR555 LE)
	out = append(out, blockmap...)  // blockmap (w_spr*h_spr palette indices)
	out = append(out, tileBlock...) // tiles (4bpp planar, name-grid order)
	return out, nil
}

// --- colour helpers ---

func rgbToBGR555(r, g, b int) int {
	return ((b >> 3) << 10) | ((g >> 3) << 5) | (r >> 3)
}

func bgr555ToRGB(word int) (r, g, b int) {
	r = (word & 0x1F) << 3
	g = ((word >> 5) & 0x1F) << 3
	b = ((word >> 10) & 0x1F) << 3
	r |= r >> 5
	g |= g >> 5
	b |= b >> 5
	return
}

// snap555 snaps a 0..255 channel onto the SNES 15-bit lattice (top 5 bits, low 3
// replicated from the top of the 5).
func snap555(v int) int {
	hi := v >> 3
	s := (hi << 3) | (hi >> 2)
	if s > 255 {
		s = 255
	}
	return s
}

// --- image -> canvas ---

// buildCanvas letterbox-fits (or crop-fills) src into a wpx*hpx canvas over a black
// background, returning the RGB grid and an opacity mask. With keepAlpha true the
// padded/transparent area is opaque=false (transparent letterbox bars); the art's
// own alpha is honoured too. With topAlign true the art is top-aligned (the
// letterbox bar goes to the bottom) so the cover touches the top of the screen.
func buildCanvas(src image.Image, wpx, hpx int, fill, keepAlpha, topAlign bool) (rgb [][][3]int, opaque [][]bool) {
	b := src.Bounds()
	sw, sh := b.Dx(), b.Dy()
	if sw < 1 {
		sw = 1
	}
	if sh < 1 {
		sh = 1
	}

	var scale float64
	if fill {
		scale = math.Max(float64(wpx)/float64(sw), float64(hpx)/float64(sh))
	} else {
		scale = math.Min(float64(wpx)/float64(sw), float64(hpx)/float64(sh))
	}
	nw := int(math.Round(float64(sw) * scale))
	nh := int(math.Round(float64(sh) * scale))
	if nw < 1 {
		nw = 1
	}
	if nh < 1 {
		nh = 1
	}

	resized := image.NewNRGBA(image.Rect(0, 0, nw, nh))
	xdraw.CatmullRom.Scale(resized, resized.Bounds(), src, b, xdraw.Over, nil)

	rgb = make([][][3]int, hpx)
	opaque = make([][]bool, hpx)
	for y := 0; y < hpx; y++ {
		rgb[y] = make([][3]int, wpx)
		opaque[y] = make([]bool, wpx)
		if !keepAlpha {
			for x := 0; x < wpx; x++ {
				opaque[y][x] = true // letterbox bars baked as opaque black
			}
		}
	}

	offx := (wpx - nw) / 2
	offy := (hpx - nh) / 2
	if topAlign {
		offy = 0 // art touches the top; the letterbox bar goes to the bottom
	}
	for y := 0; y < nh; y++ {
		cy := offy + y
		if cy < 0 || cy >= hpx {
			continue
		}
		for x := 0; x < nw; x++ {
			cx := offx + x
			if cx < 0 || cx >= wpx {
				continue
			}
			p := resized.NRGBAAt(x, y)
			a := int(p.A)
			// composite straight-alpha pixel over a black background
			rgb[cy][cx] = [3]int{
				int(p.R) * a / 255,
				int(p.G) * a / 255,
				int(p.B) * a / 255,
			}
			if keepAlpha {
				opaque[cy][cx] = a >= 128
			}
		}
	}
	return rgb, opaque
}

// --- per-block palette clustering (<=8 OBJ palettes) ---

// paletteFitError is the total nearest-colour squared error of pixels against a
// palette (0 for an empty pixel set).
func paletteFitError(pix, pal [][3]int) float64 {
	var total float64
	for _, p := range pix {
		best := math.MaxFloat64
		for _, c := range pal {
			dr := float64(p[0] - c[0])
			dg := float64(p[1] - c[1])
			db := float64(p[2] - c[2])
			d := dr*dr + dg*dg + db*db
			if d < best {
				best = d
			}
		}
		total += best
	}
	return total
}

// clusterBlockPalettes builds <=nPalettes shared 15-colour palettes and assigns
// each 16x16 block to one, minimising per-pixel quantisation error (deterministic
// farthest-point k-means). blocks is row-major (sy*wSpr+sx) opaque pixels per block.
func clusterBlockPalettes(blocks [][][3]int, wSpr, hSpr, nPalettes int) (palettes [][][3]int, blockmap []uint8) {
	nb := wSpr * hSpr
	blockmap = make([]uint8, nb)

	var nonempty []int
	for i := 0; i < nb; i++ {
		if len(blocks[i]) > 0 {
			nonempty = append(nonempty, i)
		}
	}
	if len(nonempty) == 0 {
		return [][][3]int{make([][3]int, 15)}, blockmap // a single black palette
	}

	k := nPalettes
	if k > len(nonempty) {
		k = len(nonempty)
	}

	blockPal := make(map[int][][3]int, len(nonempty))
	for _, i := range nonempty {
		blockPal[i] = medianCut(blocks[i], 15)
	}

	// farthest-point init: seed 0 = the block with the most opaque pixels, then
	// repeatedly add the block worst-fit (per pixel) by the current seed palettes.
	seeds := []int{nonempty[0]}
	for _, i := range nonempty {
		if len(blocks[i]) > len(blocks[seeds[0]]) {
			seeds[0] = i
		}
	}
	inSeeds := func(i int) bool {
		for _, s := range seeds {
			if s == i {
				return true
			}
		}
		return false
	}
	for len(seeds) < k {
		bestI, bestErr := -1, -1.0
		for _, i := range nonempty {
			if inSeeds(i) {
				continue
			}
			minErr := math.MaxFloat64
			for _, s := range seeds {
				if e := paletteFitError(blocks[i], blockPal[s]); e < minErr {
					minErr = e
				}
			}
			errn := minErr / math.Max(1, float64(len(blocks[i])))
			if errn > bestErr {
				bestErr, bestI = errn, i
			}
		}
		if bestI < 0 {
			break
		}
		seeds = append(seeds, bestI)
	}

	centroids := make([][][3]int, k)
	for c := 0; c < k; c++ {
		centroids[c] = append([][3]int(nil), blockPal[seeds[c]]...)
	}
	assign := make([]int, nb)
	for i := range assign {
		assign[i] = -1
	}
	for it := 0; it < 8; it++ {
		changed := false
		for _, i := range nonempty {
			bestC, bestE := 0, math.MaxFloat64
			for c := 0; c < k; c++ {
				if e := paletteFitError(blocks[i], centroids[c]); e < bestE {
					bestE, bestC = e, c
				}
			}
			if assign[i] != bestC {
				changed = true
			}
			assign[i] = bestC
		}
		for c := 0; c < k; c++ {
			var allpix [][3]int
			for _, i := range nonempty {
				if assign[i] == c {
					allpix = append(allpix, blocks[i]...)
				}
			}
			if len(allpix) > 0 {
				centroids[c] = medianCut(allpix, 15)
			}
		}
		if !changed && it > 0 {
			break
		}
	}

	palettes = centroids
	for _, i := range nonempty {
		blockmap[i] = uint8(assign[i])
	}
	return palettes, blockmap
}

// --- quantisation (cross-block Floyd-Steinberg) ---

// quantiseImageCrossblock quantises the whole image to 4bpp indices (0 transparent,
// 1..15) where each pixel uses its 16x16 block's assigned palette. Floyd-Steinberg
// error diffuses across block boundaries, removing visible block seams in gradients.
func quantiseImageCrossblock(rgb [][][3]int, opaque [][]bool, palettes [][][3]int, blockmap []uint8, wSpr, hSpr int, dither bool) [][]uint8 {
	h := len(rgb)
	w := 0
	if h > 0 {
		w = len(rgb[0])
	}
	idx := make([][]uint8, h)
	for y := range idx {
		idx[y] = make([]uint8, w)
	}
	blockPalAt := func(y, x int) [][3]int {
		return palettes[blockmap[(y/16)*wSpr+(x/16)]]
	}

	if !dither {
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				if opaque[y][x] {
					idx[y][x] = uint8(nearest(rgb[y][x], blockPalAt(y, x)) + 1)
				}
			}
		}
		return idx
	}

	work := make([][][3]float64, h)
	for y := 0; y < h; y++ {
		work[y] = make([][3]float64, w)
		for x := 0; x < w; x++ {
			work[y][x] = [3]float64{float64(rgb[y][x][0]), float64(rgb[y][x][1]), float64(rgb[y][x][2])}
		}
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if !opaque[y][x] {
				continue
			}
			pal := blockPalAt(y, x)
			old := work[y][x]
			k := nearestF(old, pal)
			idx[y][x] = uint8(k + 1)
			newc := pal[k]
			errc := [3]float64{old[0] - float64(newc[0]), old[1] - float64(newc[1]), old[2] - float64(newc[2])}
			diffuse := func(yy, xx int, f float64) {
				if yy < 0 || yy >= h || xx < 0 || xx >= w || !opaque[yy][xx] {
					return
				}
				work[yy][xx][0] += errc[0] * f
				work[yy][xx][1] += errc[1] * f
				work[yy][xx][2] += errc[2] * f
			}
			diffuse(y, x+1, 7.0/16)
			diffuse(y+1, x-1, 3.0/16)
			diffuse(y+1, x, 5.0/16)
			diffuse(y+1, x+1, 1.0/16)
		}
	}
	return idx
}

func nearest(p [3]int, pal [][3]int) int {
	best, bestD := 0, math.MaxInt64
	for i, c := range pal {
		dr, dg, db := p[0]-c[0], p[1]-c[1], p[2]-c[2]
		d := dr*dr + dg*dg + db*db
		if d < bestD {
			bestD, best = d, i
		}
	}
	return best
}

func nearestF(p [3]float64, pal [][3]int) int {
	best := 0
	bestD := math.MaxFloat64
	for i, c := range pal {
		dr, dg, db := p[0]-float64(c[0]), p[1]-float64(c[1]), p[2]-float64(c[2])
		d := dr*dr + dg*dg + db*db
		if d < bestD {
			bestD, best = d, i
		}
	}
	return best
}

// medianCut reduces pixels to exactly ncolors representative colours (padded with
// black when there are too few distinct colours).
func medianCut(pixels [][3]int, ncolors int) [][3]int {
	out := make([][3]int, ncolors)
	if len(pixels) == 0 {
		return out
	}
	type box struct{ px [][3]int }
	boxes := []box{{px: append([][3]int(nil), pixels...)}}

	for len(boxes) < ncolors {
		bi, bestRange, bestCh := -1, 0, 0
		for i := range boxes {
			if len(boxes[i].px) < 2 {
				continue
			}
			for ch := 0; ch < 3; ch++ {
				mn, mx := 255, 0
				for _, p := range boxes[i].px {
					if p[ch] < mn {
						mn = p[ch]
					}
					if p[ch] > mx {
						mx = p[ch]
					}
				}
				if mx-mn > bestRange {
					bestRange, bi, bestCh = mx-mn, i, ch
				}
			}
		}
		if bi < 0 || bestRange <= 0 {
			break // no box can be split further
		}
		px := boxes[bi].px
		sort.Slice(px, func(a, b int) bool { return px[a][bestCh] < px[b][bestCh] })
		mid := len(px) / 2
		nb := make([]box, 0, len(boxes)+1)
		nb = append(nb, boxes[:bi]...)
		nb = append(nb, box{px: px[:mid]}, box{px: px[mid:]})
		nb = append(nb, boxes[bi+1:]...)
		boxes = nb
	}

	for i := 0; i < ncolors; i++ {
		if i < len(boxes) && len(boxes[i].px) > 0 {
			var sr, sg, sb int
			for _, p := range boxes[i].px {
				sr += p[0]
				sg += p[1]
				sb += p[2]
			}
			n := len(boxes[i].px)
			out[i] = [3]int{(sr + n/2) / n, (sg + n/2) / n, (sb + n/2) / n}
		}
	}
	return out
}

// --- encoding ---

// encodePalettesV4 emits each palette as 16 BGR555 LE entries: index 0 = transparent
// (0), entries 1..15 = the 15 colours.
func encodePalettesV4(palettes [][][3]int) []byte {
	out := make([]byte, 0, len(palettes)*16*2)
	for _, pal := range palettes {
		out = append(out, 0, 0) // index 0 = transparent
		for i := 0; i < 15; i++ {
			var r, g, b int
			if i < len(pal) {
				r, g, b = pal[i][0], pal[i][1], pal[i][2]
			}
			w := rgbToBGR555(r, g, b)
			out = append(out, byte(w&0xFF), byte((w>>8)&0xFF))
		}
	}
	return out
}

// encodeTile4bpp encodes the 8x8 block at (x0,y0) of idx into 32 bytes of SNES 4bpp
// planar tile data (bytes 0..15 = bitplanes 0&1 row-interleaved, 16..31 = 2&3).
func encodeTile4bpp(idx [][]uint8, x0, y0 int) []byte {
	out := make([]byte, 32)
	for row := 0; row < 8; row++ {
		var p0, p1, p2, p3 int
		for col := 0; col < 8; col++ {
			v := int(idx[y0+row][x0+col]) & 0x0F
			bit := 7 - col
			p0 |= ((v >> 0) & 1) << bit
			p1 |= ((v >> 1) & 1) << bit
			p2 |= ((v >> 2) & 1) << bit
			p3 |= ((v >> 3) & 1) << bit
		}
		out[row*2] = byte(p0)
		out[row*2+1] = byte(p1)
		out[16+row*2] = byte(p2)
		out[16+row*2+1] = byte(p3)
	}
	return out
}

// encodeTilesNameGrid emits a (2*hSpr) row x 16 col grid of 8x8 4bpp tiles (right
// columns past 2*wSpr zero-filled). The OBJ tile number for sprite (sx,sy) is
// (2*sy)*16 + 2*sx, matching this streamed order.
func encodeTilesNameGrid(idx [][]uint8, wSpr, hSpr int) []byte {
	ncolsUsed := 2 * wSpr
	out := make([]byte, 0, (2*hSpr)*16*32)
	zero := make([]byte, 32)
	for cy := 0; cy < 2*hSpr; cy++ {
		for cx := 0; cx < 16; cx++ {
			if cx < ncolsUsed {
				out = append(out, encodeTile4bpp(idx, cx*8, cy*8)...)
			} else {
				out = append(out, zero...)
			}
		}
	}
	return out
}

// --- decoder (for round-trip tests / qa) ---

// Decoded is the result of decoding a .cov v4 blob.
type Decoded struct {
	WSpr, HSpr int
	NPalettes  int
	Dithered   bool
	Palettes   [][][3]int // NPalettes x 16 RGB (index 0 transparent)
	Blockmap   []uint8    // WSpr*HSpr palette indices
	// Tiles holds the decoded name-grid indices, (2*HSpr*8) high by (16*8) wide.
	Tiles [][]uint8
}

// Decode parses a .cov v4 blob (mirrors cover_conv.py verify_cov_v4).
func Decode(blob []byte) (*Decoded, error) {
	if len(blob) < headerSize || blob[0] != magic0 || blob[1] != magic1 ||
		blob[2] != version || blob[8] != bpp {
		return nil, fmt.Errorf("not a .cov v4 file")
	}
	d := &Decoded{
		Dithered:  blob[3]&0x01 != 0,
		WSpr:      int(blob[4]),
		HSpr:      int(blob[5]),
		NPalettes: int(blob[6]),
	}
	off := headerSize
	palSize := d.NPalettes * 16 * 2
	bmSize := d.WSpr * d.HSpr
	tilesSize := (2 * d.HSpr) * 16 * 32
	if len(blob) < off+palSize+bmSize+tilesSize {
		return nil, fmt.Errorf("truncated .cov v4 file")
	}

	d.Palettes = make([][][3]int, d.NPalettes)
	for p := 0; p < d.NPalettes; p++ {
		d.Palettes[p] = make([][3]int, 16)
		for i := 0; i < 16; i++ {
			w := int(blob[off]) | int(blob[off+1])<<8
			r, g, b := bgr555ToRGB(w)
			d.Palettes[p][i] = [3]int{r, g, b}
			off += 2
		}
	}

	d.Blockmap = append([]uint8(nil), blob[off:off+bmSize]...)
	off += bmSize

	rows, cols := 2*d.HSpr, 16
	d.Tiles = make([][]uint8, rows*8)
	for y := range d.Tiles {
		d.Tiles[y] = make([]uint8, cols*8)
	}
	for cy := 0; cy < rows; cy++ {
		for cx := 0; cx < cols; cx++ {
			tile := blob[off : off+32]
			off += 32
			for row := 0; row < 8; row++ {
				p0, p1 := tile[row*2], tile[row*2+1]
				p2, p3 := tile[16+row*2], tile[16+row*2+1]
				for col := 0; col < 8; col++ {
					bit := uint(7 - col)
					v := int((p0>>bit)&1) | int((p1>>bit)&1)<<1 |
						int((p2>>bit)&1)<<2 | int((p3>>bit)&1)<<3
					d.Tiles[cy*8+row][cx*8+col] = uint8(v)
				}
			}
		}
	}
	return d, nil
}

// Image renders a Decoded cover to an RGBA image (index 0 = transparent). Each
// 16x16 sprite (sx,sy) reads name-grid cells (2sy,2sx),(2sy,2sx+1),(2sy+1,2sx),
// (2sy+1,2sx+1) and colours them with its block's palette.
func (d *Decoded) Image() image.Image {
	img := image.NewRGBA(image.Rect(0, 0, d.WSpr*16, d.HSpr*16))
	draw.Draw(img, img.Bounds(), image.Transparent, image.Point{}, draw.Src)
	for sy := 0; sy < d.HSpr; sy++ {
		for sx := 0; sx < d.WSpr; sx++ {
			pi := int(d.Blockmap[sy*d.WSpr+sx])
			if pi < 0 || pi >= d.NPalettes {
				pi = 0
			}
			pal := d.Palettes[pi]
			for dy := 0; dy < 16; dy++ {
				for dx := 0; dx < 16; dx++ {
					cy := 2*sy + dy/8
					cx := 2*sx + dx/8
					v := int(d.Tiles[cy*8+dy%8][cx*8+dx%8])
					if v == 0 {
						continue // transparent
					}
					c := pal[v]
					img.Set(sx*16+dx, sy*16+dy, color.RGBA{uint8(c[0]), uint8(c[1]), uint8(c[2]), 255})
				}
			}
		}
	}
	return img
}
