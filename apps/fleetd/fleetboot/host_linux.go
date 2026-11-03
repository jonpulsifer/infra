package fleetboot

import (
	"context"
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

// LinuxHost is the machine fleet-boot runs on.
type LinuxHost struct{}

func (LinuxHost) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func (LinuxHost) IsBlockDevice(path string) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Mode()&os.ModeDevice != 0 && fi.Mode()&os.ModeCharDevice == 0
}

// IsMountpoint says whether a file system is mounted at path, from the
// mount table.
func (LinuxHost) IsMountpoint(path string) bool {
	b, err := os.ReadFile("/proc/self/mountinfo")
	return err == nil && mountpointIn(b, path)
}

func (LinuxHost) Mount(source, target, fstype, data string) error {
	return syscall.Mount(source, target, fstype, syscall.MS_NOSUID|syscall.MS_NODEV, data)
}

// Remount runs util-linux's mount, which keeps the mount's other flags.
func (h LinuxHost) Remount(target string) error {
	_, err := h.Run(context.Background(), "mount", "-o", "remount,rw", target)
	return err
}

func (LinuxHost) Unmount(target string) error { return syscall.Unmount(target, 0) }

// The inode flag ioctls and the immutable flag, from linux/fs.h.
const (
	fsIocGetFlags = 0x80086601
	fsIocSetFlags = 0x40086602
	fsImmutableFl = 0x10
)

func (LinuxHost) ClearImmutable(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var flags int32
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), fsIocGetFlags, uintptr(unsafe.Pointer(&flags))); errno != 0 {
		return errno
	}
	if flags&fsImmutableFl == 0 {
		return nil
	}
	flags &^= fsImmutableFl
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), fsIocSetFlags, uintptr(unsafe.Pointer(&flags))); errno != 0 {
		return errno
	}
	return nil
}

func (LinuxHost) Sync() { syscall.Sync() }

func (LinuxHost) Reboot(off bool) error {
	if off {
		return syscall.Reboot(syscall.LINUX_REBOOT_CMD_POWER_OFF)
	}
	return syscall.Reboot(syscall.LINUX_REBOOT_CMD_RESTART)
}
