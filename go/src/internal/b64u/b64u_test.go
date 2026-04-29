package b64u

import "testing"

func TestRoundTrip(t *testing.T) {
	cases := []string{
		"",
		"https://example.com/",
		"https://example.com/path?query=value&other=1#hash",
		"https://example.com/a%20b/c+d",
		"http://localhost:9080/",
	}
	for _, in := range cases {
		enc := Encode(in)
		dec, err := Decode(enc)
		if err != nil {
			t.Fatalf("decode %q: %v", in, err)
		}
		if dec != in {
			t.Errorf("round-trip mismatch: in=%q enc=%q dec=%q", in, enc, dec)
		}
	}
}

func TestNoPadding(t *testing.T) {
	for _, in := range []string{"x", "xx", "xxx", "xxxx"} {
		enc := Encode(in)
		for _, c := range enc {
			if c == '=' {
				t.Errorf("Encode(%q)=%q has '=' padding", in, enc)
			}
		}
	}
}

func TestDecodeAcceptsPadded(t *testing.T) {
	// "https://example.com/" → b64url unpadded = "aHR0cHM6Ly9leGFtcGxlLmNvbS8"
	// Same input padded = "aHR0cHM6Ly9leGFtcGxlLmNvbS8="
	const want = "https://example.com/"
	got, err := Decode("aHR0cHM6Ly9leGFtcGxlLmNvbS8=")
	if err != nil {
		t.Fatalf("decode padded: %v", err)
	}
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}
