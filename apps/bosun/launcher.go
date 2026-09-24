package main

import (
	"os"
	"os/exec"
)

// launcher starts a child process. Output goes to *os.File: virtiofsd's forked
// worker inherits stdio and outlives it, so a pipe would block Wait forever.
type launcher interface {
	Start(name string, args []string, stdout, stderr *os.File) (proc, error)
}

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
