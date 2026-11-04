//go:build !linux

package fleet

import "errors"

func outq(uintptr) (int, error) {
	return 0, errors.New("the send queue is read on Linux only")
}
