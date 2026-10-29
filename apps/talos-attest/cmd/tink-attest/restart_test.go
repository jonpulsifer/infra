package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestRestartPodsDeletesThePodsOnItsNode(t *testing.T) {
	var deleted []string
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/namespaces/spire/pods":
			q := r.URL.Query()
			if q.Get("labelSelector") != "app.kubernetes.io/name=spire-agent" || q.Get("fieldSelector") != "spec.nodeName=riptide" {
				t.Errorf("list query %s", r.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"spire-agent-abcde"}}]}`))
		case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/api/v1/namespaces/spire/pods/"):
			deleted = append(deleted, strings.TrimPrefix(r.URL.Path, "/api/v1/namespaces/spire/pods/"))
			_, _ = w.Write([]byte(`{}`))
		default:
			http.Error(w, "unexpected "+r.Method+" "+r.URL.Path, http.StatusNotFound)
		}
	}))
	defer ts.Close()

	k := &kube{base: ts.URL, token: "tok", client: ts.Client()}
	got, err := k.restartPods(context.Background(), "spire", "app.kubernetes.io/name=spire-agent", "riptide")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"spire-agent-abcde"}
	if !reflect.DeepEqual(got, want) || !reflect.DeepEqual(deleted, want) {
		t.Fatalf("restarted %v, deleted %v", got, deleted)
	}
}

func TestRestartPodsReportsAForbiddenDelete(t *testing.T) {
	ts := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(`{"items":[{"metadata":{"name":"spire-agent-abcde"}}]}`))
			return
		}
		http.Error(w, `{"reason":"Forbidden"}`, http.StatusForbidden)
	}))
	defer ts.Close()

	k := &kube{base: ts.URL, token: "tok", client: ts.Client()}
	if _, err := k.restartPods(context.Background(), "spire", "app.kubernetes.io/name=spire-agent", "riptide"); err == nil || !strings.Contains(err.Error(), "403") {
		t.Fatalf("got %v, want the 403", err)
	}
}
