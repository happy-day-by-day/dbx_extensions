@echo off
setlocal
set "DBDOC_ARCH=x64"
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "DBDOC_ARCH=arm64"
if /I "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "DBDOC_ARCH=arm64"
if not exist "%~dp0windows-%DBDOC_ARCH%\dbx-dbdoc.exe" (
  echo DBX document snapshot backend is missing; reinstall the complete plugin package >&2
  exit /b 127
)
"%~dp0windows-%DBDOC_ARCH%\dbx-dbdoc.exe"
exit /b %errorlevel%
