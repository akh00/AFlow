/**
 * The workflow header (spec §15.2), the schema registry (§15.7), and the item
 * typing every expression scope is built from (§3, §10).
 */

import type { TaskRecord, TrajectoryEntry } from "@aflow/engine";

import type { RouteSpec } from "./node.js";
import type { ScopeOver } from "./scope.js";

/**
 * One member per `definitions` key (§10), mapping the key to its TypeScript
 * type. Empty here; `aflow types` generates `.aflow/types/<client_id>.<name>.d.ts`,
 * which augments it (§15.7).
 */
export interface SchemaRegistry {}

/** A `definitions` key (§10). Any string until a registry has been generated. */
export type SchemaKey = [keyof SchemaRegistry] extends [never]
  ? string
  : Extract<keyof SchemaRegistry, string>;

/** A JSON Schema (draft-07 or 2020-12), as written inline in `types` (§10). */
export type JsonSchema = boolean | { readonly [keyword: string]: unknown };

/** §10 item type declaration, by schema key. */
export interface ItemDeclarationSpec {
  /** §10 — the item's `data` type: a `definitions` key, or `"input"` (the workflow input type). */
  data?: SchemaKey | "input";
  /** §10 — the item's `objects` type: a `definitions` key. */
  objects?: SchemaKey;
  /** §3 — the item type of the parent; `null` for the root item type, whose `data` is the workflow input. */
  parent: string | null;
}

/** §15.2 — the workflow header, emitted as the §13 top level. */
export interface WorkflowHeader {
  /** §13 */
  client_id: string;
  /** §13 */
  name: string;
  /** §13 */
  version?: string;
  /** §10 / §15.2 — namespace → JSON Schema file, by path relative to the header file. Contributes `<namespace>.<Name>` keys. */
  schemas?: Readonly<Record<string, string>>;
  /** §10 / §15.2 — workflow-private inline schemas, contributing `<client_id>.<Name>` keys. */
  types?: Readonly<Record<string, JsonSchema>>;
  /** → `definitions.input` (§10). MUST name a `definitions` key. */
  input: SchemaKey;
  /** → `definitions.result` (§10). MUST name a `definitions` key. */
  result: SchemaKey;
  /** → `items` (§10). Exactly one item type is declared with `parent: null` — the root (§3). */
  items: Readonly<Record<string, ItemDeclarationSpec>>;
  /** §13 `config`; expression positions hold arrows (§15.4). */
  config?: ConfigSpec<WorkflowHeader>;
}

/** §13 `config`, with its expression positions as arrows (§15.2, §15.4). */
export interface ConfigSpec<H extends WorkflowHeader> {
  json_descriptor?: { name?: string };
  /** §9 — bundles packed alongside the workflow. */
  bundles?: readonly { name: string; version?: string }[];
  /** Values reachable from expressions as `parameters` (§13). */
  parameters?: Readonly<Record<string, unknown>>;
  defaults?: {
    item?: {
      objects?: Readonly<Record<string, unknown>>;
      data?: Readonly<Record<string, unknown>>;
      target_state?: string;
      /** A literal `target_state_setter` result outside this list is an error (§15.9 `target-state`). */
      allowed_target_states?: readonly string[];
      /** §4 state phase for nodes without a `target_state_setter`. Value position: expression body (§15.4). */
      default_target_state_setter?: (
        scope: ScopeOver<"config.defaults.item.default_target_state_setter", H, ItemName<H>>,
      ) => string | null | undefined;
    };
    task?: {
      /** §4 route phase for nodes without a `route`. */
      route?: RouteSpec<ScopeOver<"config.defaults.task.route", H, ItemName<H>>>;
      default_error_handler?: {
        item?: ItemName<H>;
        /** Statement position (§15.4); always emitted as `$do` (§15.8). */
        $do?: (
          scope: ScopeOver<"config.defaults.task.default_error_handler", H, ItemName<H>>,
        ) => void;
      };
    };
    /** §19 E5 — caps simultaneously-running `call` bodies; MUST NOT change the result. */
    concurrency?: { max_parallel?: number };
    /** §19 E5 — the node the root item starts on. Defaults to `Input`, then the first root node. */
    entry?: string;
  };
}

// ── item typing ────────────────────────────────────────────────────────────

/** The declared item type names. */
export type ItemName<H extends WorkflowHeader> = Extract<keyof H["items"], string>;

type Decl<H extends WorkflowHeader, I extends ItemName<H>> = H["items"][I];

/** The registered type of a schema key; `unknown` until codegen has run. */
export type Registered<K> = K extends keyof SchemaRegistry ? SchemaRegistry[K] : unknown;

/** §10 — the type of an item's `data`. */
export type DataOf<H extends WorkflowHeader, I extends ItemName<H>> =
  Decl<H, I> extends { data: infer K }
    ? K extends "input"
      ? Registered<H["input"]>
      : Registered<K>
    : unknown;

/** §10 — the type of an item's `objects`; a plain record unless declared. */
export type ObjectsOf<H extends WorkflowHeader, I extends ItemName<H>> =
  Decl<H, I> extends { objects: infer K }
    ? K extends keyof SchemaRegistry
      ? SchemaRegistry[K]
      : Record<string, unknown>
    : Record<string, unknown>;

/**
 * True for a header whose item names are not known — `WorkflowHeader` itself,
 * which types the `config` arrows (the header cannot type itself while it is
 * being inferred). The tree is then open: any item may be parent, child or root.
 */
type Open<H extends WorkflowHeader> = string extends ItemName<H> ? true : false;

/** The item types declared with `parent: I`. */
export type ChildName<H extends WorkflowHeader, I extends ItemName<H>> =
  Open<H> extends true
    ? ItemName<H>
    : { [C in ItemName<H>]: Decl<H, C>["parent"] extends I ? C : never }[ItemName<H>];

/** The item type declared with `parent: null`. */
export type RootName<H extends WorkflowHeader> =
  Open<H> extends true
    ? ItemName<H>
    : { [C in ItemName<H>]: Decl<H, C>["parent"] extends null ? C : never }[ItemName<H>];

/** `config.parameters`, or an open record when none are declared. */
export type ParametersOf<H extends WorkflowHeader> = H["config"] extends {
  parameters: infer P;
}
  ? P
  : Readonly<Record<string, unknown>>;

/**
 * The item view an expression sees (§3), typed for item type `I`: the tree is
 * reachable as `parent` / `items` / `root`.
 */
export type ItemViewOf<H extends WorkflowHeader, I extends ItemName<H>> = {
  readonly id: string;
  /** The item type — the discriminant of a union of views. */
  readonly type: I;
  readonly data: DataOf<H, I>;
  readonly objects: ObjectsOf<H, I>;
  readonly tasks: Record<string, TaskRecord>;
  /** §19 E2 — this item's ordered visit log. */
  readonly trajectory: readonly TrajectoryEntry[];
  readonly next_task: string | null;
  readonly target_state: string | null;
  readonly logging_context: Record<string, unknown>;
  readonly additional_properties: Record<string, unknown>;
  readonly optional: boolean;
  readonly parent: ParentView<H, I>;
  readonly items: readonly ChildView<H, I>[];
  readonly root: RootView<H>;
  /** Every descendant, depth-first in creation order. */
  readonly descendants: readonly AnyView<H>[];
};

/** Distributes `ItemViewOf` over a union of item names. */
type ViewOver<H extends WorkflowHeader, Is> = Is extends ItemName<H> ? ItemViewOf<H, Is> : never;

/** The view of `I`'s parent, or `null` on the root item type. */
export type ParentView<H extends WorkflowHeader, I extends ItemName<H>> = ViewOrNull<
  H,
  Decl<H, I>["parent"]
>;
type ViewOrNull<H extends WorkflowHeader, P> = P extends ItemName<H> ? ItemViewOf<H, P> : null;

/** The union of `I`'s child views, discriminated by `type`. */
export type ChildView<H extends WorkflowHeader, I extends ItemName<H>> = ViewOver<H, ChildName<H, I>>;

/** The root item's view. */
export type RootView<H extends WorkflowHeader> = ViewOver<H, RootName<H>>;

/** The union of every item type's view. */
export type AnyView<H extends WorkflowHeader> = ViewOver<H, ItemName<H>>;

/** `I`'s child types, or every item type when `I` declares no children. */
export type ChildOrAnyName<H extends WorkflowHeader, I extends ItemName<H>> =
  [ChildName<H, I>] extends [never] ? ItemName<H> : ChildName<H, I>;

/**
 * §7 `set`. The selected set is whatever `select` returned; types cannot see
 * that from inside the same object literal, so `set` is typed as `I`'s
 * children (every item type when `I` has none).
 */
export type SetOf<H extends WorkflowHeader, I extends ItemName<H>> = readonly ViewOver<
  H,
  ChildOrAnyName<H, I>
>[];

/**
 * §6.3 — a split's selector element becomes a child's `data`, so in
 * `split.item_type` `data` is typed as the union of `I`'s child data types.
 */
export type ChildData<H extends WorkflowHeader, I extends ItemName<H>> =
  [ChildName<H, I>] extends [never]
    ? unknown
    : ChildName<H, I> extends infer C extends ItemName<H>
      ? C extends ItemName<H>
        ? DataOf<H, C>
        : never
      : never;
