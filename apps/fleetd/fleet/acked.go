package fleet

import (
	"context"
	"crypto/tls"
	"errors"
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
	return waitAck(r, c, deadline)
}

// armReset makes any close of the request's connection a reset, or with
// armed false a graceful close again. A fetch arms it before it writes the
// config and disarms it once the node acknowledged the answer: a write that
// fails can close the connection inside net/http, and a graceful close
// would leave the kernel retransmitting what it holds, so a node whose
// network comes back would get a config fleetd holds unburned.
func armReset(r *http.Request, armed bool) error {
	c, ok := tcpConn(r)
	if !ok {
		return nil
	}
	if armed {
		return c.SetLinger(0)
	}
	return c.SetLinger(-1)
}

// resetConn resets the request's connection after an answer that did not
// reach the node whole, and annotates why. Only an acknowledged retry then
// delivers the config. A connection net/http already closed was reset by
// that close, since the fetch armed it; a request without a connection is
// left as it is.
func resetConn(r *http.Request, why error) error {
	c, ok := tcpConn(r)
	if !ok {
		return why
	}
	err := c.SetLinger(0)
	if err == nil {
		err = c.Close()
	}
	if err != nil && !errors.Is(err, net.ErrClosed) {
		return fmt.Errorf("%w; reset the connection: %v", why, err)
	}
	return fmt.Errorf("%w; fleetd reset the connection", why)
}

// tcpConn is the request's TCP socket, under TLS the one below the records.
// Closing it makes net/http's next read or write on the conn fail, so the
// connection is never reused.
func tcpConn(r *http.Request) (*net.TCPConn, bool) {
	c, ok := r.Context().Value(connKey{}).(net.Conn)
	if !ok {
		return nil, false
	}
	if t, ok := c.(*tls.Conn); ok {
		c = t.NetConn()
	}
	tc, ok := c.(*net.TCPConn)
	return tc, ok
}

func waitAck(r *http.Request, c net.Conn, deadline time.Time) error {
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
