package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

const chunkBytes = 512 * 1024
const maxFileBytes = 512 * 1024 * 1024
const maxHandles = 16
const maxLocations = 64

var snapshotName = regexp.MustCompile(`^(dbdoc-[a-f0-9]{64}\.json|[a-f0-9]{64}\.cache)$`)

type location struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	Identity  string `json:"identity"`
	Preferred bool   `json:"preferred"`
	Revoked   bool   `json:"revoked"`
	CreatedAt int64  `json:"createdAt"`
}
type directoryConfig struct {
	Version   int        `json:"version"`
	Locations []location `json:"locations"`
}
type transfer struct {
	root                *os.Root
	file                *os.File
	grantID, name, temp string
	expected            *string
	hash                hash.Hash
	offset, size        int64
	write               bool
	touched             time.Time
}
type directoryStore struct {
	mu                  sync.Mutex
	dataDir, configPath string
	config              directoryConfig
	handles             map[string]*transfer
}

func newID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
func failure(code, message string) error { return fmt.Errorf("[%s] %s", code, message) }
func ioFailure(err error) error {
	if err == nil {
		return nil
	}
	if os.IsNotExist(err) {
		return failure("NOT_FOUND", err.Error())
	}
	if os.IsPermission(err) {
		return failure("ACCESS_DENIED", err.Error())
	}
	return failure("IO_ERROR", err.Error())
}
func newDirectoryStore(dataDir string) (*directoryStore, error) {
	abs, err := filepath.Abs(dataDir)
	if err != nil {
		return nil, err
	}
	if err = os.MkdirAll(abs, 0700); err != nil {
		return nil, err
	}
	s := &directoryStore{dataDir: abs, configPath: filepath.Join(abs, "snapshot-locations.json"), handles: map[string]*transfer{}}
	raw, err := os.ReadFile(s.configPath)
	if err == nil {
		if err = json.Unmarshal(raw, &s.config); err != nil {
			return nil, failure("CONFIG_CORRUPT", "快照目录配置损坏，原配置和文件已保留")
		}
		if s.config.Version != 1 {
			return nil, failure("CONFIG_CORRUPT", "不支持的快照目录配置版本")
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	} else {
		s.config.Version = 1
		// The previous native plugin already used this directory. This keeps its
		// .cache files readable and needs no migration through the 1 MiB UI store.
		grant, err := s.addLocation(filepath.Join(abs, "documents-v2"))
		if err != nil {
			return nil, err
		}
		for i := range s.config.Locations {
			s.config.Locations[i].Preferred = s.config.Locations[i].ID == grant.ID
		}
		if err = s.persist(); err != nil {
			return nil, err
		}
	}
	return s, nil
}
func (s *directoryStore) persist() error {
	raw, err := json.MarshalIndent(s.config, "", "  ")
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(s.dataDir, ".locations-")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(raw); err != nil {
		file.Close()
		return err
	}
	if err = file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = os.Rename(file.Name(), s.configPath); err != nil {
		return err
	}
	syncDirectory(s.dataDir)
	return nil
}
func syncDirectory(path string) {
	if f, err := os.Open(path); err == nil {
		_ = f.Sync()
		_ = f.Close()
	}
}
func (s *directoryStore) find(id string) (*location, error) {
	for i := range s.config.Locations {
		if s.config.Locations[i].ID == id {
			return &s.config.Locations[i], nil
		}
	}
	return nil, failure("NEEDS_AUTHORIZATION", "快照目录尚未配置")
}
func identityAtRoot(root *os.Root) (string, error) {
	f, err := root.Open(".")
	if err != nil {
		return "", err
	}
	defer f.Close()
	return directoryIdentity(f)
}
func (s *directoryStore) openLocation(id string) (*os.Root, error) {
	loc, err := s.find(id)
	if err != nil {
		return nil, err
	}
	if loc.Revoked {
		return nil, failure("REVOKED", "已停用此快照目录；原文件已保留")
	}
	root, err := os.OpenRoot(loc.Path)
	if err != nil {
		return nil, failure("UNAVAILABLE", err.Error())
	}
	identity, err := identityAtRoot(root)
	if err != nil {
		root.Close()
		return nil, ioFailure(err)
	}
	if identity != loc.Identity {
		root.Close()
		return nil, failure("IDENTITY_CHANGED", "原快照目录已被替换，需要重新配置")
	}
	return root, nil
}
func (s *directoryStore) info(loc location, check bool) map[string]any {
	status := "unchecked"
	if loc.Revoked {
		status = "revoked"
	} else if check {
		root, err := s.openLocation(loc.ID)
		if err == nil {
			root.Close()
			status = "ready"
		} else if strings.Contains(err.Error(), "[IDENTITY_CHANGED]") {
			status = "identityChanged"
		} else {
			status = "unavailable"
		}
	}
	return map[string]any{"id": loc.ID, "displayName": filepath.Base(loc.Path), "displayPath": loc.Path, "mode": "readwrite", "persistent": true, "preferred": loc.Preferred, "createdAt": loc.CreatedAt, "status": status, "chunkBytes": chunkBytes, "maxFileBytes": maxFileBytes}
}
func (s *directoryStore) addLocation(path string) (location, error) {
	if path == "" {
		path = filepath.Join(s.dataDir, "documents-v2")
	}
	if len(path) > 4096 || strings.IndexFunc(path, func(r rune) bool { return r < 32 }) >= 0 {
		return location{}, failure("INVALID_ARGUMENT", "目录路径无效")
	}
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return location{}, err
		}
		path = filepath.Join(home, strings.TrimLeft(path[1:], `/\`))
	}
	if !filepath.IsAbs(path) {
		return location{}, failure("INVALID_ARGUMENT", "请输入目录的绝对路径")
	}
	active := 0
	for _, loc := range s.config.Locations {
		if !loc.Revoked {
			active++
		}
	}
	if active >= maxLocations {
		return location{}, failure("LIMIT_EXCEEDED", "快照目录配置过多，请停用不用的目录")
	}
	// Creation is explicit configuration only. Restore never creates a missing root.
	if err := os.MkdirAll(path, 0700); err != nil {
		return location{}, ioFailure(err)
	}
	path, err := filepath.EvalSymlinks(path)
	if err != nil {
		return location{}, ioFailure(err)
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return location{}, ioFailure(err)
	}
	defer root.Close()
	identity, err := identityAtRoot(root)
	if err != nil {
		return location{}, ioFailure(err)
	}
	id, err := newID()
	if err != nil {
		return location{}, err
	}
	loc := location{ID: id, Path: path, Identity: identity, CreatedAt: time.Now().Unix()}
	s.config.Locations = append(s.config.Locations, loc)
	if err = s.persist(); err != nil {
		s.config.Locations = s.config.Locations[:len(s.config.Locations)-1]
		return location{}, ioFailure(err)
	}
	return loc, nil
}
func (s *directoryStore) dropHandle(id string) {
	if h := s.handles[id]; h != nil {
		h.file.Close()
		if h.temp != "" {
			_ = h.root.Remove(h.temp)
		}
		h.root.Close()
		delete(s.handles, id)
	}
}
func (s *directoryStore) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for id := range s.handles {
		s.dropHandle(id)
	}
}
func fileDigest(root *os.Root, name string) (*string, int64, error) {
	info, err := root.Lstat(name)
	if os.IsNotExist(err) {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, ioFailure(err)
	}
	if !info.Mode().IsRegular() {
		return nil, 0, failure("INVALID_ARGUMENT", "快照必须为普通文件，不能是符号链接或设备")
	}
	f, err := root.OpenFile(name, readOpenFlags(), 0)
	if err != nil {
		return nil, 0, ioFailure(err)
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil {
		return nil, 0, ioFailure(err)
	}
	if !info.Mode().IsRegular() {
		return nil, 0, failure("INVALID_ARGUMENT", "快照必须为普通文件")
	}
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(f, maxFileBytes+1))
	if err != nil {
		return nil, 0, ioFailure(err)
	}
	if size > maxFileBytes {
		return nil, 0, failure("LIMIT_EXCEEDED", "快照超过单文件上限")
	}
	value := hex.EncodeToString(hash.Sum(nil))
	return &value, size, nil
}
func sameEtag(a, b *string) bool { return a == nil && b == nil || a != nil && b != nil && *a == *b }
func (s *directoryStore) handle(method string, raw json.RawMessage) (any, error) {
	if !strings.HasPrefix(method, "snapshotDirectory/") {
		return nil, failure("INVALID_ARGUMENT", "unknown snapshot method")
	}
	operation := strings.TrimPrefix(method, "snapshotDirectory/")
	var p struct {
		GrantID      string          `json:"grantId"`
		HandleID     string          `json:"handleId"`
		Path         string          `json:"path"`
		InitialPath  string          `json:"initialPath"`
		Cursor       string          `json:"cursor"`
		Offset       int64           `json:"offset"`
		Length       int64           `json:"length"`
		DataBase64   string          `json:"dataBase64"`
		SHA256       string          `json:"sha256"`
		ExpectedEtag json.RawMessage `json:"expectedEtag"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return nil, failure("INVALID_ARGUMENT", err.Error())
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, h := range s.handles {
		if time.Since(h.touched) > 10*time.Minute {
			s.dropHandle(id)
		}
	}
	switch operation {
	case "request":
		loc, err := s.addLocation(p.InitialPath)
		if err != nil {
			return nil, err
		}
		return s.info(loc, true), nil
	case "listGrants":
		result := []any{}
		for _, loc := range s.config.Locations {
			result = append(result, s.info(loc, false))
		}
		return result, nil
	case "restore":
		loc, err := s.find(p.GrantID)
		if err != nil {
			return nil, err
		}
		return s.info(*loc, true), nil
	case "setPreferred", "revoke":
		loc, err := s.find(p.GrantID)
		if err != nil {
			return nil, err
		}
		before := append([]location(nil), s.config.Locations...)
		if operation == "setPreferred" {
			root, err := s.openLocation(p.GrantID)
			if err != nil {
				return nil, err
			}
			root.Close()
			for i := range s.config.Locations {
				s.config.Locations[i].Preferred = s.config.Locations[i].ID == p.GrantID
			}
		} else {
			loc.Revoked = true
		}
		if err = s.persist(); err != nil {
			s.config.Locations = before
			return nil, ioFailure(err)
		}
		if operation == "revoke" {
			for id, h := range s.handles {
				if h.grantID == p.GrantID {
					s.dropHandle(id)
				}
			}
		}
		return nil, nil
	case "close", "abort":
		s.dropHandle(p.HandleID)
		return nil, nil
	case "read", "write", "commit":
		return s.transfer(operation, p.HandleID, p.Offset, p.Length, p.DataBase64, p.SHA256)
	}
	root, err := s.openLocation(p.GrantID)
	if err != nil {
		return nil, err
	}
	keep := false
	defer func() {
		if !keep {
			root.Close()
		}
	}()
	if operation == "list" {
		if p.Path != "" && p.Path != "." {
			return nil, failure("INVALID_ARGUMENT", "只支持快照目录")
		}
		dir, err := root.Open(".")
		if err != nil {
			return nil, ioFailure(err)
		}
		defer dir.Close()
		// Bound memory to one page even if a user selects a directory with many files.
		names := []string{}
		for {
			entries, readErr := dir.ReadDir(256)
			for _, entry := range entries {
				if entry.Type().IsRegular() && snapshotName.MatchString(entry.Name()) && entry.Name() > p.Cursor {
					names = append(names, entry.Name())
				}
			}
			sort.Strings(names)
			if len(names) > 501 {
				names = names[:501]
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				return nil, ioFailure(readErr)
			}
		}
		var cursor any
		if len(names) > 500 {
			names = names[:500]
			cursor = names[len(names)-1]
		}
		entries := []any{}
		for _, name := range names {
			entries = append(entries, map[string]any{"name": name, "kind": "file"})
		}
		return map[string]any{"entries": entries, "cursor": cursor}, nil
	}
	if !snapshotName.MatchString(p.Path) {
		return nil, failure("INVALID_ARGUMENT", "只能读写本插件快照文件")
	}
	switch operation {
	case "stat":
		etag, size, err := fileDigest(root, p.Path)
		return map[string]any{"etag": etag, "size": size}, err
	case "openRead":
		if len(s.handles) >= maxHandles {
			return nil, failure("LIMIT_EXCEEDED", "打开的快照过多")
		}
		etag, size, err := fileDigest(root, p.Path)
		if err != nil {
			return nil, err
		}
		if etag == nil {
			return nil, failure("NOT_FOUND", "快照文件不存在")
		}
		file, err := root.OpenFile(p.Path, readOpenFlags(), 0)
		if err != nil {
			return nil, ioFailure(err)
		}
		info, err := file.Stat()
		if err != nil || !info.Mode().IsRegular() {
			file.Close()
			return nil, failure("INVALID_ARGUMENT", "快照不是普通文件")
		}
		id, err := newID()
		if err != nil {
			file.Close()
			return nil, err
		}
		s.handles[id] = &transfer{root: root, file: file, grantID: p.GrantID, size: size, touched: time.Now()}
		keep = true
		return map[string]any{"handleId": id, "size": size, "etag": *etag, "chunkBytes": chunkBytes}, nil
	case "beginWrite":
		if len(s.handles) >= maxHandles {
			return nil, failure("LIMIT_EXCEEDED", "打开的快照过多")
		}
		if len(p.ExpectedEtag) == 0 {
			return nil, failure("INVALID_ARGUMENT", "写入必须提供 expectedEtag")
		}
		var expected *string
		if err = json.Unmarshal(p.ExpectedEtag, &expected); err != nil {
			return nil, failure("INVALID_ARGUMENT", "无效的 expectedEtag")
		}
		etag, _, err := fileDigest(root, p.Path)
		if err != nil {
			return nil, err
		}
		if !sameEtag(etag, expected) {
			return nil, failure("CONFLICT", "快照已变化，请重试")
		}
		id, err := newID()
		if err != nil {
			return nil, err
		}
		temp := ".dbx-write-" + id
		file, err := root.OpenFile(temp, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
		if err != nil {
			return nil, ioFailure(err)
		}
		s.handles[id] = &transfer{root: root, file: file, grantID: p.GrantID, name: p.Path, temp: temp, expected: expected, hash: sha256.New(), write: true, touched: time.Now()}
		keep = true
		return map[string]any{"handleId": id, "chunkBytes": chunkBytes}, nil
	}
	return nil, failure("INVALID_ARGUMENT", "不支持的快照操作")
}
func (s *directoryStore) transfer(operation, id string, offset, length int64, dataBase64, digest string) (any, error) {
	h := s.handles[id]
	if h == nil {
		return nil, failure("INVALID_HANDLE", "快照句柄已关闭或过期")
	}
	root, err := s.openLocation(h.grantID)
	if err != nil {
		s.dropHandle(id)
		return nil, err
	}
	root.Close()
	h.touched = time.Now()
	if operation == "read" {
		if h.write || offset < 0 || offset > h.size || length <= 0 || length > chunkBytes {
			return nil, failure("INVALID_ARGUMENT", "快照读取范围无效")
		}
		count := length
		if count > h.size-offset {
			count = h.size - offset
		}
		data := make([]byte, count)
		n, err := h.file.ReadAt(data, offset)
		if err != nil && err != io.EOF {
			return nil, ioFailure(err)
		}
		return map[string]any{"dataBase64": base64.StdEncoding.EncodeToString(data[:n]), "length": n, "eof": offset+int64(n) >= h.size}, nil
	}
	if !h.write {
		return nil, failure("INVALID_ARGUMENT", "只读快照句柄")
	}
	if operation == "write" {
		if len(dataBase64) > base64.StdEncoding.EncodedLen(chunkBytes) {
			return nil, failure("LIMIT_EXCEEDED", "快照分块过大")
		}
		data, err := base64.StdEncoding.DecodeString(dataBase64)
		if err != nil || len(data) > chunkBytes || offset != h.offset || h.offset+int64(len(data)) > maxFileBytes {
			return nil, failure("INVALID_ARGUMENT", "快照分块无效")
		}
		n, err := h.file.Write(data)
		if err != nil || n != len(data) {
			s.dropHandle(id)
			if err == nil {
				err = io.ErrShortWrite
			}
			return nil, ioFailure(err)
		}
		h.hash.Write(data)
		h.offset += int64(n)
		return nil, nil
	}
	defer s.dropHandle(id)
	if hex.EncodeToString(h.hash.Sum(nil)) != digest {
		return nil, failure("CHECKSUM_MISMATCH", "快照校验失败；原文件已保留")
	}
	if err = h.file.Sync(); err != nil {
		return nil, ioFailure(err)
	}
	if err = h.file.Close(); err != nil {
		return nil, ioFailure(err)
	}
	etag, _, err := fileDigest(h.root, h.name)
	if err != nil {
		return nil, err
	}
	if !sameEtag(etag, h.expected) {
		return nil, failure("CONFLICT", "快照已变化；原文件已保留")
	}
	if h.expected == nil {
		err = h.root.Link(h.temp, h.name)
	} else {
		err = h.root.Rename(h.temp, h.name)
	}
	if errors.Is(err, os.ErrExist) {
		return nil, failure("CONFLICT", "快照已存在；原文件已保留")
	}
	if err != nil {
		return nil, ioFailure(err)
	}
	if dir, err := h.root.Open("."); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return map[string]any{"committed": true, "etag": digest}, nil
}
