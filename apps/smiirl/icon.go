package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"log"
)

var (
	iconGround = color.RGBA{0x1b, 0x19, 0x17, 0xff}
	iconCard   = color.RGBA{0xf3, 0xea, 0xdb, 0xff}
	iconSeam   = color.RGBA{0xd9, 0x8a, 0x34, 0xff}
)

// 180 px is the apple-touch-icon size. Drawing it at startup leaves no PNG
// to regenerate.
var iconPNG = drawIcon(180)

func drawIcon(size int) []byte {
	const ss = 4 // supersampling factor; the box filter below is the only antialiasing
	n := size * ss
	big := image.NewRGBA(image.Rect(0, 0, n, n))
	f := func(v float64) int { return int(v * float64(n)) }
	fill(big, 0, 0, n, n, f(0.14), iconGround)
	// The card spans the middle 62%, inside the 80% a maskable crop keeps.
	fill(big, f(0.19), f(0.13), f(0.81), f(0.87), f(0.07), iconCard)
	// The shadow the top flap casts, then the seam.
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
		log.Fatal(err) // encoding a fixed image fails only on a bug
	}
	return buf.Bytes()
}

func fill(img *image.RGBA, x0, y0, x1, y1, r int, c color.RGBA) {
	for y := y0; y < y1; y++ {
		for x := x0; x < x1; x++ {
			if inRound(x, y, x0, y0, x1, y1, r) {
				img.SetRGBA(x, y, c)
			}
		}
	}
}

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
