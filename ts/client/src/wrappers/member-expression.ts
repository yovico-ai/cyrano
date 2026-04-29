// Wrapper for dynamic member expressions.
//
// Server emits:
//   $rewriter.wrap_member_expression(obj, ($apMe = expr))[$apMe]
// in place of `obj[expr]` so the client can intercept dynamic property names
// like `obj['locat'+'ion']`. For static-content browsing this is identity:
// we just return the object and the runtime indexes into it with the
// already-evaluated key.

export function wrapMemberExpression(obj: unknown, _prop: PropertyKey): unknown {
    return obj;
}
