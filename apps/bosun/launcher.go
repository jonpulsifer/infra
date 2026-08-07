package main

import (
	"os"
	"os/exec"
)

// launcher starts a child process. execLauncher is the real adapter; tests
// substitute a fake that records argv and simulates exit.
//
// stdout/stderr are *os.File, not io.Writer: virtiofsd forks a worker that
// inherits its stdio and outlives the parent's exit, so a piped io.Writer
// would leave Wait's copy goroutine blocked on the survivor. A real file (or
// /dev/null) has no such goroutine.
type launcher interface {
	Start(name string, args []string, stdout, stderr *os.File) (proc, error)
}

// proc is a running child process.
type proc interface {
	Wait() error
	Kill() error
}

type execLauncher struct{}

func (execLauncher) Start(name string, args []string, stdout, stderr *os.File) (proc, error) {
	cmd := exec.Command(name, args...)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return &execProc{cmd: cmd}, nil
}

type execProc struct {
	cmd *exec.Cmd
}

func (p *execProc) Wait() error { return p.cmd.Wait() }
func (p *execProc) Kill() error { return p.cmd.Process.Kill() }
