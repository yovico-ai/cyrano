// Package config loads the proxy configuration from a JSON file or from
// environment variables. The JSON schema matches the legacy format; the env
// var path is the 12-factor default for new deployments.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strconv"
	"strings"
)

// File is the on-disk shape. Field tags match the JSON keys exactly.
type File struct {
	LogLevel string                    `json:"logLevel"`
	Type     string                    `json:"type"`
	Servers  []Server                  `json:"servers"`
	Global   Global                    `json:"global"`
	VHosts   []VHost                   `json:"vhosts"`
	Extra    map[string]json.RawMessage `json:"-"`
}

type Server struct {
	Port         int    `json:"port"`
	HTTPSEnabled bool   `json:"httpsEnabled"`
	HTTP2Enabled bool   `json:"http2Enabled"`
	SSLKey       string `json:"sslKey"`
	SSLCert      string `json:"sslCert"`
}

type Global struct{}

// VHost is a single virtual host configuration. Many fields are optional; only
// the ones the Go runtime actually consumes are typed strictly.
type VHost struct {
	Hostnames           []string       `json:"hostnames"`
	HTTPPort            int            `json:"httpPort"`
	HTTPSPort           int            `json:"httpsPort"`
	Mode                string         `json:"mode"`
	UserDataEncryption  bool           `json:"userDataEncryption"`
	Version             string         `json:"version"`
	SecretCookieName    string         `json:"secretCookieName"`
	RewriterJSPath      string         `json:"rewriterJsPath"`
	HeadInjectionPath   string         `json:"headInjectionPath"`
	CookiesJSONPath     string         `json:"cookiesJsonPath"`
	Raw                 map[string]any `json:"-"`
}

// Load reads and parses the JSON config at path.
func Load(path string) (*File, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("config: read %s: %w", path, err)
	}
	var f File
	if err := json.Unmarshal(data, &f); err != nil {
		return nil, fmt.Errorf("config: parse %s: %w", path, err)
	}
	if len(f.Servers) == 0 {
		return nil, fmt.Errorf("config: %s has no servers", path)
	}
	if len(f.VHosts) == 0 {
		return nil, fmt.Errorf("config: %s has no vhosts", path)
	}
	return &f, nil
}

// FromEnv constructs a File from environment variables. All vars have defaults
// that match a single-vhost local dev setup on port 9081.
//
// Supported variables:
//
//	CYRANO_PORT              HTTP listen port (default 9081)
//	CYRANO_HOSTNAME          VHost hostname matched against Host header (default "localhost")
//	CYRANO_HTTPS_ENABLED     Enable TLS listener (default false)
//	CYRANO_HTTPS_PORT        TLS listen port (default 9444)
//	CYRANO_SSL_CERT          Path to TLS certificate PEM
//	CYRANO_SSL_KEY           Path to TLS key PEM
//	CYRANO_MODE              Proxy mode: "webproxy" or "transparent" (default "webproxy")
//	CYRANO_SECRET_COOKIE     Name of the session secret cookie (default "crnsct")
//	CYRANO_REWRITER_JS_PATH  URL path serving rewriter.js (default "/rewriter.js")
//	CYRANO_HEAD_INJECTION_PATH  URL path for head-injection endpoint (default "/head-injection")
//	CYRANO_COOKIES_JSON_PATH URL path for cookies.json endpoint (default "/cookies.json")
func FromEnv() (*File, error) {
	port, err := envInt("CYRANO_PORT", 9081)
	if err != nil {
		return nil, err
	}
	httpsPort, err := envInt("CYRANO_HTTPS_PORT", 9444)
	if err != nil {
		return nil, err
	}
	httpsEnabled, err := envBool("CYRANO_HTTPS_ENABLED", false)
	if err != nil {
		return nil, err
	}

	hostname := envStr("CYRANO_HOSTNAME", "localhost")

	f := &File{
		Servers: []Server{{
			Port:         port,
			HTTPSEnabled: httpsEnabled,
			SSLCert:      envStr("CYRANO_SSL_CERT", ""),
			SSLKey:       envStr("CYRANO_SSL_KEY", ""),
		}},
		VHosts: []VHost{{
			Hostnames:         []string{hostname},
			HTTPPort:          port,
			HTTPSPort:         httpsPort,
			Mode:              envStr("CYRANO_MODE", "webproxy"),
			SecretCookieName:  envStr("CYRANO_SECRET_COOKIE", "crnsct"),
			RewriterJSPath:    envStr("CYRANO_REWRITER_JS_PATH", "/rewriter.js"),
			HeadInjectionPath: envStr("CYRANO_HEAD_INJECTION_PATH", "/head-injection"),
			CookiesJSONPath:   envStr("CYRANO_COOKIES_JSON_PATH", "/cookies.json"),
		}},
	}
	return f, nil
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return 0, fmt.Errorf("config: %s=%q is not an integer", key, v)
	}
	return n, nil
}

func envBool(key string, def bool) (bool, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	b, err := strconv.ParseBool(strings.TrimSpace(v))
	if err != nil {
		return false, fmt.Errorf("config: %s=%q is not a boolean", key, v)
	}
	return b, nil
}

// FindVHost returns the vhost configuration for the given Host header value.
// The Host header may contain a port suffix (`example.com:9080`); the port
// is stripped before matching.
func (f *File) FindVHost(hostHeader string) *VHost {
	host := hostHeader
	for i := 0; i < len(host); i++ {
		if host[i] == ':' {
			host = host[:i]
			break
		}
	}
	for i := range f.VHosts {
		if slices.Contains(f.VHosts[i].Hostnames, host) {
			return &f.VHosts[i]
		}
	}
	return nil
}
