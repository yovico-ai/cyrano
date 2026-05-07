// Client-side JavaScript rewriter — applies the same JS_WRAP_* AST
// transformations the server-side rewriter applies, but on JS source the
// server can't see (eval, new Function bodies, inline <script> content
// inside dynamically inserted HTML).
//
// Mirrors go/src/internal/jsrewrite/rewriter.go rule-for-rule. The output
// must be functionally identical: bare `location` reads route through
// `$rewriter.wrap_get_location(location)`, `obj.location` becomes
// `$rewriter.wrap_location({obj: obj}).location`, and so on. That ensures
// dynamic JS sees the same wrapped runtime as server-rewritten JS.
//
// Uses acorn for parsing + astring for source serialization. Both ship in
// the bundle; their combined unminified weight (~120 KB) is the price of
// faithful AST-level rewriting on the client. A regex-based shortcut would
// be smaller but would miss every dynamically-constructed URL access.
//
// Failure policy: matches the server. Parse failures → return source
// unchanged (never break a page we can't safely transform). Already-rewritten
// input (carrying `$rewriter.wrap_` or `$rewriter_init(`) → return
// unchanged.

import { Parser, type Node } from "acorn";
import { generate } from "astring";

// ESTree node types we touch. We use loose interface declarations rather
// than @types/estree to keep the dependency surface minimal — acorn's runtime
// shapes match these.
interface ProgramNode extends Node {
    type: "Program";
    body: StatementNode[];
}

type StatementNode = Node & {
    type: string;
    body?: StatementNode | StatementNode[] | BlockStatement;
    declarations?: VariableDeclarator[];
    expression?: ExpressionNode;
    test?: ExpressionNode | null;
    consequent?: StatementNode | StatementNode[];
    alternate?: StatementNode | null;
    update?: ExpressionNode | null;
    init?: ExpressionNode | StatementNode | null;
    argument?: ExpressionNode | null;
    cases?: SwitchCase[];
    discriminant?: ExpressionNode;
    block?: BlockStatement;
    handler?: { body: BlockStatement } | null;
    finalizer?: BlockStatement | null;
    label?: { name: string };
    params?: PatternNode[];
    id?: { name: string } | null;
    left?: ExpressionNode | PatternNode;
    right?: ExpressionNode;
};

interface BlockStatement extends Node {
    type: "BlockStatement";
    body: StatementNode[];
}

interface SwitchCase extends Node {
    type: "SwitchCase";
    test: ExpressionNode | null;
    consequent: StatementNode[];
}

interface VariableDeclarator extends Node {
    type: "VariableDeclarator";
    id: PatternNode;
    init: ExpressionNode | null;
}

interface PatternNode extends Node {
    type: string;
}

type ExpressionNode = Node & {
    type: string;
    name?: string;
    value?: unknown;
    object?: ExpressionNode;
    property?: ExpressionNode;
    computed?: boolean;
    callee?: ExpressionNode;
    arguments?: ExpressionNode[];
    operator?: string;
    left?: ExpressionNode;
    right?: ExpressionNode;
    expressions?: ExpressionNode[];
    quasis?: unknown[];
    elements?: (ExpressionNode | null)[];
    properties?: ObjectProperty[];
    test?: ExpressionNode;
    consequent?: ExpressionNode;
    alternate?: ExpressionNode;
    body?: BlockStatement | ExpressionNode;
    params?: PatternNode[];
    argument?: ExpressionNode | null;
};

interface ObjectProperty extends Node {
    type: "Property" | "SpreadElement";
    key?: ExpressionNode;
    value?: ExpressionNode;
    computed?: boolean;
    shorthand?: boolean;
    kind?: string;
    argument?: ExpressionNode;
}

export interface JsRewriteOptions {
    wrapGetLocation: boolean;
    wrapSetLocation: boolean;
    wrapLocation: boolean;
    wrapGetTopWindow: boolean;
    wrapTopWindow: boolean;
    wrapGetParentWindow: boolean;
    wrapParentWindow: boolean;
    wrapDocumentWrite: boolean;
    wrapPostMessage: boolean;
    wrapEval: boolean;
    wrapEvalArg: boolean;
    wrapEvalMemexp: boolean;
    wrapMemberExpression: boolean;
}

/** Mirrors the server's DefaultOptions — every rule we kept after cleanup. */
export function defaultJsRewriteOptions(): JsRewriteOptions {
    return {
        wrapGetLocation: true,
        wrapSetLocation: true,
        wrapLocation: true,
        wrapGetTopWindow: true,
        wrapTopWindow: true,
        wrapGetParentWindow: true,
        wrapParentWindow: true,
        wrapDocumentWrite: true,
        wrapPostMessage: true,
        wrapEval: true,
        wrapEvalArg: true,
        wrapEvalMemexp: true,
        wrapMemberExpression: true,
    };
}

/** Cheap check: input that already calls into our runtime should not be re-wrapped. */
function alreadyRewritten(src: string): boolean {
    return src.includes("$rewriter.wrap_") || src.includes("$rewriter_init(");
}

/**
 * Preamble injected before eval'd code that references $rewriter.* or uses
 * $__crn_key__. Makes both available even in sandboxed execution contexts
 * (e.g. GTM custom-template sandbox) where the global object may differ from
 * the main window. Inserted after a leading "use strict" directive if present
 * so strict mode is preserved.
 *
 * The $rewriter fallback walks up the frame tree — ad iframes written via
 * document.write don't have the bootstrap injected into their window, so
 * window.$rewriter is undefined. All proxied frames share the same proxy
 * origin, so parent frame access is always same-origin safe.
 */
const EVAL_PREAMBLE =
    'var $rewriter=window.$rewriter||(function(){' +
    'try{for(var _w=window;_w!==_w.parent;_w=_w.parent)' +
    'if(_w.parent.$rewriter)return _w.parent.$rewriter;}' +
    'catch(_e){}return null}()),' +
    '$__crn_key__=window.$__crn_key__||0;';

function withEvalPreamble(code: string): string {
    // Detect a leading strict-mode directive and insert preamble after it.
    const m = /^(['"])use strict\1\s*;?\n?/.exec(code);
    if (m) {
        return code.slice(0, m[0].length) + EVAL_PREAMBLE + "\n" + code.slice(m[0].length);
    }
    return EVAL_PREAMBLE + "\n" + code;
}

/**
 * Parses src as JS, applies enabled rules, and returns the rewritten source.
 * Returns src unchanged on parse failure, matching the server's
 * "fail open — never break a page we can't safely transform" policy.
 *
 * When the output references $rewriter.* (either from fresh rewriting or
 * because the input was already server-rewritten), an eval-preamble is
 * prepended that makes $rewriter and $__crn_key__ accessible in sandboxed
 * eval contexts.
 */
export function rewriteJsSource(src: string, opts: JsRewriteOptions): string {
    if (typeof src !== "string" || src.length === 0) return src;

    let result: string;
    if (alreadyRewritten(src)) {
        result = src; // don't double-rewrite
    } else {
        let ast: ProgramNode;
        try {
            ast = Parser.parse(src, {
                ecmaVersion: "latest",
                sourceType: "script",
                allowReturnOutsideFunction: true,
                allowAwaitOutsideFunction: true,
                allowImportExportEverywhere: true,
            }) as unknown as ProgramNode;
        } catch {
            return src;
        }

        const rewriter = new JsRewriter(opts);
        rewriter.walkProgram(ast);

        try {
            result = generate(ast);
        } catch {
            return src;
        }
    }

    // Inject the preamble whenever the code references our runtime — this
    // covers both freshly-rewritten code and already-server-rewritten fragments.
    if (result.includes("$rewriter.") || result.includes("$__crn_key__")) {
        return withEvalPreamble(result);
    }
    return result;
}

class JsRewriter {
    constructor(private readonly opts: JsRewriteOptions) {}

    walkProgram(program: ProgramNode): void {
        for (let i = 0; i < program.body.length; i++) {
            program.body[i] = this.walkStmt(program.body[i] as StatementNode);
        }
    }

    walkBlock(block: BlockStatement): void {
        for (let i = 0; i < block.body.length; i++) {
            block.body[i] = this.walkStmt(block.body[i]!);
        }
    }

    walkStmt(stmt: StatementNode): StatementNode {
        switch (stmt.type) {
            case "ExpressionStatement":
                stmt.expression = this.rvalue(stmt.expression!);
                break;
            case "VariableDeclaration":
                if (stmt.declarations) {
                    for (const d of stmt.declarations) {
                        if (d.init) d.init = this.rvalue(d.init);
                    }
                }
                break;
            case "IfStatement":
                stmt.test = this.rvalue(stmt.test as ExpressionNode);
                stmt.consequent = this.walkStmt(stmt.consequent as StatementNode);
                if (stmt.alternate) stmt.alternate = this.walkStmt(stmt.alternate);
                break;
            case "ForStatement":
                if (stmt.init) {
                    stmt.init = (stmt.init as StatementNode).type === "VariableDeclaration"
                        ? this.walkStmt(stmt.init as StatementNode)
                        : this.rvalue(stmt.init as ExpressionNode);
                }
                if (stmt.test) stmt.test = this.rvalue(stmt.test);
                if (stmt.update) stmt.update = this.rvalue(stmt.update);
                stmt.body = this.walkStmt(stmt.body as StatementNode);
                break;
            case "ForInStatement":
            case "ForOfStatement":
                // LHS (left) is the iteration target — for `for (location in ...)`
                // the server treats `location` as an lvalue (set_location wrap).
                stmt.left = this.lvalue(stmt.left as ExpressionNode);
                stmt.right = this.rvalue(stmt.right as ExpressionNode);
                stmt.body = this.walkStmt(stmt.body as StatementNode);
                break;
            case "WhileStatement":
            case "DoWhileStatement":
                stmt.test = this.rvalue(stmt.test as ExpressionNode);
                stmt.body = this.walkStmt(stmt.body as StatementNode);
                break;
            case "ReturnStatement":
            case "ThrowStatement":
                if (stmt.argument) stmt.argument = this.rvalue(stmt.argument);
                break;
            case "BlockStatement":
                this.walkBlock(stmt as unknown as BlockStatement);
                break;
            case "SwitchStatement":
                stmt.discriminant = this.rvalue(stmt.discriminant!);
                if (stmt.cases) {
                    for (const c of stmt.cases) {
                        if (c.test) c.test = this.rvalue(c.test);
                        for (let i = 0; i < c.consequent.length; i++) {
                            c.consequent[i] = this.walkStmt(c.consequent[i]!);
                        }
                    }
                }
                break;
            case "TryStatement":
                if (stmt.block) this.walkBlock(stmt.block);
                if (stmt.handler) this.walkBlock(stmt.handler.body);
                if (stmt.finalizer) this.walkBlock(stmt.finalizer);
                break;
            case "LabeledStatement":
                stmt.body = this.walkStmt(stmt.body as StatementNode);
                break;
            case "FunctionDeclaration":
            case "FunctionExpression":
                if (stmt.body) this.walkBlock(stmt.body as BlockStatement);
                break;
        }
        return stmt;
    }

    /**
     * rvalue: rewrites an expression in a value-read context. Recurses into
     * children first (post-order), then applies wrap rules at this node.
     */
    rvalue(expr: ExpressionNode): ExpressionNode {
        if (!expr) return expr;
        switch (expr.type) {
            case "AssignmentExpression": {
                if (expr.operator === "=") {
                    expr.left = this.lvalue(expr.left as ExpressionNode);
                } else {
                    expr.left = this.rvalue(expr.left as ExpressionNode);
                }
                expr.right = this.rvalue(expr.right as ExpressionNode);
                return expr;
            }
            case "BinaryExpression":
            case "LogicalExpression": {
                expr.left = this.rvalue(expr.left as ExpressionNode);
                expr.right = this.rvalue(expr.right as ExpressionNode);
                return expr;
            }
            case "ConditionalExpression": {
                expr.test = this.rvalue(expr.test!);
                expr.consequent = this.rvalue(expr.consequent!);
                expr.alternate = this.rvalue(expr.alternate!);
                return expr;
            }
            case "UnaryExpression":
            case "UpdateExpression":
            case "AwaitExpression":
            case "YieldExpression": {
                if (expr.argument) expr.argument = this.rvalue(expr.argument);
                return expr;
            }
            case "SequenceExpression": {
                if (expr.expressions) {
                    for (let i = 0; i < expr.expressions.length; i++) {
                        expr.expressions[i] = this.rvalue(expr.expressions[i]!);
                    }
                }
                return expr;
            }
            case "CallExpression": {
                // Detect `eval(arg, ...)` BEFORE recursing into the callee so
                // we don't trigger WRAP_EVAL on the bare `eval` identifier
                // (which would result in $rewriter.wrap_eval_arg($rewriter.wrap_eval(eval),...)).
                const isBareEvalCall = this.opts.wrapEvalArg &&
                    isIdentifier(expr.callee!, "eval") &&
                    (expr.arguments?.length ?? 0) > 0;
                if (isBareEvalCall) {
                    expr.arguments![0] = this.wrapEvalArg(this.rvalue(expr.arguments![0]!));
                } else {
                    expr.callee = this.rvalue(expr.callee!);
                }
                if (expr.arguments) {
                    for (let i = 0; i < expr.arguments.length; i++) {
                        if (isBareEvalCall && i === 0) continue;
                        expr.arguments[i] = this.rvalue(expr.arguments[i]!);
                    }
                }
                return expr;
            }
            case "NewExpression": {
                expr.callee = this.rvalue(expr.callee!);
                if (expr.arguments) {
                    for (let i = 0; i < expr.arguments.length; i++) {
                        expr.arguments[i] = this.rvalue(expr.arguments[i]!);
                    }
                }
                return expr;
            }
            case "MemberExpression": {
                expr.object = this.rvalue(expr.object!);
                if (expr.computed) {
                    // obj[expr] — WRAP_MEMBER_EXPRESSION
                    expr.property = this.rvalue(expr.property!);
                    if (this.opts.wrapMemberExpression) {
                        return this.wrapMemberExpression(expr);
                    }
                    return expr;
                }
                // obj.X — non-computed; check property name
                const propName = expr.property?.type === "Identifier"
                    ? expr.property.name
                    : undefined;
                switch (propName) {
                    case "location":
                        if (this.opts.wrapLocation) return this.wrapDotObj(expr, "wrap_location");
                        break;
                    case "top":
                        if (this.opts.wrapTopWindow) return this.wrapDotObj(expr, "wrap_top_window");
                        break;
                    case "parent":
                        if (this.opts.wrapParentWindow) return this.wrapDotObj(expr, "wrap_parent_window");
                        break;
                    case "write":
                    case "writeln":
                        if (this.opts.wrapDocumentWrite) return this.wrapDotObj(expr, "wrap_document_write");
                        break;
                    case "postMessage":
                        if (this.opts.wrapPostMessage) return this.wrapDotObj(expr, "wrap_postMessage");
                        break;
                    case "eval":
                        if (this.opts.wrapEvalMemexp) return this.wrapEvalMemexp(expr);
                        break;
                }
                return expr;
            }
            case "Identifier": {
                switch (expr.name) {
                    case "location":
                        if (this.opts.wrapGetLocation) return this.wrapCall("wrap_get_location", expr);
                        break;
                    case "top":
                        if (this.opts.wrapGetTopWindow) return this.wrapCall("wrap_get_top_window", expr);
                        break;
                    case "parent":
                        // v1 reuses get_top_window for both top and parent rvalues.
                        if (this.opts.wrapGetParentWindow) return this.wrapCall("wrap_get_top_window", expr);
                        break;
                    case "eval":
                        if (this.opts.wrapEval) return this.wrapCall("wrap_eval", expr);
                        break;
                }
                return expr;
            }
            case "ArrayExpression": {
                if (expr.elements) {
                    for (let i = 0; i < expr.elements.length; i++) {
                        const el = expr.elements[i];
                        if (el) expr.elements[i] = this.rvalue(el);
                    }
                }
                return expr;
            }
            case "ObjectExpression": {
                if (expr.properties) {
                    for (const p of expr.properties) {
                        if (p.type === "Property" && p.value) {
                            p.value = this.rvalue(p.value);
                        } else if (p.type === "SpreadElement" && p.argument) {
                            p.argument = this.rvalue(p.argument);
                        }
                    }
                }
                return expr;
            }
            case "TemplateLiteral": {
                if (expr.expressions) {
                    for (let i = 0; i < expr.expressions.length; i++) {
                        expr.expressions[i] = this.rvalue(expr.expressions[i]!);
                    }
                }
                return expr;
            }
            case "TaggedTemplateExpression": {
                if ((expr as ExpressionNode & { tag?: ExpressionNode }).tag) {
                    (expr as ExpressionNode & { tag: ExpressionNode }).tag =
                        this.rvalue((expr as ExpressionNode & { tag: ExpressionNode }).tag);
                }
                if ((expr as ExpressionNode & { quasi?: ExpressionNode }).quasi) {
                    (expr as ExpressionNode & { quasi: ExpressionNode }).quasi =
                        this.rvalue((expr as ExpressionNode & { quasi: ExpressionNode }).quasi);
                }
                return expr;
            }
            case "SpreadElement": {
                if (expr.argument) expr.argument = this.rvalue(expr.argument);
                return expr;
            }
            case "ArrowFunctionExpression":
            case "FunctionExpression": {
                if (expr.body) {
                    if ((expr.body as Node).type === "BlockStatement") {
                        this.walkBlock(expr.body as BlockStatement);
                    } else {
                        // Concise arrow body: `() => expr`
                        (expr as ExpressionNode & { body: ExpressionNode }).body =
                            this.rvalue(expr.body as ExpressionNode);
                    }
                }
                return expr;
            }
        }
        return expr;
    }

    /**
     * lvalue: rewrites the LHS of an assignment.
     *   - Bare `location` → set_location wrapper
     *   - Member access (obj.X / obj[expr]) → delegate to rvalue (the same
     *     rules apply on lvalue side).
     */
    lvalue(expr: ExpressionNode): ExpressionNode {
        if (expr.type === "Identifier" && expr.name === "location" && this.opts.wrapSetLocation) {
            return this.wrapSetLocation();
        }
        if (expr.type === "MemberExpression") {
            return this.rvalue(expr);
        }
        return expr;
    }

    // ── helpers ──────────────────────────────────────────────────────────

    /** Builds `$rewriter.<helper>(<arg>)`. */
    wrapCall(helper: string, arg: ExpressionNode): ExpressionNode {
        return {
            type: "CallExpression",
            callee: makeMemberDot(makeIdentifier("$rewriter"), helper),
            arguments: [arg],
            optional: false,
        } as unknown as ExpressionNode;
    }

    /** Rewrites `obj.X` to `$rewriter.<helper>({obj: <X>}).X`. */
    wrapDotObj(member: ExpressionNode, helper: string): ExpressionNode {
        const wrapped: ExpressionNode = {
            type: "CallExpression",
            callee: makeMemberDot(makeIdentifier("$rewriter"), helper),
            arguments: [makeObjectExpression([
                makeProperty("obj", member.object!),
            ])],
            optional: false,
        } as unknown as ExpressionNode;
        member.object = wrapped;
        return member;
    }

    /** Rewrites `eval(src, ...)` first arg → `$rewriter.wrap_eval_arg(eval, src)`. */
    wrapEvalArg(arg: ExpressionNode): ExpressionNode {
        return {
            type: "CallExpression",
            callee: makeMemberDot(makeIdentifier("$rewriter"), "wrap_eval_arg"),
            arguments: [makeIdentifier("eval"), arg],
            optional: false,
        } as unknown as ExpressionNode;
    }

    /** Rewrites `obj.eval` → `$rewriter.wrap_eval_memexp(obj).eval`. */
    wrapEvalMemexp(member: ExpressionNode): ExpressionNode {
        const wrapped: ExpressionNode = {
            type: "CallExpression",
            callee: makeMemberDot(makeIdentifier("$rewriter"), "wrap_eval_memexp"),
            arguments: [member.object!],
            optional: false,
        } as unknown as ExpressionNode;
        member.object = wrapped;
        return member;
    }

    /**
     * Rewrites `obj[expr]` to:
     *   $rewriter.wrap_member_expression(obj, ($__crn_key__ = expr))[$__crn_key__]
     *
     * The sequence-style `($__crn_key__ = expr)` keeps the original `expr` evaluating
     * exactly once while letting the bracket access pick up the resolved name.
     */
    wrapMemberExpression(member: ExpressionNode): ExpressionNode {
        const apMeAssign: ExpressionNode = {
            type: "AssignmentExpression",
            operator: "=",
            left: makeIdentifier("$__crn_key__"),
            right: member.property!,
        } as unknown as ExpressionNode;

        const wrapperCall: ExpressionNode = {
            type: "CallExpression",
            callee: makeMemberDot(makeIdentifier("$rewriter"), "wrap_member_expression"),
            arguments: [member.object!, apMeAssign],
            optional: false,
        } as unknown as ExpressionNode;

        return {
            type: "MemberExpression",
            object: wrapperCall,
            property: makeIdentifier("$__crn_key__"),
            computed: true,
            optional: false,
        } as unknown as ExpressionNode;
    }

    /**
     * Builds the LHS of a set-location assignment:
     *   $rewriter.wrap_set_location(location, function(v){location=v;}).value
     */
    wrapSetLocation(): ExpressionNode {
        const setterFn: ExpressionNode = {
            type: "FunctionExpression",
            id: null,
            params: [makeIdentifier("v")],
            body: {
                type: "BlockStatement",
                body: [{
                    type: "ExpressionStatement",
                    expression: {
                        type: "AssignmentExpression",
                        operator: "=",
                        left: makeIdentifier("location"),
                        right: makeIdentifier("v"),
                    },
                }],
            },
            async: false,
            generator: false,
        } as unknown as ExpressionNode;

        const callExpr: ExpressionNode = {
            type: "CallExpression",
            callee: makeMemberDot(makeIdentifier("$rewriter"), "wrap_set_location"),
            arguments: [makeIdentifier("location"), setterFn],
            optional: false,
        } as unknown as ExpressionNode;

        return makeMemberDot(callExpr, "value");
    }
}

// ── ESTree node builders (acorn / astring compatible) ─────────────────────

function isIdentifier(expr: ExpressionNode, name: string): boolean {
    return expr.type === "Identifier" && expr.name === name;
}

function makeIdentifier(name: string): ExpressionNode {
    return { type: "Identifier", name } as unknown as ExpressionNode;
}

function makeMemberDot(object: ExpressionNode, propertyName: string): ExpressionNode {
    return {
        type: "MemberExpression",
        object,
        property: makeIdentifier(propertyName),
        computed: false,
        optional: false,
    } as unknown as ExpressionNode;
}

function makeProperty(keyName: string, value: ExpressionNode): ObjectProperty {
    return {
        type: "Property",
        key: makeIdentifier(keyName),
        value,
        kind: "init",
        method: false,
        shorthand: false,
        computed: false,
    } as unknown as ObjectProperty;
}

function makeObjectExpression(properties: ObjectProperty[]): ExpressionNode {
    return {
        type: "ObjectExpression",
        properties,
    } as unknown as ExpressionNode;
}
