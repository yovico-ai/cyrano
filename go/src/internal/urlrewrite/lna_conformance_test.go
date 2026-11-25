package urlrewrite

import (
	"fmt"
	"net"
	"testing"

	"github.com/yovico/cyrano/internal/specoracle"
	"pgregory.net/rapid"
)

func TestSpecConformance_LNA(t *testing.T) {
	oracle := specoracle.Need(t)
	rapid.Check(t, func(rt *rapid.T) {
		o := []int{rapid.SampledFrom([]int{0, 1, 8, 10, 100, 127, 169, 172, 192, 255}).Draw(rt, "a"), rapid.SampledFrom([]int{0, 15, 16, 31, 32, 168, 254, 255}).Draw(rt, "b"), rapid.IntRange(0, 255).Draw(rt, "c"), rapid.IntRange(0, 255).Draw(rt, "d")}
		want, _, err := oracle.Ask("lnaspace4", fmt.Sprint(o[0]), fmt.Sprint(o[1]), fmt.Sprint(o[2]), fmt.Sprint(o[3]))
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if got := SpaceOf(net.IPv4(byte(o[0]), byte(o[1]), byte(o[2]), byte(o[3]))).String(); got != want {
			rt.Fatalf("SpaceOf(%v) = %s, spec %s", o, got, want)
		}
		d := AddressSpace(rapid.IntRange(0, 2).Draw(rt, "doc"))
		tg := AddressSpace(rapid.IntRange(0, 2).Draw(rt, "target"))
		nav := rapid.Bool().Draw(rt, "nav")
		n := "0"
		if nav {
			n = "1"
		}
		w, _, err := oracle.Ask("lnarefused", d.String(), tg.String(), n)
		if err != nil {
			rt.Fatalf("oracle: %v", err)
		}
		if LNARefused(d, tg, nav) != (w == "yes") {
			rt.Fatalf("LNARefused(%s, %s, %v), spec %s", d, tg, nav, w)
		}
	})
}
