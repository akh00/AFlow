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

import { type Position, SCOPE_AT } from "../surface/scope.js";
import { type AflowDiagnostic, diagnosticAt } from "./diagnostics.js";

type Ts = typeof TS;

const SAFE = new Set(SAFE_GLOBAL_NAMES);

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
 * exempt from `param-shape`, `async` and `forbidden-global`, and may use
 * any host global (R20). It is not exempt from `outside-reference`.
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
    const childThis = ownThis || bindsThis(ts, node);
    ts.forEachChild(node, (c) => visit(c, childThis));
  };
  ts.forEachChild(arrow, (c) => visit(c, false));
  return out;
}
