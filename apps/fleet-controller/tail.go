package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Fetch is one line of nginx's talos-config log, in the log_format fleet:
// '$time_iso8601 $arg_uuid $arg_code $status'.
type Fetch struct {
	At     time.Time
	UUID   string
	Code   string
	Status int
}

// parseFetch reads one log line. nginx writes "-" for an empty argument.
func parseFetch(line string) (Fetch, bool) {
	f := strings.Fields(line)
	if len(f) != 4 {
		return Fetch{}, false
	}
	at, err := time.Parse(time.RFC3339, f[0])
	if err != nil {
		return Fetch{}, false
	}
	status, err := strconv.Atoi(f[3])
	if err != nil {
		return Fetch{}, false
	}
	return Fetch{At: at, UUID: strings.ToLower(f[1]), Code: f[2], Status: status}, true
}

// Tail follows the log from where it left off, across restarts: the file's
// inode and the offset read so far are kept in Offset. A new inode, or a file
// shorter than the offset, is a rotation, and the new file is read from its
// start. Only whole lines are returned.
type Tail struct {
	Path   string
	Offset string

	inode uint64
	pos   int64
	ready bool
}

type tailState struct {
	Inode uint64 `json:"inode"`
	Pos   int64  `json:"pos"`
}

func (t *Tail) load() {
	t.ready = true
	b, err := os.ReadFile(t.Offset)
	if err != nil {
		return
	}
	var st tailState
	if json.Unmarshal(b, &st) == nil {
		t.inode, t.pos = st.Inode, st.Pos
	}
}

// Read returns the lines written since the last call.
func (t *Tail) Read() ([]string, error) {
	if !t.ready {
		t.load()
	}
	f, err := os.Open(t.Path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return nil, err
	}
	var inode uint64
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		inode = st.Ino
	}
	if inode != t.inode || fi.Size() < t.pos {
		t.inode, t.pos = inode, 0
	}
	if fi.Size() == t.pos {
		return nil, nil
	}
	if _, err := f.Seek(t.pos, io.SeekStart); err != nil {
		return nil, err
	}
	b, err := io.ReadAll(io.LimitReader(f, 4<<20))
	if err != nil {
		return nil, err
	}
	end := bytes.LastIndexByte(b, '\n')
	if end < 0 {
		return nil, nil
	}
	t.pos += int64(end + 1)
	return strings.Split(string(b[:end]), "\n"), nil
}

// Save records the position, after the lines Read returned are handled.
func (t *Tail) Save() error {
	b, err := json.Marshal(tailState{Inode: t.inode, Pos: t.pos})
	if err != nil {
		return err
	}
	if err := writeFile(t.Offset, b, 0o600); err != nil {
		return fmt.Errorf("save the log offset: %w", err)
	}
	return nil
}
