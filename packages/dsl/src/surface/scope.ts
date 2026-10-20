/**
 * The expression scope per position (spec §15.5) — defined once, as data.
 *
 * `SCOPE_AT` is the runtime table the analyzer checks parameter names against
 * (§15.4 `param-shape`); `ScopeAt` derives the parameter type of every DSL
 * arrow from the same table, so the editor and the build cannot disagree about
 * which names a position offers.
 */

import type {
  CtxView,
  ItemView,
  TaskRecord,
  TrajectoryEntry,
  WorkflowError,
} from "@aflow/engine";

import type {
  AnyView,
  ChildData,
  ChildView,
  DataOf,
  ItemName,
  ItemViewOf,
  ObjectsOf,
  ParametersOf,
  ParentView,
  RootView,
  SetOf,
  WorkflowHeader,
} from "./header.js";

/** §15.5 *base*: the scope every item-bound expression sees. */
const BASE = [
  "id",
  "type",
  "data",
  "objects",
  "tasks",
  "trajectory",
  "items",
  "parent",
  "root",
  "next_task",
  "target_state",
  "logging_context",
  "additional_properties",
  "optional",
  "parameters",
  "ctx",
  "self",
] as const;

/**
 * §15.5, one row per position. Keys are the field paths of §13 relative to the
 * node (or to the workflow, for `config.*`); values are the scope member names
 * valid there. `route` covers both the expression and the `switch` form.
 */
export const SCOPE_AT = {
  condition: BASE,
  "await.select": BASE,
  "aggregate.select": BASE,
  enrich: BASE,
  "split.selector": BASE,
  "dispatch.select": BASE,
  route: BASE,
  "config.defaults.task.route": BASE,
  "return.result": BASE,
  "return.error": BASE,
  "call.input": BASE,
  "call.request.url": BASE,
  "call.request.headers": BASE,
  "call.request.body": BASE,
  "call.request.query": BASE,

  /** Base, bound to the produced child (§19 E1). */
  "split.route": BASE,
  /** Base, bound to the dispatched item (§19 E4). */
  "dispatch.route": BASE,

  "await.until": [...BASE, "set"],
  "aggregate.until": [...BASE, "set"],
  "aggregate.reduce": [...BASE, "set"],

  "call.output.transform": [...BASE, "result", "input"],
  "call.output.enrich": [...BASE, "result", "input"],

  target_state_setter: [...BASE, "task_state", "error", "result"],
  "config.defaults.item.default_target_state_setter": [
    ...BASE,
    "task_state",
    "error",
    "result",
  ],

  "config.defaults.task.default_error_handler": [...BASE, "error", "task_state"],

  /** The child does not exist yet (§19 E1). */
  "split.item_type": [
    "data",
    "index",
    "objects",
    "tasks",
    "items",
    "parent",
    "root",
    "parameters",
    "ctx",
  ],
} as const;

/** A §15.5 expression position. */
export type Position = keyof typeof SCOPE_AT;

/**
 * §15.4 statement positions: the arrow MAY use a block body. Every other
 * position is a value position and MUST use an expression body (`body-form`).
 */
export const STATEMENT_POSITIONS = [
  "enrich",
  "aggregate.reduce",
  "call.output.enrich",
  "config.defaults.task.default_error_handler",
] as const satisfies readonly Position[];

/** The scope member names valid at `P`. */
export type ScopeName<P extends Position> = (typeof SCOPE_AT)[P][number];

/** Every member an item-bound scope can carry, typed for item type `I`. */
export interface ScopeMembers<H extends WorkflowHeader, I extends ItemName<H>, E> {
  /** The item's id. */
  id: string;
  /** The item type (§3) — the discriminant of `items` and `set` members. */
  type: I;
  /** The item's `data`, typed from its declaration (§10, §15.7). A `$do` MAY rebind it. */
  data: DataOf<H, I>;
  /** The item's `objects`, typed from its declaration (§10, §15.7). */
  objects: ObjectsOf<H, I>;
  /** §3 `tasks[name]` — the latest record of each node visit. */
  tasks: Record<string, TaskRecord>;
  /** §19 E2 — this item's ordered visit log. */
  trajectory: readonly TrajectoryEntry[];
  /** The item's children (§3), discriminated by `type`. */
  items: readonly ChildView<H, I>[];
  /** The parent item (§3); `null` on the root item type. */
  parent: ParentView<H, I>;
  /** The root item (§3); its `data` is the workflow input. */
  root: RootView<H>;
  /** §3 — the next node; `null` ends the branch. A `$do` MAY rebind it. */
  next_task: string | null;
  /** §3 — the item's target state. A `$do` MAY rebind it. */
  target_state: string | null;
  logging_context: Record<string, unknown>;
  additional_properties: Record<string, unknown>;
  optional: boolean;
  /** `config.parameters` (§13). */
  parameters: ParametersOf<H>;
  /** §19 E3 — the evaluation context, order-free. */
  ctx: CtxView;
  /** The item view the engine binds `this` to (§15.4). */
  self: ItemViewOf<H, I>;
  /** §7 — the selected set. `until` MUST be monotonic; `reduce` MUST be commutative and associative. */
  set: SetOf<H, I>;
  /** §9 — the captured call result; in `target_state_setter`, the task's recorded result. */
  result: unknown;
  /** §9 — the value `call.input` computed. */
  input: unknown;
  /** §3 — the record of this node's visit. */
  task_state: TaskRecord;
  /** §3 / §11 — the error the visit captured. */
  error: E;
}

/** §19 E1 — the scope of `split.item_type`, before the child exists. */
export interface ProspectiveMembers<H extends WorkflowHeader, I extends ItemName<H>> {
  /** The selector element this child will receive as its `data` (§6.3). */
  data: ChildData<H, I>;
  /** The element's position in the selector's result. */
  index: number;
  /** Always empty: the child does not exist yet. */
  objects: Record<string, unknown>;
  /** Always empty: the child does not exist yet. */
  tasks: Record<string, TaskRecord>;
  /** Always empty: the child does not exist yet. */
  items: readonly never[];
  /** The splitting item — the child's parent. */
  parent: ItemViewOf<H, I>;
  root: RootView<H>;
  parameters: ParametersOf<H>;
  ctx: CtxView;
}

type ErrorAt<P extends Position> =
  P extends "config.defaults.task.default_error_handler" ? WorkflowError : WorkflowError | null;

type MembersAt<P extends Position, H extends WorkflowHeader, I extends ItemName<H>> =
  P extends "split.item_type" ? ProspectiveMembers<H, I> : ScopeMembers<H, I, ErrorAt<P>>;

/**
 * The parameter type of an arrow at position `P` on a node bound to item type
 * `I`: exactly the names `SCOPE_AT[P]` lists.
 */
export type ScopeAt<P extends Position, H extends WorkflowHeader, I extends ItemName<H>> = Pick<
  MembersAt<P, H, I>,
  ScopeName<P> & keyof MembersAt<P, H, I>
>;

/** `ScopeAt` distributed over several item types — a union of scopes, discriminated by `type`. */
export type ScopeOver<P extends Position, H extends WorkflowHeader, Is extends ItemName<H>> =
  Is extends ItemName<H> ? ScopeAt<P, H, Is> : never;

/** The items a selector can return: views from the scope, or from `ctx` (§19 E3). */
export type Selection<H extends WorkflowHeader> = readonly (AnyView<H> | ItemView)[];

// Every name in `SCOPE_AT` has a type above; a new name without one fails here.
type Untyped = Exclude<
  ScopeName<Position>,
  keyof ScopeMembers<WorkflowHeader, string, unknown> | keyof ProspectiveMembers<WorkflowHeader, string>
>;
type AllNamesTyped = Expect<[Untyped] extends [never] ? true : false>;
type Expect<T extends true> = T;
