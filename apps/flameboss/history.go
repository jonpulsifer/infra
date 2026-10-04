package main

import (
	"slices"
	"time"
)

const (
	historyStep = time.Minute
	historyMax  = 240
)

// Series positions in a bucket: the pit, the set temperature, then the three
// meat probes.
const (
	pitSeries = iota
	setSeries
	probeSeries
	seriesCount = probeSeries + 3
)

// A bucket holds the last reading that arrived in it, in decidegrees Celsius.
// probeUnplugged marks a series with no value, so an unplugged probe and a
// missed reading both read as null.
type bucket [seriesCount]int

func emptyBucket() bucket {
	var b bucket
	for i := range b {
		b[i] = probeUnplugged
	}
	return b
}

// merge returns the later bucket as it is when it holds a reading, which always
// carries the set temperature, and the earlier bucket otherwise.
func (b bucket) merge(later bucket) bucket {
	if later[setSeries] != probeUnplugged {
		return later
	}
	return b
}

// history is a cook's temperature record in buckets of step width, counted
// from the cook's start. A cook that outgrows historyMax buckets doubles the
// step and merges neighbours, so the record stays bounded however long the
// cook runs.
type history struct {
	step    time.Duration
	buckets []bucket
}

func newHistory() history {
	return history{step: historyStep}
}

func (h history) index(elapsed time.Duration) int {
	return int(max(elapsed, 0) / h.step)
}

// advance grows the record to cover elapsed, so its last bucket is the
// present, and compacts until that bucket fits.
func (h *history) advance(elapsed time.Duration) {
	for h.index(elapsed) >= historyMax {
		h.compact()
	}
	for len(h.buckets) <= h.index(elapsed) {
		h.buckets = append(h.buckets, emptyBucket())
	}
}

func (h *history) compact() {
	merged := make([]bucket, 0, (len(h.buckets)+1)/2)
	for i := 0; i < len(h.buckets); i += 2 {
		b := h.buckets[i]
		if i+1 < len(h.buckets) {
			b = b.merge(h.buckets[i+1])
		}
		merged = append(merged, b)
	}
	h.buckets = merged
	h.step *= 2
}

func (h *history) record(elapsed time.Duration, reading bucket) {
	h.advance(elapsed)
	h.buckets[h.index(elapsed)] = reading
}

// at returns the record as of elapsed without changing it, which is how a quiet
// controller shows trailing nulls.
func (h history) at(elapsed time.Duration) history {
	h.buckets = slices.Clone(h.buckets)
	h.advance(elapsed)
	return h
}
