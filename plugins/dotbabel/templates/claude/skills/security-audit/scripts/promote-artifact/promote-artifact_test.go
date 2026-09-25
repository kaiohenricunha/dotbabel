package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// Each case builds a scratch tree that a target-controlled process could have
// produced, then asks the promoter to copy an allowlisted file out of it. The
// promoter must refuse everything that is not a plain, single-linked, in-bounds
// regular file reached without following a symlink.

func roots(t *testing.T) (scratch string, artifacts string) {
	t.Helper()
	base := t.TempDir()
	scratch = filepath.Join(base, "scratch")
	artifacts = filepath.Join(base, "artifacts")
	if err := os.MkdirAll(scratch, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(artifacts, 0o700); err != nil {
		t.Fatal(err)
	}
	return scratch, artifacts
}

func write(t *testing.T, path string, contents string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
}

func run(t *testing.T, scratch, artifacts string, limits Limits, files ...string) Result {
	t.Helper()
	return Promote(scratch, artifacts, Manifest{Files: files, MaxFileBytes: limits.MaxFileBytes, MaxTotalBytes: limits.MaxTotalBytes})
}

func defaults() Limits { return Limits{MaxFileBytes: 1 << 20, MaxTotalBytes: 8 << 20} }

func refusalFor(t *testing.T, result Result, path string) string {
	t.Helper()
	for _, refused := range result.Refused {
		if refused.Path == path {
			return refused.Reason
		}
	}
	t.Fatalf("expected %q to be refused, got %+v", path, result)
	return ""
}

func TestPromotesPlainFiles(t *testing.T) {
	scratch, artifacts := roots(t)
	write(t, filepath.Join(scratch, "report.txt"), "hello")
	write(t, filepath.Join(scratch, "nested", "deep", "out.json"), `{"ok":true}`)

	result := run(t, scratch, artifacts, defaults(), "report.txt", "nested/deep/out.json")

	if len(result.Refused) != 0 {
		t.Fatalf("expected no refusals, got %+v", result.Refused)
	}
	if len(result.Promoted) != 2 {
		t.Fatalf("expected 2 promoted, got %+v", result.Promoted)
	}
	if got, err := os.ReadFile(filepath.Join(artifacts, "report.txt")); err != nil || string(got) != "hello" {
		t.Fatalf("report.txt not promoted verbatim: %q %v", got, err)
	}
	if got, err := os.ReadFile(filepath.Join(artifacts, "nested", "deep", "out.json")); err != nil || string(got) != `{"ok":true}` {
		t.Fatalf("nested file not promoted verbatim: %q %v", got, err)
	}
	if result.TotalBytes != 16 {
		t.Fatalf("expected 16 total bytes, got %d", result.TotalBytes)
	}
	// The digest lets the parent cite the artifact without re-reading it.
	if len(result.Promoted[0].SHA256) != 64 {
		t.Fatalf("expected a sha256 hex digest, got %q", result.Promoted[0].SHA256)
	}
}

func TestRefusesUnsafeDeclaredPaths(t *testing.T) {
	scratch, artifacts := roots(t)
	write(t, filepath.Join(scratch, "ok.txt"), "x")

	for _, declared := range []string{"", ".", "..", "../ok.txt", "/etc/passwd", "nested/../../ok.txt", "a//b", "bad\x00name"} {
		result := run(t, scratch, artifacts, defaults(), declared)
		reason := refusalFor(t, result, declared)
		if !strings.Contains(reason, "path") {
			t.Fatalf("declared %q: expected a path refusal, got %q", declared, reason)
		}
		if len(result.Promoted) != 0 {
			t.Fatalf("declared %q: nothing may be promoted", declared)
		}
	}
}

func TestRefusesSymlinkedParentComponent(t *testing.T) {
	scratch, artifacts := roots(t)
	outside := t.TempDir()
	write(t, filepath.Join(outside, "secret.txt"), "not yours")
	if err := os.Symlink(outside, filepath.Join(scratch, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	result := run(t, scratch, artifacts, defaults(), "link/secret.txt")

	refusalFor(t, result, "link/secret.txt")
	if _, err := os.Stat(filepath.Join(artifacts, "link", "secret.txt")); !os.IsNotExist(err) {
		t.Fatal("a file reached through a symlinked component must not be promoted")
	}
}

func TestRefusesSymlinkedLeaf(t *testing.T) {
	scratch, artifacts := roots(t)
	outside := t.TempDir()
	write(t, filepath.Join(outside, "secret.txt"), "not yours")
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(scratch, "sneaky.txt")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	result := run(t, scratch, artifacts, defaults(), "sneaky.txt")

	refusalFor(t, result, "sneaky.txt")
	if len(result.Promoted) != 0 {
		t.Fatal("a symlinked leaf must not be promoted")
	}
}

func TestRefusesNonRegularFiles(t *testing.T) {
	scratch, artifacts := roots(t)
	if err := syscall.Mkfifo(filepath.Join(scratch, "pipe"), 0o600); err != nil {
		t.Skipf("mkfifo unavailable: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(scratch, "adir"), 0o700); err != nil {
		t.Fatal(err)
	}

	result := run(t, scratch, artifacts, defaults(), "pipe", "adir")

	// A FIFO opened O_NONBLOCK for reading succeeds, so the fstat check is what
	// has to catch it — that is exactly why the open is non-blocking.
	refusalFor(t, result, "pipe")
	refusalFor(t, result, "adir")
	if len(result.Promoted) != 0 {
		t.Fatalf("expected nothing promoted, got %+v", result.Promoted)
	}
}

func TestRefusesHardLinkedFile(t *testing.T) {
	scratch, artifacts := roots(t)
	write(t, filepath.Join(scratch, "original.txt"), "shared")
	if err := os.Link(filepath.Join(scratch, "original.txt"), filepath.Join(scratch, "alias.txt")); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}

	result := run(t, scratch, artifacts, defaults(), "alias.txt")

	reason := refusalFor(t, result, "alias.txt")
	if !strings.Contains(reason, "link count") {
		t.Fatalf("expected a link-count refusal, got %q", reason)
	}
}

func TestEnforcesPerFileLimit(t *testing.T) {
	scratch, artifacts := roots(t)
	write(t, filepath.Join(scratch, "big.txt"), strings.Repeat("a", 100))

	result := run(t, scratch, artifacts, Limits{MaxFileBytes: 64, MaxTotalBytes: 8 << 20}, "big.txt")

	reason := refusalFor(t, result, "big.txt")
	if !strings.Contains(reason, "exceeds") {
		t.Fatalf("expected a size refusal, got %q", reason)
	}
	if _, err := os.Stat(filepath.Join(artifacts, "big.txt")); !os.IsNotExist(err) {
		t.Fatal("an over-limit file must not leave a partial artifact")
	}
}

func TestEnforcesCumulativeLimit(t *testing.T) {
	scratch, artifacts := roots(t)
	write(t, filepath.Join(scratch, "one.txt"), strings.Repeat("a", 60))
	write(t, filepath.Join(scratch, "two.txt"), strings.Repeat("b", 60))

	result := run(t, scratch, artifacts, Limits{MaxFileBytes: 100, MaxTotalBytes: 100}, "one.txt", "two.txt")

	if len(result.Promoted) != 1 || result.Promoted[0].Path != "one.txt" {
		t.Fatalf("expected only the first file to fit, got %+v", result.Promoted)
	}
	reason := refusalFor(t, result, "two.txt")
	if !strings.Contains(reason, "cumulative") {
		t.Fatalf("expected a cumulative-limit refusal, got %q", reason)
	}
}

func TestRefusesExistingDestination(t *testing.T) {
	scratch, artifacts := roots(t)
	write(t, filepath.Join(scratch, "out.txt"), "new")
	write(t, filepath.Join(artifacts, "out.txt"), "already here")

	result := run(t, scratch, artifacts, defaults(), "out.txt")

	refusalFor(t, result, "out.txt")
	if got, _ := os.ReadFile(filepath.Join(artifacts, "out.txt")); string(got) != "already here" {
		t.Fatal("promotion must never overwrite an existing artifact")
	}
}

func TestRefusesMissingFile(t *testing.T) {
	scratch, artifacts := roots(t)
	result := run(t, scratch, artifacts, defaults(), "nope.txt")
	refusalFor(t, result, "nope.txt")
}

func TestRejectsChangedSourceIdentity(t *testing.T) {
	// The post-copy check is what defends against a file swapped mid-copy. It is
	// racy to provoke for real, so the comparison itself is asserted directly.
	before := syscall.Stat_t{Dev: 1, Ino: 2, Nlink: 1, Size: 10, Mode: syscall.S_IFREG | 0o600}
	same := before
	if err := sameFile(&before, &same); err != nil {
		t.Fatalf("identical stats must compare equal: %v", err)
	}
	for name, mutate := range map[string]func(*syscall.Stat_t){
		"inode":      func(s *syscall.Stat_t) { s.Ino = 99 },
		"device":     func(s *syscall.Stat_t) { s.Dev = 99 },
		"size":       func(s *syscall.Stat_t) { s.Size = 11 },
		"link count": func(s *syscall.Stat_t) { s.Nlink = 2 },
		"mode":       func(s *syscall.Stat_t) { s.Mode = syscall.S_IFIFO | 0o600 },
	} {
		changed := before
		mutate(&changed)
		if err := sameFile(&before, &changed); err == nil {
			t.Fatalf("a changed %s must be rejected", name)
		}
	}
}

func TestResultSerialisesForTheParent(t *testing.T) {
	scratch, artifacts := roots(t)
	write(t, filepath.Join(scratch, "ok.txt"), "x")

	result := run(t, scratch, artifacts, defaults(), "ok.txt", "../escape")

	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var round Result
	if err := json.Unmarshal(encoded, &round); err != nil {
		t.Fatal(err)
	}
	if len(round.Promoted) != 1 || len(round.Refused) != 1 {
		t.Fatalf("round trip lost detail: %s", encoded)
	}
	if round.Refused[0].Reason == "" {
		t.Fatal("a refusal must carry its reason for the ledger")
	}
}

func TestExitCodeReflectsOutcome(t *testing.T) {
	if got := exitCode(Result{Promoted: []Promoted{{Path: "a"}}}); got != 0 {
		t.Fatalf("a clean run exits 0, got %d", got)
	}
	if got := exitCode(Result{Refused: []Refused{{Path: "a", Reason: "nope"}}}); got != 1 {
		t.Fatalf("any refusal exits 1, got %d", got)
	}
}
