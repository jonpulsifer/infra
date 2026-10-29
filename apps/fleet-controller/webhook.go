package main

import (
	"crypto/hmac"
	"crypto/sha512"
	"encoding/hex"
	"io"
	"log"
	"net/http"
)

// Webhook takes NetBox's event-rule webhook. NetBox signs the body with the
// rule's secret as HMAC-SHA512 hex in X-Hook-Signature. The rule has no
// condition (a condition sees only the changed object), so the hook rings on
// every device update, the controller's own writes included. It is therefore
// nothing but a "reconcile now": the body is read for the signature and
// dropped, and the trigger coalesces.
type Webhook struct {
	Secret  []byte
	Trigger chan<- string
	Metrics *Metrics
}

func (h *Webhook) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if len(h.Secret) == 0 {
		http.Error(w, "no webhook secret is configured", http.StatusServiceUnavailable)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "read", http.StatusBadRequest)
		return
	}
	mac := hmac.New(sha512.New, h.Secret)
	mac.Write(body)
	want := hex.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(want), []byte(r.Header.Get("X-Hook-Signature"))) {
		h.Metrics.WebhookRejected.Add(1)
		http.Error(w, "bad signature", http.StatusUnauthorized)
		return
	}
	h.Metrics.WebhookAccepted.Add(1)
	select {
	case h.Trigger <- "webhook":
	default:
	}
	w.WriteHeader(http.StatusAccepted)
	if _, err := io.WriteString(w, "reconcile queued\n"); err != nil {
		log.Printf("webhook reply: %v", err)
	}
}
