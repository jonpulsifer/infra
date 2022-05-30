package view_counter

import (
	"net/http/httptest"
	"regexp"
	"testing"
)

func TestViewCounterGet(t *testing.T) {
	// TODO: make a firestore test :O
	t.Skip("this test doesn't work with firestore")

	req := httptest.NewRequest("GET", "/", nil)
	rr := httptest.NewRecorder()

	// make a request
	viewCounter(rr, req)

	// validate content type
	contentType := "image/svg+xml"
	if got := rr.Header().Get("Content-Type"); got != contentType {
		t.Errorf("Wrong Content-Type. got: %q, want: %q", got, contentType)
	}

	// check that the response body has the svg text "1"
	r, _ := regexp.Compile("<text.+>1</text>")
	if got := rr.Body.String(); !r.MatchString(got) {
		t.Errorf("Could not find SVG text \"1\", got: %q", got)
	}

	// make another request to increment the counter, check that it is "2"
	viewCounter(rr, req)
	r, _ = regexp.Compile("<text.+>2</text>")
	if got := rr.Body.String(); !r.MatchString(got) {
		t.Errorf("Could not find SVG text \"2\", got: %q", got)
	}

	// make a request with a new label
	req = httptest.NewRequest("GET", "/?label=TestLabel", nil)
	viewCounter(rr, req)

	// check that the response body has the svg text "TestLabel"
	r, _ = regexp.Compile("<text.+>TestLabel</text>")
	if got := rr.Body.String(); !r.MatchString(got) {
		t.Errorf("Could not find SVG text \"TestLabel\", got: %q", got)
	}

	// check that the response body has the svg text "1"
	r, _ = regexp.Compile("<text.+>1</text>")
	if got := rr.Body.String(); !r.MatchString(got) {
		t.Errorf("Could not find SVG text \"1\", got: %q", got)
	}
}
