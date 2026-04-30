package config

import (
	"os"
	"testing"
)

func TestFromEnv_PublicURL(t *testing.T) {
	os.Setenv("CYRANO_PUBLIC_URL", "https://vpn.example.com")
	defer os.Unsetenv("CYRANO_PUBLIC_URL")

	f, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if got := f.VHosts[0].PublicURL; got != "https://vpn.example.com" {
		t.Errorf("PublicURL = %q; want https://vpn.example.com", got)
	}
}

func TestFromEnv_PublicURL_DefaultsEmpty(t *testing.T) {
	os.Unsetenv("CYRANO_PUBLIC_URL")

	f, err := FromEnv()
	if err != nil {
		t.Fatal(err)
	}
	if got := f.VHosts[0].PublicURL; got != "" {
		t.Errorf("PublicURL should default to empty, got %q", got)
	}
}
