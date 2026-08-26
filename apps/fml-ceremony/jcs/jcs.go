// Package jcs canonicalizes JSON per RFC 8785 (JCS).
//
// The ceremony transcript is signed, and a signature is over bytes, so the
// encoding has to be byte-stable forever. JSON needs a canonicalisation rule to
// be signable at all; CBOR has a deterministic profile but there is no
// encoding/cbor in the Go standard library, and a transcript meant to be read
// by strangers should not need a decoder they have to install.
package jcs

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"unicode/utf16"
)

// Canonical rewrites a JSON document into its canonical form.
//
// It rejects duplicate object keys, which encoding/json silently resolves
// last-wins. A transcript is verified by strangers against bytes someone else
// produced: two readers must not be able to disagree about what a document
// says, and last-wins means a document that says two things at once.
func Canonical(raw []byte) ([]byte, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	v, err := parseValue(dec)
	if err != nil {
		return nil, err
	}
	// Anything after the top-level value would be a second document sharing a
	// signature with the first.
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("jcs: trailing data after the top-level value")
	}
	var out bytes.Buffer
	if err := write(&out, v); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// Marshal is Canonical over encoding/json's output, which is how the ceremony
// serialises a transcript struct. json.Marshal already refuses NaN and
// Infinity, which RFC 8785 also forbids.
func Marshal(v any) ([]byte, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return Canonical(raw)
}

// member keeps a key alongside its UTF-16 code units. RFC 8785 sorts property
// names as arrays of UTF-16 code units, not as UTF-8 bytes: the two orders
// disagree for anything above the basic multilingual plane, which is why the
// specification's own "weird" vector puts an emoji next to a Hebrew letter.
type member struct {
	key   string
	units []uint16
	value any
}

type object []member

func parseValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	return parseFrom(dec, tok)
}

func parseFrom(dec *json.Decoder, tok json.Token) (any, error) {
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			return parseObject(dec)
		case '[':
			return parseArray(dec)
		}
		return nil, fmt.Errorf("jcs: unexpected %q", t)
	default:
		return tok, nil
	}
}

func parseObject(dec *json.Decoder) (object, error) {
	obj := object{}
	seen := map[string]bool{}
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		if d, ok := tok.(json.Delim); ok && d == '}' {
			sort.Slice(obj, func(i, j int) bool { return lessUTF16(obj[i].units, obj[j].units) })
			return obj, nil
		}
		key, ok := tok.(string)
		if !ok {
			return nil, fmt.Errorf("jcs: object key is %T", tok)
		}
		if seen[key] {
			return nil, fmt.Errorf("jcs: duplicate object key %q", key)
		}
		seen[key] = true
		val, err := parseValue(dec)
		if err != nil {
			return nil, err
		}
		obj = append(obj, member{key: key, units: utf16.Encode([]rune(key)), value: val})
	}
}

func parseArray(dec *json.Decoder) ([]any, error) {
	// Non-nil so an empty array marshals as [] rather than null.
	arr := []any{}
	for {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		if d, ok := tok.(json.Delim); ok && d == ']' {
			return arr, nil
		}
		v, err := parseFrom(dec, tok)
		if err != nil {
			return nil, err
		}
		arr = append(arr, v)
	}
}

func lessUTF16(a, b []uint16) bool {
	for i := 0; i < len(a) && i < len(b); i++ {
		if a[i] != b[i] {
			return a[i] < b[i]
		}
	}
	return len(a) < len(b)
}

func write(w *bytes.Buffer, v any) error {
	switch t := v.(type) {
	case nil:
		w.WriteString("null")
	case bool:
		w.WriteString(strconv.FormatBool(t))
	case string:
		writeString(w, t)
	case json.Number:
		f, err := t.Float64()
		if err != nil {
			return fmt.Errorf("jcs: %s: %w", t, err)
		}
		s, err := formatNumber(f)
		if err != nil {
			return err
		}
		w.WriteString(s)
	case []any:
		w.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				w.WriteByte(',')
			}
			if err := write(w, e); err != nil {
				return err
			}
		}
		w.WriteByte(']')
	case object:
		w.WriteByte('{')
		for i, m := range t {
			if i > 0 {
				w.WriteByte(',')
			}
			writeString(w, m.key)
			w.WriteByte(':')
			if err := write(w, m.value); err != nil {
				return err
			}
		}
		w.WriteByte('}')
	default:
		return fmt.Errorf("jcs: cannot serialise %T", v)
	}
	return nil
}

// escapes is ECMAScript's JSON.stringify escaping, which RFC 8785 adopts: the
// six two-character escapes, \u00xx for the remaining C0 controls, and literal
// UTF-8 for everything else. Notably U+007F and U+0080 are not escaped, and a
// solidus is never escaped.
var escapes = map[byte]string{
	'"':  `\"`,
	'\\': `\\`,
	'\b': `\b`,
	'\f': `\f`,
	'\n': `\n`,
	'\r': `\r`,
	'\t': `\t`,
}

func writeString(w *bytes.Buffer, s string) {
	w.WriteByte('"')
	for i := 0; i < len(s); i++ {
		c := s[i]
		if e, ok := escapes[c]; ok {
			w.WriteString(e)
			continue
		}
		if c < 0x20 {
			w.WriteString(`\u00`)
			const hexDigits = "0123456789abcdef"
			w.WriteByte(hexDigits[c>>4])
			w.WriteByte(hexDigits[c&0xf])
			continue
		}
		w.WriteByte(c)
	}
	w.WriteByte('"')
}
