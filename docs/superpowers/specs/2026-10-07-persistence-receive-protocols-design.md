# Persistence & resume, external input, call protocols & adapters — design

> Status: **Approved design, pending spec review** · Date: 2026-10-07
>
> Lands in `docs/aflow-workflow-spec.md` as §19 **E6–E9**, in
> `docs/aflow-api.openapi.yaml`, and in `src/`. The workflow spec stays the source of
> truth: this document is the brief for editing it, not a parallel normative text.

## 1. Intent

Three capabilities requested for the engine:

1. **External service call** with a selectable protocol — REST and streamed HTTP now,
   plus **MCP** — whose request is built by an **adapter** that sees the whole workflow
   context. The adapter is defined inline in the task, or is an external function.
2. **A task that waits for external input**, delivered by an HTTP POST.
3. **Configurable persistence**: a level, plus per-task points, at which the whole
   workflow context is stored such that the evaluation can be retrieved and continued
   from that point.

(2) cannot exist without (3): an evaluation that waits days for a POST must be stored
and continued. (3) is the foundation; (2) is its first consumer, together with the
offline-retry resumption (§11) that today parks as `suspended` and never continues.

### Decisions taken

| Question | Decision |
|---|---|
| "HTTP streamable" | Streamed responses (SSE / NDJSON / chunked) are read to the end and captured as **one** result. Chunks never drive the workflow while the stream is open. |
| MCP scope | Engine is an MCP **client** over Streamable HTTP. `tools/call`, `resources/read`, `prompts/get`, selected per task. **One session per call attempt.** |
| MCP auth | Static headers computed from `parameters` (e.g. bearer token). OAuth out of scope. |
| Persistence model | **Levels + explicit checkpoints.** Suspension points always persist. |
| Storage strategy | **Full snapshot per checkpoint** (not journal + replay). |
| Store | Injected `Store` provider; `memoryStore()` for tests. Engine stays dependency-free. |
| Who listens for the POST | **Library-first**: `deliver()` / `resume()` library calls + OpenAPI paths. No HTTP server is built in this work. |
| Input correlation | **Engine-issued token** per waiting visit. No business-key correlation. |
| External adapter | **Effect side, output captured.** Runs inside the call's retry/timeout envelope on a frozen context snapshot; its output is recorded and never re-run on resume/replay. |
| Names | body kind **`receive`**; providers **`http`** (gains `response.stream`) and **`mcp`**; node flag **`checkpoint`**; field **`call.adapter`**. |

### Out of scope

- An HTTP server implementing the OpenAPI document, and a scheduler that fires
  `resume()` at `next_retry_at` / input expiry. The host does this.
- §10 validation. `receive.payload_type` is recorded and documented but **not enforced**
  until §10 validation lands — the spec text says so explicitly.
- MCP OAuth, MCP sessions spanning several tasks, MCP client capabilities (sampling,
  roots, elicitation).
- Streams whose chunks drive the workflow incrementally (would expose arrival order).
- Business-key correlation for inbound input.
- Persisting §8 rule-1 write-conflict tracking across a resume (see §2.5).

## 2. E6 — Persistence and resume

### 2.1 Configuration

```jsonc
"config": { "defaults": {
  "persistence": { "level": "checkpoint" }   // none | checkpoint | effects | every_task
} }
```

```jsonc
{ "name": "reserve_all", "item": "order",
  "checkpoint": true,        // snapshot after this visit
  "durable": true,           // snapshot before this visit runs (existing §4 field, now honoured)
  "idempotent": true,        // safe to re-invoke after a crash (existing §4 field, now honoured)
  … }
```

| Level | Snapshot taken |
|---|---|
| `none` (default) | Never voluntarily. A suspension point with no store configured is an engine error. |
| `checkpoint` | After visits of nodes with `checkpoint: true`; before visits of nodes with `durable: true`. |
| `effects` | As `checkpoint`, plus before and after every `call` attempt. |
| `every_task` | After every visit (and before `durable` ones). |

`checkpoint` / `durable` are ignored at `none`. **Suspension points always snapshot**,
regardless of level: an evaluation that returns `suspended` (offline retry, `receive`)
is unresumable otherwise. If a suspension is reached and no `store` was provided, the
evaluation errors rather than returning an unresumable `suspended`.

### 2.2 Snapshot contents

A snapshot is self-contained and JSON-serializable:

```jsonc
{
  "format": 1,
  "evaluation_id": "ev_…",
  "seq": 7,                                   // increments per save of this evaluation
  "saved_at": "…",
  "workflow": { "client_id": "…", "name": "…", "version": "…", "hash": "sha256:…" },
  "status": "running" | "suspended" | "succeeded" | "failed",
  "submitted_at": "…",
  "items": [ /* every item, creation order: §3 fields + status, createdIndex, sequencePredecessor */ ],
  "returned": { "result": …, "error": … },    // `return` bodies already executed
  "counters": { "visit_count": 42, "visit_seq": 42 },
  "log": [ /* E2 flat cross-item log */ ],
  "suspension": { … } | null,
  "pending_inputs": [ /* E7 */ ]
}
```

`workflow.hash` is over the canonical JSON of the definition. `resume()` / `deliver()`
refuse a definition whose hash differs — continuing a snapshot against a changed graph
is undefined, so it is rejected, not attempted.

The engine is single-threaded, so between awaits the item tree is consistent: a
snapshot never observes half a visit.

### 2.3 In-flight work and effect delivery

A visit that is **in flight** at snapshot time — including an `async` branch whose
record is `pending` — is stored with its item `ready` on that same node. Resuming
re-runs the visit from its start. The one exception is a `receive` visit (E7) waiting
on its input: it is persisted as a pending input with its token, not reset, so a
resume never re-issues a token the external system already holds. Pure bodies are
trivially safe to re-run. Effects are
therefore **at-least-once**, and the rules for `call` are:

- At `effects` level a `call` saves a snapshot **before** invoking the provider, with
  the attempt marked `started` and the captured adapter request (E9), and **after** it
  returns, with the captured result.
- On resume, a `call` found `started` with no result is **in doubt**:
  - `idempotent: true` → re-invoked, with the same recorded request and the same
    `idempotency_key` = `{evaluation_id}:{item_id}:{task}:{attempt}`, passed to the
    provider (`http` sends it as an `Idempotency-Key` header; `mcp` in `_meta`).
  - otherwise → the visit completes `status: error`, code `409`, category `TECHNICAL`,
    message "in-doubt effect", `retry_type: null`, and proceeds through the normal error
    handler, state and route phases. The engine never silently invokes a
    non-idempotent effect twice.
- Below `effects` level, nothing records "started", so an in-flight `call` is simply
  re-run on resume. The spec states this plainly: below `effects`, effects in flight at
  the last snapshot may repeat.

### 2.4 Store contract

```ts
interface Store {
  save(snapshot: Snapshot): Promise<void>;          // latest wins; `seq` must not go backwards
  load(evaluationId: string): Promise<Snapshot | undefined>;
  findByToken(token: string): Promise<string | undefined>;  // → evaluation id (E7)
}
function memoryStore(): Store;
```

Only the latest snapshot per evaluation is required. A store MAY keep history.
`save` rejecting is an engine error for the evaluation (the guarantee cannot be kept).

### 2.5 Library API

```ts
evaluate(def, input, { store, … }): Promise<Evaluation>
resume(def, evaluationId, { store, … }): Promise<Evaluation>
deliver(def, evaluationId, token, payload, { store, … }): Promise<Evaluation>
```

`resume()` loads the latest snapshot and continues the §12 loop. It is how the host
continues an offline retry after `next_retry_at`, an expired `receive` (E7), or an
evaluation whose process died. Resuming a `succeeded`/`failed` snapshot returns it
unchanged.

§8 rule-1 write-conflict bookkeeping is not persisted: every live visit restarts on
resume, so no write claim can span the restart.

### 2.6 OpenAPI

- `POST /evaluations/{evaluationId}/resume` → `200` (completed in-request) or `202` +
  `Location`; `404` unknown evaluation; `409` workflow hash mismatch.
- `Evaluation` and `EvaluationOptions` unchanged except as E7 adds.
- `Node` gains `checkpoint`; `WorkflowConfig.defaults` gains `persistence`; the
  `durable` / `idempotent` descriptions change from aspirational to normative.

## 3. E7 — `receive`: waiting for external input

### 3.1 Shape

A seventh body kind. At most one body kind per node still holds, so §16 gains the six
`receive` pair rows (21 total), as does the OpenAPI `Node`, and `BODY_KINDS` gains
`"receive"`.

```jsonc
{ "name": "wait_approval", "item": "order",
  "receive": {
    "payload_type": "ApprovalDecision",   // recorded; enforced once §10 validation lands
    "expires": "48h",                    // optional; §11 duration syntax
    "output": { "enrich": { "$do": "objects.approval = result" } }   // as call.output
  },
  "route": { "switch": { "$expr": "objects.approval.decision" },
             "cases": { "approve": "commit", "reject": "release" } } }
```

`receive` sits on the effect side of §5: data enters from outside, so it is captured
into `tasks[name].result` exactly like a `call` result, and expressions read the
recorded value.

### 3.2 Lifecycle

1. **Arrive.** The engine issues a token (128 random bits, URL-safe) and writes
   `tasks[name] = { status: "pending", token, expires_at, … }`. Token and `expires_at`
   are engine-generated and recorded, so replay reads them rather than regenerating.
2. **Wait.** The item stays `running` on the node. Other items continue. When the loop
   has nothing runnable and nothing in flight except pending inputs, the evaluation
   snapshots and returns `suspended`, `reason: "await_input"`, listing **every** pending
   input. Several items waiting on the same node after a `split` each have their own
   token.
3. **Deliver.** `deliver(token, payload)` loads the snapshot and locates the pending
   input. The payload is captured as `tasks[name].result`; `output.enrich` (and
   `output.transform`, as for `call`) runs; then state and route; the loop continues.
4. **Expire.** If `resume()` runs at or after `expires_at`, the visit completes
   `status: error`, code `408`, message "input expired", `retry_type: null`, and
   proceeds through error handler, state and route. Expiry is evaluated only when the
   engine is invoked; the host schedules that from the suspension's
   `next_deadline_at`.

Errors from `deliver()`: unknown token → not found; already delivered or expired →
conflict; evaluation not suspended on that token → conflict.

### 3.3 Handing the token to the external system

No new mechanism: the existing §8 `async` reading (§19 *Interpretations*) already
routes the item onward while the record is `pending`.

```jsonc
{ "name": "wait_approval", "item": "order", "async": true,
  "receive": { "expires": "48h" }, "route": "request_approval" },
{ "name": "request_approval", "item": "order",
  "call": { "provider": "http",
            "request": { "method": "POST", "url": { "$expr": "parameters['approvals.url']" },
                         "body": { "$expr": "({ order: data.id, callback: `${parameters['aflow.base-url']}/evaluations/${ctx.evaluation.id}/inputs/${tasks.wait_approval.token}` })" } } },
  "route": "after_approval" },
{ "name": "after_approval", "item": "order", "await": ["wait_approval"], … }
```

This requires `ctx.evaluation.id` — added to E3's `ctx` table. The evaluation id is
fixed for the evaluation's lifetime, so it is order-free and deterministic.

Without `async`, the host obtains the token from the suspension.

### 3.4 Runtime and OpenAPI shapes

```jsonc
"suspension": {
  "reason": "await_input",               // added to the enum alongside offline_retry
  "pending_inputs": [ { "token": "…", "task": "wait_approval", "item_id": "1.2",
                        "expires_at": "…" } ],
  "next_deadline_at": "…"                // earliest of expires_at / next_retry_at
}
```

`TaskRecord` gains optional `token` and `expires_at`.

`POST /evaluations/{evaluationId}/inputs/{token}` — body: the payload (unconstrained
JSON, `x-aflow-type` naming `receive.payload_type`). `200` completed in-request; `202` +
`Location` suspended again or still running; `404` unknown evaluation or token; `409`
already delivered, expired, or not awaiting; `422` payload fails `payload_type` (once §10
validation exists). A workflow that *decides* failure after delivery is still `200` +
`status: failed`, per the API convention.

## 4. E8 — Call protocols

The protocol is selected by `call.provider`. No new body kind: `call` is already the
only I/O body and owns retry, timeout, concurrency and capture. Further protocols are
added the same way, via `options.providers`.

### 4.1 `http` — REST and streamed responses

`http` stays the REST provider and gains:

- `request.query` — applied (today it is parsed and ignored).
- `response.stream` — read a streamed body to the end:

```jsonc
"call": { "provider": "http",
  "request":  { "method": "POST", "url": {…}, "headers": {…}, "query": {…}, "body": {…} },
  "response": { "stream": {
    "format": "sse",                 // sse | ndjson | text
    "collect": "array",              // array (default) | last | concat
    "fold": { "$do": "acc.total = (acc.total ?? 0) + chunk.amount" },   // optional
    "max_chunks": 10000, "max_bytes": 10485760, "idle_timeout": 30000
  } } }
```

- Chunk parsing: `sse` → each event's `data` (JSON-parsed if it parses); `ndjson` → one
  JSON value per line; `text` → raw decoded chunks.
- `collect`: `array` of chunks, `last` chunk, or `concat` (strings joined / arrays
  flattened).
- `fold`, when present, replaces `collect`: a pure `$do` run once per chunk in stream
  order with `acc` (starting `{}`) and `chunk` bound; the final `acc` is the result.
  Order *within* one stream is the server's, and only the folded value is captured, so
  replay is deterministic. `fold` is subject to the §5 guard like every `$do`.
- `node.timeout` bounds the whole stream; `idle_timeout` bounds the gap between chunks.
  Exceeding any limit is a `TECHNICAL` error with `retry_type: "inline_then_offline"`
  for timeouts and `null` for size limits.
- Non-2xx status codes behave as today, before any stream is read.

### 4.2 `mcp` — MCP client over Streamable HTTP

```jsonc
"call": { "provider": "mcp",
  "server": { "url":     { "$expr": "parameters['mcp.flights']" },
              "headers": { "$expr": "({ authorization: `Bearer ${parameters['mcp.token']}` })" } },
  "operation": "tools/call",          // tools/call | resources/read | prompts/get
  "target": "search_flights",         // tool name | resource URI | prompt name
  "adapter": { "$expr": "({ arguments: { from: data.from, to: data.to } })" } }
```

Per **attempt**:

1. `POST initialize` (declaring no client capabilities, negotiating protocol version);
   retain `Mcp-Session-Id` if returned.
2. `POST notifications/initialized`.
3. `POST` the operation: `tools/call {name, arguments}`, `resources/read {uri}`, or
   `prompts/get {name, arguments}`. Accept `application/json` or `text/event-stream`
   (reusing `stream.ts`); in SSE, ignore notifications (progress, logging), answer any
   server-initiated request with JSON-RPC error `-32601`, and finish on the response
   whose `id` matches.
4. `DELETE` the session when a session id was issued (failure here is ignored).

Result mapping:

| Outcome | Captured as |
|---|---|
| `tools/call` result, `isError` false | success; result = the `CallToolResult` |
| `tools/call` result, `isError: true` | error, category `BUSINESS`, `retry_type: null`, `data` = the result |
| `resources/read`, `prompts/get` result | success; result = the protocol result |
| JSON-RPC error | error, code = JSON-RPC code, `BUSINESS`, `retry_type: null` |
| HTTP 5xx / I/O / timeout | `TECHNICAL`, `retry_type: "inline_then_offline"` (§11) |
| HTTP 4xx | `BUSINESS`, `retry_type: null` |

A session never outlives an attempt, so §11 retries and E6 resumes open a fresh one.

## 5. E9 — `call.adapter`

An optional field on every `call`, building the provider's request from the whole
context. When absent, today's `input` / `request` expressions behave unchanged.

| Provider | Adapter returns | Effect |
|---|---|---|
| `http` | `{ url?, headers?, query?, body? }` | merged over evaluated `request` (adapter wins per key) |
| `mcp` | `{ arguments?, target? }` | `target` overrides the static one |
| `js`, `sub_workflow` | any value | replaces `input` |

Two forms:

- **Inline** — `{ "$expr": … }` or `{ "$do": … }` (a `$do` assigns `request`). Pure,
  §5-guarded, full access to `this`, `parent`, `items`, `root`, `ctx`, `parameters`.
- **External** — `{ "function": { "bundle_name", "bundle_version", "entry" } }` or
  `{ "registry": { "url", "ref" } }`, resolved through the existing `BundleRegistry`.
  It runs on the **effect side**, as the first step of the call attempt, inside the
  call's timeout, retry and `[E5]` concurrency envelope, and may be async. It receives a
  deep-frozen JSON snapshot `{ self, root, items, parameters, workflow, evaluation_id }`
  — no live views, so it cannot write the tree. Throwing is a captured call error.

**Capture.** The adapter's output (either form) is recorded in `tasks[name].request`
and in the visit's trajectory entry. On resume at `effects` level the recorded request
is reused and the adapter is not invoked again; in-doubt re-invocation (§2.3) uses it
too. This is what keeps an external adapter — which the engine cannot inspect for
purity — on the right side of the §5 boundary.

## 6. Changes to existing documents

### `docs/aflow-workflow-spec.md`

- §19: retitle "Engine extensions (E1–E9)"; intro sentence changes ("all five are
  pure" no longer holds — E6 is engine machinery, E7/E8/E9 extend the effect side).
  Add E6, E7, E8, E9.
- TOC: §19 title.
- §1 non-goals: "offline retry storage … described at the contract level" now points
  at E6's store contract.
- §4 common fields: add `checkpoint`; `durable`/`idempotent` descriptions point at E6.
- §5: the effect side lists `receive` and the external adapter.
- §6 table: add `receive`; `call` row names `http` / `mcp` / `sub_workflow` / `js`.
- §9 providers table: `http` streaming, `mcp`; add `adapter` to the common shape.
- §11: offline retries resume via E6 `resume()`.
- §12: steps for snapshot points, suspension on pending inputs, resume and deliver.
- §16: `persistence`, `checkpoint`, `receive`, `call.adapter` / `response` / `server` /
  `operation` / `target`; provider enum; the 21-row body-kind exclusion matrix.
- §18 glossary: snapshot, checkpoint, `receive`, adapter, in-doubt effect.
- §19 E3 `ctx` table: `ctx.evaluation.id`.

### `docs/aflow-api.openapi.yaml`

- Paths: `POST /evaluations/{evaluationId}/resume`,
  `POST /evaluations/{evaluationId}/inputs/{token}`.
- Schemas: `Node` (`checkpoint`, `receive`, exclusion pairs), `Receive`, `Call`
  (`adapter`, `response`, `server`, `operation`, `target`, provider enum), `WorkflowConfig`
  (`persistence`), `Suspension` (`await_input`, `pending_inputs`, `next_deadline_at`),
  `TaskRecord` (`request`, `token`, `expires_at`), `TrajectoryEntry` (`request`).
- Every new description cites §19 E6–E9.
- Verify: `yq . docs/aflow-api.openapi.yaml`, ad-hoc `npx @redocly/cli lint`.

### `CLAUDE.md`, `README.md`

- Body kinds: six → seven; the "Not yet built" list loses offline-retry resumption.

## 7. Engine structure

New modules, one responsibility each, so `engine.ts` does not grow by four features:

| Module | Responsibility |
|---|---|
| `persistence.ts` | `Snapshot` type, `Store`, `memoryStore()`, snapshot/restore of `EvaluationContext` + counters, definition hash |
| `stream.ts` | SSE / NDJSON / text chunk parsing over a `ReadableStream`, limits, idle timeout, collect / fold |
| `mcp.ts` | `mcp` provider: session handshake, JSON-RPC, SSE response handling, result mapping |
| `adapter.ts` | inline and external adapter evaluation, frozen context snapshot, merge per provider |

`engine.ts` gains only: snapshot hooks around visits and call attempts, the `receive`
body, the pending-input suspension condition, and `resume` / `deliver` entry points
(`Engine.fromSnapshot`). `providers.ts` gains `request.query` and `response.stream`
in `http`, and the idempotency key on `ProviderInvocation`.

## 8. Testing

vitest, hermetic, providers injected as in `test/fixtures/suppliers.ts`. Every new test
is shown to fail against a broken implementation (fix reverted or mutated) before it
counts. Async waits are bounded.

- **E6** — for each level: run to a snapshot, discard the engine, `resume()` → same
  outcome and same per-item trajectories as an uninterrupted run. In-doubt
  non-idempotent call → `409` error routed normally; idempotent → re-invoked once with
  the same key and recorded request. Hash mismatch rejected. Suspension with no store
  → error. `durable` snapshots before, `checkpoint` after.
- **E7** — suspend → deliver → complete. Two split children waiting on one node get
  distinct tokens and complete independently in either delivery order with identical
  outcome. Duplicate / unknown / expired tokens. Expiry via `resume()` after
  `expires_at` with an injected clock. The `async` + `await` callback pattern, with
  `ctx.evaluation.id`.
- **E8 http** — `query` applied; SSE and NDJSON with each `collect` and with `fold`;
  `max_chunks`, `max_bytes`, `idle_timeout` errors.
- **E8 mcp** — fake Streamable HTTP server via injected `fetch`: handshake order and
  session header, `DELETE` at end, JSON and SSE responses, ignored notifications,
  server request answered `-32601`, `isError`, JSON-RPC error, all three operations,
  5xx retried with a fresh session.
- **E9** — inline `$expr` and `$do` adapters per provider; external adapter receives a
  frozen snapshot and cannot mutate the tree; output in `tasks[name].request`; not
  re-invoked on resume at `effects` level.
- `test/booking.test.ts` stays green unchanged.

## 9. Build order

One implementation plan per step, each leaving the suite green:

1. **E6** persistence & resume (incl. offline-retry resume).
2. **E7** `receive`.
3. **E9** `call.adapter`.
4. **E8** `http` streaming + `mcp`.

Each step updates the spec, the OpenAPI document and the engine together, so the three
never disagree at a commit boundary.
