package htmlrewrite

import (
	"io"

	"golang.org/x/net/html"
)

// tokenStream is the document as the server reads it: x/net/html's
// tokenizer, told what the tree would tell it (spec/HtmlTok.agda). An
// element in foreign content does not make its content raw text
// (<svg><style> holds markup), and a CDATA section is one only in foreign
// content; the tokenizer alone takes every <style>, <title>, <textarea>…
// for raw text and every <![CDATA[ for a bogus comment.
type tokenStream struct {
	z  *html.Tokenizer
	ns nsTracker
	// ignored: the start tag last given to startTag makes no element.
	ignored bool
}

func newTokenStream(r io.Reader) *tokenStream {
	return &tokenStream{z: html.NewTokenizer(r)}
}

// startTag records the start tag just read and returns its element's
// namespace. Call it before the next token is read.
func (s *tokenStream) startTag(tok html.Token, selfClosing bool) Ns {
	// A <form> inside an open form makes no element (spec formIgnored):
	// the stack stays as it is.
	if s.ignored = s.ns.formIgnored(tok.Data); s.ignored {
		return NsHTML
	}
	ns := s.ns.start(tok.Data, selfClosing, func(a string) (string, bool) { return getAttr(tok.Attr, a) })
	if ns != NsHTML {
		s.z.NextIsNotRawText()
	}
	s.z.AllowCDATA(s.ns.cdataAllowed())
	return ns
}

// endTag records the end tag just read.
func (s *tokenStream) endTag(tag string) {
	s.ns.end(tag)
	s.z.AllowCDATA(s.ns.cdataAllowed())
}

// bootstrapPlace: where the runtime's bootstrap goes relative to the first
// start tag other than <html> (spec/HtmlTok.agda bootstrapAt): after a
// <head> or <body>, before anything else.
func bootstrapPlace(tag string) (before, after bool) {
	switch tag {
	case "html":
		return false, false
	case "head", "body":
		return false, true
	}
	return true, false
}
