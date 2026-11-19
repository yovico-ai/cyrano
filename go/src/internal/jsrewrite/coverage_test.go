package jsrewrite

import (
	"bytes"
	"testing"

	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/js"
)

// Every place JavaScript can hold an expression must be reached by the
// rewriter: a `location` read the walk never visits reaches the page
// unrewritten and shows it the proxy. Each case names how many reads it
// holds; all must be wrapped, and the output must still parse.
func TestRewrite_ReachesEveryExpressionPosition(t *testing.T) {
	for _, c := range []struct {
		src string
		n   int
	}{
		{`var o = { m() { return location.href; } };`, 1},
		{`var o = { 123() { return location.href; } };`, 1},
		{`var o = { get g() { return location.href; }, set s(v) { x = location.href; } };`, 2},
		{`var o = { async m() { return location.href; }, *gen() { yield location.href; } };`, 2},
		{`var o = { [location.href]: 1, k2: () => location.href, [location.host]() { return location.port; } };`, 4},
		{`class C extends f(location.href) { m() { return location.href; } static s() { return location.href; } f = location.href; static { location.href; } #p() { return location.href; } [location.host]() {} get g() { return location.port; } }`, 8},
		{`var K = class { m() { return location.href; } };`, 1},
		{`(self.webpackChunk = self.webpackChunk || []).push([[1], { 5(e, t, o) { globalThis.x = globalThis.location.pathname; } }]);`, 1},
		// (6: the pattern with a computed key also reads its source through wrap_pattern, R14)
		{`var {a = location.href, [location.host]: b = location.port} = o; var [c = location.href, [d = location.host]] = arr;`, 6},
		{`function d(p = location.href, {q = location.host}, ...[r = location.port]) {} var e = (p = location.href) => p; var g = function (p = location.host) {};`, 5},
		{`try { x } catch ({ m = location.href }) { location.host }`, 2},
		{`do { location.href } while (location.host); with (location.port) { location.href }`, 4},
		{`var f = function*() { yield location.href; }; var g = async () => { await location.href; };`, 2},
		{`for (const x of location.href) {} for (var k in location.host) {} label: for (;;) { location.href; break label; }`, 3},
		{"var t = `${location.href}`; var tt = tag`${location.href}`;", 2},
		{`a ?? location.href; a?.[location.href]; a?.(location.href); new X(location.href); x = c ? location.href : location.host;`, 6},
		{`switch (location.href) { case location.host: location.href; default: location.port; }`, 4},
		{`export const m = { 5(e) { return location.href; } }; export function f() { return location.host; } export class K { m() { return location.port; } }`, 3},
		{`export default { m() { return location.href; } };`, 1},
		{`export default function () { return location.href; }`, 1},
		{`for (var i = location.href, j = location.host; i < j; i++) { location.port }`, 3},
		{`for (const [a = location.href] of xs) {} for (let {b = location.host} in o) {}`, 2},
	} {
		out := Rewrite([]byte(c.src), DefaultOptions())
		if got := bytes.Count(out, []byte("$rewriter.wrap_")); got != c.n {
			t.Errorf("%d of %d reads wrapped:\n  in:  %s\n  out: %s", got, c.n, c.src, out)
		}
		if _, err := js.Parse(parse.NewInputBytes(append([]byte(nil), out...)), js.Options{}); err != nil {
			t.Errorf("output does not parse (%v):\n  in:  %s\n  out: %s", err, c.src, out)
		}
	}
}

// A wrapped member in an optional chain must still short-circuit on a
// nullish object (ibm.com: digitalData?.user?.location?.country): the
// helper is passed opt and the access after it is optional.
func TestRewrite_OptionalChainKeepsShortCircuit(t *testing.T) {
	for src, want := range map[string]string{
		`x = d?.user?.location?.country;`: `$rewriter.wrap_location({obj:d?.user,opt:1})?.location?.country`,
		`x = d?.user.location.country;`:   `$rewriter.wrap_location({obj:d?.user,opt:1})?.location.country`,
		`x = d?.w?.top?.y;`:               `$rewriter.wrap_top_window({obj:d?.w,opt:1})?.top?.y`,
		`x = d.user.location.country;`:    `$rewriter.wrap_location({obj:d.user}).location.country`,
	} {
		out := string(Unmarked(Rewrite([]byte(src), DefaultOptions())))
		if !bytes.Contains([]byte(out), []byte(want)) {
			t.Errorf("in:  %s\n out: %s\n want it to contain: %s", src, out, want)
		}
	}
}
