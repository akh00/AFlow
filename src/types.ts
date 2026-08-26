/**
 * Types for the canonical AFlow workflow JSON document (spec §13) and the node
 * model (§4, §6, §16).
 *
 * Extensions to §16 are marked `[E1]`…`[E5]` and documented in
 * `docs/aflow-workflow-spec.md` §19.
 */

/** A pure expression (`$expr`) or pure statement block (`$do`) — §5. */
export type Expr = string | { $expr: string } | { $do: string };

export interface TypeRef {
  $ref?: string;
}

/** §10 item type declaration. */
export interface ItemTypeDeclaration {
  data?: TypeRef | null;
  objects?: TypeRef | null;
  /** Item type of the parent; `null` for the root item type. */
  parent?: string | null;
}

/** §4 route phase. `[E1]` also used per-child by `split.route`. */
export type Route =
  | string
  | null
  | { $expr: string }
  | {
      switch?: Expr;
      cases: Record<string, string | null>;
      /** Fallback when no case matches. Absent ⇒ unmatched case is an error. */
      default?: string | null;
    };

/** §7 `select` + `until` + `reduce`. Used by `aggregate` and by `await`. */
export interface Gate {
  select?: Expr;
  until?: Expr;
  reduce?: Expr;
}

export interface RetryTier {
  max_count?: number;
  interval?: string;
  max_interval?: string;
}

/** §11 retry configuration. */
export interface RetryConfig {
  inline?: RetryTier;
  offline?: RetryTier;
  catch_offline_retry_error?: boolean;
}

/** §6.3 `split` / `add_items`. */
export interface SplitBody {
  /**
   * Item type of the produced children.
   * `[E1]` may be an expression evaluated once per child, with `this` bound to
   * the prospective child, so one split can produce several item types.
   */
  itemType: string | { $expr: string };
  /** Pure expression returning an array; each element becomes a child's `data`. */
  selector: Expr;
  /**
   * Entry node for the produced children.
   * `[E1]` widened from `string | null` to the full `Route` shape, evaluated
   * per child, so one split can route children onto different paths.
   */
  route?: Route;
  /** Run the produced children concurrently (§8). Default `false` ⇒ sequential. */
  parallel?: boolean;
}

/**
 * `[E4]` `dispatch` — the inverse of `aggregate`. Selects existing items and
 * sets their `next_task`, re-activating branches that had ended
 * (`next_task === null`). Pure; the mechanism §17's `change_rollback_router`
 * needs to drive children into a commit or rollback phase.
 */
export interface DispatchBody {
  /** Pure expression returning the items to re-activate. */
  select: Expr;
  /** Route evaluated once per selected item, with `this` bound to that item. */
  route: Route;
}

export type CallProvider = "http" | "sub_workflow" | "js";

export interface CallOutput {
  resultType?: string;
  errorType?: string;
  /**
   * Pure output transform (§11). Receives `result`; may return
   * `{ error: … }` to turn a successful response into a retryable error.
   */
  transform?: Expr;
  /** Pure `$do` that folds `result` into `this`. */
  enrich?: Expr;
}

export interface HttpRequest {
  method?: string;
  url?: Expr;
  headers?: Expr;
  body?: Expr;
  query?: Expr;
}

/** §6.5 / §9 `call` — the only body kind that performs I/O. */
export interface CallBody {
  provider: CallProvider;
  input?: Expr;
  output?: CallOutput;
  /** provider: http */
  request?: HttpRequest;
  /** provider: sub_workflow — name of the workflow to invoke. */
  name?: string;
  /** provider: sub_workflow — client id, defaults to the caller's. */
  client_id?: string;
  /** provider: js — `async (input, lib) => …` */
  script?: string;
  /** provider: js — library packed alongside the workflow. */
  implementation?: {
    bundle_name?: string;
    bundle_version?: string;
    entry?: string;
  };
  /** provider: js — library resolved from an external artifactory. */
  registry?: { url?: string; ref?: string };
}

/** §4 node ("task"). At most one body kind. */
export interface Node {
  name: string;
  /** Item type this node applies to — the `this` binding. */
  item: string;
  condition?: Expr;
  /** §8 self-await on named async branches, or a full §7 gate. */
  await?: Gate | string[];
  async?: boolean;
  durable?: boolean;
  idempotent?: boolean;
  timeout?: number;
  retry?: RetryConfig;
  target_state_setter?: Expr;
  route?: Route;

  // ── at most one body kind ────────────────────────────────────────────────
  enrich?: { $do: string } | string;
  split?: SplitBody;
  aggregate?: Gate;
  /** `[E4]` */
  dispatch?: DispatchBody;
  call?: CallBody;
  return?: { result?: Expr; error?: Expr };
}

export const BODY_KINDS = [
  "enrich",
  "split",
  "aggregate",
  "dispatch",
  "call",
  "return",
] as const;

export type BodyKind = (typeof BODY_KINDS)[number];

export interface ItemDefaults {
  objects?: Record<string, unknown>;
  data?: Record<string, unknown>;
  target_state?: string;
  allowed_target_states?: string[];
  default_target_state_setter?: Expr;
}

export interface TaskDefaults {
  route?: Route;
  default_error_handler?: { item?: string; $do?: string };
}

export interface WorkflowConfig {
  json_descriptor?: { name?: string };
  bundles?: Array<{ name: string; version?: string }>;
  /** Values reachable from expressions as `parameters[...]`. */
  parameters?: Record<string, unknown>;
  defaults?: {
    item?: ItemDefaults;
    task?: TaskDefaults;
    /** `[E5]` cap on simultaneously-running `call` bodies. */
    concurrency?: { max_parallel?: number };
    /** Node the root item starts on. Defaults to `Input`, then the first node. */
    entry?: string;
  };
}

/** §13 top-level workflow document. */
export interface WorkflowDefinition {
  client_id: string;
  name: string;
  version?: string;
  definitions?: Record<string, unknown>;
  items?: Record<string, ItemTypeDeclaration>;
  config?: WorkflowConfig;
  tasks: Node[];
}
