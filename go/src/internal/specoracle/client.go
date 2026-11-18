// Package specoracle drives the compiled Agda spec (spec/ at the repo
// root, built with `make oracle`) for the conformance tests. It transports
// requests and makes no decisions of its own: the answers are the spec's.
//
// Protocol (spec/Oracle.agda): one tab-separated request line in, one
// JSON line out. Imported only from _test.go files.
package specoracle

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// Answer is the spec's verdict on one URL: the rule that decided it and
// the resulting text.
type Answer struct {
	Kind string
	Out  string
}

// Client keeps ONE oracle process alive for the whole test run and
// serializes queries against it. A process per query would make a
// thousand-case run about process start-up, not the property.
type Client struct {
	mu     sync.Mutex
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Scanner
	stderr *bytes.Buffer
	closed bool
}

// RepoRoot is the repository root, found from this file's location.
func RepoRoot() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", "..", ".."))
}

// Locate returns the oracle binary to use: $CYRANO_ORACLE, or the one
// `make oracle` builds. skip is non-empty when there is none, or it is
// older than the spec it was built from; whether that skips or fails is
// the caller's decision ($CYRANO_REQUIRE_ORACLE).
func Locate() (path string, skip string) {
	root := RepoRoot()
	path = os.Getenv("CYRANO_ORACLE")
	if path == "" {
		path = filepath.Join(root, "spec", "build", "Main")
	}
	info, err := os.Stat(path)
	if err != nil {
		return path, fmt.Sprintf("spec oracle %s not built (make oracle)", path)
	}
	sources, _ := filepath.Glob(filepath.Join(root, "spec", "*.agda"))
	for _, src := range sources {
		if s, err := os.Stat(src); err == nil && s.ModTime().After(info.ModTime()) {
			return path, fmt.Sprintf("spec oracle %s is older than %s (make oracle)", path, filepath.Base(src))
		}
	}
	return path, ""
}

// Required reports whether a missing or stale oracle must fail the run
// instead of skipping it (`make spec-check` sets it).
func Required() bool { return os.Getenv("CYRANO_REQUIRE_ORACLE") != "" }

// Start launches the compiled oracle at path. Close kills it: the serve
// loop is `forever` and will not notice EOF.
func Start(path string) (*Client, error) {
	cmd := exec.Command(path)
	// A nix-built binary links nix's glibc; an inherited LD_LIBRARY_PATH
	// can shadow it and the child dies at start-up with "undefined
	// symbol: __nptl_change_stack_perm". Strip it before exec.
	cmd.Env = withoutLDLibraryPath(os.Environ())
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("oracle stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("oracle stdout pipe: %w", err)
	}
	// Captured, not inherited, so a start-up crash names its cause instead
	// of surfacing as a bare "broken pipe".
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("start oracle: %w", err)
	}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	return &Client{cmd: cmd, stdin: stdin, stdout: sc, stderr: &stderr}, nil
}

func withoutLDLibraryPath(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if strings.HasPrefix(kv, "LD_LIBRARY_PATH=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// Close terminates the oracle. Safe to call more than once.
func (c *Client) Close() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.closed = true
	_ = c.stdin.Close()
	_ = c.cmd.Process.Kill()
	_ = c.cmd.Wait()
}

// Schemes asks the oracle which schemes it proxifies. The suites compare
// this to the implementation's own list before running anything else.
func (c *Client) Schemes() ([]string, error) {
	line, err := c.roundTrip("vocab")
	if err != nil {
		return nil, err
	}
	var r struct {
		Schemes []string `json:"schemes"`
	}
	if err := json.Unmarshal([]byte(line), &r); err != nil || r.Schemes == nil {
		return nil, fmt.Errorf("oracle protocol: unexpected reply to vocab: %q", line)
	}
	return r.Schemes, nil
}

// ErrOutOfModel is returned for a URL the spec does not decide (IPv6,
// IDNA, percent-encoded or unusual IPv4 hosts). Generators should rarely
// produce one; a test skips that draw.
var ErrOutOfModel = fmt.Errorf("outside the spec's model")

// Rewrite asks what `raw`, found on the page `base`, becomes.
func (c *Client) Rewrite(proxy, base, raw string) (Answer, error) {
	return c.answer("rewrite", proxy, base, raw)
}

// Direct asks what the browser shows for `raw` on a page at `base`
// without cyrano: the right-hand side of the page-cannot-tell law.
func (c *Client) Direct(base, raw string) (Answer, error) {
	return c.answer("direct", base, raw)
}

// Ask sends any request and returns the reply's "out", with ok false for
// {"none":true}.
func (c *Client) Ask(op string, args ...string) (out string, ok bool, err error) {
	line, err := c.roundTrip(request(op, args...))
	if err != nil {
		return "", false, err
	}
	var r struct {
		Out   *string `json:"out"`
		None  bool    `json:"none"`
		Error string  `json:"error"`
	}
	if err := json.Unmarshal([]byte(line), &r); err != nil {
		return "", false, fmt.Errorf("oracle protocol: %q", line)
	}
	switch {
	case r.Error == "OutOfModel":
		return "", false, ErrOutOfModel
	case r.Error != "":
		return "", false, fmt.Errorf("oracle: %s (%s)", r.Error, op)
	case r.None:
		return "", false, nil
	case r.Out == nil:
		return "", false, fmt.Errorf("oracle protocol: %q", line)
	}
	return *r.Out, true, nil
}

// Unwrap asks what page code reading `href` back is shown.
func (c *Client) Unwrap(proxy, href string) (Answer, error) {
	return c.answer("unwrap", proxy, href)
}

// Srcset asks what a srcset value becomes when every URL u in it is
// rewritten to "[u]".
func (c *Client) Srcset(value string) (string, error) {
	a, err := c.answer("srcset", value)
	return a.Out, err
}

func (c *Client) answer(op string, args ...string) (Answer, error) {
	req := op
	for _, a := range args {
		req += "\t" + Escape(a)
	}
	line, err := c.roundTrip(req)
	if err != nil {
		return Answer{}, err
	}
	// Pointers: an {"error":...} reply must fail here, not decode as an
	// empty answer.
	var r struct {
		Kind  *string `json:"kind"`
		Out   *string `json:"out"`
		Error *string `json:"error"`
	}
	if err := json.Unmarshal([]byte(line), &r); err != nil {
		return Answer{}, fmt.Errorf("oracle protocol: unexpected reply to %q: %q", req, line)
	}
	if r.Error != nil {
		if *r.Error == "OutOfModel" {
			return Answer{}, ErrOutOfModel
		}
		return Answer{}, fmt.Errorf("oracle refused %q: %s", req, *r.Error)
	}
	if r.Out == nil || (op != "srcset" && r.Kind == nil) {
		return Answer{}, fmt.Errorf("oracle protocol: unexpected reply to %q: %q", req, line)
	}
	a := Answer{Out: *r.Out}
	if r.Kind != nil {
		a.Kind = *r.Kind
	}
	return a, nil
}

// Escape writes a field for the wire: every backslash, control character
// and non-ASCII character becomes "\u{HEX}", so the line is ASCII and
// holds no stray tab or newline.
func Escape(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == '\\' || r < 0x20 || r >= 0x7f {
			fmt.Fprintf(&b, "\\u{%X}", r)
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// roundTrip writes one line and reads one line back, serialized so two
// callers cannot interleave on the single pipe pair.
func (c *Client) roundTrip(req string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return "", fmt.Errorf("oracle client is closed")
	}
	if _, err := fmt.Fprintln(c.stdin, req); err != nil {
		return "", fmt.Errorf("write to oracle: %w%s", err, c.stderrSuffix())
	}
	if !c.stdout.Scan() {
		if err := c.stdout.Err(); err != nil {
			return "", fmt.Errorf("read from oracle: %w%s", err, c.stderrSuffix())
		}
		return "", fmt.Errorf("oracle closed its output%s", c.stderrSuffix())
	}
	return c.stdout.Text(), nil
}

func (c *Client) stderrSuffix() string {
	if c.stderr == nil || c.stderr.Len() == 0 {
		return ""
	}
	return fmt.Sprintf(" (oracle stderr: %s)", strings.TrimSpace(c.stderr.String()))
}

func request(op string, args ...string) string {
	req := op
	for _, a := range args {
		req += "\t" + Escape(a)
	}
	return req
}
