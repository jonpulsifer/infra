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
// '$time_iso8601 $arg_uuid $arg_code $status $request_method
// $request_completion $body_bytes_sent'.
type Fetch struct {
	At       time.Time
	UUID     string
	Code     string
	Status   int
	Method   string
	Complete bool
	Sent     int64
}

// parseFetch reads one log line. nginx logs a missing argument as "-",
// which matches neither the UUID's nor the code's pattern, and the
// $request_completion of a request that did not finish as an empty field, so
// the line splits on single spaces.
func parseFetch(line string) (Fetch, bool) {
	f := strings.Split(line, " ")
	if len(f) != 7 {
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
	sent, err := strconv.ParseInt(f[6], 10, 64)
	if err != nil {
		return Fetch{}, false
	}
	return Fetch{
		At: at, UUID: strings.ToLower(f[1]), Code: f[2], Status: status,
		Method: f[4], Complete: f[5] == "OK", Sent: sent,
	}, true
}

// Delivered says whether nginx sent a whole config in this fetch. Whether
// the bytes are the file's size the store checks.
func (f Fetch) Delivered() bool {
	return f.Status == 200 && f.Method == "GET" && f.Complete
}

// Tail follows the log from where it left off, across restarts: the file's
// inode and the offset read so far are kept in Offset. A file shorter than
// the offset was truncated, and is read from its start. When the path names
// a new inode, a rotation, the old file is read to its end, then once more on
// the next call for what nginx wrote before it reopened its log, and the new
// file is read from its start. Only whole lines are returned.
type Tail struct {
	Path   string
	Offset string

	cur, old    *os.File
	inode       uint64
	pos, oldPos int64
	loaded      bool
}

type tailState struct {
	Inode uint64 `json:"inode"`
	Pos   int64  `json:"pos"`
}

func inodeOf(fi os.FileInfo) uint64 {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return st.Ino
	}
	return 0
}

// readFrom returns the whole lines of f after pos and the new position.
func readFrom(f *os.File, pos int64) ([]string, int64, error) {
	fi, err := f.Stat()
	if err != nil {
		return nil, pos, err
	}
	if fi.Size() < pos {
		pos = 0
	}
	if fi.Size() == pos {
		return nil, pos, nil
	}
	b, err := io.ReadAll(io.LimitReader(io.NewSectionReader(f, pos, fi.Size()-pos), 4<<20))
	if err != nil {
		return nil, pos, err
	}
	end := bytes.LastIndexByte(b, '\n')
	if end < 0 {
		return nil, pos, nil
	}
	return strings.Split(string(b[:end]), "\n"), pos + int64(end+1), nil
}

func (t *Tail) open() error {
	f, err := os.Open(t.Path)
	if err != nil {
		return err
	}
	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	if ino := inodeOf(fi); ino != t.inode {
		t.inode, t.pos = ino, 0
	}
	t.cur = f
	return nil
}

// Read returns the lines written since the last call.
func (t *Tail) Read() ([]string, error) {
	if !t.loaded {
		t.loaded = true
		if b, err := os.ReadFile(t.Offset); err == nil {
			var st tailState
			if json.Unmarshal(b, &st) == nil {
				t.inode, t.pos = st.Inode, st.Pos
			}
		}
	}
	var lines []string
	if t.old != nil {
		l, _, err := readFrom(t.old, t.oldPos)
		t.old.Close()
		t.old = nil
		if err != nil {
			return nil, err
		}
		lines = append(lines, l...)
	}
	if t.cur == nil {
		if err := t.open(); errors.Is(err, os.ErrNotExist) {
			return lines, nil
		} else if err != nil {
			return lines, err
		}
	}
	l, pos, err := readFrom(t.cur, t.pos)
	if err != nil {
		return lines, err
	}
	lines, t.pos = append(lines, l...), pos
	fi, err := os.Stat(t.Path)
	if err != nil || inodeOf(fi) == t.inode {
		return lines, nil
	}
	t.old, t.oldPos = t.cur, t.pos
	t.cur = nil
	if err := t.open(); err != nil {
		return lines, nil
	}
	l, pos, err = readFrom(t.cur, t.pos)
	if err != nil {
		return lines, err
	}
	t.pos = pos
	return append(lines, l...), nil
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
