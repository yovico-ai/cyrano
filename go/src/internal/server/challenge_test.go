package server

import "testing"

// The Cloudflare markers (vendor heuristics, not a standard: they only
// decide whether a session's challenge origin is recorded for routing
// bare /cdn-cgi/challenge-platform/ requests that carry no Referer).
func TestChallengeHeuristics(t *testing.T) {
	for body, want := range map[string]bool{
		`<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>`: true,
		`window._cf_chl_opt={cvId:'3'}`:                                                   true,
		`<script src="/__cf_chl_rt_tk/x"></script>`:                                        true,
		`<script src="/__challenge_abc/challenge.js"></script>`:                            true,
		// The passive telemetry script on ordinary pages is no challenge.
		`<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>`: false,
		`<p>hello</p>`: false,
	} {
		if got := isChallengeHTML([]byte(body)); got != want {
			t.Errorf("isChallengeHTML(%q) = %v", body, got)
		}
	}
	if !isChallengeHost("Challenges.Cloudflare.com") || isChallengeHost("cloudflare.com") {
		t.Error("isChallengeHost")
	}
	for path, want := range map[string][2]bool{
		"/cdn-cgi/challenge-platform/h/b/orchestrate/x.js": {true, true},
		"/CDN-CGI/Challenge-Platform/h/g/x":                {true, false},
		"/cdn-cgi/trace":                                   {false, false},
		"/app/cdn-cgi/challenge-platform/a.JS":             {true, true},
	} {
		if isChallengeplatformPath(path) != want[0] || isChallengeJSPath(path) != want[1] {
			t.Errorf("%s: platform %v js %v", path, isChallengeplatformPath(path), isChallengeJSPath(path))
		}
	}
}
