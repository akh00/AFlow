/**
 * `@aflow/dsl` — the typed TypeScript front for the §13 workflow document
 * (spec §15, artifact 2).
 *
 * DSL files are analysed, never executed (§15.1): `workflow()`, `.tasks()` and
 * `.assemble()` are inert at runtime — each returns its argument — and exist
 * so the editor can type what the author writes.
 */

import type { ConfigSpec, ItemName, WorkflowHeader } from "./surface/header.js";
import type { NodeSpec } from "./surface/node.js";

declare const workflowOf: unique symbol;

/** §15.3 — a task group: task name → node, bound to the workflow `H`. */
export type TaskGroup<H extends WorkflowHeader, T> = T & { readonly [workflowOf]?: H };

/** §15.3 — the workflow, defined as exactly the listed groups, in argument order. */
export type Assembled<H extends WorkflowHeader> = readonly TaskGroup<H, unknown>[] & {
  readonly [workflowOf]?: H;
};

/** The header `workflow()` returns: the place task groups and the assembly hang off. */
export interface Workflow<H extends WorkflowHeader> {
  /**
   * §15.3 — declares a task group: property names are task names, values are
   * §13 nodes without `name`, with `item` naming the item type the node binds
   * to (§4). At most one body kind per node (§6, §16).
   */
  tasks<const T extends Record<string, NodeSpec<H>>>(tasks: T): TaskGroup<H, T>;
  /**
   * §15.3 — the workflow is exactly the listed groups. `tasks` is emitted in
   * argument order, then property order within each group; a task name in two
   * groups is an error (`duplicate-task`).
   */
  assemble(...groups: TaskGroup<H, unknown>[]): Assembled<H>;
}

/** Item declarations whose `parent` names a declared item type (§3, §15.2). */
type HeaderItems<H extends WorkflowHeader> = {
  readonly [K in keyof H["items"]]: { readonly parent: ItemName<H> | null };
};

/**
 * §15.2 — declares the workflow header. Must be a top-level
 * `const X = workflow({…})` (§15.1).
 */
export function workflow<const H extends WorkflowHeader>(
  header: H & { items: HeaderItems<H> },
): Workflow<H> {
  // Inert (§15.1): the header itself, with the two methods attached as
  // non-enumerable identities so an accidental import does not throw.
  return Object.defineProperties(header, {
    tasks: { value: <T>(tasks: T) => tasks },
    assemble: { value: (...groups: unknown[]) => groups },
  }) as unknown as Workflow<H>;
}

export type {
  AnyView,
  ChildView,
  ConfigSpec,
  DataOf,
  ItemDeclarationSpec,
  ItemName,
  ItemViewOf,
  JsonSchema,
  ObjectsOf,
  ParentView,
  RootView,
  SchemaKey,
  SchemaRegistry,
  WorkflowHeader,
} from "./surface/header.js";
export type { NodeFields, NodeSpec, RouteSpec } from "./surface/node.js";
export { SCOPE_AT, STATEMENT_POSITIONS } from "./surface/scope.js";
export type { Position, ScopeAt, ScopeName } from "./surface/scope.js";
