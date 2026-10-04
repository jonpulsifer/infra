package main

import (
	"testing"
	"time"
)

// pitReading is a reading with only the pit and the set temperature known.
func pitReading(pit int) bucket {
	b := emptyBucket()
	b[pitSeries] = pit
	b[setSeries] = 1211
	return b
}

func TestHistoryKeepsTheLastReadingOfEachBucket(t *testing.T) {
	h := newHistory()
	h.record(0, pitReading(1000))
	h.record(59*time.Second, pitReading(1001))
	h.record(150*time.Second, pitReading(1002))

	want := []int{1001, probeUnplugged, 1002}
	if len(h.buckets) != len(want) {
		t.Fatalf("buckets = %d, want %d", len(h.buckets), len(want))
	}
	for i, pit := range want {
		if got := h.buckets[i][pitSeries]; got != pit {
			t.Errorf("bucket %d pit = %d, want %d", i, got, pit)
		}
	}
}

func TestHistoryStepFitsTheElapsedTime(t *testing.T) {
	for _, tc := range []struct {
		name    string
		elapsed time.Duration
		step    time.Duration
		length  int
	}{
		{"first reading", 0, time.Minute, 1},
		{"last bucket at one minute", 239 * time.Minute, time.Minute, 240},
		{"first bucket past the limit", 240 * time.Minute, 2 * time.Minute, 121},
		{"last bucket at two minutes", 479 * time.Minute, 2 * time.Minute, 240},
		{"second doubling", 480 * time.Minute, 4 * time.Minute, 121},
		{"a long cook", 30 * time.Hour, 8 * time.Minute, 226},
		{"before the cook began", -time.Minute, time.Minute, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newHistory()
			h.record(0, pitReading(1000))
			h.record(tc.elapsed, pitReading(1500))

			if h.step != tc.step || len(h.buckets) != tc.length {
				t.Errorf("step %v with %d buckets, want %v with %d", h.step, len(h.buckets), tc.step, tc.length)
			}
			if got := h.buckets[h.index(tc.elapsed)][pitSeries]; got != 1500 {
				t.Errorf("newest reading = %d, want 1500", got)
			}
		})
	}
}

func TestHistoryCompactionKeepsTheLaterReadingOfEachPair(t *testing.T) {
	h := newHistory()
	for m := 0; m < historyMax; m++ {
		h.record(time.Duration(m)*time.Minute, pitReading(1000+m))
	}
	if h.step != time.Minute || len(h.buckets) != historyMax {
		t.Fatalf("before the boundary: step %v with %d buckets", h.step, len(h.buckets))
	}

	h.record(historyMax*time.Minute, pitReading(2000))

	if h.step != 2*time.Minute || len(h.buckets) != historyMax/2+1 {
		t.Fatalf("after the boundary: step %v with %d buckets", h.step, len(h.buckets))
	}
	for i := 0; i < historyMax/2; i++ {
		if got, want := h.buckets[i][pitSeries], 1000+2*i+1; got != want {
			t.Fatalf("merged bucket %d pit = %d, want %d", i, got, want)
		}
	}
	if got := h.buckets[historyMax/2][pitSeries]; got != 2000 {
		t.Errorf("newest bucket pit = %d, want 2000", got)
	}
}

// An unplugged probe in the later half of a pair is that reading's value, so it
// must not be filled from the earlier half.
func TestHistoryMergeDoesNotFillFromTheEarlierReading(t *testing.T) {
	early := emptyBucket()
	early[pitSeries], early[setSeries], early[probeSeries] = 1000, 1211, 500
	late := emptyBucket()
	late[pitSeries], late[setSeries], late[probeSeries+1] = 1010, 1211, 600

	h := newHistory()
	h.record(0, early)
	h.record(time.Minute, late)
	h.record(historyMax*time.Minute, pitReading(1500))

	if got := h.buckets[0]; got != late {
		t.Errorf("merged bucket = %v, want the later reading %v", got, late)
	}
}

func TestHistoryMergeKeepsTheEarlierReadingOverAnEmptyBucket(t *testing.T) {
	early := pitReading(1000)

	if got := early.merge(emptyBucket()); got != early {
		t.Errorf("merged bucket = %v, want %v", got, early)
	}
}

// The last reading of a coarse bucket reads the same whether compaction ran
// before or after it arrived.
func TestHistoryLastReadingIsIndependentOfCompactionOrder(t *testing.T) {
	probeOne := func(pit int) bucket {
		b := pitReading(pit)
		b[probeSeries] = 500
		return b
	}
	last := pitReading(1010)

	after := newHistory()
	after.record(0, probeOne(1000))
	after.record(time.Minute, last)
	after.record(historyMax*time.Minute, pitReading(1500))

	before := newHistory()
	before.record(0, probeOne(1000))
	before.record(historyMax*time.Minute, pitReading(1500))
	before.record(time.Minute, last)

	if after.buckets[0] != last || before.buckets[0] != last {
		t.Errorf("first bucket = %v after, %v before, want %v for both", after.buckets[0], before.buckets[0], last)
	}
}

func TestHistoryAtLeavesTheRecordUntouched(t *testing.T) {
	h := newHistory()
	h.record(0, pitReading(1000))

	view := h.at(500 * time.Minute)

	if view.step != 4*time.Minute || len(view.buckets) != 126 {
		t.Errorf("view: step %v with %d buckets, want 4m0s with 126", view.step, len(view.buckets))
	}
	if h.step != time.Minute || len(h.buckets) != 1 {
		t.Errorf("record: step %v with %d buckets, want 1m0s with 1", h.step, len(h.buckets))
	}
}
