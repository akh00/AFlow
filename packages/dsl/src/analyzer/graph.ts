/**
 * Whole-workflow graph checks (spec §15.3, §15.9 item 3; design §5).
 *
 * These are the checks that TypeScript types cannot express: route targets
 * that name no task, item types across routes, reachability, duplicate task
 * names and more than one body kind. Each diagnostic is reported at the
 * offending literal or task name, so it is in the file that declares it.
 */

import { BODY_KINDS, type Node, type Route } from "@aflow/engine";
import type * as TS from "typescript";

import { type AflowDiagnostic, diagnosticAt } from "./diagnostics.js";
import type { WorkflowAnalysis } from "./index.js";
import { propertyNameText, unwrapLiteral } from "./literal.js";

type Ts = typeof TS;

/** The source nodes of one workflow, in `definition.tasks` order. Internal to the analyzer. */
export interface GraphSources {
  /** The header object literal; absent when the header argument is not one. */
  header: TS.ObjectLiteralExpression | undefined;
  tasks: { name: TS.PropertyName; literal: TS.ObjectLiteralExpression }[];
}

/** A task name that a route can send an item to, and the node that names it. */
interface Target {
  name: string;
  at: TS.Node;
}

/** The targets of one route. */
interface RouteTargets {
  /** The members of an expression route all point at its arrow. */
  targets: Target[];
  /** False when an expression route's return type is not a union of string literals. */
  known: boolean;
}

const BODY_KIND_SET: ReadonlySet<string> = new Set(BODY_KINDS);

/** The value at `path` inside the object literal `root`, through `as const` / `satisfies` / parentheses. */
function literalAt(ts: Ts, root: TS.Expression | undefined, path: readonly string[]): TS.Expression | undefined {
  let node = root;
  for (const key of path) {
    const lit = node && unwrapLiteral(ts, node);
    if (!lit || !ts.isObjectLiteralExpression(lit)) return undefined;
    // The last property of a name wins, as in the extracted value.
    const props = lit.properties.filter(
      (p): p is TS.PropertyAssignment => ts.isPropertyAssignment(p) && propertyNameText(ts, p.name) === key,
    );
    node = props.at(-1)?.initializer;
  }
  return node && unwrapLiteral(ts, node);
}

/**
 * The targets of `route`. `node` is the route's literal; `fallback` is the
 * location when a part of it is not found; `arrow` is the arrow of an
 * expression route.
 */
function routeTargets(
  ts: Ts,
  checker: TS.TypeChecker,
  route: Route | undefined,
  node: TS.Expression | undefined,
  fallback: TS.Node,
  arrow: TS.ArrowFunction | undefined,
): RouteTargets {
  if (route === undefined || route === null) return { targets: [], known: true };
  if (typeof route === "string") return { targets: [{ name: route, at: node ?? fallback }], known: true };
  if ("cases" in route) {
    const targets: Target[] = [];
    for (const [key, value] of Object.entries(route.cases ?? {})) {
      if (typeof value === "string") targets.push({ name: value, at: literalAt(ts, node, ["cases", key]) ?? fallback });
    }
    if (typeof route.default === "string") {
      targets.push({ name: route.default, at: literalAt(ts, node, ["default"]) ?? fallback });
    }
    return { targets, known: true };
  }
  // An expression route: its targets are the members of a string-literal union return type.
  if (!arrow) return { targets: [], known: false };
  const signature = checker.getSignatureFromDeclaration(arrow);
  if (!signature) return { targets: [], known: false };
  const returned = checker.getReturnTypeOfSignature(signature);
  const members = returned.isUnion() ? returned.types : [returned];
  const targets: Target[] = [];
  for (const t of members) {
    if (t.isStringLiteral()) targets.push({ name: t.value, at: arrow });
    else if (!(t.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never))) {
      return { targets: [], known: false };
    }
  }
  return { targets, known: true };
}

/** The string literals an expression can yield: through `?:`, `??`, `||`, parentheses and `as`. */
function literalResults(ts: Ts, expr: TS.Expression, out: TS.StringLiteralLike[] = []): TS.StringLiteralLike[] {
  const e = unwrapLiteral(ts, expr);
  if (ts.isStringLiteralLike(e)) out.push(e);
  else if (ts.isAsExpression(e)) literalResults(ts, e.expression, out);
  else if (ts.isConditionalExpression(e)) {
    literalResults(ts, e.whenTrue, out);
    literalResults(ts, e.whenFalse, out);
  } else if (
    ts.isBinaryExpression(e) &&
    (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    literalResults(ts, e.left, out);
    literalResults(ts, e.right, out);
  }
  return out;
}

/** The string literals an arrow returns: its expression body, or the `return`s of its block body. */
function returnedLiterals(ts: Ts, arrow: TS.ArrowFunction): TS.StringLiteralLike[] {
  if (!ts.isBlock(arrow.body)) return literalResults(ts, arrow.body);
  const out: TS.StringLiteralLike[] = [];
  const visit = (n: TS.Node): void => {
    if (ts.isFunctionLike(n)) return;
    if (ts.isReturnStatement(n) && n.expression) literalResults(ts, n.expression, out);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(arrow.body, visit);
  return out;
}

const quoted = (names: readonly string[]) => names.map((n) => `\`${n}\``).join(", ");

/**
 * The graph diagnostics of `wf`. `arrows` is the arrow node of each expression
 * pointer (Ruling R2); the return types of route expressions come from `checker`.
 */
export function checkGraph(
  ts: Ts,
  checker: TS.TypeChecker,
  wf: WorkflowAnalysis,
  arrows: ReadonlyMap<string, TS.ArrowFunction>,
  sources: GraphSources,
): AflowDiagnostic[] {
  const out: AflowDiagnostic[] = [];
  const { definition } = wf;
  const tasks = definition.tasks;
  const items = definition.items ?? {};
  const defaults = definition.config?.defaults;
  const header = sources.header;

  /** Task name → index of its first declaration. */
  const first = new Map<string, number>();
  tasks.forEach((t, i) => {
    if (!first.has(t.name)) first.set(t.name, i);
  });
  const taskOf = (name: string): Node | undefined => {
    const i = first.get(name);
    return i === undefined ? undefined : tasks[i];
  };

  // ── unknown-task ──
  /** Unknown names per reporting node: an expression's unknown members share one diagnostic. */
  const unknown = new Map<TS.Node, string[]>();
  const checkKnown = (targets: readonly Target[]) => {
    for (const t of targets) {
      if (first.has(t.name)) continue;
      const names = unknown.get(t.at) ?? [];
      if (!names.includes(t.name)) names.push(t.name);
      unknown.set(t.at, names);
    }
  };

  let allKnown = true;
  const routeAt = (route: Route | undefined, owner: TS.Expression | undefined, path: readonly string[], fallback: TS.Node, pointer: string) => {
    const r = routeTargets(ts, checker, route, literalAt(ts, owner, path), fallback, arrows.get(pointer));
    allKnown &&= r.known;
    checkKnown(r.targets);
    return r.targets;
  };

  const entry = defaults?.entry;
  if (typeof entry === "string") {
    const at = literalAt(ts, header, ["config", "defaults", "entry"]);
    if (at) checkKnown([{ name: entry, at }]);
  }
  const defaultTargets = header
    ? routeAt(defaults?.task?.route, header, ["config", "defaults", "task", "route"], header, "/config/defaults/task/route")
    : [];

  /** Is `type` declared as a child of `parent`? `undefined` when the item types do not say. */
  const isChildOf = (type: string, parent: string): boolean | undefined => {
    const decl = items[type];
    return decl === undefined ? undefined : decl.parent === parent;
  };

  /** Task index → the tasks its routes, split and dispatch can send an item to. */
  const edges: string[][] = [];

  tasks.forEach((node, i) => {
    const src = sources.tasks[i]!;
    const base = `/tasks/${i}`;
    const lit = src.literal;
    const next: string[] = [];
    edges.push(next);

    // ── duplicate-task ──
    if (first.get(node.name) !== i) {
      const loc = wf.locations.tasks[node.name];
      const where = loc ? ` at ${loc.file}:${loc.line}` : "";
      out.push(
        diagnosticAt(
          src.name,
          "duplicate-task",
          `Task \`${node.name}\` is already declared${where}. A task name MUST be unique in the workflow (§15.3).`,
        ),
      );
    }

    // ── multiple-bodies ──
    const bodies = lit.properties.filter(
      (p): p is TS.PropertyAssignment => ts.isPropertyAssignment(p) && BODY_KIND_SET.has(propertyNameText(ts, p.name) ?? ""),
    );
    if (bodies.length > 1) {
      const kinds = bodies.map((p) => propertyNameText(ts, p.name)!);
      out.push(
        diagnosticAt(
          bodies[1]!.name,
          "multiple-bodies",
          `Task \`${node.name}\` has the body kinds ${quoted(kinds)}. A node has at most one body kind (§6, §16).`,
        ),
      );
    }

    // ── route: the same item ──
    // The engine does not route a `return` node: it ends the branch (§6.6).
    // A route on it gives no edge and no mismatch. A name in it must still name a task.
    const own = node.route !== undefined;
    const ends = node.return !== undefined;
    if (ends && own) {
      checkKnown(routeTargets(ts, checker, node.route, literalAt(ts, lit, ["route"]), src.name, arrows.get(`${base}/route`)).targets);
    }
    const routed = ends ? [] : own ? routeAt(node.route, lit, ["route"], src.name, `${base}/route`) : defaultTargets;
    for (const t of routed) {
      next.push(t.name);
      const target = taskOf(t.name);
      if (!target || target.item === node.item) continue;
      out.push(
        diagnosticAt(
          own ? t.at : src.name,
          "item-type-mismatch",
          `Task \`${node.name}\` (item \`${node.item}\`) routes to \`${t.name}\` (item \`${target.item}\`)` +
            `${own ? "" : " through `config.defaults.task.route`"}. A route keeps the same item (§4).`,
        ),
      );
    }

    // ── split.route / dispatch.route: a child type ──
    const childRoutes: [kind: "split" | "dispatch", route: Route | undefined][] = [
      ["split", node.split?.route],
      ["dispatch", node.dispatch?.route],
    ];
    for (const [kind, route] of childRoutes) {
      if (route === undefined) continue;
      const literalType = kind === "split" && typeof node.split?.item_type === "string" ? node.split.item_type : undefined;
      for (const t of routeAt(route, lit, [kind, "route"], src.name, `${base}/${kind}/route`)) {
        next.push(t.name);
        const target = taskOf(t.name);
        if (!target) continue;
        const wrong = literalType !== undefined ? target.item !== literalType : isChildOf(target.item, node.item) === false;
        if (!wrong) continue;
        const expected = literalType !== undefined ? `item \`${literalType}\`` : `a child type of \`${node.item}\``;
        out.push(
          diagnosticAt(
            t.at,
            "item-type-mismatch",
            `\`${kind}.route\` of \`${node.name}\` sends ${expected} to \`${t.name}\` (item \`${target.item}\`) (§6.3, §19).`,
          ),
        );
      }
    }
  });

  for (const [at, names] of unknown) {
    const verb = names.length === 1 ? "names" : "name";
    out.push(
      diagnosticAt(at, "unknown-task", `${quoted(names)} ${verb} no task of workflow \`${definition.name}\` (§4, §15.9).`),
    );
  }

  // ── unreachable ── (only when every route target is known)
  const start = entryTask(definition.tasks, defaults?.entry, items);
  if (allKnown && start !== undefined) {
    const reached = new Set<number>([start]);
    const queue = [start];
    while (queue.length) {
      for (const name of edges[queue.shift()!]!) {
        const j = first.get(name);
        if (j !== undefined && !reached.has(j)) {
          reached.add(j);
          queue.push(j);
        }
      }
    }
    tasks.forEach((node, i) => {
      if (reached.has(i) || first.get(node.name) !== i) return;
      out.push(
        diagnosticAt(
          sources.tasks[i]!.name,
          "unreachable",
          `No route, split, dispatch or entry reaches task \`${node.name}\` (§15.9).`,
          "warning",
        ),
      );
    });
  }

  // ── target-state ──
  const allowed = defaults?.item?.allowed_target_states;
  if (Array.isArray(allowed)) {
    for (const [pointer, arrow] of arrows) {
      if (!/^\/tasks\/\d+\/target_state_setter$/.test(pointer) && pointer !== "/config/defaults/item/default_target_state_setter") {
        continue;
      }
      for (const lit of returnedLiterals(ts, arrow)) {
        if (allowed.includes(lit.text)) continue;
        out.push(
          diagnosticAt(
            lit,
            "target-state",
            `\`${lit.text}\` is not in \`allowed_target_states\` (${quoted(allowed)}) (§10, §15.9).`,
          ),
        );
      }
    }
  }

  return out;
}

/**
 * The index of the task the root item starts on, as the engine picks it:
 * `config.defaults.entry`, else `Input`, else the first task bound to the root
 * item type. `undefined` when the configured entry names no task.
 */
function entryTask(
  tasks: readonly Node[],
  configured: string | undefined,
  items: NonNullable<WorkflowAnalysis["definition"]["items"]>,
): number | undefined {
  const indexOf = (name: string) => {
    const i = tasks.findIndex((t) => t.name === name);
    return i < 0 ? undefined : i;
  };
  if (typeof configured === "string") return indexOf(configured);
  const input = indexOf("Input");
  if (input !== undefined) return input;
  const root = Object.entries(items).find(([, d]) => d?.parent === null || d?.parent === undefined)?.[0] ?? "input";
  const i = tasks.findIndex((t) => t.item === root);
  return i >= 0 ? i : tasks.length ? 0 : undefined;
}
