/**
 * Name positions of the DSL (spec §15.9 item 2): which names a string literal
 * takes, found from the property path between the literal and the
 * `workflow({…})` or `X.tasks({…})` call that holds it.
 */

import type { Analysis, WorkflowAnalysis } from "@aflow/dsl";
import type * as TS from "typescript";

type Ts = typeof TS;

/** A string literal that takes task names or item names. */
export interface NamePosition {
  literal: TS.StringLiteral | TS.NoSubstitutionTemplateLiteral;
  names: string[];
}

/** The string literal whose text holds `pos`, or `undefined`. */
function stringLiteralAt(ts: Ts, sf: TS.SourceFile, pos: number) {
  let found: TS.StringLiteral | TS.NoSubstitutionTemplateLiteral | undefined;
  const visit = (n: TS.Node): void => {
    if (pos < n.pos || pos > n.end) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const start = n.getStart(sf);
      const end = contentEnd(sf, n);
      if (start < pos && pos <= end) found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

/** The offset after the last character of the literal's text: before the closing quote, if there is one. */
export function contentEnd(sf: TS.SourceFile, lit: TS.StringLiteral | TS.NoSubstitutionTemplateLiteral): number {
  const start = lit.getStart(sf);
  const quote = sf.text[start];
  const closed = lit.end - start >= 2 && sf.text[lit.end - 1] === quote;
  return closed ? lit.end - 1 : lit.end;
}

function propertyName(ts: Ts, name: TS.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

/**
 * The call whose object-literal argument holds `lit`, and the property path
 * from that argument down to `lit`. The value MAY be the result of an arrow at
 * that path (`route: ({ type }) => type === … ? "a" : "b"`); it may not be an
 * operand, so a comparison string is not a name position.
 */
function pathTo(ts: Ts, lit: TS.Node): { call: TS.CallExpression; path: string[] } | undefined {
  const path: string[] = [];
  let node = lit;
  for (;;) {
    const p = node.parent;
    if (!p) return undefined;
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isSatisfiesExpression(p)) {
      node = p;
    } else if (ts.isConditionalExpression(p) && (p.whenTrue === node || p.whenFalse === node)) {
      node = p;
    } else if (ts.isArrowFunction(p) && p.body === node) {
      node = p;
    } else if (ts.isPropertyAssignment(p) && p.initializer === node) {
      const name = propertyName(ts, p.name);
      if (name === undefined) return undefined;
      path.unshift(name);
      node = p.parent;
    } else if (ts.isCallExpression(p) && p.arguments[0] === node && ts.isObjectLiteralExpression(node)) {
      return { call: p, path };
    } else {
      return undefined;
    }
  }
}

/** True for `[]`, `["cases", <state>]` and `["default"]`: the targets inside one route value (§13). */
const routeTail = (rest: string[]) =>
  rest.length === 0 || (rest.length === 2 && rest[0] === "cases") || (rest.length === 1 && rest[0] === "default");

/** The kind of name a node-relative path takes (§15.9 item 2). */
function nodePathKind(rest: string[]): "task" | "item" | undefined {
  if (rest[0] === "route" && routeTail(rest.slice(1))) return "task";
  if ((rest[0] === "split" || rest[0] === "dispatch") && rest[1] === "route" && routeTail(rest.slice(2))) return "task";
  if (rest.length === 1 && rest[0] === "item") return "item";
  if (rest.length === 2 && rest[0] === "split" && rest[1] === "item_type") return "item";
  return undefined;
}

/** The kind of name a header-relative path takes (§15.9 item 2). */
function headerPathKind(path: string[]): "task" | "item" | undefined {
  if (path.length === 3 && path[0] === "items" && path[2] === "parent") return "item";
  if (path.join(".") === "config.defaults.entry") return "task";
  if (path.slice(0, 4).join(".") === "config.defaults.task.route" && routeTail(path.slice(4))) return "task";
  return undefined;
}

/** The header `{ file, symbol }` that `X` in `X.tasks(…)` resolves to. */
function groupHeader(ts: Ts, checker: TS.TypeChecker, call: TS.CallExpression) {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "tasks") return undefined;
  let sym = checker.getSymbolAtLocation(callee.expression);
  if (sym && sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
  const decl = sym?.valueDeclaration;
  if (!decl || !ts.isVariableDeclaration(decl) || !ts.isIdentifier(decl.name)) return undefined;
  return { file: decl.getSourceFile().fileName, symbol: decl.name.text };
}

/** The header `{ file, symbol }` declared by `const X = workflow(…)`. */
function headerDeclaredBy(ts: Ts, call: TS.CallExpression) {
  const decl = call.parent;
  if (!ts.isVariableDeclaration(decl) || decl.initializer !== call || !ts.isIdentifier(decl.name)) return undefined;
  return { file: call.getSourceFile().fileName, symbol: decl.name.text };
}

const unique = (names: Iterable<string>) => [...new Set(names)];

function namesOf(kind: "task" | "item", workflows: WorkflowAnalysis[]): string[] {
  if (kind === "task") return unique(workflows.flatMap((w) => w.taskNames));
  return unique(workflows.flatMap((w) => Object.keys(w.header.items ?? {})));
}

/**
 * The names the string literal at `pos` takes: every task of the workflow
 * (from all its groups and files) at a route target, the declared item types
 * at `item`, `split.item_type` and `items.*.parent`. `undefined` elsewhere.
 */
export function namePositionAt(
  ts: Ts,
  program: TS.Program,
  analysis: Analysis,
  sf: TS.SourceFile,
  pos: number,
): NamePosition | undefined {
  const literal = stringLiteralAt(ts, sf, pos);
  if (!literal) return undefined;
  const at = pathTo(ts, literal);
  if (!at) return undefined;
  const group = groupHeader(ts, program.getTypeChecker(), at.call);
  const header = group ?? headerDeclaredBy(ts, at.call);
  if (!header) return undefined;
  const kind = group ? (at.path.length > 1 ? nodePathKind(at.path.slice(1)) : undefined) : headerPathKind(at.path);
  if (!kind) return undefined;
  const workflows = analysis.workflows.filter((w) => w.headerFile === header.file && w.headerSymbol === header.symbol);
  if (workflows.length === 0) return undefined;
  return { literal, names: namesOf(kind, workflows) };
}
