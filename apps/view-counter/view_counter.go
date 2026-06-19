package view_counter

import (
	"context"
	"html/template"
	"log"
	"net/http"
	"os"

	"strconv"

	"cloud.google.com/go/firestore"
	"github.com/GoogleCloudPlatform/functions-framework-go/functions"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

var client *firestore.Client

func init() {
	projectID := os.Getenv("GCP_PROJECT")
	var err error
	client, err = firestore.NewClient(context.Background(), projectID)
	if err != nil {
		log.Fatalf("firestore.NewClient: %v", err)
	}
	functions.HTTP("ViewCounter", viewCounter)
}

type document struct {
	Count int64 `firestore:"count"`
}

type imageData struct {
	BadgeHeight   float32
	BadgeWidth    float32
	Counter       int64
	CounterOffset float32
	CounterWidth  float32
	Label         string
	LabelOffset   float32
	LabelWidth    float32
}

const (
	defaultBadgeHeight  float32 = 20
	defaultCounterWidth float32 = 18
	defaultLabelWidth   float32 = 12
	defaultLabel        string  = "View Count"
)
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="{{.BadgeWidth}}" height="{{.BadgeHeight}}">
    <linearGradient id="b" x2="0" y2="100%">
        <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
        <stop offset="1" stop-opacity=".1"/>
    </linearGradient>
    <mask id="a">
        <rect width="{{.BadgeWidth}}" height="{{.BadgeHeight}}" rx="3" fill="#fff"/>
    </mask>
    <g mask="url(#a)">
        <rect width="{{.LabelWidth}}" height="{{.BadgeHeight}}" fill="#555"/>
        <rect x="{{.LabelWidth}}" width="{{.CounterWidth}}" height="{{.BadgeHeight}}" fill="#0e75b6"/>
        <rect width="{{.BadgeWidth}}" height="{{.BadgeHeight}}" fill="url(#b)"/>
    </g>
    <g fill="#fff" text-anchor="middle" font-family="sans-serif" font-size="12">
        <text x="{{.LabelOffset}}" y="15" fill="#010101" fill-opacity=".3">{{.Label}}</text>
        <text x="{{.LabelOffset}}" y="14">{{.Label}}</text>
        <text x="{{.CounterOffset}}" y="15" fill="#010101" fill-opacity=".3">{{.Counter}}</text>
        <text x="{{.CounterOffset}}" y="14">{{.Counter}}</text>
    </g>
</svg>
`

// viewCounter is an HTTP Cloud Function.
func viewCounter(w http.ResponseWriter, r *http.Request) {
	t, err := template.New("counter").Parse(svg)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	label := defaultLabel
	urlLabel := r.URL.Query().Get("label")
	if urlLabel != "" {
		label = urlLabel
	}

	ctx := context.Background()

	collection := "views"
	doc := client.Collection(collection).Doc(label)

	snapshot, err := doc.Get(ctx)
	if err != nil {
		if status.Code(err) != codes.NotFound {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
	}

	var counter int64
	if snapshot.Exists() {
		var current document
		err = snapshot.DataTo(&current)
		if err != nil {
			log.Printf("firestore: could not get data from ref: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		counter += current.Count

		_, err := doc.Update(ctx, []firestore.Update{
			{Path: "count", Value: firestore.Increment(1)},
		})
		if err != nil {
			log.Printf("firestore: could not update record: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
	} else {
		counter = 1
		_, err := doc.Set(ctx, map[string]interface{}{"count": counter}, firestore.MergeAll)
		if err != nil {
			log.Printf("firestore: could not upsert: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
	}

	counterStringLength := len(strconv.Itoa(int(counter)))
	counterWidth := defaultCounterWidth + (float32(counterStringLength) * 5)
	labelWidth := defaultLabelWidth + (float32(len(label)) * 7)

	svg := imageData{
		BadgeHeight:   defaultBadgeHeight,
		BadgeWidth:    labelWidth + counterWidth,
		Counter:       counter,
		CounterOffset: labelWidth + (counterWidth / 2),
		CounterWidth:  counterWidth,
		Label:         label,
		LabelOffset:   labelWidth / 2,
		LabelWidth:    labelWidth,
	}

	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "no-store, max-age=0")
	t.Execute(w, svg)
}
