/**
 * The node ("task") surface (spec §4, §6, §15.3): one discriminated union per
 * workflow, keyed by `item`, with the six body kinds mutually exclusive.
 *
 * Every expression position is an arrow whose parameter type is the §15.5
 * scope at that position (`ScopeAt`). Value positions are typed by their
 * result; statement positions return `void`, so either body form fits. Which
 * body form a position permits is checked by the analyzer (`body-form`), not
 * by these types.
 */

import type { BodyKind, RetryConfig } from "@aflow/engine";

import type {
  ChildOrAnyName,
  ItemName,
  Registered,
  SchemaKey,
  WorkflowHeader,
} from "./header.js";
import type { Position, ScopeAt, ScopeOver, Selection } from "./scope.js";

/** A value position: an expression body yielding `R` (§15.4). */
type Value<
  P extends Position,
  H extends WorkflowHeader,
  I extends ItemName<H>,
  R = unknown,
  Res = unknown,
> = (scope: ScopeAt<P, H, I, Res>) => R;

/** A statement position: either body form (§15.4). */
type Statement<
  P extends Position,
  H extends WorkflowHeader,
  I extends ItemName<H>,
  Res = unknown,
> = (scope: ScopeAt<P, H, I, Res>) => void;

/**
 * §4 route phase: a task name, `null` (ends the branch), an expression
 * yielding either, or `switch`/`cases`. `S` is the scope the expression and
 * `switch` see.
 */
export type RouteSpec<S> =
  | string
  | null
  | ((scope: S) => string | null)
  | {
      /** Selects the case; defaults to `target_state`. */
      switch?: (scope: S) => unknown;
      /** Case value → task name, or `null` to end the branch. */
      cases: Readonly<Record<string, string | null>>;
      /** Fallback when no case matches. Absent ⇒ an unmatched case is an error. */
      default?: string | null;
    };

/** §7 / §8 gate on a node. */
export interface AwaitGate<H extends WorkflowHeader, I extends ItemName<H>> {
  /** §7 — the set to wait on. */
  select?: Value<"await.select", H, I, Selection<H>>;
  /** §7 — `until` MUST be monotonic: once true for a set it stays true as members finish. */
  until?: Value<"await.until", H, I>;
}

/** The kind-independent node fields (§4). */
export interface CommonFields<H extends WorkflowHeader, I extends ItemName<H>> {
  /** §4 gate — may this node fire on `this`? Pure; default: always. */
  condition?: Value<"condition", H, I>;
  /**
   * §7 / §8 — block until a set satisfies `until`, or self-await the named
   * async branches. `until` MUST be monotonic.
   */
  await?: readonly string[] | AwaitGate<H, I>;
  /** §8 — spawn a branch for the item; the flow continues without waiting. */
  async?: boolean;
  /** §4 — persist before running (crash-safe). */
  durable?: boolean;
  /** §4 */
  idempotent?: boolean;
  /** §4 — milliseconds. */
  timeout?: number;
  /** §11 — retry tiers for effect tasks. */
  retry?: RetryConfig;
  /** §4 state phase — computes the item's `target_state`. Pure. */
  target_state_setter?: Value<"target_state_setter", H, I, string | null | undefined>;
  /** §4 route phase — computes `next_task`. Pure. */
  route?: RouteSpec<ScopeAt<"route", H, I>>;
}

/**
 * §6.3 / §19 E1 `split`. `route` sees the union of the child types' scopes
 * (discriminated by `type`), whichever form `item_type` takes.
 */
export interface SplitSpec<H extends WorkflowHeader, I extends ItemName<H>> {
  /**
   * §6.3 — the produced children's item type. §19 E1: MAY be an expression,
   * evaluated once per child before the child exists.
   */
  item_type: ItemName<H> | Value<"split.item_type", H, I, ItemName<H>>;
  /** §6.3 — pure; returns an array, each element becomes a child's `data`. */
  selector: Value<"split.selector", H, I, readonly unknown[]>;
  /** §19 E1 — entry node for each produced child, evaluated with `this` bound to that child. */
  route?: RouteSpec<ScopeOver<"split.route", H, ChildOrAnyName<H, I>>>;
  /** §6.3 / §8 — run the produced children concurrently; default `false` ⇒ in selector order. */
  parallel?: boolean;
}

/** §7 `aggregate` — `select` + `until` + `reduce`. */
export interface AggregateSpec<H extends WorkflowHeader, I extends ItemName<H>> {
  /** §7 — the set to wait on and fold. */
  select?: Value<"aggregate.select", H, I, Selection<H>>;
  /** §7 — `until` MUST be monotonic: once true for a set it stays true as members finish. */
  until?: Value<"aggregate.until", H, I>;
  /** §7 — folds the set into `this`. `reduce` MUST be commutative and associative. */
  reduce?: Statement<"aggregate.reduce", H, I>;
}

/** §19 E4 `dispatch`. */
export interface DispatchSpec<H extends WorkflowHeader, I extends ItemName<H>> {
  /** §19 E4 — the items to re-activate. Dispatching an item that is mid-visit is an error. */
  select: Value<"dispatch.select", H, I, Selection<H>>;
  /** §19 E4 — evaluated once per selected item, with `this` bound to that item; `null` leaves it ended. */
  route: RouteSpec<ScopeOver<"dispatch.route", H, ChildOrAnyName<H, I>>>;
}

/** §9 / §11 `call.output` for result type `K`; `result` is `SchemaRegistry[K]`. */
export interface OutputFields<H extends WorkflowHeader, I extends ItemName<H>, K> {
  /** §9 / §15.4 — the result's `definitions` key. Required in the DSL: it types `result` in `transform` / `enrich`. */
  result_type: K;
  /** §9 — the error's `definitions` key. */
  error_type?: SchemaKey;
  /** §11 — pure; MAY turn a successful response into an error to trigger a retry. Runs before `enrich`. */
  transform?: Value<"call.output.transform", H, I, unknown, Registered<K>>;
  /** §9 — pure statement block folding `result` into `this`. */
  enrich?: Statement<"call.output.enrich", H, I, Registered<K>>;
}

/**
 * §9 / §15.4 `call.output`, discriminated by `result_type`, which the DSL
 * requires (there is no untyped variant: TypeScript cannot narrow by a missing
 * discriminant under the optional `output`).
 */
export type OutputSpec<H extends WorkflowHeader, I extends ItemName<H>> = {
  [K in SchemaKey]: OutputFields<H, I, K>;
}[SchemaKey];

/** §9 `call` — the only body kind that performs I/O; its result is captured. */
export interface CallSpec<H extends WorkflowHeader, I extends ItemName<H>> {
  /** §9 */
  provider: "http" | "sub_workflow" | "js";
  /** §9 — pure; computes the effect's input. */
  input?: Value<"call.input", H, I>;
  output?: OutputSpec<H, I>;
  /** §9 provider `http`. */
  request?: {
    method?: string;
    url?: Value<"call.request.url", H, I>;
    headers?: Value<"call.request.headers", H, I>;
    body?: Value<"call.request.body", H, I>;
    query?: Value<"call.request.query", H, I>;
  };
  /** §9 provider `sub_workflow` — the workflow to invoke. */
  name?: string;
  /** §9 provider `sub_workflow` — defaults to the caller's. */
  client_id?: string;
  /**
   * §9 / §15.6 provider `js` — effect code: MAY be `async`, receives
   * `(input, lib)`; MAY reference only its parameters, its locals and the safe
   * globals.
   */
  script?: (input: any, lib: any) => unknown;
  /** §9 provider `js` — a library packed alongside the workflow. */
  implementation?: { bundle_name?: string; bundle_version?: string; entry?: string };
  /** §9 provider `js` — a library resolved from an external artifactory. */
  registry?: { url?: string; ref?: string };
}

/** §6.6 `return`. */
export interface ReturnSpec<H extends WorkflowHeader, I extends ItemName<H>> {
  /** §6.6 — the workflow `result`. */
  result?: Value<"return.result", H, I>;
  /** §6.6 — the declared workflow `error`; a determined failure. */
  error?: Value<"return.error", H, I>;
}

/** §6 — the body kinds. At most one per node (§16). */
export interface BodyFields<H extends WorkflowHeader, I extends ItemName<H>> {
  /** §6.1 `enrich` — a pure statement block that assigns into `this`. Performs no I/O. */
  enrich: Statement<"enrich", H, I>;
  /** §6.3 `split` — creates children of `this` from a selector; type and route MAY vary per child (§19 E1). */
  split: SplitSpec<H, I>;
  /** §7 — `until` MUST be monotonic; `reduce` MUST be commutative and associative. */
  aggregate: AggregateSpec<H, I>;
  /** §19 E4 `dispatch` — the inverse of `aggregate`: selects a set and sets each member's `next_task`. Pure. */
  dispatch: DispatchSpec<H, I>;
  /** §6.5 / §9 `call` — the only body kind that performs I/O; its result is captured into `tasks[name].result`. */
  call: CallSpec<H, I>;
  /** §6.6 `return` — emits the workflow `result` or `error` and ends the branch. */
  return: ReturnSpec<H, I>;
}

type Exclusive<H extends WorkflowHeader, I extends ItemName<H>, K extends BodyKind> = Pick<
  BodyFields<H, I>,
  K
> & { [Q in Exclude<BodyKind, K>]?: never };

/** One body kind, or none (a routing-only node). */
export type BodyVariant<H extends WorkflowHeader, I extends ItemName<H>> =
  | { [K in BodyKind]: Exclusive<H, I, K> }[BodyKind]
  | { [Q in BodyKind]?: never };

/** §13 node fields minus `name` / `item`, for a node bound to `I`. */
export type NodeFields<H extends WorkflowHeader, I extends ItemName<H>> = CommonFields<H, I> &
  BodyVariant<H, I>;

/** The node's item binding. */
export interface ItemBinding<I> {
  /** §4 — the item type this node applies to (the `this` binding). */
  item: I;
}

/** §15.3 — a task in a `wf.tasks({…})` group: one variant per declared item type. */
export type NodeSpec<H extends WorkflowHeader> = {
  [I in ItemName<H>]: ItemBinding<I> & NodeFields<H, I>;
}[ItemName<H>];

// `BodyFields` lists exactly the engine's `BODY_KINDS`; drift fails here.
type Expect<T extends true> = T;
type SameKeys<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type BodyKindsInSync = Expect<SameKeys<keyof BodyFields<WorkflowHeader, string>, BodyKind>>;
