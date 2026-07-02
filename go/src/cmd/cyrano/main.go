// Command cyrano is the Go SSL VPN proxy.
//
// By default configuration is read from environment variables (see
// config.FromEnv for the full list). Pass --config to override with a JSON
// file instead.
package main

import (
	"flag"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/yovico/cyrano/internal/config"
	"github.com/yovico/cyrano/internal/server"
)

func main() {
	configPath := flag.String("config", "", "path to proxy config JSON (default: read from env)")
	assetsRoot := flag.String("assets", "", "static asset root (default: ../assets relative to the binary)")
	logLevel := flag.String("log-level", "info", "log verbosity: debug | info | warn | error")
	prettify := flag.Bool("prettify", false, "reformat JS and CSS responses for readability (debug only, never use in production)")
	flag.Parse()

	level := parseLogLevel(*logLevel)
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

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
