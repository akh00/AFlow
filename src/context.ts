/**
 * The evaluation context: the item tree (§3), the item views expressions see,
 * and the `[E3]` `ctx` binding.
 */

import type {
  ItemSnapshot,
  TaskRecord,
  TrajectoryEntry,
  WorkflowError,
} from "./runtime.js";
import type { WorkflowDefinition } from "./types.js";

export type ItemStatus = "ready" | "running" | "done";

/** Internal, mutable item. `ItemView` is what expressions get to see. */
export interface ItemNode {
  id: string;
  type: string;
  parentId: string | null;
  childIds: string[];
  data: unknown;
  objects: Record<string, unknown>;
  tasks: Record<string, TaskRecord>;
  /** `[E2]` ordered visit log for this item. */
  trajectory: TrajectoryEntry[];
  next_task: string | null;
  target_state: string | null;
  logging_context: Record<string, unknown>;
  additional_properties: Record<string, unknown>;

  // ── scheduling state, not part of the item contract ─────────────────────
  status: ItemStatus;
  /** Creation order across the whole evaluation; deterministic. */
  createdIndex: number;
  /**
   * For a non-parallel `split`: this child may not start until its predecessor
   * in the produced sequence is done.
   */
  sequencePredecessor?: string;
}

/**
 * Read view of an item, with the tree reachable as `parent` / `items` / `root`.
 * `data`, `objects`, `logging_context` and `additional_properties` are the live
 * objects, so a `$do` can write through them.
 */
export class ItemView {
  constructor(
    private readonly node: ItemNode,
    private readonly ctx: EvaluationContext,
  ) {}

  get id(): string {
    return this.node.id;
  }
  get type(): string {
    return this.node.type;
  }
  get data(): unknown {
    return this.node.data;
  }
  get objects(): Record<string, unknown> {
    return this.node.objects;
  }
  get tasks(): Record<string, TaskRecord> {
    return this.node.tasks;
  }
  /** `[E2]` this item's ordered visit log. */
  get trajectory(): readonly TrajectoryEntry[] {
    return this.node.trajectory;
  }
  get next_task(): string | null {
    return this.node.next_task;
  }
  get target_state(): string | null {
    return this.node.target_state;
  }
  get logging_context(): Record<string, unknown> {
    return this.node.logging_context;
  }
  get additional_properties(): Record<string, unknown> {
    return this.node.additional_properties;
  }
  /** Used by the §7/§17 examples (`!i.optional`). */
  get optional(): boolean {
    return Boolean(this.node.additional_properties.optional);
  }

  get parent(): ItemView | null {
    return this.node.parentId ? this.ctx.view(this.node.parentId) : null;
  }
  get items(): ItemView[] {
    return this.node.childIds.map((id) => this.ctx.view(id));
  }
  get root(): ItemView {
    return this.ctx.view(this.ctx.root.id);
  }
  /** Every descendant, depth-first in creation order. */
  get descendants(): ItemView[] {
    const out: ItemView[] = [];
    const walk = (n: ItemNode) => {
      for (const id of n.childIds) {
        const child = this.ctx.node(id);
        out.push(this.ctx.view(id));
        walk(child);
      }
    };
    walk(this.node);
    return out;
  }

  /** Escape hatch for the engine; not reachable from expressions. */
  unwrap(): ItemNode {
    return this.node;
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      type: this.type,
      parent: this.node.parentId,
      data: this.data,
      objects: this.objects,
      target_state: this.target_state,
      next_task: this.next_task,
    };
  }
}

/**
 * `[E3]` The `ctx` binding available in every pure expression.
 *
 * Deliberately order-free: there is no accessor returning a global
 * chronological log, because §8 forbids expressions depending on arrival
 * order. `items` and `visits()` are in item *creation* order, which is a pure
 * function of the `split` selectors; `trajectory(id)` is ordered only within a
 * single item, whose visits are strictly sequential.
 */
export interface CtxView {
  readonly workflow: { client_id: string; name: string; version: string | null };
  readonly parameters: Readonly<Record<string, unknown>>;
  /** Every item in the evaluation, flat, in creation order. */
  readonly items: readonly ItemView[];
  item(id: string): ItemView | undefined;
  byType(type: string): ItemView[];
  /** Items that have visited `task` at least once. */
  byTask(task: string): ItemView[];
  /** Every recorded visit of `task`, ordered by (item creation, per-item seq). */
  visits(task: string): readonly TrajectoryEntry[];
  /** One item's ordered visits, or a per-item map when `itemId` is omitted. */
  trajectory(itemId?: string): readonly TrajectoryEntry[] | Record<string, readonly TrajectoryEntry[]>;
  /** Number of items matching a type, or all items when omitted. */
  count(type?: string): number;
}

export interface EvaluationContextInit {
  definition: WorkflowDefinition;
  parameters?: Record<string, unknown>;
}

export class EvaluationContext {
  readonly definition: WorkflowDefinition;
  readonly parameters: Record<string, unknown>;
  readonly items = new Map<string, ItemNode>();

  root!: ItemNode;

  /**
   * `[E2]` Flat cross-item visit log in completion order — diagnostics and the
   * API response only. Never exposed through `CtxView`.
   */
  readonly log: TrajectoryEntry[] = [];

  /** Set by a `return` body (§6.6). */
  returnedResult: { value: unknown } | undefined;
  returnedError: WorkflowError | undefined;

  private readonly views = new Map<string, ItemView>();
  private createdCount = 0;

  constructor(init: EvaluationContextInit) {
    this.definition = init.definition;
    this.parameters = {
      ...(init.definition.config?.parameters ?? {}),
      ...(init.parameters ?? {}),
    };
  }

  node(id: string): ItemNode {
    const n = this.items.get(id);
    if (!n) throw new Error(`unknown item id ${id}`);
    return n;
  }

  view(id: string): ItemView {
    let v = this.views.get(id);
    if (!v) {
      v = new ItemView(this.node(id), this);
      this.views.set(id, v);
    }
    return v;
  }

  /**
   * Create an item. Ids are structural (`1`, `1.2`, `1.2.3`) so they are
   * reproducible across runs — no counter racing, no RNG (§8).
   */
  createItem(spec: {
    id: string;
    type: string;
    parentId: string | null;
    data: unknown;
    objects?: Record<string, unknown>;
    target_state?: string | null;
    next_task?: string | null;
    logging_context?: Record<string, unknown>;
  }): ItemNode {
    if (this.items.has(spec.id)) {
      throw new Error(`duplicate item id ${spec.id}`);
    }
    const node: ItemNode = {
      id: spec.id,
      type: spec.type,
      parentId: spec.parentId,
      childIds: [],
      data: spec.data,
      objects: spec.objects ?? {},
      tasks: {},
      trajectory: [],
      next_task: spec.next_task ?? null,
      target_state: spec.target_state ?? null,
      logging_context: spec.logging_context ?? {},
      additional_properties: {},
      status: "ready",
      createdIndex: this.createdCount++,
    };
    this.items.set(node.id, node);
    if (spec.parentId) this.node(spec.parentId).childIds.push(node.id);
    else this.root = node;
    return node;
  }

  /** Items in creation order. */
  allNodes(): ItemNode[] {
    return [...this.items.values()].sort(
      (a, b) => a.createdIndex - b.createdIndex,
    );
  }

  record(entry: TrajectoryEntry): void {
    this.node(entry.item_id).trajectory.push(entry);
    this.log.push(entry);
  }

  /** `[E3]` build the `ctx` binding. Frozen; expressions cannot mutate it. */
  ctxView(): CtxView {
    const self = this;
    const view: CtxView = {
      workflow: Object.freeze({
        client_id: self.definition.client_id,
        name: self.definition.name,
        version: self.definition.version ?? null,
      }),
      parameters: Object.freeze({ ...self.parameters }),
      get items() {
        return Object.freeze(self.allNodes().map((n) => self.view(n.id)));
      },
      item: (id) => (self.items.has(id) ? self.view(id) : undefined),
      byType: (type) =>
        self
          .allNodes()
          .filter((n) => n.type === type)
          .map((n) => self.view(n.id)),
      byTask: (task) =>
        self
          .allNodes()
          .filter((n) => n.tasks[task] !== undefined)
          .map((n) => self.view(n.id)),
      visits: (task) =>
        Object.freeze(
          self
            .allNodes()
            .flatMap((n) => n.trajectory.filter((e) => e.task === task)),
        ),
      trajectory: (itemId?: string) => {
        if (itemId !== undefined) {
          return Object.freeze([...self.node(itemId).trajectory]);
        }
        const out: Record<string, readonly TrajectoryEntry[]> = {};
        for (const n of self.allNodes()) out[n.id] = Object.freeze([...n.trajectory]);
        return Object.freeze(out);
      },
      count: (type?) =>
        type === undefined
          ? self.items.size
          : self.allNodes().filter((n) => n.type === type).length,
    };
    return Object.freeze(view);
  }

  snapshot(id: string = this.root.id): ItemSnapshot {
    const n = this.node(id);
    return {
      id: n.id,
      type: n.type,
      parent: n.parentId,
      items: n.childIds.map((c) => this.snapshot(c)),
      data: n.data,
      objects: n.objects,
      tasks: n.tasks,
      trajectory: n.trajectory,
      next_task: n.next_task,
      target_state: n.target_state,
      logging_context: n.logging_context,
      additional_properties: n.additional_properties,
    };
  }
}
