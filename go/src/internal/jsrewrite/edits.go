package jsrewrite

import (
	"bytes"
	"sort"
	"strings"
)

// An edit is one change to the source: at byte offset pos, del bytes are
// replaced by ins. (TS: Edit in ts/client/src/js/rewriter.ts.)
type edit struct {
	pos, del int
	ins      string
	kind     uint8
	seq      int
	dead     bool // withdrawn: the identifier turned out to be declared or assigned
}

// Where an edit sits among others at the same offset: closers, then
// openers, then replacements.
const (
	editClose uint8 = iota
	editOpen
	editReplace
)

func (p *parser) open(pos int, ins string) {
	p.edits = append(p.edits, edit{pos: pos, ins: p.rt(ins), kind: editOpen, seq: p.seq})
	p.seq++
}

func (p *parser) close(pos int, ins string) {
	p.edits = append(p.edits, edit{pos: pos, ins: p.rt(ins), kind: editClose, seq: p.seq})
	p.seq++
}

func (p *parser) replace(pos, del int, ins string) {
	p.edits = append(p.edits, edit{pos: pos, del: del, ins: p.rt(ins), kind: editReplace, seq: p.seq})
	p.seq++
}

// withGlobal is the global object whatever names a with object claims: a
// sloppy function's this, or — in a strict function nested in the with,
// where this is undefined — globalThis when it holds the runtime, and only
// past that a function compiled from "return this", reached from a
// literal's constructor (an eval: refused under a CSP without
// 'unsafe-eval'). R13 (TS: WITH_GLOBAL in ts/client/src/js/rewriter.ts).
const withGlobal = `((typeof _crn$g!=="undefined"&&_crn$g)||(function(){return this})()||(typeof globalThis!=="undefined"&&globalThis&&globalThis.$rewriter&&globalThis)||(function(){}).constructor("return this")()).`

// rt is an edit's text as written where it lands: inside a with body the
// runtime's names go through the global object (Vue's compiled templates
// run in with(_ctx), whose Proxy claims every name).
func (p *parser) rt(ins string) string {
	if p.withDepth == 0 {
		return ins
	}
	ins = strings.ReplaceAll(ins, "$rewriter.", withGlobal+"$rewriter.")
	return strings.ReplaceAll(ins, "$__crn_key__", withGlobal+"$__crn_key__")
}

// Edit is an edit as the conformance tests compare it.
type Edit struct {
	Pos, Del int
	Ins      string
}

// jsEdits parses src and returns the edits the rules call for, in
// application order; ok is false when src does not parse.
func jsEdits(src []byte, opts *Options) (edits []edit, ok bool) {
	p := &parser{o: opts}
	p.src = src
	defer func() {
		if r := recover(); r != nil {
			switch r.(type) {
			case parseError, scanError:
				edits, ok = nil, false
			default:
				// An index out of range on truncated input is a script
				// that does not parse, not a server fault.
				if _, isRuntime := r.(interface{ RuntimeError() }); isRuntime {
					edits, ok = nil, false
					return
				}
				panic(r)
			}
		}
	}()
	p.program()
	live := p.edits[:0]
	for _, e := range p.edits {
		if !e.dead {
			live = append(live, e)
		}
	}
	// At one offset: inner closers first (in the order made), then openers
	// outermost first (the reverse of the order made), then replacements.
	sort.Slice(live, func(i, j int) bool {
		a, b := &live[i], &live[j]
		if a.pos != b.pos {
			return a.pos < b.pos
		}
		if a.kind != b.kind {
			return a.kind < b.kind
		}
		if a.kind == editOpen {
			return a.seq > b.seq
		}
		return a.seq < b.seq
	})
	return live, true
}

// Edits is jsEdits for the conformance tests.
func Edits(src []byte, opts Options) ([]Edit, bool) {
	es, ok := jsEdits(src, &opts)
	if !ok {
		return nil, false
	}
	out := make([]Edit, len(es))
	for i, e := range es {
		out[i] = Edit{Pos: e.pos, Del: e.del, Ins: e.ins}
	}
	return out, true
}

// applyEdits splices the (sorted) edits into src, each as a marked
// fragment; insertions at one offset share a fragment.
func applyEdits(src []byte, edits []edit) []byte {
	if len(edits) == 0 {
		return src
	}
	// The marker byte may occur in a script; what must not is a sequence
	// that would read as a marker of ours.
	marked := !bytes.Contains(src, markOpen) && !bytes.Contains(src, markEscape)
	grow := 0
	for i := range edits {
		grow += len(edits[i].ins) + 2*len(markClose)
	}
	out := make([]byte, 0, len(src)+grow)
	at := 0
	var ins []byte
	for i := 0; i < len(edits); {
		e := &edits[i]
		ins = append(ins[:0], e.ins...)
		j := i + 1
		if e.del == 0 {
			for j < len(edits) && edits[j].pos == e.pos && edits[j].del == 0 {
				ins = append(ins, edits[j].ins...)
				j++
			}
		}
		out = append(out, src[at:e.pos]...)
		if marked {
			out = appendFragment(out, string(ins), src[e.pos:e.pos+e.del], e.pos > at && src[e.pos-1] == '/')
		} else {
			// No marker comment to separate tokens: `return[a][k]` must
			// not become `return$rewriter…`.
			if len(out) > 0 && len(ins) > 0 && isIdentPart(out[len(out)-1]) && out[len(out)-1] != '\\' && isIdentPart(ins[0]) {
				out = append(out, ' ')
			}
			out = append(out, ins...)
		}
		at = e.pos + e.del
		i = j
	}
	return append(out, src[at:]...)
}
