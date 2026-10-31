package fleet

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// bigConfig is larger than a stalled reader's receive window and smaller
// than the server's send buffer, so the server's write returns while the
// reader holds back its acknowledgements.
var bigConfig = bytes.Repeat([]byte("# padding of a large Talos config\n"), 2000)

func (it *installTest) putConfig(t *testing.T, cfg []byte) {
	t.Helper()
	p := Pending{UUID: testUUID, Code: testCode, Serial: "MXL0172Q6L", Node: "riptide", Class: "worker-g5", Workflow: provWF, Rendered: it.now, TTL: 2 * time.Hour}
	if err := it.in.Configs.Put(p, cfg); err != nil {
		t.Fatal(err)
	}
}

// sndbufListener gives each accepted connection a send buffer that holds a
// whole bigConfig.
type sndbufListener struct{ net.Listener }

func (l sndbufListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if tc, ok := c.(*net.TCPConn); ok {
		_ = tc.SetWriteBuffer(1 << 20)
	}
	return c, err
}

// bootServer is the installer behind a real listener with ConnContext, as
// the boot listener runs it. Each handler that returns sends on done.
type bootServer struct {
	*httptest.Server
	in   *Installer
	done chan struct{}
}

func (it *installTest) serve(t *testing.T, writeTimeout time.Duration, useTLS bool) *bootServer {
	t.Helper()
	s := &bootServer{in: it.in, done: make(chan struct{}, 16)}
	s.Server = httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		it.in.ServeHTTP(w, r)
		s.done <- struct{}{}
	}))
	s.Listener = sndbufListener{s.Listener}
	s.Config.ConnContext = ConnContext
	s.Config.WriteTimeout = writeTimeout
	if useTLS {
		s.StartTLS()
	} else {
		s.Start()
	}
	t.Cleanup(s.Close)
	return s
}

const configPath = "/talos/config?uuid=" + testUUID + "&code=" + testCode

// get fetches the config and waits for the handler and what it started.
func (s *bootServer) get() (int, []byte, error) {
	resp, err := s.Client().Get(s.URL + configPath)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return 0, nil, err
	}
	if err := s.wait(5 * time.Second); err != nil {
		return 0, nil, err
	}
	return resp.StatusCode, body, nil
}

func (s *bootServer) mustGet(t *testing.T) (int, []byte) {
	t.Helper()
	code, body, err := s.get()
	if err != nil {
		t.Fatal(err)
	}
	return code, body
}

// wait waits for a handler to return, then for the NetBox writes it started.
func (s *bootServer) wait(within time.Duration) error {
	select {
	case <-s.done:
	case <-time.After(within):
		return fmt.Errorf("the handler did not return within %s", within)
	}
	s.in.Drain()
	return nil
}

// stalledGet asks for the config over a socket with a small receive buffer,
// reads the headers and the start of the body, and reads no more.
func stalledGet(t *testing.T, addr string) net.Conn {
	t.Helper()
	d := net.Dialer{Control: func(_, _ string, rc syscall.RawConn) error {
		var serr error
		if err := rc.Control(func(fd uintptr) {
			serr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF, 4096)
		}); err != nil {
			return err
		}
		return serr
	}}
	c, err := d.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Fprintf(c, "GET %s HTTP/1.1\r\nHost: enroll\r\n\r\n", configPath)
	head := make([]byte, 2048)
	if _, err := io.ReadFull(c, head); err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(head, []byte("HTTP/1.1 200 ")) {
		t.Fatalf("the stalled fetch began %q", head[:20])
	}
	return c
}

// The answer burns only once the node has acknowledged every byte; over TLS
// too, where the records below carry it.
func TestAnAcknowledgedAnswerBurns(t *testing.T) {
	for _, useTLS := range []bool{false, true} {
		t.Run(fmt.Sprintf("tls=%v", useTLS), func(t *testing.T) {
			it := newInstallTest(t, "planned", nil)
			it.putConfig(t, bigConfig)
			s := it.serve(t, 10*time.Second, useTLS)
			code, body := s.mustGet(t)
			if code != http.StatusOK || !bytes.Equal(body, bigConfig) {
				t.Fatalf("the fetch: %d, %d bytes", code, len(body))
			}
			if it.held(testCode) || !it.in.Configs.Spent(testUUID, testCode) {
				t.Fatal("an acknowledged answer did not burn")
			}
			if journalCount(it.nb, "success") != 1 || it.in.Metrics.Released.Load() != 1 {
				t.Fatalf("the release did not run: %v", it.nb.journals)
			}
			if code, _ := s.mustGet(t); code != http.StatusNotFound {
				t.Fatalf("a second fetch answered %d", code)
			}
		})
	}
}

// A connection that closes part way through the body leaves the config
// unburned, and the node's next fetch gets it whole.
func TestAnAnswerCutMidBodyDoesNotBurn(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	it.putConfig(t, bigConfig)
	s := it.serve(t, 30*time.Second, false)
	c := stalledGet(t, s.Listener.Addr().String())
	c.Close()
	if err := s.wait(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	if !it.held(testCode) || it.in.Configs.Spent(testUUID, testCode) {
		t.Fatal("a cut answer burned the config")
	}
	if len(it.nb.journalWith("the peer did not acknowledge all of it")) != 1 || journalCount(it.nb, "success") != 0 {
		t.Fatalf("journals %v", it.nb.journals)
	}
	code, body := s.mustGet(t)
	if code != http.StatusOK || !bytes.Equal(body, bigConfig) || it.held(testCode) || journalCount(it.nb, "success") != 1 {
		t.Fatalf("the retry: %d, %d bytes", code, len(body))
	}
}

// A node that holds its acknowledgements past the write deadline, as across
// a network that died, leaves the config unburned.
func TestAnAnswerUnacknowledgedAtTheDeadlineDoesNotBurn(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	it.putConfig(t, bigConfig)
	s := it.serve(t, 500*time.Millisecond, false)
	c := stalledGet(t, s.Listener.Addr().String())
	defer c.Close()
	if err := s.wait(5 * time.Second); err != nil {
		t.Fatal(err)
	}
	if !it.held(testCode) {
		t.Fatal("an unacknowledged answer burned the config")
	}
	if got := it.nb.journalWith("at the write deadline"); len(got) != 1 {
		t.Fatalf("journals %v", it.nb.journals)
	}
}

// Fetches at once over real connections get the config once.
func TestConcurrentFetchesBurnOnce(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	it.putConfig(t, bigConfig)
	s := it.serve(t, 10*time.Second, false)
	var wg sync.WaitGroup
	var mu sync.Mutex
	codes := map[int]int{}
	for range 8 {
		wg.Go(func() {
			code, body, err := s.get()
			if err != nil {
				t.Error(err)
			}
			if code == http.StatusOK && !bytes.Equal(body, bigConfig) {
				t.Errorf("a 200 carried %d bytes", len(body))
			}
			mu.Lock()
			codes[code]++
			mu.Unlock()
		})
	}
	wg.Wait()
	it.in.Drain()
	if codes[http.StatusOK] != 1 || codes[http.StatusNotFound] != 7 || it.in.Metrics.Released.Load() != 1 {
		t.Fatalf("answers %v, releases %d", codes, it.in.Metrics.Released.Load())
	}
}

// An HTTP/2 answer shares its connection, so its acknowledgement confirms
// nothing and the config stays.
func TestAnHTTP2AnswerDoesNotBurn(t *testing.T) {
	it := newInstallTest(t, "planned", nil)
	it.putConfig(t, []byte("machine: {}\n"))
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	r := httptest.NewRequest(http.MethodGet, configPath, nil)
	r.Proto, r.ProtoMajor, r.ProtoMinor = "HTTP/2.0", 2, 0
	r = r.WithContext(ConnContext(context.Background(), a))
	it.in.ServeHTTP(httptest.NewRecorder(), r)
	it.in.Drain()
	if !it.held(testCode) || !strings.Contains(strings.Join(it.nb.journalWith("did not acknowledge"), ""), "HTTP/2.0") {
		t.Fatalf("an HTTP/2 answer burned the config, or went unjournaled: %v", it.nb.journals)
	}
}
