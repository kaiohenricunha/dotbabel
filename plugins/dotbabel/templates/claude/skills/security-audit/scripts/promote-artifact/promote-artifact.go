// promote-artifact copies pre-declared files out of an agent's scratch
// directory into its parent-owned artifacts directory, refusing anything that
// is not a plain, single-linked, in-bounds regular file reached without
// following a symlink.
//
// It exists because scratch is target-controlled after a sandboxed check runs:
// the agent, and any code the agent ran, can replace a declared file with a
// symlink, a FIFO, a hard link or a file that grows while it is read. Copying
// by path would follow those. Every step below is therefore descriptor-relative
// and no-follow, and the source identity is re-checked after the copy.
//
// This implements the artifact promotion procedure in the security-audit
// skill (see references/upstream/UPSTREAM-SKILL.md, "Write isolation"). Without
// it, a run cannot retain evidence produced by target-controlled code, and
// every such lead stays needs_validation with a promotion blocker.
//
// Usage:
//
//	go run promote-artifact.go --scratch <dir> --artifacts <dir> --manifest <file|->
//
// The manifest is JSON:
//
//	{"max_file_bytes": 1048576, "max_total_bytes": 8388608, "files": ["report.txt"]}
//
// It prints a JSON result to stdout and exits 0 when every declared file was
// promoted, 1 when any was refused, 2 on an environment error, 64 on bad usage.
//
// Linux and macOS only: it needs descriptor-relative openat. On any other
// platform the promoter must not be used, and the run stays source-only.
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"syscall"
)

// Limits bound one promotion run. The parent records them before the sandbox
// starts, so a file that grew during the check cannot spend more than declared.
type Limits struct {
	MaxFileBytes  int64 `json:"max_file_bytes"`
	MaxTotalBytes int64 `json:"max_total_bytes"`
}

// Manifest is the parent's allowlist: only these scratch-relative paths may be
// promoted, and only within these bounds.
type Manifest struct {
	Files         []string `json:"files"`
	MaxFileBytes  int64    `json:"max_file_bytes"`
	MaxTotalBytes int64    `json:"max_total_bytes"`
}

// Promoted describes one file that survived every check.
type Promoted struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
}

// Refused records why a declared file was discarded. The parent copies the
// reason into the coverage ledger, so it has to be specific.
type Refused struct {
	Path   string `json:"path"`
	Reason string `json:"reason"`
}

// Result is the whole outcome, shaped for the parent to read back.
type Result struct {
	Promoted   []Promoted `json:"promoted"`
	Refused    []Refused  `json:"refused"`
	TotalBytes int64      `json:"total_bytes"`
}

const (
	defaultMaxFileBytes  = 1 << 20
	defaultMaxTotalBytes = 8 << 20
	openFlags            = syscall.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_NONBLOCK | syscall.O_CLOEXEC
	dirFlags             = syscall.O_RDONLY | syscall.O_DIRECTORY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC
)

func main() {
	scratch := flag.String("scratch", "", "agent scratch root (target-controlled)")
	artifacts := flag.String("artifacts", "", "agent artifacts root (parent-owned)")
	manifestPath := flag.String("manifest", "", "manifest JSON file, or - for stdin")
	flag.Parse()

	if *scratch == "" || *artifacts == "" || *manifestPath == "" || flag.NArg() > 0 {
		fmt.Fprintln(os.Stderr, "usage: promote-artifact --scratch <dir> --artifacts <dir> --manifest <file|->")
		os.Exit(64)
	}

	manifest, err := readManifest(*manifestPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "promote-artifact: %v\n", err)
		os.Exit(2)
	}

	result := Promote(*scratch, *artifacts, manifest)
	encoded, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "promote-artifact: %v\n", err)
		os.Exit(2)
	}
	fmt.Println(string(encoded))
	os.Exit(exitCode(result))
}

func readManifest(manifestPath string) (Manifest, error) {
	var raw []byte
	var err error
	if manifestPath == "-" {
		raw, err = io.ReadAll(os.Stdin)
	} else {
		raw, err = os.ReadFile(manifestPath)
	}
	if err != nil {
		return Manifest{}, fmt.Errorf("cannot read manifest: %w", err)
	}
	var manifest Manifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("manifest is not valid JSON: %w", err)
	}
	return manifest, nil
}

func exitCode(result Result) int {
	if len(result.Refused) > 0 {
		return 1
	}
	return 0
}

// Promote walks the manifest in order, promoting what passes and recording why
// anything else did not. One refusal never stops the rest: the parent wants the
// full picture in a single pass.
func Promote(scratchRoot, artifactsRoot string, manifest Manifest) Result {
	limits := Limits{MaxFileBytes: manifest.MaxFileBytes, MaxTotalBytes: manifest.MaxTotalBytes}
	if limits.MaxFileBytes <= 0 {
		limits.MaxFileBytes = defaultMaxFileBytes
	}
	if limits.MaxTotalBytes <= 0 {
		limits.MaxTotalBytes = defaultMaxTotalBytes
	}

	result := Result{Promoted: []Promoted{}, Refused: []Refused{}}

	// The two roots are opened once and kept. Every later step is relative to a
	// descriptor, never to a path, so nothing can be swapped underneath us.
	scratchFd, err := syscall.Open(scratchRoot, dirFlags, 0)
	if err != nil {
		return refuseAll(manifest.Files, fmt.Sprintf("cannot open scratch root: %v", err))
	}
	defer syscall.Close(scratchFd)

	artifactsFd, err := syscall.Open(artifactsRoot, dirFlags, 0)
	if err != nil {
		return refuseAll(manifest.Files, fmt.Sprintf("cannot open artifacts root: %v", err))
	}
	defer syscall.Close(artifactsFd)

	for _, declared := range manifest.Files {
		promoted, err := promoteOne(scratchFd, artifactsFd, declared, limits, result.TotalBytes)
		if err != nil {
			result.Refused = append(result.Refused, Refused{Path: declared, Reason: err.Error()})
			continue
		}
		result.Promoted = append(result.Promoted, promoted)
		result.TotalBytes += promoted.Bytes
	}
	return result
}

func refuseAll(files []string, reason string) Result {
	result := Result{Promoted: []Promoted{}, Refused: []Refused{}}
	for _, declared := range files {
		result.Refused = append(result.Refused, Refused{Path: declared, Reason: reason})
	}
	return result
}

// splitDeclared validates the declared path before any syscall runs. A path
// that is absolute, empty, dotted, doubled or NUL-bearing is refused outright:
// the promoter never normalises a caller's path into something safe.
func splitDeclared(declared string) ([]string, error) {
	if declared == "" {
		return nil, errors.New("path is empty")
	}
	if strings.ContainsRune(declared, 0) {
		return nil, errors.New("path contains a NUL byte")
	}
	if path.IsAbs(declared) || strings.HasPrefix(declared, "/") {
		return nil, errors.New("path is absolute")
	}
	parts := strings.Split(declared, "/")
	for _, part := range parts {
		if part == "" {
			return nil, errors.New("path has an empty component")
		}
		if part == "." || part == ".." {
			return nil, fmt.Errorf("path has a %q component", part)
		}
	}
	return parts, nil
}

func promoteOne(scratchFd, artifactsFd int, declared string, limits Limits, alreadyUsed int64) (Promoted, error) {
	parts, err := splitDeclared(declared)
	if err != nil {
		return Promoted{}, err
	}

	srcDirFd, err := walkParents(scratchFd, parts[:len(parts)-1])
	if err != nil {
		return Promoted{}, fmt.Errorf("scratch parent: %w", err)
	}
	if srcDirFd != scratchFd {
		defer syscall.Close(srcDirFd)
	}

	// O_NONBLOCK matters here: opening a FIFO for reading would otherwise block
	// until a writer appears. It opens, and fstat below rejects it.
	srcFd, err := syscall.Openat(srcDirFd, parts[len(parts)-1], openFlags, 0)
	if err != nil {
		return Promoted{}, fmt.Errorf("cannot open source: %w", err)
	}
	defer syscall.Close(srcFd)

	var before syscall.Stat_t
	if err := syscall.Fstat(srcFd, &before); err != nil {
		return Promoted{}, fmt.Errorf("cannot stat source: %w", err)
	}
	if before.Mode&syscall.S_IFMT != syscall.S_IFREG {
		return Promoted{}, errors.New("source is not a regular file")
	}
	if before.Nlink != 1 {
		return Promoted{}, fmt.Errorf("source link count is %d, not 1", before.Nlink)
	}
	if before.Size > limits.MaxFileBytes {
		return Promoted{}, fmt.Errorf("source size %d exceeds the per-file limit %d", before.Size, limits.MaxFileBytes)
	}
	if alreadyUsed+before.Size > limits.MaxTotalBytes {
		return Promoted{}, fmt.Errorf("source size %d exceeds the remaining cumulative budget %d", before.Size, limits.MaxTotalBytes-alreadyUsed)
	}

	dstDirFd, err := makeParents(artifactsFd, parts[:len(parts)-1])
	if err != nil {
		return Promoted{}, fmt.Errorf("artifacts parent: %w", err)
	}
	if dstDirFd != artifactsFd {
		defer syscall.Close(dstDirFd)
	}

	dstFd, err := syscall.Openat(dstDirFd, parts[len(parts)-1],
		syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0o600)
	if err != nil {
		return Promoted{}, fmt.Errorf("cannot create destination: %w", err)
	}
	defer syscall.Close(dstFd)

	var destStat syscall.Stat_t
	if err := syscall.Fstat(dstFd, &destStat); err != nil {
		return Promoted{}, fmt.Errorf("cannot stat destination: %w", err)
	}
	if destStat.Mode&syscall.S_IFMT != syscall.S_IFREG || destStat.Nlink != 1 {
		return Promoted{}, errors.New("destination is not a fresh regular file")
	}

	digest, err := copyExactly(srcFd, dstFd, before.Size)
	if err != nil {
		removeAt(dstDirFd, parts[len(parts)-1])
		return Promoted{}, err
	}

	// The source could have been swapped or truncated while it was read. If its
	// identity moved at all, the copy is not evidence of anything.
	var after syscall.Stat_t
	if err := syscall.Fstat(srcFd, &after); err != nil {
		removeAt(dstDirFd, parts[len(parts)-1])
		return Promoted{}, fmt.Errorf("cannot re-stat source: %w", err)
	}
	if err := sameFile(&before, &after); err != nil {
		removeAt(dstDirFd, parts[len(parts)-1])
		return Promoted{}, err
	}

	return Promoted{Path: declared, Bytes: before.Size, SHA256: digest}, nil
}

// walkParents opens each parent component no-follow, so a symlinked directory
// anywhere on the path fails with ELOOP instead of leading somewhere else.
func walkParents(rootFd int, parents []string) (int, error) {
	current := rootFd
	for _, name := range parents {
		next, err := syscall.Openat(current, name, dirFlags, 0)
		if err != nil {
			if current != rootFd {
				syscall.Close(current)
			}
			return -1, fmt.Errorf("cannot open %q: %w", name, err)
		}
		if current != rootFd {
			syscall.Close(current)
		}
		current = next
	}
	return current, nil
}

// makeParents creates missing destination directories exclusively, then reopens
// each one no-follow, so a directory planted between the two steps is caught.
func makeParents(rootFd int, parents []string) (int, error) {
	current := rootFd
	for _, name := range parents {
		if err := syscall.Mkdirat(current, name, 0o700); err != nil && !errors.Is(err, syscall.EEXIST) {
			if current != rootFd {
				syscall.Close(current)
			}
			return -1, fmt.Errorf("cannot create %q: %w", name, err)
		}
		next, err := syscall.Openat(current, name, dirFlags, 0)
		if err != nil {
			if current != rootFd {
				syscall.Close(current)
			}
			return -1, fmt.Errorf("cannot open %q: %w", name, err)
		}
		if current != rootFd {
			syscall.Close(current)
		}
		current = next
	}
	return current, nil
}

// copyExactly copies exactly size bytes and refuses a source that turned out to
// be longer, which is how a file still being written is caught.
func copyExactly(srcFd, dstFd int, size int64) (string, error) {
	src := os.NewFile(uintptr(srcFd), "source")
	dst := os.NewFile(uintptr(dstFd), "destination")
	hasher := sha256.New()

	copied, err := io.Copy(io.MultiWriter(dst, hasher), io.LimitReader(src, size))
	if err != nil {
		return "", fmt.Errorf("copy failed: %w", err)
	}
	if copied != size {
		return "", fmt.Errorf("copied %d bytes, expected %d", copied, size)
	}

	// One more byte than the verified size means the source grew while it was
	// read, so the bytes just copied are a prefix of something else.
	var probe [1]byte
	if n, _ := src.Read(probe[:]); n > 0 {
		return "", errors.New("source grew during the copy")
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

// sameFile reports whether two stats describe the same unchanged file.
func sameFile(before, after *syscall.Stat_t) error {
	switch {
	case before.Ino != after.Ino:
		return errors.New("source inode changed during the copy")
	case before.Dev != after.Dev:
		return errors.New("source device changed during the copy")
	case before.Size != after.Size:
		return errors.New("source size changed during the copy")
	case before.Nlink != after.Nlink:
		return errors.New("source link count changed during the copy")
	case before.Mode != after.Mode:
		return errors.New("source mode changed during the copy")
	}
	return nil
}

func removeAt(dirFd int, name string) {
	_ = syscall.Unlinkat(dirFd, name)
}
