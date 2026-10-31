package fleet

import (
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"syscall"
	"time"
)

type connKey struct{}

// ConnContext keeps a connection in the context of its requests. The boot
// listener's server sets it, so the config's answer can wait for the node to
// acknowledge every byte before it burns.
func ConnContext(ctx context.Context, c net.Conn) context.Context {
	return context.WithValue(ctx, connKey{}, c)
}

// ackPoll is how often a fetch reads its socket's send queue.
const ackPoll = 10 * time.Millisecond

// defaultAckWait bounds the wait of a server without a WriteTimeout.
const defaultAckWait = time.Minute

// ackDeadline is when a fetch that started at start stops waiting for the
// node's acknowledgement: the end of the server's WriteTimeout.
func ackDeadline(r *http.Request, start time.Time) time.Time {
	if s, ok := r.Context().Value(http.ServerContextKey).(*http.Server); ok && s.WriteTimeout > 0 {
		return start.Add(s.WriteTimeout)
	}
	return start.Add(defaultAckWait)
}

// awaitAck waits until the peer of the request's connection has acknowledged
// every byte written to it, which means its kernel holds the answer. It
// gives up at deadline, or when the connection closes first. A request
// without a connection in its context, as from a server without
// ConnContext, has nothing to wait on.
//
// Only HTTP/1 is confirmed: HTTP/2 shares the connection among streams and
// writes a stream's data on its own schedule, so the send queue says nothing
// about one answer.
func awaitAck(r *http.Request, deadline time.Time) error {
	c, ok := r.Context().Value(connKey{}).(net.Conn)
	if !ok {
		return nil
	}
	if r.ProtoMajor != 1 {
		return fmt.Errorf("%s shares its connection, so no acknowledgement confirms the answer", r.Proto)
	}
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	tick := time.NewTicker(ackPoll)
	defer tick.Stop()
	for {
		n, err := sendQueue(c)
		switch {
		case err != nil:
			return fmt.Errorf("read the send queue: %w", err)
		case n == 0:
			return nil
		}
		select {
		case <-tick.C:
			continue
		case <-r.Context().Done():
		case <-timer.C:
		}
		if n, err = sendQueue(c); err == nil && n == 0 {
			return nil
		}
		if r.Context().Err() != nil {
			return fmt.Errorf("the connection closed with %d bytes unacknowledged", n)
		}
		return fmt.Errorf("%d bytes unacknowledged at the write deadline", n)
	}
}

// sendQueue reads the bytes written to the connection's socket that its
// peer has not acknowledged. Under TLS it reads the socket below, whose
// records carry the answer.
func sendQueue(c net.Conn) (int, error) {
	if t, ok := c.(*tls.Conn); ok {
		c = t.NetConn()
	}
	sc, ok := c.(syscall.Conn)
	if !ok {
		return 0, fmt.Errorf("%T is not a socket", c)
	}
	raw, err := sc.SyscallConn()
	if err != nil {
		return 0, err
	}
	var n int
	var qerr error
	if err := raw.Control(func(fd uintptr) { n, qerr = outq(fd) }); err != nil {
		return 0, err
	}
	return n, qerr
}
