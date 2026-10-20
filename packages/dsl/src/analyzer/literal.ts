/**
 * Static literal evaluation (spec §15.1).
 *
 * Every non-expression value in a DSL file MUST be a literal: a string,
 * number, boolean or `null`; a unary minus on a number; an object or array
 * literal; a template literal without substitutions. Each MAY be wrapped in
 * `as const`, `satisfies` or parentheses. Anything else is `not-static`.
 */

import type * as TS from "typescript";

import { type AflowDiagnostic, diagnosticAt } from "./diagnostics.js";

type Ts = typeof TS;

/** Object keys and array indices from the literal root to a value. */
export type LiteralPath = readonly (string | number)[];

/**
 * Called for an arrow function at `path`. Returns the value to emit, or `null`
 * when an arrow is not legal at `path` (the walk then reports `not-static`).
 */
export type ArrowHandler = (arrow: TS.ArrowFunction, path: LiteralPath) => { value: unknown } | null;

/** The state of one literal walk: collected diagnostics and the arrow handler. */
export interface LiteralWalk {
  diagnostics: AflowDiagnostic[];
  onArrow?: ArrowHandler;
}

const MAX_SNIPPET = 40;

/** The source text of `node` on one line, shortened for a message. */
export function snippet(node: TS.Node): string {
  const text = node.getText().replace(/\s+/g, " ");
  return text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET - 1)}…` : text;
}

function notStatic(node: TS.Node, what = "not a literal"): AflowDiagnostic {
  return diagnosticAt(
    node,
    "not-static",
    `\`${snippet(node)}\` is ${what}. Use a literal value: a string, number, boolean, null, object or array (§15.1).`,
  );
}

/** Removes parentheses, `as const` and `satisfies` around a literal. */
export function unwrapLiteral(ts: Ts, node: TS.Expression): TS.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
    else if (ts.isAsExpression(node) && isConstType(ts, node.type)) node = node.expression;
    else return node;
  }
}

function isConstType(ts: Ts, type: TS.TypeNode): boolean {
  return ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === "const";
}

/** The static text of a property name, or `undefined` when it is computed from a non-literal. */
export function propertyNameText(ts: Ts, name: TS.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const e = unwrapLiteral(ts, name.expression);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)) return e.text;
  }
  return undefined;
}

/**
 * Reads the literal at `node`, pushing a diagnostic for every part that is not
 * static. A part that fails reads as `undefined`, so one walk reports every
 * problem in the literal.
 */
export function readLiteral(ts: Ts, node: TS.Expression, walk: LiteralWalk, path: LiteralPath = []): unknown {
  const fail = (at: TS.Node, what?: string) => {
    walk.diagnostics.push(notStatic(at, what));
    return undefined;
  };
  const e = unwrapLiteral(ts, node);
  switch (e.kind) {
    case ts.SyntaxKind.StringLiteral:
    case ts.SyntaxKind.NoSubstitutionTemplateLiteral:
      return (e as TS.StringLiteral).text;
    case ts.SyntaxKind.NumericLiteral:
      return Number((e as TS.NumericLiteral).text);
    case ts.SyntaxKind.TrueKeyword:
      return true;
    case ts.SyntaxKind.FalseKeyword:
      return false;
    case ts.SyntaxKind.NullKeyword:
      return null;
  }
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
    const operand = unwrapLiteral(ts, e.operand);
    return ts.isNumericLiteral(operand) ? -Number(operand.text) : fail(e);
  }
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.map((el, i) =>
      ts.isSpreadElement(el) || ts.isOmittedExpression(el)
        ? fail(el, ts.isSpreadElement(el) ? "a spread" : "an array hole")
        : readLiteral(ts, el, walk, [...path, i]),
    );
  }
  if (ts.isObjectLiteralExpression(e)) {
    const out: Record<string, unknown> = {};
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p)) {
        fail(p, ts.isSpreadAssignment(p) ? "a spread" : "not a literal property");
        continue;
      }
      const key = propertyNameText(ts, p.name);
      if (key === undefined) {
        fail(p.name, "a computed name");
        continue;
      }
      // defineProperty: a `"__proto__"` key stays a plain key.
      Object.defineProperty(out, key, {
        value: readLiteral(ts, p.initializer, walk, [...path, key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  if (ts.isArrowFunction(e)) {
    const handled = walk.onArrow?.(e, path);
    if (handled) return handled.value;
    walk.diagnostics.push(
      diagnosticAt(
        e,
        "not-static",
        `An arrow function is not allowed at \`${path.join(".")}\`. Use arrow functions only at the expression positions of §15.5 and at \`call.script\` (§15.6).`,
      ),
    );
    return undefined;
  }
  return fail(e);
}

/** Evaluates a literal (§15.1). Arrow functions are not literals here. */
export function evaluateLiteral(
  ts: Ts,
  node: TS.Expression,
): { value: unknown } | { diagnostic: AflowDiagnostic } {
  const walk: LiteralWalk = { diagnostics: [] };
  const value = readLiteral(ts, node, walk);
  return walk.diagnostics.length ? { diagnostic: walk.diagnostics[0]! } : { value };
}
