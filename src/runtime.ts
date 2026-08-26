/**
 * Runtime shapes: the item (§3), its recorded task state, the `[E2]` ordered
 * trajectory, and the `Evaluation` response (OpenAPI `components.schemas`).
 */

export type TaskStatus = "success" | "failure" | "pending" | "error" | "skipped";

export type EvaluationStatus =
  | "running"
  | "suspended"
  | "succeeded"
  | "failed"
  | "cancelled";

/** §6.6 / §3 declared workflow error. A determined outcome, not a transport fault. */
export interface WorkflowError {
  code: number;
  category?: string;
  message: string;
  data?: unknown;
  retry_type?: "inline" | "offline" | "inline_then_offline" | null;
  next_retry?: string | null;
  [k: string]: unknown;
}

/** §3 `tasks[name]` — the latest record of a node visit by an item. */
export interface TaskRecord {
  id: string;
  status: TaskStatus;
  started: string;
  updated: string;
  /** How many times this item has visited this node (1 on the first visit). */
  attempts: number;
  result?: unknown;
  error?: WorkflowError | null;
}

/**
 * `[E2]` One entry per node visit, appended in visit order.
 *
 * Ordering is meaningful only *within* one item — an item's visits are strictly
 * sequential, so `seq` is scheduling-independent. The engine also keeps a
 * flat cross-item log for diagnostics, which is deliberately NOT reachable
 * from pure expressions (§5, §8).
 */
export interface TrajectoryEntry {
  /** Per-item sequence number, starting at 0. */
  seq: number;
  item_id: string;
  item_type: string;
  /** Node name. */
  task: string;
  /** Visit ordinal for this (item, node) pair, starting at 1. */
  attempt: number;
  status: TaskStatus;
  started: string;
  updated: string;
  /** `target_state` after the state phase. */
  target_state: string | null;
  /** `next_task` after the route phase; `null` ended the branch. */
  next_task: string | null;
  result?: unknown;
  error?: WorkflowError | null;
}

/** §3 item, as serialized into `Evaluation.trace`. */
export interface ItemSnapshot {
  id: string;
  type: string;
  parent: string | null;
  items: ItemSnapshot[];
  data: unknown;
  objects: Record<string, unknown>;
  tasks: Record<string, TaskRecord>;
  /** `[E2]` */
  trajectory: TrajectoryEntry[];
  next_task: string | null;
  target_state: string | null;
  logging_context: Record<string, unknown>;
  additional_properties: Record<string, unknown>;
}

export interface Suspension {
  reason: "offline_retry" | "await";
  task?: string;
  item_id?: string;
  attempt?: number;
  next_retry_at?: string | null;
  detail?: string;
}

export interface WorkflowRef {
  client_id: string;
  name: string;
  version: string | null;
}

/** OpenAPI `Evaluation`. */
export interface Evaluation {
  id: string;
  status: EvaluationStatus;
  workflow: WorkflowRef;
  target_state: string | null;
  submitted_at: string;
  updated_at: string;
  completed_at: string | null;
  result?: unknown;
  error?: WorkflowError;
  suspension?: Suspension;
  /** Present when `include_trace` was requested. */
  trace?: ItemSnapshot;
  /**
   * `[E2]` Flat cross-item visit log in completion order. Diagnostics only —
   * scheduling-dependent, and never visible to pure expressions.
   */
  trajectory?: TrajectoryEntry[];
}

// ── engine errors ──────────────────────────────────────────────────────────

export class AFlowError extends Error {
  constructor(
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** A workflow document that cannot be executed as written. */
export class WorkflowDefinitionError extends AFlowError {}

/** An expression did something §5 forbids, or §8 rule 1 was violated. */
export class DeterminismViolation extends AFlowError {}

/** An expression threw. */
export class ExpressionError extends AFlowError {}

/** No item can progress and the evaluation is not terminal. */
export class DeadlockError extends AFlowError {}
