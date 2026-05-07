package jsrewrite

import (
	"fmt"
	"testing"
)

func TestWorkerDiag(t *testing.T) {
	cases := []string{
		`new Worker(url)`,
		`new Worker(z[41](14,d),void 0)`,
		`(A=new Worker(z[41](14,d),void 0))`,
		`A=new Worker(z[41](14,d),void 0)`,
		`((n+R[2]|26)>=n&&(A=new Worker(z[41](14,d),void 0)),R)`,
	}
	opts := DefaultOptions()
	for i, src := range cases {
		out := Rewrite([]byte(src), opts)
		fmt.Printf("Test %d: %s\n", i+1, out)
	}
}
