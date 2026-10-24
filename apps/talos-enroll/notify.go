package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

// Notifier keeps one chat message per key and replaces its text on each call.
type Notifier interface {
	Notify(ctx context.Context, key, content string) error
}

// Discord posts through a webhook whose URL it reads from a file on every
// call, so a rotated Secret needs no restart.
type Discord struct {
	URLFile string
	Client  *http.Client
	ids     map[string]string
}

type discordMessage struct {
	Content         string         `json:"content"`
	AllowedMentions map[string]any `json:"allowed_mentions"`
}

func (d *Discord) Notify(ctx context.Context, key, content string) error {
	raw, err := os.ReadFile(d.URLFile)
	if err != nil {
		return fmt.Errorf("read the webhook URL: %w", err)
	}
	base, err := url.Parse(strings.TrimSpace(string(raw)))
	if err != nil {
		return fmt.Errorf("parse the webhook URL: %w", err)
	}
	if d.ids == nil {
		d.ids = map[string]string{}
	}
	// Device fields are self-asserted, so no mention in them may ping anyone.
	body, _ := json.Marshal(discordMessage{Content: content, AllowedMentions: map[string]any{"parse": []string{}}})

	if id := d.ids[key]; id != "" {
		edit := *base
		edit.Path = strings.TrimSuffix(edit.Path, "/") + "/messages/" + id
		status, _, err := d.send(ctx, http.MethodPatch, edit.String(), body)
		if err == nil {
			return nil
		}
		if status != http.StatusNotFound {
			return err
		}
	}
	post := *base
	q := post.Query()
	q.Set("wait", "true")
	post.RawQuery = q.Encode()
	_, resp, err := d.send(ctx, http.MethodPost, post.String(), body)
	if err != nil {
		return err
	}
	var msg struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(resp, &msg) == nil && msg.ID != "" {
		d.ids[key] = msg.ID
	}
	return nil
}

func (d *Discord) send(ctx context.Context, method, u string, body []byte) (int, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := d.Client.Do(req)
	if err != nil {
		// The URL holds the webhook's token, so it never reaches a log.
		return 0, nil, fmt.Errorf("discord %s: %w", method, unwrapURLError(err))
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode/100 != 2 {
		return resp.StatusCode, nil, fmt.Errorf("discord %s: status %d", method, resp.StatusCode)
	}
	return resp.StatusCode, data, nil
}

func unwrapURLError(err error) error {
	if ue, ok := err.(*url.Error); ok {
		return ue.Err
	}
	return err
}

type note struct{ key, content string }

// Outbox sends notes one at a time in order, so edits to one message never
// race, and a slow Discord never holds up a Talos request.
type Outbox struct {
	n       Notifier
	queue   chan note
	log     *slog.Logger
	Failed  atomic.Uint64
	Dropped atomic.Uint64
}

func NewOutbox(n Notifier, log *slog.Logger) *Outbox {
	return &Outbox{n: n, queue: make(chan note, 64), log: log}
}

func (o *Outbox) Send(key, content string) {
	select {
	case o.queue <- note{key, content}:
	default:
		o.Dropped.Add(1)
		o.log.Warn("notification dropped, the outbox is full", "key", key)
	}
}

func (o *Outbox) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case m := <-o.queue:
			sendCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			if err := o.n.Notify(sendCtx, m.key, m.content); err != nil {
				o.Failed.Add(1)
				o.log.Error("notification failed", "key", m.key, "err", err)
			}
			cancel()
		}
	}
}
