/**
 * Expression emission (spec §15.8).
 *
 * The text comes from the TypeScript source, never from a compiled function.
 * Types are erased by deleting the source spans of TypeScript-only syntax
 * (Ruling R19). All other text stays byte for byte: spacing, parentheses,
 * comments and line breaks. Syntax that deletion cannot erase (`enum`,
 * `namespace`, parameter properties, decorators) is `not-static`.
 */

import type * as TS from "typescript";

import { type AflowDiagnostic, diagnosticAt } from "./diagnostics.js";

type Ts = typeof TS;

const WRAP_DO = "function __aflow_do() ";

/** The modifiers that exist only in TypeScript. */
function tsModifiers(ts: Ts): Set<TS.SyntaxKind> {
  return new Set([
    ts.SyntaxKind.PublicKeyword,
    ts.SyntaxKind.PrivateKeyword,
    ts.SyntaxKind.ProtectedKeyword,
    ts.SyntaxKind.ReadonlyKeyword,
    ts.SyntaxKind.AbstractKeyword,
    ts.SyntaxKind.OverrideKeyword,
    ts.SyntaxKind.DeclareKeyword,
  ]);
}

/** The token child of `node` with kind `kind`, if there is one. */
function childToken(node: TS.Node, kind: TS.SyntaxKind, sf: TS.SourceFile): TS.Node | undefined {
  return node.getChildren(sf).find((c) => c.kind === kind);
}

/** The [start, end) span from the `<` to the `>` around a type parameter or type argument list. */
function angleSpan(ts: Ts, node: TS.Node, sf: TS.SourceFile): [number, number] | undefined {
  const lt = childToken(node, ts.SyntaxKind.LessThanToken, sf);
  const gt = childToken(node, ts.SyntaxKind.GreaterThanToken, sf);
  return lt && gt ? [lt.getStart(sf), gt.getEnd()] : undefined;
}

/**
 * The span of a `: T` annotation on `node`: from the end of the child before
 * the colon to the end of the type. The space before the colon goes with it.
 */
function annotationSpan(ts: Ts, node: TS.Node, type: TS.TypeNode, sf: TS.SourceFile): [number, number] {
  const children = node.getChildren(sf);
  const colon = children.findIndex((c) => c.kind === ts.SyntaxKind.ColonToken && c.getEnd() <= type.getStart(sf));
  const before = colon > 0 ? children[colon - 1]! : undefined;
  return [before ? before.getEnd() : children[colon]!.getStart(sf), type.getEnd()];
}

/** The span of a modifier token and the spaces after it. */
function modifierSpan(m: TS.Node, sf: TS.SourceFile): [number, number] {
  let end = m.getEnd();
  while (end < sf.text.length && (sf.text[end] === " " || sf.text[end] === "\t")) end++;
  return [m.getStart(sf), end];
}

/** Collects the spans of TypeScript-only syntax under `root`, and reports what deletion cannot erase. */
function typeSpans(ts: Ts, root: TS.Node, diagnostics: AflowDiagnostic[]): [number, number][] {
  const sf = root.getSourceFile();
  const spans: [number, number][] = [];
  const modifiers = tsModifiers(ts);
  const reject = (node: TS.Node, what: string): void => {
    diagnostics.push(
      diagnosticAt(
        node,
        "not-static",
        `${what} is not allowed in expressions. Type erasure cannot remove its runtime behaviour (§15.8).`,
      ),
    );
  };
  const whole = (node: TS.Node): void => {
    spans.push([node.getStart(sf), node.getEnd()]);
  };

  const visit = (node: TS.Node): void => {
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    if (ts.isEnumDeclaration(node)) return reject(node, "An `enum`");
    if (ts.isModuleDeclaration(node)) return reject(node, "A `namespace`");
    if (ts.isDecorator(node)) return reject(node, "A decorator");
    if (ts.isParameter(node) && ts.isConstructorDeclaration(node.parent) && node.modifiers?.length) {
      return reject(node, "A parameter property");
    }
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return whole(node);
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && !node.body) return whole(node);
    if (ts.canHaveModifiers(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      return whole(node);
    }
    if (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword) return whole(node);

    if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === "this") {
      // `this: T` exists only in TypeScript. Delete it with the comma after it, if there is one.
      const params = (node.parent as TS.SignatureDeclaration).parameters;
      const next = params[params.indexOf(node) + 1];
      spans.push([node.getStart(sf), next ? next.getStart(sf) : node.getEnd()]);
      return;
    }

    if (ts.canHaveModifiers(node)) {
      for (const m of node.modifiers ?? []) if (modifiers.has(m.kind)) spans.push(modifierSpan(m, sf));
    }
    if (ts.isParameter(node) || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) {
      // The optional `?` and the definite-assignment `!` exist only in TypeScript.
      const question = "questionToken" in node ? node.questionToken : undefined;
      const exclamation = "exclamationToken" in node ? node.exclamationToken : undefined;
      for (const mark of [question, exclamation]) if (mark) spans.push([mark.getStart(sf), mark.getEnd()]);
      if (node.type) spans.push(annotationSpan(ts, node, node.type, sf));
    }
    if (ts.isFunctionLike(node)) {
      if (node.typeParameters) {
        const s = angleSpan(ts, node, sf);
        if (s) spans.push(s);
      }
      if (node.type) spans.push(annotationSpan(ts, node, node.type, sf));
    }
    if (ts.isClassLike(node) && node.typeParameters) {
      const s = angleSpan(ts, node, sf);
      if (s) spans.push(s);
    }
    if (
      (ts.isCallExpression(node) ||
        ts.isNewExpression(node) ||
        ts.isTaggedTemplateExpression(node) ||
        ts.isExpressionWithTypeArguments(node)) &&
      node.typeArguments
    ) {
      const s = angleSpan(ts, node, sf);
      if (s) spans.push(s);
    }
    if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node)) {
      spans.push([node.expression.getEnd(), node.getEnd()]);
    }
    if (ts.isTypeAssertionExpression(node)) spans.push([node.getStart(sf), node.expression.getStart(sf)]);
    // `forEachChild` stops at a truthy return, so `visit` returns nothing.
    ts.forEachChild(node, (n) => void visit(n));
  };
  visit(root);
  return spans;
}

/** The source text of `node` with every TypeScript-only span deleted. */
function erase(ts: Ts, node: TS.Node, diagnostics: AflowDiagnostic[]): string {
  const sf = node.getSourceFile();
  const start = node.getStart(sf);
  const spans = typeSpans(ts, node, diagnostics).sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = start;
  for (const [s, e] of spans) {
    if (s > at) out += sf.text.slice(at, s);
    at = Math.max(at, e);
  }
  return out + sf.text.slice(at, node.getEnd());
}

/** The [start, end) offsets of every template literal under `node`. */
function templateSpans(ts: Ts, node: TS.Node, sf: TS.SourceFile): [number, number][] {
  const spans: [number, number][] = [];
  const visit = (n: TS.Node): void => {
    if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      spans.push([n.getStart(sf), n.getEnd()]);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return spans;
}

/** The statements of an erased block, without the braces and the common indentation. */
function blockStatements(ts: Ts, erasedBlock: string): string {
  // Parse the erased text (no printing) to find the template literals.
  const sf = ts.createSourceFile("aflow-do.js", `${WRAP_DO}${erasedBlock}`, ts.ScriptTarget.ESNext, true);
  const body = sf.statements.find(ts.isFunctionDeclaration)!.body!;
  const open = body.getStart(sf) + 1;
  const close = body.getEnd() - 1;
  return dedent(sf.text.slice(open, close), open, templateSpans(ts, body, sf));
}

/**
 * Removes the blank lines at both ends and the common indentation. Template
 * literal text is content: a line that starts inside a template is not
 * measured and not cut, and a line that ends inside a template keeps its
 * trailing spaces. `offset` is the position of `text` in the file the spans
 * refer to.
 */
function dedent(text: string, offset: number, templates: [number, number][]): string {
  const inside = (pos: number) => templates.some(([s, e]) => pos > s && pos < e);
  const lines: { text: string; startsInside: boolean; endsInside: boolean }[] = [];
  let at = offset;
  for (const line of text.split("\n")) {
    lines.push({ text: line, startsInside: inside(at), endsInside: inside(at + line.length) });
    at += line.length + 1;
  }
  const blank = (l: (typeof lines)[number]) => !l.startsInside && !l.endsInside && l.text.trim() === "";
  while (lines.length && blank(lines[0]!)) lines.shift();
  while (lines.length && blank(lines[lines.length - 1]!)) lines.pop();
  const indents = lines
    .filter((l) => !l.startsInside && l.text.trim() !== "")
    .map((l) => /^[ \t]*/.exec(l.text)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines
    .map((l) => {
      const t = l.startsInside ? l.text : l.text.slice(cut);
      return l.endsInside ? t : t.trimEnd();
    })
    .join("\n")
    .trim();
}

/**
 * Emits a DSL arrow as a §13 expression: an expression body as `{ $expr }`,
 * a block body as `{ $do }` (§15.8). Syntax that type erasure cannot remove
 * is reported into `diagnostics`.
 */
export function emitArrow(
  ts: Ts,
  arrow: TS.ArrowFunction,
  diagnostics: AflowDiagnostic[] = [],
): { $expr: string } | { $do: string } {
  const text = erase(ts, arrow.body, diagnostics);
  return ts.isBlock(arrow.body) ? { $do: blockStatements(ts, text) } : { $expr: text };
}

/**
 * The statement text of an arrow, for positions the engine runs only as `$do`
 * (`default_error_handler`, §15.8): a block body without its braces, or the
 * expression body as is.
 */
export function emitStatements(ts: Ts, arrow: TS.ArrowFunction, diagnostics: AflowDiagnostic[] = []): string {
  const e = emitArrow(ts, arrow, diagnostics);
  return "$do" in e ? e.$do : e.$expr;
}

/** Emits `call.script` as the full type-erased arrow text, parameters included (§15.6, §15.8). */
export function emitScript(ts: Ts, arrow: TS.ArrowFunction, diagnostics: AflowDiagnostic[] = []): string {
  return erase(ts, arrow, diagnostics);
}
