package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"log"
)

// The icon is a split-flap card on a dark ground: the drum's seam across the
// middle is the whole read. It is drawn rather than committed as a blob so
// there is no asset to regenerate, and it stays inside the middle 80% of the
// square so a maskable crop never cuts it.
var (
	iconGround = color.RGBA{0x1b, 0x19, 0x17, 0xff}
	iconCard   = color.RGBA{0xf3, 0xea, 0xdb, 0xff}
	iconSeam   = color.RGBA{0xd9, 0x8a, 0x34, 0xff}
)

// iconPNG is the apple-touch-icon, drawn once at startup.
var iconPNG = drawIcon(180)

// drawIcon renders the icon at size px square. It draws at 4x and box-filters
// down, which is the whole of the antialiasing.
func drawIcon(size int) []byte {
	const ss = 4
	n := size * ss
	big := image.NewRGBA(image.Rect(0, 0, n, n))
	f := func(v float64) int { return int(v * float64(n)) }
	fill(big, 0, 0, n, n, f(0.14), iconGround)
	// The card sits in the middle 62%, well inside a maskable crop.
	fill(big, f(0.19), f(0.13), f(0.81), f(0.87), f(0.07), iconCard)
	// The seam, and the shadow the top flap casts on the bottom one.
	fill(big, f(0.19), f(0.47), f(0.81), f(0.50), 0, color.RGBA{0x2a, 0x25, 0x21, 0xff})
	fill(big, f(0.19), f(0.50), f(0.81), f(0.53), 0, iconSeam)

	out := image.NewRGBA(image.Rect(0, 0, size, size))
	for y := range size {
		for x := range size {
			var r, g, b int
			for dy := range ss {
				for dx := range ss {
					c := big.RGBAAt(x*ss+dx, y*ss+dy)
					r, g, b = r+int(c.R), g+int(c.G), b+int(c.B)
				}
			}
			d := ss * ss
			out.SetRGBA(x, y, color.RGBA{uint8(r / d), uint8(g / d), uint8(b / d), 0xff})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, out); err != nil {
		log.Fatal(err) // a fixed image that cannot be encoded is a bug, not a runtime error
	}
	return buf.Bytes()
}

// fill paints the rectangle with corners rounded to radius r.
func fill(img *image.RGBA, x0, y0, x1, y1, r int, c color.RGBA) {
	for y := y0; y < y1; y++ {
		for x := x0; x < x1; x++ {
			if inRound(x, y, x0, y0, x1, y1, r) {
				img.SetRGBA(x, y, c)
			}
		}
	}
}

// inRound reports whether x,y is inside the rounded rectangle. Only the four
// corner squares need the distance check; everything else is inside already.
func inRound(x, y, x0, y0, x1, y1, r int) bool {
	cx, cy := x, y
	switch {
	case x < x0+r:
		cx = x0 + r
	case x >= x1-r:
		cx = x1 - r - 1
	default:
		return true
	}
	switch {
	case y < y0+r:
		cy = y0 + r
	case y >= y1-r:
		cy = y1 - r - 1
	default:
		return true
	}
	dx, dy := x-cx, y-cy
	return dx*dx+dy*dy <= r*r
}
