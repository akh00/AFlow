/**
 * The expression boundary (spec §5, §15.4, §15.6).
 *
 * A DSL arrow is shipped as source and evaluated where the module around it
 * does not exist. Its only way in is its parameter. This check finds every
 * name that would type-check in the editor but fail in the engine.
 *
 * The safe and forbidden names come from the engine (§15.4: "from the
 * engine, not from a copy"). The scope per position comes from `SCOPE_AT`.
 */

import { FORBIDDEN_REASONS, SAFE_GLOBAL_NAMES } from "@aflow/engine";
import type * as TS from "typescript";

import { type Position, SCOPE_AT, STATEMENT_POSITIONS } from "../surface/scope.js";
import { type AflowDiagnostic, diagnosticAt } from "./diagnostics.js";

type Ts = typeof TS;

const SAFE = new Set(SAFE_GLOBAL_NAMES);

/**
 * The scope names that the engine copies back to the item after a statement
 * position runs (engine `writeBack`). The engine drops an assignment to any
 * other scope name (§15.4).
 */
const COPIED_BACK: ReadonlySet<string> = new Set(["data", "target_state", "next_task"]);

const STATEMENT: ReadonlySet<string> = new Set(STATEMENT_POSITIONS);

/**
 * The one safe-global member the engine refuses (`SAFE_MATH.random` throws).
 * The engine does not export a reason for it, so the reason is stated here.
 */
const MATH_RANDOM_REASON = "the RNG";

/** True if `d` is inside a `declare global { … }` block. */
function inGlobalAugmentation(ts: Ts, d: TS.Node): boolean {
  for (let n: TS.Node | undefined = d.parent; n; n = n.parent) {
    if (ts.isModuleDeclaration(n) && n.flags & ts.NodeFlags.GlobalAugmentation) return true;
  }
  return false;
}

/**
 * True if `symbol` is a host global: its value is declared ambiently, in a
 * `.d.ts` file (the default lib, `@types/node`) or in `declare global`.
 * The value side decides, so an augmentation of a lib interface (`interface
 * Array<T>` in `@types/node` or in user code) does not change the answer.
 * An unresolved name and a checker intrinsic (`undefined`) count as host globals.
 */
function isAmbientGlobal(ts: Ts, symbol: TS.Symbol | undefined): boolean {
  if (!symbol) return true;
  const decls = symbol.valueDeclaration ? [symbol.valueDeclaration] : (symbol.declarations ?? []);
  return decls.every((d) => d.getSourceFile().isDeclarationFile || inGlobalAugmentation(ts, d));
}

/** `file:line` of a declaration, for the message. */
function whereDeclared(d: TS.Declaration): string {
  const sf = d.getSourceFile();
  return `${sf.fileName}:${sf.getLineAndCharacterOfPosition(d.getStart(sf)).line + 1}`;
}

/** True if `id` is a name that does not reference a binding: a member name, a key, a label. */
function isNonReference(ts: Ts, id: TS.Identifier): boolean {
  const p = id.parent;
  return (
    (ts.isPropertyAccessExpression(p) && p.name === id) ||
    (ts.isQualifiedName(p) && p.right === id) ||
    (ts.isPropertyAssignment(p) && p.name === id) ||
    (ts.isBindingElement(p) && p.propertyName === id) ||
    (ts.isMetaProperty(p) && p.name === id) ||
    ((ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) && p.label === id) ||
    (ts.isMethodDeclaration(p) && p.name === id) ||
    (ts.isPropertyDeclaration(p) && p.name === id)
  );
}

/**
 * True if `id` is the target of an assignment, an increment or a decrement.
 * This includes a target inside a destructuring assignment and the variable
 * of a `for … in` or `for … of` loop.
 */
function isAssignmentTarget(ts: Ts, id: TS.Identifier): boolean {
  let n: TS.Node = id;
  for (;;) {
    const p = n.parent;
    if (
      ts.isParenthesizedExpression(p) ||
      ts.isNonNullExpression(p) ||
      ts.isAsExpression(p) ||
      ts.isTypeAssertionExpression(p) ||
      ts.isSatisfiesExpression(p) ||
      ts.isArrayLiteralExpression(p) ||
      ts.isSpreadElement(p) ||
      ts.isSpreadAssignment(p) ||
      (ts.isShorthandPropertyAssignment(p) && p.name === n) ||
      (ts.isPropertyAssignment(p) && p.initializer === n)
    ) {
      n = ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p) || ts.isSpreadAssignment(p) ? p.parent : p;
      continue;
    }
    if (ts.isBinaryExpression(p)) {
      const op = p.operatorToken.kind;
      return p.left === n && op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment;
    }
    if (ts.isPrefixUnaryExpression(p) || ts.isPostfixUnaryExpression(p)) {
      return p.operator === ts.SyntaxKind.PlusPlusToken || p.operator === ts.SyntaxKind.MinusMinusToken;
    }
    if (ts.isForInStatement(p) || ts.isForOfStatement(p)) return p.initializer === n;
    return false;
  }
}

/** True if `node` is a function-like that binds its own `this`. */
function bindsThis(ts: Ts, node: TS.Node): boolean {
  return (
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isClassLike(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/**
 * The `param-shape` diagnostics of a pure arrow: one object pattern of
 * shorthand names valid at `position` (§15.4). `({})` is valid (Ruling R6).
 */
function checkParams(ts: Ts, arrow: TS.ArrowFunction, position: Position): AflowDiagnostic[] {
  const scope: readonly string[] = SCOPE_AT[position];
  const shape = (node: TS.Node, what: string) =>
    diagnosticAt(
      node,
      "param-shape",
      `${what}. Write one object pattern of shorthand scope names, e.g. \`({ data }) => …\` (§15.4).`,
    );
  const params = arrow.parameters;
  if (params.length !== 1) {
    const at = params.length > 1 ? params[1]! : arrow;
    return [shape(at, params.length ? "The arrow takes more than one parameter" : "The arrow takes no parameter; write `({}) => …`")];
  }
  const param = params[0]!;
  if (!ts.isObjectBindingPattern(param.name)) {
    return [shape(param, `\`${param.name.getText()}\` is not an object pattern`)];
  }
  const out: AflowDiagnostic[] = [];
  if (param.dotDotDotToken || param.initializer || param.questionToken) {
    out.push(shape(param, "The parameter has a rest, default or optional marker"));
  }
  for (const el of param.name.elements) {
    if (el.dotDotDotToken) out.push(shape(el, `\`${el.getText()}\` is a rest element`));
    else if (el.propertyName) out.push(shape(el, `\`${el.getText()}\` renames a scope name`));
    else if (!ts.isIdentifier(el.name)) out.push(shape(el, `\`${el.getText()}\` is a nested pattern`));
    else if (el.initializer) out.push(shape(el, `\`${el.getText()}\` has a default value`));
    else if (!scope.includes(el.name.text)) {
      out.push(shape(el, `\`${el.name.text}\` is not in scope at \`${position}\`; the scope is ${scope.join(", ")}`));
    }
  }
  return out;
}

/**
 * Checks one DSL arrow against the expression boundary.
 *
 * `kind` is `"pure"` for a §15.5 position, with `position` set. It is
 * `"effect"` for `call.script` (§15.6), with `position` `null`: effect code is
 * exempt from `param-shape`, `async`, `forbidden-global` and `scope-rebind`,
 * and may use any host global (R20). It is not exempt from `outside-reference`.
 * In pure code, `this` is an error everywhere, also in a nested function or
 * class: the engine evaluates the code in sloppy mode, so there `this` is
 * `globalThis`. In effect code, a nested function or class binds its own `this`.
 */
export function checkBoundary(
  ts: Ts,
  checker: TS.TypeChecker,
  arrow: TS.ArrowFunction,
  position: Position | null,
  kind: "pure" | "effect",
): AflowDiagnostic[] {
  const out: AflowDiagnostic[] = [];
  const sf = arrow.getSourceFile();
  const [lo, hi] = [arrow.getStart(sf), arrow.getEnd()];
  const inside = (d: TS.Declaration) => d.getSourceFile() === sf && d.getStart(sf) >= lo && d.getEnd() <= hi;

  if (kind === "pure" && position) out.push(...checkParams(ts, arrow, position));

  // The names that the parameter pattern binds (§15.4).
  const params = new Set<TS.Node>(
    arrow.parameters.flatMap((p) => (ts.isObjectBindingPattern(p.name) ? [...p.name.elements] : [])),
  );
  const checkRebind = (id: TS.Identifier, symbol: TS.Symbol | undefined): void => {
    if (kind !== "pure" || !position || !symbol?.declarations?.some((d) => params.has(d))) return;
    if (!isAssignmentTarget(ts, id)) return;
    const name = id.text;
    if (COPIED_BACK.has(name) && STATEMENT.has(position)) return;
    const why = COPIED_BACK.has(name)
      ? `\`${position}\` is a value position. The engine copies \`${name}\` back to the item only at a statement position`
      : `The engine copies back only \`data\`, \`target_state\` and \`next_task\`. Assign to a member instead, e.g. \`${name}.x = …\``;
    out.push(diagnosticAt(id, "scope-rebind", `The assignment to the scope name \`${name}\` has no effect. ${why} (§15.4).`));
  };
  if (kind === "pure" && arrow.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
    out.push(diagnosticAt(arrow, "async", "A pure expression MUST NOT be `async`. All I/O belongs in a `call` body (§5, §15.4)."));
  }

  const checkName = (id: TS.Identifier, symbol: TS.Symbol | undefined): void => {
    const name = id.text;
    const decls = symbol?.declarations ?? [];
    if (decls.some(inside)) return;
    const ambient = isAmbientGlobal(ts, symbol);
    // R20: effect code runs with the host globals; only user declarations are out of reach.
    if (ambient && (kind === "effect" || SAFE.has(name))) return;
    const reason = FORBIDDEN_REASONS.get(name);
    if (reason !== undefined && ambient) {
      out.push(diagnosticAt(id, "forbidden-global", `\`${name}\` is forbidden in an expression: ${reason} (§5).`));
      return;
    }
    const where = !symbol
      ? "not declared anywhere"
      : ambient
      ? "a host global, not an engine safe global"
      : `${symbol!.flags & ts.SymbolFlags.Alias ? "imported" : "declared"} outside the expression, at ${whereDeclared(decls[0]!)}`;
    out.push(
      diagnosticAt(
        id,
        "outside-reference",
        `\`${name}\` is ${where}. The body is shipped as source; only its parameter, its locals and the engine's safe globals exist there (§15.4).`,
      ),
    );
  };

  const isMathRandom = (n: TS.Node): TS.Expression | undefined => {
    let obj: TS.Expression | undefined;
    if (ts.isPropertyAccessExpression(n) && n.name.text === "random") obj = n.expression;
    else if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression) && n.argumentExpression.text === "random") {
      obj = n.expression;
    }
    if (!obj || !ts.isIdentifier(obj) || obj.text !== "Math") return undefined;
    return isAmbientGlobal(ts, checker.getSymbolAtLocation(obj)) ? (n as TS.Expression) : undefined;
  };

  const visit = (node: TS.Node, ownThis: boolean): void => {
    // Types are erased (§15.8): names in them never reach the engine.
    if (ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node)) return;
    if (ts.isIdentifier(node)) {
      if (isNonReference(ts, node)) return;
      const p = node.parent;
      const symbol = ts.isShorthandPropertyAssignment(p) && p.name === node
        ? checker.getShorthandAssignmentValueSymbol(p)
        : checker.getSymbolAtLocation(node);
      checkRebind(node, symbol);
      checkName(node, symbol);
      return;
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword && !ownThis) {
      out.push(diagnosticAt(node, "this", "`this` is not available in an expression. Use `self`, the item view (§15.4)."));
    }
    if (kind === "pure") {
      if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
        out.push(diagnosticAt(node, "async", "`await` is not available in a pure expression. All I/O belongs in a `call` body (§5, §15.4)."));
      } else if (node !== arrow && ts.isFunctionLike(node) && ts.getCombinedModifierFlags(node as TS.Declaration) & ts.ModifierFlags.Async) {
        out.push(diagnosticAt(node, "async", "An `async` function is not available in a pure expression (§5, §15.4)."));
      }
    }
    const random = kind === "pure" ? isMathRandom(node) : undefined;
    if (random) {
      out.push(diagnosticAt(random, "forbidden-global", `\`Math.random\` is forbidden in an expression: ${MATH_RANDOM_REASON} (§5).`));
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      out.push(diagnosticAt(node, "dynamic-import", "`import()` is not available in shipped code. Load modules nowhere in an expression (§15.4)."));
    } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      out.push(diagnosticAt(node, "dynamic-import", "`import.meta` is not available in shipped code (§15.4)."));
    }
    const childThis = kind === "effect" && (ownThis || bindsThis(ts, node));
    ts.forEachChild(node, (c) => visit(c, childThis));
  };
  ts.forEachChild(arrow, (c) => visit(c, false));
  return out;
}
