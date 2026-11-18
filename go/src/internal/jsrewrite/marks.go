package jsrewrite

import (
	"bytes"
)

// Invertible edits (TS: ts/client/src/js/marks.ts — the format is defined
// there; the two must agree byte for byte).
//
// The rewriter does not re-print a script: it splices its changes into the
// text, each written as
//
//	/*␡ORIGINAL*/NEW/*␡*/
//
// (␡ stands for U+007F, one ASCII byte), so that removing the fragments and putting each ORIGINAL
// back gives the script exactly as the origin sent it. The client answers
// Function.prototype.toString and script-text reads with that.

const mark = "\x7f"

var (
	markOpen   = []byte("/*" + mark)
	markClose  = []byte("/*" + mark + "*/")
	markEscape = []byte("*" + mark + "/") // `*/` inside ORIGINAL
)

// appendFragment appends one edit: inserted code, and the text it replaces.
// afterSlash: the source byte before it is `/` (a division); the fragment's `/*`
// would join it into `//`, a line comment: the fragment then starts with a
// space, and says so with a doubled marker so that the space is taken out
// again.
func appendFragment(dst []byte, inserted string, replaced []byte, afterSlash bool) []byte {
	if afterSlash {
		dst = append(dst, ' ')
		dst = append(dst, markOpen...)
		dst = append(dst, mark...)
	} else {
		dst = append(dst, markOpen...)
	}
	for len(replaced) > 0 {
		i := bytes.Index(replaced, []byte("*/"))
		if i < 0 {
			dst = append(dst, replaced...)
			break
		}
		dst = append(dst, replaced[:i]...)
		dst = append(dst, '*')
		dst = append(dst, mark...)
		dst = append(dst, '/')
		replaced = replaced[i+2:]
	}
	dst = append(dst, '*', '/')
	dst = append(dst, inserted...)
	return append(dst, markClose...)
}

// Original is the script as the page wrote it: every fragment replaced by
// its original text.
func Original(text []byte) []byte {
	a := bytes.Index(text, markOpen)
	if a < 0 {
		return text
	}
	var out []byte
	i := 0
	for a >= 0 {
		a += i
		from, upTo := a+len(markOpen), a
		if from < len(text) && text[from] == mark[0] { // a doubled marker: the space before it is ours
			from++
			if upTo > i && text[upTo-1] == ' ' {
				upTo--
			}
		}
		b := bytes.Index(text[from:], []byte("*/"))
		if b < 0 {
			break
		}
		b += from
		out = append(out, text[i:upTo]...)
		out = append(out, bytes.ReplaceAll(text[from:b], markEscape, []byte("*/"))...)
		c := bytes.Index(text[b+2:], markClose)
		if c < 0 {
			return out // cut short: the fragment runs to the end
		}
		i = b + 2 + c + len(markClose)
		a = bytes.Index(text[i:], markOpen)
	}
	return append(out, text[i:]...)
}

// Unmarked is the rewritten code without its markers: what runs, minus the
// comments. For tests and logs.
func Unmarked(text []byte) []byte {
	a := bytes.Index(text, markOpen)
	if a < 0 {
		return text
	}
	var out []byte
	i := 0
	for a >= 0 {
		a += i
		b := bytes.Index(text[a+len(markOpen):], []byte("*/"))
		if b < 0 {
			break
		}
		out = append(out, text[i:a]...)
		i = a + len(markOpen) + b + 2
		a = bytes.Index(text[i:], markOpen)
	}
	return append(out, text[i:]...)
}
