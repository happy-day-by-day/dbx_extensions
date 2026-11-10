//go:build darwin || linux

package main

import (
	"fmt"
	"os"
	"syscall"
)

func directoryIdentity(file *os.File) (string, error) {
	info, err := file.Stat()
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("directory expected")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", fmt.Errorf("directory identity unavailable")
	}
	return fmt.Sprintf("%d:%d", stat.Dev, stat.Ino), nil
}

func readOpenFlags() int { return os.O_RDONLY | syscall.O_NONBLOCK }
