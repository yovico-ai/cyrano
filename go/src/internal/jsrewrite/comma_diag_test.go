package jsrewrite

import (
	"fmt"
	"testing"
	"github.com/tdewolff/parse/v2"
	"github.com/tdewolff/parse/v2/js"
)

func TestCommaExpr(t *testing.T) {
	src := []byte(`((n+R[2]|26)>=n&&(A=new Worker(z[41](14,d),void 0)),R)`)
	ast, err := js.Parse(parse.NewInputBytes(src), js.Options{})
	if err != nil {
		t.Fatalf("parse error: %v", err)
	}
	// Walk the first statement to see if it's a CommaExpr  
	stmt := ast.BlockStmt.List[0]
	fmt.Printf("Top stmt type: %T\n", stmt)
	if es, ok := stmt.(*js.ExprStmt); ok {
		fmt.Printf("ExprStmt value type: %T\n", es.Value)
		if grp, ok := es.Value.(*js.GroupExpr); ok {
			fmt.Printf("GroupExpr inner: %T\n", grp.X)
			if ce, ok := grp.X.(*js.CommaExpr); ok {
				fmt.Printf("CommaExpr list len: %d\n", len(ce.List))
				for i, item := range ce.List {
					fmt.Printf("  [%d] type: %T\n", i, item)
				}
			}
		}
	}
}
