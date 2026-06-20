package view_counter

import (
	"context"
	"html/template"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"

	"cloud.google.com/go/firestore"
	"github.com/GoogleCloudPlatform/functions-framework-go/functions"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

var (
	defaultStoreMu sync.Mutex
	defaultStore   counterStore
)

func init() {
	functions.HTTP("ViewCounter", viewCounter)
}

type counterStore interface {
	Next(context.Context, string) (int64, error)
}

type firestoreCounterStore struct {
	client *firestore.Client
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
	store, err := getDefaultStore(r.Context())
	if err != nil {
		log.Printf("firestore.NewClient: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	viewCounterWithStore(store).ServeHTTP(w, r)
}

func viewCounterWithStore(store counterStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
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

		counter, err := store.Next(r.Context(), label)
		if err != nil {
			log.Printf("firestore: could not update counter: %v", err)
			w.WriteHeader(http.StatusInternalServerError)
			return
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
		if err := t.Execute(w, svg); err != nil {
			log.Printf("template: could not render svg: %v", err)
		}
	}
}

func getDefaultStore(ctx context.Context) (counterStore, error) {
	defaultStoreMu.Lock()
	defer defaultStoreMu.Unlock()

	if defaultStore != nil {
		return defaultStore, nil
	}

	client, err := firestore.NewClient(ctx, projectIDFromEnv())
	if err != nil {
		return nil, err
	}

	defaultStore = &firestoreCounterStore{client: client}
	return defaultStore, nil
}

func projectIDFromEnv() string {
	if projectID := os.Getenv("GOOGLE_CLOUD_PROJECT"); projectID != "" {
		return projectID
	}

	return os.Getenv("GCP_PROJECT")
}

func (s *firestoreCounterStore) Next(ctx context.Context, label string) (int64, error) {
	doc := s.client.Collection("views").Doc(label)

	snapshot, err := doc.Get(ctx)
	if err != nil && status.Code(err) != codes.NotFound {
		return 0, err
	}

	counter := int64(1)
	if err == nil && snapshot.Exists() {
		var current document
		if err := snapshot.DataTo(&current); err != nil {
			return 0, err
		}

		counter = current.Count + 1
		_, err := doc.Update(ctx, []firestore.Update{
			{Path: "count", Value: firestore.Increment(1)},
		})
		if err != nil {
			return 0, err
		}
	} else {
		_, err := doc.Set(ctx, map[string]interface{}{"count": counter}, firestore.MergeAll)
		if err != nil {
			return 0, err
		}
	}

	return counter, nil
}
