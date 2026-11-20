package server

import "testing"

// CYRANO_DEBUG_R5's grammar, as documented on debugR5For.
func TestDebugR5For(t *testing.T) {
	const u = "https://h.example/app.js"
	if debugR5For("", u) != nil || debugR5For("app 1", u) != nil || debugR5For("([ 1 2", u) != nil {
		t.Error("an empty, odd or bad spec applies")
	}
	at := debugR5For("other 0 9; app 10 20 30 40", u)
	if at == nil {
		t.Fatal("the matching spec does not apply")
	}
	for pos, want := range map[int]bool{9: false, 10: true, 19: true, 20: false, 35: true, 40: false} {
		if at(pos) != want {
			t.Errorf("pos %d: %v", pos, !want)
		}
	}
	if at := debugR5For("!app 0 1; .* 5 6", u); at == nil || !at(5) || at(0) {
		t.Error("an inverted spec matched its own URL, or the next was not taken")
	}
	if at := debugR5For("!other 0 1", u); at == nil || !at(0) {
		t.Error("an inverted spec does not apply to the scripts not matching")
	}
}
