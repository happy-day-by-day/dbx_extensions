//go:build windows

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
	var value syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &value); err != nil {
		return "", err
	}
	return fmt.Sprintf("%d:%d:%d", value.VolumeSerialNumber, value.FileIndexHigh, value.FileIndexLow), nil
}

func readOpenFlags() int { return os.O_RDONLY }
