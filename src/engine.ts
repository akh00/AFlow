/**
 * The evaluation engine (spec artifact 4, §12).
 *
 * One `Engine` instance evaluates one workflow against one input. The loop is
 * §12 verbatim: collect the items whose next node's gate is open, run them —
 * concurrently, in any order — and repeat until every item's `next_task` is
 * `null`.
 */

import {
  EvaluationContext,
  type CtxView,
  type ItemNode,
  type ItemView,
} from "./context.js";
import { evalExpr, exprSource, runDo, truthy, type Scope } from "./expr.js";
import {
  bundleRegistry,
  defaultProviders,
  HTTP_REQUEST,
  toWorkflowError,
  type BundleRegistry,
  type EffectProvider,
  type HttpRequestValues,
} from "./providers.js";
import { resolveRetry, sleep } from "./retry.js";
import {
  DeadlockError,
  DeterminismViolation,
  WorkflowDefinitionError,
  type Evaluation,
  type EvaluationStatus,
  type ItemSnapshot,
  type Suspension,
  type TaskRecord,
  type TaskStatus,
  type TrajectoryEntry,
  type WorkflowError,
} from "./runtime.js";
import {
  BODY_KINDS,
  type BodyKind,
  type Expr,
  type Gate,
  type Node,
  type Route,
  type WorkflowDefinition,
} from "./types.js";

export interface EvaluateOptions {
  /** Extra providers, or overrides for `http` / `js` / `sub_workflow`. */
  providers?: Record<string, EffectProvider>;
  /** §9 libraries for `provider: js`, keyed by `name` or `name@version`. */
  bundles?: Record<string, Record<string, unknown>> | BundleRegistry;
  /** Values reachable as `parameters[...]`; merged over `config.parameters`. */
  parameters?: Record<string, unknown>;
  /** Injectable `fetch` for `provider: http`. */
  fetch?: typeof globalThis.fetch;
  /** Resolve a workflow by name for `provider: sub_workflow`. */
  resolveWorkflow?: (ref: {
    client_id: string;
    name: string;
  }) => WorkflowDefinition | Promise<WorkflowDefinition> | undefined;
  /** Include the item tree in the response. */
  includeTrace?: boolean;
  /** Include the flat cross-item visit log in the response. */
  includeTrajectory?: boolean;
  /** `[E5]` cap on simultaneously-running `call` bodies; overrides config. */
  maxParallel?: number;
  /** Injectable clock, so timestamps are reproducible in tests. */
  now?: () => Date;
  /** Injectable evaluation id. */
  evaluationId?: string;
  /** Hard cap on node visits, as a runaway-loop backstop. */
  maxVisits?: number;
}

/** Thrown internally when an effect parks on an offline retry (§11). */
class SuspendSignal extends Error {
  constructor(readonly suspension: Suspension) {
    super(`suspended: ${suspension.reason}`);
  }
}

let evaluationCounter = 0;

export async function evaluate(
  definition: WorkflowDefinition,
  input: unknown,
  options: EvaluateOptions = {},
): Promise<Evaluation> {
  return new Engine(definition, options).run(input);
}

export class Engine {
  private readonly ctx: EvaluationContext;
  private readonly nodes = new Map<string, Node>();
  private readonly providers: Record<string, EffectProvider>;
  private readonly bundles: BundleRegistry | undefined;
  private readonly now: () => Date;
  private readonly maxParallel: number;
  private readonly maxVisits: number;

  /** In-flight visits, so the loop can await progress. */
  private readonly inflight = new Map<string, Promise<void>>();
  /** Every visit id currently executing, including detached branches. */
  private readonly liveVisits = new Set<string>();
  /** In-flight `call` bodies, for the `[E5]` concurrency cap. */
  private inflightCalls = 0;
  /** §8 detached branches (`async: true`), keyed `${itemId}::${node}`. */
  private readonly branches = new Map<string, Promise<void>>();
  /** A detached branch that threw; surfaced by the loop. */
  private branchError: unknown;

  /**
   * §8 rule 1: two live branches writing the same `objects` path is a
   * validation error. Key is `itemId::topLevelKey` → the visit that wrote it.
   */
  private readonly writes = new Map<string, string>();
  /**
   * Visit lifetimes on a logical clock, so "were these two writers ever live at
   * the same time?" can be answered after both have finished. A short visit's
   * claim must outlive the visit itself, or a long branch claiming the same
   * path afterwards would look sequential.
   */
  private readonly visitSpans = new Map<string, { start: number; end: number }>();
  private tick = 0;

  private visitCount = 0;
  private visitSeq = 0;
  private suspension: Suspension | undefined;
  private cachedCtxView: CtxView | undefined;

  constructor(
    private readonly definition: WorkflowDefinition,
    private readonly options: EvaluateOptions = {},
  ) {
    validateDefinition(definition);
    for (const n of definition.tasks) this.nodes.set(n.name, n);

    this.ctx = new EvaluationContext({ definition, parameters: options.parameters });
    this.providers = {
      ...defaultProviders({ fetch: options.fetch }),
      ...(options.providers ?? {}),
    };
    this.bundles = normalizeBundles(options.bundles);
    this.now = options.now ?? (() => new Date());
    this.maxParallel = Math.max(
      1,
      options.maxParallel ??
        definition.config?.defaults?.concurrency?.max_parallel ??
        Number.POSITIVE_INFINITY,
    );
    this.maxVisits = options.maxVisits ?? 100_000;
  }

  // ── entry point ──────────────────────────────────────────────────────────

  async run(input: unknown): Promise<Evaluation> {
    const submittedAt = this.now().toISOString();
    const id =
      this.options.evaluationId ?? `ev_${(++evaluationCounter).toString(36).padStart(6, "0")}`;

    this.createRoot(input);

    let status: EvaluationStatus;
    try {
      await this.loop();
      status = this.suspension ? "suspended" : this.terminalStatus();
    } catch (cause) {
      if (cause instanceof SuspendSignal) {
        this.suspension = cause.suspension;
        status = "suspended";
      } else {
        throw cause;
      }
    }

    const completed = status === "succeeded" || status === "failed";
    const finishedAt = this.now().toISOString();

    const evaluation: Evaluation = {
      id,
      status,
      workflow: {
        client_id: this.definition.client_id,
        name: this.definition.name,
        version: this.definition.version ?? null,
      },
      target_state: this.ctx.root.target_state,
      submitted_at: submittedAt,
      updated_at: finishedAt,
      completed_at: completed ? finishedAt : null,
    };

    if (status === "succeeded") evaluation.result = this.finalResult();
    if (status === "failed") evaluation.error = this.finalError();
    if (this.suspension) evaluation.suspension = this.suspension;
    if (this.options.includeTrace) evaluation.trace = this.trace();
    if (this.options.includeTrajectory) evaluation.trajectory = [...this.ctx.log];

    return evaluation;
  }

  /** The item tree, for `include_trace`. */
  trace(): ItemSnapshot {
    return this.ctx.snapshot();
  }

  /** The flat cross-item visit log — diagnostics only (§8). */
  get log(): readonly TrajectoryEntry[] {
    return this.ctx.log;
  }

  // ── setup ────────────────────────────────────────────────────────────────

  private rootItemType(): string {
    const decls = this.definition.items ?? {};
    for (const [name, decl] of Object.entries(decls)) {
      if (decl.parent === null || decl.parent === undefined) return name;
    }
    return "input";
  }

  private entryNode(): string {
    const configured = this.definition.config?.defaults?.entry;
    if (configured) {
      if (!this.nodes.has(configured)) {
        throw new WorkflowDefinitionError(`config.defaults.entry names an unknown node: ${configured}`);
      }
      return configured;
    }
    if (this.nodes.has("Input")) return "Input";
    const rootType = this.rootItemType();
    const first = this.definition.tasks.find((n) => n.item === rootType);
    if (!first) {
      throw new WorkflowDefinitionError(
        `no entry node: define a node named \`Input\`, set config.defaults.entry, or declare a node bound to item type \`${rootType}\``,
      );
    }
    return first.name;
  }

  private createRoot(input: unknown): void {
    const defaults = this.definition.config?.defaults?.item;
    this.ctx.createItem({
      id: "1",
      type: this.rootItemType(),
      parentId: null,
      data: input,
      objects: structuredClone(defaults?.objects ?? {}),
      target_state: defaults?.target_state ?? "success",
      next_task: this.entryNode(),
    });
  }

  // ── the §12 loop ─────────────────────────────────────────────────────────

  private async loop(): Promise<void> {
    for (;;) {
      if (this.branchError) throw this.branchError;

      const runnable = this.collectRunnable();
      let started = 0;
      let deferred = 0;

      for (const { item, node, set } of runnable) {
        // `[E5]` cap on simultaneous `call` bodies. Accounted synchronously so
        // one scheduling pass cannot blow past the cap.
        if (node.call && this.inflightCalls >= this.maxParallel) {
          deferred++;
          continue;
        }
        this.startVisit(item, node, set);
        started++;
      }

      if (started > 0) {
        // Starting work can make other items runnable straight away — an
        // `async` node routes its item onward before its body has run (§8). Do
        // one more scheduling pass before parking on a completion, or the
        // async branch would serialize the very flow it is meant to overlap.
        await Promise.resolve();
        continue;
      }

      if (this.inflight.size === 0 && this.branches.size === 0) {
        // Quiescent: either every branch has ended, or nothing can progress.
        const stuck = this.ctx
          .allNodes()
          .filter((n) => n.next_task !== null && n.status !== "done");
        if (stuck.length === 0) return;
        if (deferred > 0) continue;
        this.reportDeadlock(stuck);
      }

      await Promise.race([...this.inflight.values(), ...this.branches.values()]);
    }
  }

  private collectRunnable(): Array<{ item: ItemNode; node: Node; set?: ItemView[] }> {
    const out: Array<{ item: ItemNode; node: Node; set?: ItemView[] }> = [];
    for (const item of this.ctx.allNodes()) {
      if (item.status !== "ready" || item.next_task === null) continue;
      if (item.sequencePredecessor) {
        const pred = this.ctx.items.get(item.sequencePredecessor);
        if (pred && pred.status !== "done") continue;
      }
      const node = this.nodeFor(item);
      const gate = this.evaluateGate(item, node);
      if (!gate.open) continue;
      out.push({ item, node, set: gate.set });
    }
    return out;
  }

  private nodeFor(item: ItemNode): Node {
    const node = this.nodes.get(item.next_task!);
    if (!node) {
      throw new WorkflowDefinitionError(
        `item ${item.id} routes to unknown node \`${item.next_task}\``,
      );
    }
    if (node.item !== item.type) {
      throw new WorkflowDefinitionError(
        `node \`${node.name}\` is bound to item type \`${node.item}\` but item ${item.id} is \`${item.type}\``,
      );
    }
    return node;
  }

  private reportDeadlock(stuck: ItemNode[]): never {
    const detail = stuck.map((n) => {
      const node = this.nodes.get(n.next_task!);
      const gate = node ? this.evaluateGate(n, node) : undefined;
      return {
        item_id: n.id,
        item_type: n.type,
        blocked_on: n.next_task,
        reason: gate?.reason ?? "unknown",
      };
    });
    throw new DeadlockError(
      `evaluation cannot progress: ${detail.length} item(s) blocked (${detail
        .map((d) => `${d.item_id}@${d.blocked_on} [${d.reason}]`)
        .join(", ")})`,
      { blocked: detail },
    );
  }

  // ── gate phase (§4, §7) ──────────────────────────────────────────────────

  private evaluateGate(
    item: ItemNode,
    node: Node,
  ): { open: boolean; set?: ItemView[]; reason?: string } {
    if (node.condition !== undefined) {
      const ok = truthy(
        evalExpr(node.condition, this.scope(item), {
          self: this.ctx.view(item.id),
          where: `${node.name}.condition`,
        }),
      );
      if (!ok) return { open: false, reason: "condition" };
    }

    const gate = node.aggregate ?? normalizeAwait(node.await);
    if (!gate) return { open: true };

    const set = gate.select
      ? asItemViews(
          evalExpr(gate.select, this.scope(item), {
            self: this.ctx.view(item.id),
            where: `${node.name}.select`,
          }),
          node.name,
        )
      : [];

    if (!gate.until) return { open: true, set };

    const ok = truthy(
      evalExpr(gate.until, this.scope(item, { set }), {
        self: this.ctx.view(item.id),
        where: `${node.name}.until`,
      }),
    );
    return ok ? { open: true, set } : { open: false, set, reason: "until" };
  }

  // ── one visit: body → state → route ──────────────────────────────────────

  private startVisit(item: ItemNode, node: Node, set?: ItemView[]): void {
    if (++this.visitCount > this.maxVisits) {
      throw new DeadlockError(
        `visit limit ${this.maxVisits} exceeded — the workflow is probably looping`,
      );
    }
    const visitId = `v${this.visitSeq++}`;
    item.status = "running";
    this.liveVisits.add(visitId);
    this.visitSpans.set(visitId, { start: this.tick++, end: Number.POSITIVE_INFINITY });
    if (node.call) this.inflightCalls++;
    const settle = () => {
      if (node.call) this.inflightCalls--;
      this.liveVisits.delete(visitId);
      this.visitSpans.get(visitId)!.end = this.tick++;
      // Once nothing is in flight, no future visit can overlap a past one, so
      // the bookkeeping can be dropped wholesale.
      if (this.liveVisits.size === 0) {
        this.visitSpans.clear();
        this.writes.clear();
      }
    };

    if (node.async) {
      // §8: the flow continues past this node without waiting. The node's own
      // work becomes a detached branch; the item routes immediately.
      this.beginPendingRecord(item, node);
      this.applyState(item, node, item.tasks[node.name]);
      this.applyRoute(item, node);
      this.appendTrajectory(item, node, item.tasks[node.name], "pending");
      item.status = item.next_task === null ? "done" : "ready";

      const key = `${item.id}::${node.name}`;
      const branch = this.runBody(item, node, set, visitId)
        .then((outcome) => {
          this.writeRecord(item, node, outcome);
          this.appendTrajectory(item, node, item.tasks[node.name], outcome.status);
        })
        .catch((cause) => {
          if (cause instanceof SuspendSignal) {
            this.suspension ??= cause.suspension;
            return;
          }
          // Nothing races a detached branch once the loop has moved on, so
          // park the error where the loop will find it.
          this.branchError ??= cause;
        })
        .finally(() => {
          this.branches.delete(key);
          settle();
        });
      this.branches.set(key, branch);
      return;
    }

    const promise = (async () => {
      const outcome = await this.runBody(item, node, set, visitId);
      this.writeRecord(item, node, outcome);
      if (outcome.status === "error") {
        this.runErrorHandler(item, node, outcome.error!, visitId);
      }
      this.applyState(item, node, item.tasks[node.name]);
      if (node.return) item.next_task = null;
      else this.applyRoute(item, node);
      this.appendTrajectory(item, node, item.tasks[node.name], outcome.status);
      item.status = item.next_task === null ? "done" : "ready";
    })()
      .catch((cause) => {
        item.status = "done";
        throw cause;
      })
      .finally(() => {
        this.inflight.delete(visitId);
        settle();
      });

    this.inflight.set(visitId, promise);
  }

  private async runBody(
    item: ItemNode,
    node: Node,
    set: ItemView[] | undefined,
    visitId: string,
  ): Promise<BodyOutcome> {
    const kind = bodyKindOf(node);
    const rec: WriteRecorder = { keys: new Set() };
    try {
      switch (kind) {
        case undefined:
          return { status: "success" };
        case "enrich":
          return this.bodyEnrich(item, node, rec);
        case "split":
          return this.bodySplit(item, node);
        case "aggregate":
          return this.bodyAggregate(item, node, set ?? [], rec);
        case "dispatch":
          return this.bodyDispatch(item, node);
        case "return":
          return this.bodyReturn(item, node);
        case "call":
          return await this.bodyCall(item, node, rec);
      }
    } finally {
      this.claimWrites(item, rec.keys, visitId, node.name);
    }
  }

  // ── bodies (§6) ──────────────────────────────────────────────────────────

  private bodyEnrich(item: ItemNode, node: Node, rec: WriteRecorder): BodyOutcome {
    const body = node.enrich!;
    const e: Expr = typeof body === "string" ? { $do: body } : body;
    const scope = this.scope(item, {}, rec);
    runDo(e, scope, { self: this.ctx.view(item.id), where: `${node.name}.enrich` });
    this.writeBack(item, scope);
    return { status: "success" };
  }

  private bodySplit(item: ItemNode, node: Node): BodyOutcome {
    const split = node.split!;
    const produced = evalExpr(split.selector, this.scope(item), {
      self: this.ctx.view(item.id),
      where: `${node.name}.split.selector`,
    });
    if (!Array.isArray(produced)) {
      throw new WorkflowDefinitionError(
        `${node.name}.split.selector must return an array, got ${typeof produced}`,
      );
    }

    const defaults = this.definition.config?.defaults?.item;
    const created: string[] = [];
    let previous: string | undefined;

    produced.forEach((data, index) => {
      // `[E1]` item type may vary per child.
      const type =
        typeof split.item_type === "string"
          ? split.item_type
          : String(
              evalExpr(split.item_type, this.prospectiveScope(item, data, index), {
                where: `${node.name}.split.item_type`,
              }),
            );
      this.assertItemType(type, node);

      const child = this.ctx.createItem({
        id: `${item.id}.${index + 1}`,
        type,
        parentId: item.id,
        data,
        objects: structuredClone(defaults?.objects ?? {}),
        target_state: defaults?.target_state ?? "success",
        next_task: null,
      });

      // `[E1]` route may vary per child; evaluated with `this` bound to it.
      child.next_task = this.resolveRoute(
        split.route ?? null,
        child,
        `${node.name}.split.route`,
      );
      child.status = child.next_task === null ? "done" : "ready";

      // Non-parallel splits run their children in selector order (§6.3, §8).
      if (!split.parallel && previous) child.sequencePredecessor = previous;
      previous = child.id;
      created.push(child.id);
    });

    return {
      status: "success",
      result: { created, item_type: split.item_type, parallel: Boolean(split.parallel) },
    };
  }

  private bodyAggregate(
    item: ItemNode,
    node: Node,
    set: ItemView[],
    rec: WriteRecorder,
  ): BodyOutcome {
    const agg = node.aggregate!;
    if (agg.reduce) {
      const scope = this.scope(item, { set }, rec);
      runDo(agg.reduce, scope, {
        self: this.ctx.view(item.id),
        where: `${node.name}.reduce`,
      });
      this.writeBack(item, scope);
    }
    return { status: "success", result: { selected: set.map((v) => v.id) } };
  }

  /** `[E4]` re-activate a selected set of items onto a computed node. */
  private bodyDispatch(item: ItemNode, node: Node): BodyOutcome {
    const dispatch = node.dispatch!;
    const set = asItemViews(
      evalExpr(dispatch.select, this.scope(item), {
        self: this.ctx.view(item.id),
        where: `${node.name}.dispatch.select`,
      }),
      node.name,
    );

    const dispatched: Array<{ item_id: string; next_task: string | null }> = [];
    for (const view of set) {
      const target = view.unwrap();
      if (target.status === "running") {
        throw new DeterminismViolation(
          `${node.name}.dispatch targets item ${target.id}, which is mid-visit — dispatch may only re-activate items whose branch has ended`,
        );
      }
      const next = this.resolveRoute(dispatch.route, target, `${node.name}.dispatch.route`);
      target.next_task = next;
      target.status = next === null ? "done" : "ready";
      // Re-activation restarts a sequential group from scratch.
      delete target.sequencePredecessor;
      dispatched.push({ item_id: target.id, next_task: next });
    }
    return { status: "success", result: { dispatched } };
  }

  private bodyReturn(item: ItemNode, node: Node): BodyOutcome {
    const ret = node.return!;
    if (ret.result !== undefined) {
      this.ctx.returnedResult = {
        value: evalExpr(ret.result, this.scope(item), {
          self: this.ctx.view(item.id),
          where: `${node.name}.return.result`,
        }),
      };
    }
    if (ret.error !== undefined) {
      this.ctx.returnedError = evalExpr(ret.error, this.scope(item), {
        self: this.ctx.view(item.id),
        where: `${node.name}.return.error`,
      }) as WorkflowError;
    }
    return { status: "success" };
  }

  // ── call (§9) + retry (§11) ──────────────────────────────────────────────

  private async bodyCall(
    item: ItemNode,
    node: Node,
    rec: WriteRecorder,
  ): Promise<BodyOutcome> {
    const call = node.call!;
    const provider = this.providers[call.provider];
    if (!provider) {
      throw new WorkflowDefinitionError(
        `node ${node.name}: unknown call provider \`${call.provider}\``,
      );
    }

    const view = this.ctx.view(item.id);
    const input =
      call.input === undefined
        ? undefined
        : evalExpr(call.input, this.scope(item), {
            self: view,
            where: `${node.name}.call.input`,
          });

    const attempts = { inline: 0, offline: 0 };
    this.inflightCalls++;
    try {
      for (;;) {
        const controller = new AbortController();
        const timer =
          node.timeout && node.timeout > 0
            ? setTimeout(() => controller.abort(), node.timeout)
            : undefined;

        const invocation = {
          node,
          call,
          item: view,
          input,
          parameters: this.ctx.parameters,
          bundles: this.bundles,
          signal: controller.signal,
          attempt: attempts.inline + attempts.offline,
          definition: this.definition,
          evaluateSubWorkflow: this.subWorkflowRunner(),
          [HTTP_REQUEST]:
            call.provider === "http" ? this.httpRequestValues(item, node) : undefined,
        };

        let raw: unknown;
        let failure: WorkflowError | undefined;
        try {
          // A provider is free to ignore `signal`, so the timeout is enforced
          // here rather than trusted to the provider.
          raw = await Promise.race([
            provider(invocation as never),
            abortRace(controller.signal),
          ]);
        } catch (cause) {
          failure = controller.signal.aborted
            ? {
                code: 504,
                category: "TECHNICAL",
                message: `node ${node.name} timed out after ${node.timeout}ms`,
                retry_type: "inline_then_offline",
              }
            : toWorkflowError(cause);
        } finally {
          if (timer) clearTimeout(timer);
          controller.abort();
        }

        // §11: a pure output transform may turn a success into an error.
        if (!failure && call.output?.transform) {
          const transformed = evalExpr(
            call.output.transform,
            this.scope(item, { result: raw, input }),
            { self: view, where: `${node.name}.call.output.transform` },
          ) as { error?: WorkflowError } | unknown;
          if (transformed && typeof transformed === "object" && "error" in (transformed as object)) {
            failure = (transformed as { error: WorkflowError }).error;
          } else {
            raw = transformed;
          }
        }

        if (!failure) {
          if (call.output?.enrich) {
            const scope = this.scope(item, { result: raw, input }, rec);
            runDo(call.output.enrich, scope, {
              self: view,
              where: `${node.name}.call.output.enrich`,
            });
            this.writeBack(item, scope);
          }
          return { status: "success", result: raw };
        }

        const decision = resolveRetry(failure.retry_type, node.retry, attempts);
        if (decision.kind === "inline") {
          attempts.inline++;
          await sleep(decision.delayMs);
          continue;
        }
        if (decision.kind === "offline") {
          const nextRetry = new Date(this.now().getTime() + decision.delayMs).toISOString();
          const parked: WorkflowError = {
            ...failure,
            retry_type: "offline",
            next_retry: nextRetry,
          };
          if (node.retry?.catch_offline_retry_error) {
            // §11: store it and let the flow continue.
            return { status: "error", error: parked };
          }
          throw new SuspendSignal({
            reason: "offline_retry",
            task: node.name,
            item_id: item.id,
            attempt: attempts.offline,
            next_retry_at: nextRetry,
          });
        }
        return { status: "error", error: { ...failure, retry_type: null } };
      }
    } finally {
      this.inflightCalls--;
    }
  }

  private httpRequestValues(item: ItemNode, node: Node): HttpRequestValues | undefined {
    const req = node.call?.request;
    if (!req) return undefined;
    const view = this.ctx.view(item.id);
    const ev = (e: Expr | undefined, where: string) =>
      e === undefined ? undefined : evalExpr(e, this.scope(item), { self: view, where });
    return {
      method: (req.method ?? "GET").toUpperCase(),
      url: String(ev(req.url, `${node.name}.call.request.url`) ?? ""),
      headers: (ev(req.headers, `${node.name}.call.request.headers`) ?? {}) as Record<string, string>,
      body: ev(req.body, `${node.name}.call.request.body`),
    };
  }

  private subWorkflowRunner() {
    const resolve = this.options.resolveWorkflow;
    if (!resolve) return undefined;
    return async (ref: { client_id: string; name: string }, input: unknown) => {
      const def = await resolve(ref);
      if (!def) {
        return {
          error: {
            code: 404,
            category: "TECHNICAL",
            message: `sub-workflow not found: ${ref.client_id}/${ref.name}`,
          } satisfies WorkflowError,
        };
      }
      const sub = await evaluate(def, input, { ...this.options, includeTrace: false });
      return sub.status === "failed"
        ? { error: sub.error }
        : { result: sub.result };
    };
  }

  // ── state phase (§4) ─────────────────────────────────────────────────────

  private applyState(item: ItemNode, node: Node, record: TaskRecord | undefined): void {
    const setter =
      node.target_state_setter ??
      this.definition.config?.defaults?.item?.default_target_state_setter;

    if (!setter) {
      // No setter anywhere: a captured error still has to be routable.
      if (record?.status === "error") item.target_state = "failure";
      return;
    }

    const scope = this.scope(item, {
      task_state: record,
      error: record?.error ?? null,
      result: record?.result,
    });
    const next = evalExpr(setter, scope, {
      self: this.ctx.view(item.id),
      where: `${node.name}.target_state_setter`,
    });
    if (next === undefined || next === null) return;

    const value = String(next);
    const allowed = this.definition.config?.defaults?.item?.allowed_target_states;
    if (allowed && !allowed.includes(value)) {
      throw new WorkflowDefinitionError(
        `${node.name}: target_state \`${value}\` is not in allowed_target_states [${allowed.join(", ")}]`,
      );
    }
    item.target_state = value;
  }

  // ── route phase (§4) ─────────────────────────────────────────────────────

  private applyRoute(item: ItemNode, node: Node): void {
    const route = node.route ?? this.definition.config?.defaults?.task?.route;
    item.next_task = this.resolveRoute(route ?? null, item, `${node.name}.route`);
  }

  private resolveRoute(route: Route | undefined, item: ItemNode, where: string): string | null {
    if (route === undefined || route === null) return null;

    const view = this.ctx.view(item.id);

    if (typeof route === "string") return this.assertNode(route, where);

    if ("$expr" in route && !("cases" in route)) {
      const v = evalExpr(route as Expr, this.scope(item), { self: view, where });
      return v === null || v === undefined ? null : this.assertNode(String(v), where);
    }

    const sw = (route as { switch?: Expr }).switch;
    const cases = (route as { cases: Record<string, string | null> }).cases;
    const key = String(
      sw === undefined
        ? item.target_state
        : evalExpr(sw, this.scope(item), { self: view, where: `${where}.switch` }),
    );

    if (key in cases) {
      const target = cases[key];
      return target === null || target === undefined ? null : this.assertNode(target, where);
    }
    if ("default" in route) {
      const fallback = (route as { default?: string | null }).default;
      return fallback === null || fallback === undefined
        ? null
        : this.assertNode(fallback, where);
    }
    throw new WorkflowDefinitionError(
      `${where}: no case for \`${key}\` and no \`default\` (cases: ${Object.keys(cases).join(", ")})`,
    );
  }

  private assertNode(name: string, where: string): string {
    if (!this.nodes.has(name)) {
      throw new WorkflowDefinitionError(`${where}: routes to unknown node \`${name}\``);
    }
    return name;
  }

  private assertItemType(type: string, node: Node): void {
    const declared = this.definition.items;
    if (declared && !(type in declared)) {
      throw new WorkflowDefinitionError(
        `${node.name}.split produced undeclared item type \`${type}\` (declared: ${Object.keys(declared).join(", ")})`,
      );
    }
  }

  // ── records & trajectory (§3, [E2]) ──────────────────────────────────────

  private beginPendingRecord(item: ItemNode, node: Node): void {
    const ts = this.now().toISOString();
    const prior = item.tasks[node.name];
    item.tasks[node.name] = {
      id: `${item.id}:${node.name}:${(prior?.attempts ?? 0) + 1}`,
      status: "pending",
      started: ts,
      updated: ts,
      attempts: (prior?.attempts ?? 0) + 1,
    };
  }

  private writeRecord(item: ItemNode, node: Node, outcome: BodyOutcome): void {
    const ts = this.now().toISOString();
    const prior = item.tasks[node.name];
    const attempts = prior?.status === "pending" ? prior.attempts : (prior?.attempts ?? 0) + 1;
    item.tasks[node.name] = {
      id: prior?.status === "pending" ? prior.id : `${item.id}:${node.name}:${attempts}`,
      status: outcome.status,
      started: prior?.status === "pending" ? prior.started : ts,
      updated: ts,
      attempts,
      result: outcome.result,
      error: outcome.error ?? null,
    };
  }

  private appendTrajectory(
    item: ItemNode,
    node: Node,
    record: TaskRecord | undefined,
    status: TaskStatus,
  ): void {
    this.ctx.record({
      seq: item.trajectory.length,
      item_id: item.id,
      item_type: item.type,
      task: node.name,
      attempt: record?.attempts ?? 1,
      status,
      started: record?.started ?? this.now().toISOString(),
      updated: record?.updated ?? this.now().toISOString(),
      target_state: item.target_state,
      next_task: item.next_task,
      result: record?.result,
      error: record?.error ?? null,
    });
  }

  private runErrorHandler(
    item: ItemNode,
    node: Node,
    error: WorkflowError,
    visitId: string,
  ): void {
    const handler = this.definition.config?.defaults?.task?.default_error_handler;
    if (!handler?.$do) return;
    const rec: WriteRecorder = { keys: new Set() };
    const scope = this.scope(item, { error, task_state: item.tasks[node.name] }, rec);
    try {
      runDo({ $do: handler.$do }, scope, {
        self: this.ctx.view(item.id),
        where: "config.defaults.task.default_error_handler",
      });
      this.writeBack(item, scope);
    } finally {
      this.claimWrites(item, rec.keys, visitId, "default_error_handler");
    }
  }

  // ── §8 rule 1: concurrent writes to the same path ────────────────────────

  /**
   * Wrap an item's `objects` so a `$do` running against it reports which
   * top-level keys it assigned. Attribution has to be per-write, not a
   * before/after diff: a long-running branch would otherwise be blamed for
   * keys some other visit wrote while it was in flight.
   *
   * Granularity is the top-level key. `objects.a.b = 1` mutates the real
   * nested object and is not recorded — deep aliasing between concurrent
   * branches is out of scope for this check.
   */
  private recordingObjects(
    item: ItemNode,
    rec: WriteRecorder,
  ): Record<string, unknown> {
    return new Proxy(item.objects, {
      set(target, key, value) {
        if (typeof key === "string") rec.keys.add(key);
        (target as Record<string, unknown>)[key as string] = value;
        return true;
      },
      deleteProperty(target, key) {
        if (typeof key === "string") rec.keys.add(key);
        delete (target as Record<string, unknown>)[key as string];
        return true;
      },
      defineProperty(target, key, desc) {
        if (typeof key === "string") rec.keys.add(key);
        return Reflect.defineProperty(target, key, desc);
      },
    });
  }

  private claimWrites(
    item: ItemNode,
    keys: Set<string>,
    visitId: string,
    nodeName: string,
  ): void {
    const mine = this.visitSpans.get(visitId);
    for (const key of keys) {
      const path = `${item.id}::objects.${key}`;
      const owner = this.writes.get(path);
      if (owner && owner !== visitId) {
        const theirs = this.visitSpans.get(owner);
        // Overlap: the previous writer was still live when this visit began.
        if (theirs && mine && theirs.end > mine.start) {
          throw new DeterminismViolation(
            `two live branches write \`objects.${key}\` on item ${item.id} (§8 rule 1); the second was \`${nodeName}\``,
            { item: item.id, path, owner, writer: visitId },
          );
        }
      }
      this.writes.set(path, visitId);
    }
  }

  // ── expression scope ─────────────────────────────────────────────────────

  private ctxView(): CtxView {
    this.cachedCtxView ??= this.ctx.ctxView();
    return this.cachedCtxView;
  }

  private scope(item: ItemNode, extra: Scope = {}, rec?: WriteRecorder): Scope {
    const v = this.ctx.view(item.id);
    return {
      id: v.id,
      type: v.type,
      data: v.data,
      objects: rec ? this.recordingObjects(item, rec) : v.objects,
      tasks: v.tasks,
      trajectory: v.trajectory,
      items: v.items,
      parent: v.parent,
      root: v.root,
      next_task: v.next_task,
      target_state: v.target_state,
      logging_context: v.logging_context,
      additional_properties: v.additional_properties,
      optional: v.optional,
      parameters: this.ctx.parameters,
      ctx: this.ctxView(),
      self: v,
      ...extra,
    };
  }

  /** Scope for `[E1]` per-child `item_type`, before the child item exists. */
  private prospectiveScope(parent: ItemNode, data: unknown, index: number): Scope {
    const p = this.ctx.view(parent.id);
    return {
      data,
      index,
      objects: {},
      tasks: {},
      items: [],
      parent: p,
      root: p.root,
      parameters: this.ctx.parameters,
      ctx: this.ctxView(),
    };
  }

  /** Copy scalar rebindings a `$do` performed back onto the item. */
  private writeBack(item: ItemNode, scope: Scope): void {
    if (scope.data !== undefined && scope.data !== item.data) item.data = scope.data;
    if (scope.target_state !== item.target_state) {
      item.target_state = scope.target_state as string | null;
    }
    if (scope.next_task !== item.next_task) {
      item.next_task = scope.next_task as string | null;
    }
  }

  // ── termination (§12 step 3) ─────────────────────────────────────────────

  private terminalStatus(): EvaluationStatus {
    if (this.ctx.returnedError) return "failed";
    if (this.ctx.returnedResult) return "succeeded";
    return this.ctx.root.target_state === "failure" ? "failed" : "succeeded";
  }

  private finalResult(): unknown {
    if (this.ctx.returnedResult) return this.ctx.returnedResult.value;
    return this.ctx.root.objects.result ?? null;
  }

  private finalError(): WorkflowError {
    return (
      this.ctx.returnedError ?? {
        code: 500,
        category: "BUSINESS",
        message: `workflow determined target_state \`${this.ctx.root.target_state}\``,
      }
    );
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

interface BodyOutcome {
  status: TaskStatus;
  result?: unknown;
  error?: WorkflowError;
}

/** Collects the top-level `objects` keys one visit assigned. */
interface WriteRecorder {
  keys: Set<string>;
}

/** Rejects when the signal aborts; never resolves. */
function abortRace(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });
}

function bodyKindOf(node: Node): BodyKind | undefined {
  const present = BODY_KINDS.filter((k) => node[k] !== undefined);
  if (present.length > 1) {
    throw new WorkflowDefinitionError(
      `node \`${node.name}\` carries ${present.length} body kinds (${present.join(", ")}); at most one is allowed (§6)`,
    );
  }
  return present[0];
}

function normalizeAwait(a: Node["await"]): Gate | undefined {
  if (!a) return undefined;
  if (!Array.isArray(a)) return a;
  if (a.length === 0) return undefined;
  // §8 sugar: block until every named async branch on this item has settled.
  const names = JSON.stringify(a);
  return {
    select: { $expr: "[self]" },
    until: {
      $expr: `set.every(i => ${names}.every(n => i.tasks[n] && i.tasks[n].status !== 'pending'))`,
    },
  };
}

function asItemViews(v: unknown, where: string): ItemView[] {
  const arr = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v];
  for (const x of arr) {
    if (!x || typeof (x as ItemView).unwrap !== "function") {
      throw new WorkflowDefinitionError(
        `${where}: select must return items, got ${typeof x}`,
      );
    }
  }
  return arr as ItemView[];
}

function normalizeBundles(
  b: EvaluateOptions["bundles"],
): BundleRegistry | undefined {
  if (!b) return undefined;
  if (typeof (b as BundleRegistry).resolve === "function") return b as BundleRegistry;
  return bundleRegistry(b as Record<string, Record<string, unknown>>);
}

/** Static checks that do not need an input (§16 + the body-kind matrix). */
export function validateDefinition(def: WorkflowDefinition): void {
  if (!def.client_id) throw new WorkflowDefinitionError("workflow is missing `client_id`");
  if (!def.name) throw new WorkflowDefinitionError("workflow is missing `name`");
  if (!Array.isArray(def.tasks) || def.tasks.length === 0) {
    throw new WorkflowDefinitionError("workflow has no `tasks`");
  }

  const seen = new Set<string>();
  for (const node of def.tasks) {
    if (!node.name) throw new WorkflowDefinitionError("a node is missing `name`");
    if (!node.item) throw new WorkflowDefinitionError(`node \`${node.name}\` is missing \`item\``);
    if (seen.has(node.name)) {
      throw new WorkflowDefinitionError(`duplicate node name \`${node.name}\``);
    }
    seen.add(node.name);
    bodyKindOf(node);
    if (node.split && (node.split as { item_type?: unknown }).item_type === undefined) {
      throw new WorkflowDefinitionError(
        `node \`${node.name}\`: split is missing \`item_type\``,
      );
    }

    if (def.items && !(node.item in def.items)) {
      throw new WorkflowDefinitionError(
        `node \`${node.name}\` is bound to undeclared item type \`${node.item}\``,
      );
    }
    // Fail fast on unparseable expressions rather than at visit time.
    for (const e of collectExprs(node)) exprSource(e);
  }
}

function collectExprs(node: Node): Expr[] {
  const out: Expr[] = [];
  const push = (e: Expr | undefined) => {
    if (e !== undefined) out.push(e);
  };
  push(node.condition);
  push(node.target_state_setter);
  if (node.aggregate) {
    push(node.aggregate.select);
    push(node.aggregate.until);
    push(node.aggregate.reduce);
  }
  if (node.enrich) push(typeof node.enrich === "string" ? { $do: node.enrich } : node.enrich);
  if (node.split) push(node.split.selector);
  if (node.dispatch) push(node.dispatch.select);
  if (node.return) {
    push(node.return.result);
    push(node.return.error);
  }
  if (node.call) {
    push(node.call.input);
    push(node.call.output?.transform);
    push(node.call.output?.enrich);
    push(node.call.request?.url);
    push(node.call.request?.headers);
    push(node.call.request?.body);
  }
  return out;
}
