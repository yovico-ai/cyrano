// Command cyrano is the Go SSL VPN proxy.
//
// By default configuration is read from environment variables (see
// config.FromEnv for the full list). Pass --config to override with a JSON
// file instead.
package main

import (
	"flag"
	"log/slog"
	"net"
	"net/http"
	_ "net/http/pprof"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/yovico/cyrano/internal/config"
	"github.com/yovico/cyrano/internal/server"
	"github.com/yovico/cyrano/internal/turn"
)

func main() {
	configPath := flag.String("config", "", "path to proxy config JSON (default: read from env)")
	assetsRoot := flag.String("assets", "", "static asset root (default: ../assets relative to the binary)")
	logLevel := flag.String("log-level", "info", "log verbosity: debug | info | warn | error")
	prettify := flag.Bool("prettify", false, "reformat JS and CSS responses for readability (debug only, never use in production)")
	flag.Parse()

	level := parseLogLevel(*logLevel)
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	// Profiling, on a separate listener only when asked for (debug):
	// CYRANO_PPROF=127.0.0.1:6060.
	if addr := os.Getenv("CYRANO_PPROF"); addr != "" {
		go func() { logger.Info("pprof", "err", http.ListenAndServe(addr, nil)) }()
	}

	var cfg *config.File
	var err error
	if *configPath != "" {
		cfg, err = config.Load(*configPath)
	} else {
		cfg, err = config.FromEnv()
	}
	if err != nil {
		logger.Error("config load failed", "err", err)
		os.Exit(1)
	}

	root := *assetsRoot
	if root == "" {
		// Default: <binary's grandparent>/assets — works when the binary is
		// built into go/src/... and run from the project root, and also works
		// when the binary is shipped next to /assets in a Docker image.
		exe, err := os.Executable()
		if err == nil {
			root = filepath.Join(filepath.Dir(exe), "..", "assets")
		}
		// Fall back to a path relative to the current working directory if
		// that didn't pan out.
		if root == "" {
			root = "../assets"
		}
	}

	// The WebRTC relay (internal/turn; spec/WebRtc.agda): CYRANO_TURN_PORT
	// (default 3478, 0 none), CYRANO_TURN_IP (default the public URL's
	// host). A relay that cannot start leaves peer connections with no
	// servers at all (relay only): they gather nothing, never going direct.
	if port := envIntOr("CYRANO_TURN_PORT", 3478); port > 0 {
		ip := os.Getenv("CYRANO_TURN_IP")
		if ip == "" {
			ip = relayIPOf(os.Getenv("CYRANO_PUBLIC_URL"))
		}
		if r, err := turn.Start(turn.Options{Port: port, IP: ip, Logger: logger}); err != nil {
			logger.Warn("turn relay not started: WebRTC gathers nothing", "port", port, "ip", ip, "err", err)
		} else {
			server.Relay = r
		}
	}

	s := server.New(cfg, root, logger)
	s.Prettify = *prettify
	if err := s.ListenAndServe(); err != nil {
		logger.Error("server exited", "err", err)
		os.Exit(1)
	}
}

func parseLogLevel(s string) slog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func envIntOr(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// relayIPOf is the relay's address for a public URL: its host's (an IP as
// it is, localhost as 127.0.0.1, a name resolved to its first IPv4).
func relayIPOf(public string) string {
	host := "localhost"
	if u, err := url.Parse(public); err == nil && u.Hostname() != "" {
		host = u.Hostname()
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.String()
	}
	if strings.EqualFold(host, "localhost") {
		return "127.0.0.1"
	}
	if ips, err := net.LookupIP(host); err == nil {
		for _, ip := range ips {
			if v4 := ip.To4(); v4 != nil {
				return v4.String()
			}
		}
	}
	return ""
}
