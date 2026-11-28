package proxy

import (
	"context"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/yovico/cyrano/internal/urlrewrite"
)

// An import map's "integrity" section, enforced here (spec ImportMap
// integrityEntries). The browser is given the map with it emptied — a
// rewritten module never matches the original's hash — so a module listed
// there ran whatever the origin sent. The proxy keeps a document's entries
// (the maps the server rewrote, first entry for a URL standing) per
// session and page, and a module script request for that document — its
// own, or an import of one of its modules (scriptDocs) — without integrity
// in its URL is checked by its entry, as an integrity attribute is
// (SRIFails). A module script's or modulepreload's own integrity is kept
// the same way (RecordModuleIntegrity), first entry for a URL standing.
// Limits: a classic script of a listed URL is checked too (the
// proxy sees both in cors mode); a map the runtime inserts is not kept.

var pageIntegrity struct {
	mu sync.Mutex
	m  map[string][]urlrewrite.IntegrityEntry
}

// RecordModuleIntegrity adds a module member's integrity (a module script's
// src, a modulepreload's href, spec Sri.carry inDocument): its URL stays
// unmarked, the module's one identity, and its request is checked here as
// an import map entry is.
func RecordModuleIntegrity(resp *http.Response, target *url.URL, abs, metadata string) {
	recordIntegrity(resp, target, []urlrewrite.IntegrityEntry{{URL: abs, Metadata: metadata}})
}

// RecordImportMap adds a document's import map (as the page wrote it, its
// keys resolved against base) to the integrity it enforces.
func RecordImportMap(resp *http.Response, target *url.URL, base, text string) {
	recordIntegrity(resp, target, urlrewrite.ImportMapIntegrity(text, base))
}

func recordIntegrity(resp *http.Response, target *url.URL, entries []urlrewrite.IntegrityEntry) {
	if len(entries) == 0 {
		return
	}
	var req *http.Request
	if resp != nil {
		req = resp.Request
	}
	k := sessionIn(req) + "\x00" + pageKey(target)
	pageIntegrity.mu.Lock()
	defer pageIntegrity.mu.Unlock()
	if pageIntegrity.m == nil {
		pageIntegrity.m = map[string][]urlrewrite.IntegrityEntry{}
	}
	if _, ok := pageIntegrity.m[k]; !ok && len(pageIntegrity.m) >= policyStoreMax {
		for x := range pageIntegrity.m {
			delete(pageIntegrity.m, x)
			break
		}
	}
	pageIntegrity.m[k] = urlrewrite.MergeIntegrity(pageIntegrity.m[k], entries)
}

// forgetImportMaps drops a document's entries when it is loaded again.
func forgetImportMaps(session, page string) {
	pageIntegrity.mu.Lock()
	defer pageIntegrity.mu.Unlock()
	delete(pageIntegrity.m, session+"\x00"+page)
}

// noteMapIntegrity gives a module script request with no integrity of its
// own its document's import map entry, for SRIFails.
func noteMapIntegrity(req *http.Request, target *url.URL) {
	if v, _ := req.Context().Value(integrityKey{}).(string); v != "" {
		return
	}
	if !strings.EqualFold(req.Header.Get("Sec-Fetch-Dest"), "script") || !strings.EqualFold(req.Header.Get("Sec-Fetch-Mode"), "cors") {
		return
	}
	page, _ := req.Context().Value(requesterKey{}).(string)
	if page == "" {
		return
	}
	pageIntegrity.mu.Lock()
	entries := pageIntegrity.m[sessionIn(req)+"\x00"+page]
	pageIntegrity.mu.Unlock()
	meta, ok := urlrewrite.IntegrityFor(entries, target.String())
	if !ok {
		return
	}
	// No valid item (an unknown algorithm, nothing): nothing to match, as an attribute's.
	if mark, ok := urlrewrite.SRIMark(meta); ok && mark != "" {
		*req = *req.WithContext(context.WithValue(req.Context(), integrityKey{}, mark))
	}
}
