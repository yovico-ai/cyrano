// Akamai Bot Manager fixture payload.
//
// This script is served at /rAnD0m/sEgMnt?v=<UUID> — a URL shape that the
// proxy's isChallengeScript() detects and passes through unmodified.
//
// The computed-property call below would produce a TypeError if the proxy's
// wrap_member_expression rewrite were applied:
//   obj[key]()
// becomes
//   $rewriter.wrap_member_expression(obj, $__crn_tmp__ = key)[$__crn_tmp__]()
// which breaks when the object is a plain array whose element is a function
// (the this-binding changes) — or in Akamai's obfuscated code, when the
// subscript result is used in a pattern the rewriter subtly mishandles.

(function() {
  // Pattern 1: computed property access used as a callable.
  var fns = { run: function() { return 42; } };
  var key = "run";
  var result = fns[key]();        // would fail post-rewrite if not passed through
  if (result !== 42) return;      // bail silently — test will see flag unset

  // Pattern 2: chained computed access.
  var obj = { a: { b: function() { return true; } } };
  var k1 = "a", k2 = "b";
  if (!obj[k1][k2]()) return;

  // Pattern 3: method call preserving `this`.
  var counter = {
    n: 0,
    inc: function() { this.n++; return this; },
  };
  var method = "inc";
  counter[method]()[method]();
  if (counter.n !== 2) return;

  window.__akamaiFixtureRan = true;
})();
