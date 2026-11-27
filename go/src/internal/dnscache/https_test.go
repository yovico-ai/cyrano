package dnscache

import (
	"reflect"
	"testing"

	"golang.org/x/net/dns/dnsmessage"
)

// A reply as a recursive resolver gives it for www.napaonline.com: a CNAME
// to the CDN name, then that name's HTTPS record (alpn h3,h2); an alias-mode
// record (priority 0) carries no service parameters to take.
func reply(t *testing.T, id uint16, records ...func(b *dnsmessage.Builder) error) []byte {
	t.Helper()
	b := dnsmessage.NewBuilder(nil, dnsmessage.Header{ID: id, Response: true, RecursionAvailable: true})
	if err := b.StartQuestions(); err != nil {
		t.Fatal(err)
	}
	q := dnsmessage.MustNewName("www.napaonline.com.")
	if err := b.Question(dnsmessage.Question{Name: q, Type: dnsmessage.TypeHTTPS, Class: dnsmessage.ClassINET}); err != nil {
		t.Fatal(err)
	}
	if err := b.StartAnswers(); err != nil {
		t.Fatal(err)
	}
	for _, r := range records {
		if err := r(&b); err != nil {
			t.Fatal(err)
		}
	}
	m, err := b.Finish()
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func hdr(name string, typ dnsmessage.Type) dnsmessage.ResourceHeader {
	return dnsmessage.ResourceHeader{Name: dnsmessage.MustNewName(name), Type: typ, Class: dnsmessage.ClassINET, TTL: 300}
}

func httpsRR(name string, prio uint16, alpn ...string) func(b *dnsmessage.Builder) error {
	return func(b *dnsmessage.Builder) error {
		r := dnsmessage.HTTPSResource{SVCBResource: dnsmessage.SVCBResource{Priority: prio, Target: dnsmessage.MustNewName(".")}}
		if len(alpn) > 0 {
			var v []byte
			for _, a := range alpn {
				v = append(v, byte(len(a)))
				v = append(v, a...)
			}
			r.SetParam(dnsmessage.SVCParamALPN, v)
		}
		return b.HTTPSResource(hdr(name, dnsmessage.TypeHTTPS), r)
	}
}

func TestParseHTTPS(t *testing.T) {
	query := []byte{0x12, 0x34}
	cname := func(b *dnsmessage.Builder) error {
		return b.CNAMEResource(hdr("www.napaonline.com.", dnsmessage.TypeCNAME), dnsmessage.CNAMEResource{CNAME: dnsmessage.MustNewName("www.napaonline.com.cdn.cloudflare.net.")})
	}
	for _, c := range []struct {
		name    string
		records []func(*dnsmessage.Builder) error
		alpn    []string
		found   bool
	}{
		{"cname then service record", []func(*dnsmessage.Builder) error{cname, httpsRR("www.napaonline.com.cdn.cloudflare.net.", 1, "h3", "h2")}, []string{"h3", "h2"}, true},
		{"no record", []func(*dnsmessage.Builder) error{cname}, nil, false},
		{"alias mode only", []func(*dnsmessage.Builder) error{httpsRR("www.napaonline.com.", 0)}, nil, false},
		{"service record without alpn", []func(*dnsmessage.Builder) error{httpsRR("www.napaonline.com.", 1)}, nil, true},
	} {
		alpn, found, err := parseHTTPS(reply(t, 0x1234, c.records...), query)
		if err != nil || found != c.found || !reflect.DeepEqual(alpn, c.alpn) {
			t.Errorf("%s: alpn %v found %v err %v; want %v %v", c.name, alpn, found, err, c.alpn, c.found)
		}
	}
	if _, _, err := parseHTTPS(reply(t, 0x9999), query); err == nil {
		t.Errorf("a reply to another query was taken")
	}
}
