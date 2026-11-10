package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

var testName = "dbdoc-" + strings.Repeat("a", 64) + ".json"

func call(t *testing.T, s *directoryStore, op string, p map[string]any) any {
	t.Helper()
	raw, _ := json.Marshal(p)
	v, err := s.handle("snapshotDirectory/"+op, raw)
	if err != nil {
		t.Fatalf("%s: %v", op, err)
	}
	return v
}
func callErr(s *directoryStore, op string, p map[string]any) error {
	raw, _ := json.Marshal(p)
	_, err := s.handle("snapshotDirectory/"+op, raw)
	return err
}
func expectCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || !strings.Contains(err.Error(), "["+code+"]") {
		t.Fatalf("expected %s, got %v", code, err)
	}
}
func testStore(t *testing.T) (*directoryStore, string, string) {
	t.Helper()
	data := t.TempDir()
	s, err := newDirectoryStore(data)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.close)
	id := s.config.Locations[0].ID
	return s, data, id
}
func begin(t *testing.T, s *directoryStore, id, name string, expected any) string {
	t.Helper()
	return call(t, s, "beginWrite", map[string]any{"grantId": id, "path": name, "expectedEtag": expected}).(map[string]any)["handleId"].(string)
}
func writeTo(t *testing.T, s *directoryStore, h string, data []byte) {
	t.Helper()
	for offset := 0; offset < len(data); offset += chunkBytes {
		end := offset + chunkBytes
		if end > len(data) {
			end = len(data)
		}
		call(t, s, "write", map[string]any{"handleId": h, "offset": offset, "dataBase64": base64.StdEncoding.EncodeToString(data[offset:end])})
	}
}
func commit(t *testing.T, s *directoryStore, h string, data []byte) string {
	t.Helper()
	sum := sha256.Sum256(data)
	etag := hex.EncodeToString(sum[:])
	call(t, s, "commit", map[string]any{"handleId": h, "sha256": etag})
	return etag
}
func put(t *testing.T, s *directoryStore, id string, data []byte, expected any) string {
	t.Helper()
	h := begin(t, s, id, testName, expected)
	writeTo(t, s, h, data)
	return commit(t, s, h, data)
}
func TestLargeSnapshotAndRestart(t *testing.T) {
	s, dir, id := testStore(t)
	data := bytes.Repeat([]byte("Unicode \xe9\x87\x91\xe9\xa2\x9d "), 400000)
	put(t, s, id, data, nil)
	s.close()
	reopened, err := newDirectoryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.close()
	if !reopened.config.Locations[0].Preferred {
		t.Fatal("lost preference")
	}
	opened := call(t, reopened, "openRead", map[string]any{"grantId": id, "path": testName}).(map[string]any)
	h := opened["handleId"].(string)
	var got []byte
	for offset := 0; offset < len(data); offset += chunkBytes {
		v := call(t, reopened, "read", map[string]any{"handleId": h, "offset": offset, "length": chunkBytes}).(map[string]any)
		b, _ := base64.StdEncoding.DecodeString(v["dataBase64"].(string))
		got = append(got, b...)
	}
	call(t, reopened, "close", map[string]any{"handleId": h})
	if !bytes.Equal(got, data) {
		t.Fatal("snapshot mismatch")
	}
}
func TestFailedCommitPreservesPrevious(t *testing.T) {
	s, _, id := testStore(t)
	old := []byte("complete old snapshot")
	etag := put(t, s, id, old, nil)
	h := begin(t, s, id, testName, etag)
	writeTo(t, s, h, []byte("new candidate"))
	expectCode(t, callErr(s, "commit", map[string]any{"handleId": h, "sha256": strings.Repeat("0", 64)}), "CHECKSUM_MISMATCH")
	raw, _ := os.ReadFile(filepath.Join(s.config.Locations[0].Path, testName))
	if !bytes.Equal(raw, old) {
		t.Fatal("previous file changed")
	}
	if len(s.handles) != 0 {
		t.Fatal("failed commit leaked handle")
	}
}
func TestInterruptedWriteKeepsFileAndCleansStage(t *testing.T) {
	s, _, id := testStore(t)
	etag := put(t, s, id, []byte("old"), nil)
	h := begin(t, s, id, testName, etag)
	writeTo(t, s, h, []byte("partial"))
	s.close()
	raw, _ := os.ReadFile(filepath.Join(s.config.Locations[0].Path, testName))
	if string(raw) != "old" {
		t.Fatal("old snapshot lost")
	}
	files, _ := os.ReadDir(s.config.Locations[0].Path)
	if len(files) != 1 {
		t.Fatal("stage leaked")
	}
}
func TestConcurrentCompareAndSwap(t *testing.T) {
	s, _, id := testStore(t)
	etag := put(t, s, id, []byte("old"), nil)
	a := begin(t, s, id, testName, etag)
	b := begin(t, s, id, testName, etag)
	writeTo(t, s, a, []byte("first"))
	writeTo(t, s, b, []byte("second"))
	commit(t, s, a, []byte("first"))
	sum := sha256.Sum256([]byte("second"))
	expectCode(t, callErr(s, "commit", map[string]any{"handleId": b, "sha256": hex.EncodeToString(sum[:])}), "CONFLICT")
	expectCode(t, callErr(s, "beginWrite", map[string]any{"grantId": id, "path": testName}), "INVALID_ARGUMENT")
}
func TestCustomDirectoryPreferredAndRestart(t *testing.T) {
	s, dir, old := testStore(t)
	path := filepath.Join(t.TempDir(), "directory with spaces", "snapshots")
	g := call(t, s, "request", map[string]any{"initialPath": path}).(map[string]any)
	path, _ = filepath.EvalSymlinks(path)
	id := g["id"].(string)
	if g["preferred"].(bool) {
		t.Fatal("incomplete switch changed preference")
	}
	call(t, s, "setPreferred", map[string]any{"grantId": id})
	s.close()
	again, err := newDirectoryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer again.close()
	for _, loc := range again.config.Locations {
		if loc.ID == old && loc.Preferred {
			t.Fatal("old still preferred")
		}
		if loc.ID == id && (!loc.Preferred || loc.Path != path) {
			t.Fatal("new selection lost")
		}
	}
}
func TestRevokePersistsAndBlocksOpenTransfer(t *testing.T) {
	s, dir, id := testStore(t)
	h := begin(t, s, id, testName, nil)
	call(t, s, "revoke", map[string]any{"grantId": id})
	if len(s.handles) != 0 {
		t.Fatal("revoke left handles")
	}
	expectCode(t, callErr(s, "write", map[string]any{"handleId": h}), "INVALID_HANDLE")
	again, err := newDirectoryStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer again.close()
	v := call(t, again, "restore", map[string]any{"grantId": id}).(map[string]any)
	if v["status"] != "revoked" || v["preferred"] != true {
		t.Fatal("revocation tombstone lost")
	}
	expectCode(t, callErr(again, "stat", map[string]any{"grantId": id, "path": testName}), "REVOKED")
}
func TestUnavailableRootNotRecreated(t *testing.T) {
	s, _, id := testStore(t)
	path := s.config.Locations[0].Path
	if err := os.Rename(path, path+"-moved"); err != nil {
		t.Fatal(err)
	}
	expectCode(t, callErr(s, "stat", map[string]any{"grantId": id, "path": testName}), "UNAVAILABLE")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("root recreated")
	}
}
func TestReplacedRootDenied(t *testing.T) {
	s, _, id := testStore(t)
	path := s.config.Locations[0].Path
	h := begin(t, s, id, testName, nil)
	if err := os.Rename(path, path+"-moved"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	expectCode(t, callErr(s, "write", map[string]any{"handleId": h, "offset": 0, "dataBase64": ""}), "IDENTITY_CHANGED")
	if len(s.handles) != 0 {
		t.Fatal("identity mismatch left handle")
	}
}
func TestPathTraversalAndSymlinksDenied(t *testing.T) {
	s, _, id := testStore(t)
	for _, path := range []string{"../outside", "/etc/passwd", `C:\\test`, `sub/` + testName, "snapshot-locations.json"} {
		expectCode(t, callErr(s, "stat", map[string]any{"grantId": id, "path": path}), "INVALID_ARGUMENT")
	}
	outside := filepath.Join(t.TempDir(), "secret")
	os.WriteFile(outside, []byte("secret"), 0600)
	if err := os.Symlink(outside, filepath.Join(s.config.Locations[0].Path, testName)); err != nil {
		t.Skip(err)
	}
	expectCode(t, callErr(s, "openRead", map[string]any{"grantId": id, "path": testName}), "INVALID_ARGUMENT")
}
func TestFailedPreferencePersistenceRollsBack(t *testing.T) {
	s, _, old := testStore(t)
	g := call(t, s, "request", map[string]any{"initialPath": t.TempDir()}).(map[string]any)
	id := g["id"].(string)
	os.Rename(s.configPath, s.configPath+".old")
	os.Mkdir(s.configPath, 0700)
	expectCode(t, callErr(s, "setPreferred", map[string]any{"grantId": id}), "IO_ERROR")
	for _, loc := range s.config.Locations {
		if loc.Preferred != (loc.ID == old) {
			t.Fatal("failed switch changed preference")
		}
	}
}
func TestPagedListing(t *testing.T) {
	s, _, id := testStore(t)
	for i := 0; i < 503; i++ {
		name := fmt.Sprintf("dbdoc-%064x.json", i)
		if err := os.WriteFile(filepath.Join(s.config.Locations[0].Path, name), []byte("{}"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	first := call(t, s, "list", map[string]any{"grantId": id}).(map[string]any)
	if len(first["entries"].([]any)) != 500 {
		t.Fatal("page size")
	}
	second := call(t, s, "list", map[string]any{"grantId": id, "cursor": first["cursor"]}).(map[string]any)
	if len(second["entries"].([]any)) != 3 || second["cursor"] != nil {
		t.Fatal("pagination")
	}
}
func TestExpiredHandlesAndOffsetLimits(t *testing.T) {
	s, _, id := testStore(t)
	h := begin(t, s, id, testName, nil)
	expectCode(t, callErr(s, "write", map[string]any{"handleId": h, "offset": 1, "dataBase64": "YQ=="}), "INVALID_ARGUMENT")
	s.handles[h].touched = time.Now().Add(-11 * time.Minute)
	call(t, s, "listGrants", map[string]any{})
	if len(s.handles) != 0 {
		t.Fatal("expiry failed")
	}
}
func TestCorruptConfigPreserved(t *testing.T) {
	s, dir, _ := testStore(t)
	s.close()
	if err := os.WriteFile(s.configPath, []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := newDirectoryStore(dir)
	expectCode(t, err, "CONFIG_CORRUPT")
	raw, _ := os.ReadFile(s.configPath)
	if string(raw) != "broken" {
		t.Fatal("overwrote corrupt config")
	}
}
func TestLegacyNativeCacheReadable(t *testing.T) {
	s, _, id := testStore(t)
	name := strings.Repeat("b", 64) + ".cache"
	if err := os.WriteFile(filepath.Join(s.config.Locations[0].Path, name), []byte("previous cache"), 0600); err != nil {
		t.Fatal(err)
	}
	v := call(t, s, "openRead", map[string]any{"grantId": id, "path": name}).(map[string]any)
	if v["size"] != int64(14) {
		t.Fatal("legacy not read")
	}
}
