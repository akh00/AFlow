# AFlow

A workflow / rule engine. An input is wrapped in a **root item**, split into child items
along the way, and each item is driven through a graph of **nodes** until every branch
ends — at which point the root's disposition maps to a result or a declared error.

- [`docs/aflow-workflow-spec.md`](docs/aflow-workflow-spec.md) — the normative
  specification. Source of truth.
- [`docs/aflow-api.openapi.yaml`](docs/aflow-api.openapi.yaml) — the HTTP API for the
  engine.
- `src/` — `@aflow/engine`, the evaluation engine (spec §1 artifact 4).

```bash
npm install
npm test
npm run typecheck
```

## Using the engine

```ts
import { evaluate } from "@aflow/engine";

const evaluation = await evaluate(workflowDefinition, input, {
  bundles: { "hotel-supplier@2.1.0": hotelClient },  // §9 libraries for `provider: js`
  fetch,                                             // §9 `provider: http`
  resolveWorkflow,                                   // §9 `provider: sub_workflow`
  includeTrace: true,                                // the item tree
  includeTrajectory: true,                           // the flat visit log
});

evaluation.status;   // succeeded | failed | suspended
evaluation.result;   // on success — the workflow's declared `result` type
evaluation.error;    // on a *determined* failure, not a transport fault
```

The engine takes no runtime dependencies and performs no I/O of its own: HTTP, inline JS
and sub-workflows all reach the outside world through providers you inject.

## What the engine does

- **Drives an input item through the graph.** Every node runs up to four phases — gate,
  body, state, route (§4).
- **Creates items.** A `split` turns a selector's output into child items; the selector is
  a pure expression, so it can read the item's `data`, its `objects`, or a captured task
  result. Types and entry nodes are chosen per child (§19 E1), so heterogeneous input fans
  out onto different paths at the point of creation.
- **Routes items independently.** Each item has its own trajectory.
- **Runs work concurrently.** Items that are ready run together, bounded by
  `config.defaults.concurrency.max_parallel` (§19 E5). `async: true` detaches a node's body
  into a branch the flow can rejoin with `await` (§8).
- **Records the trajectory.** Every visit — item, node, status, result, resulting route —
  is appended to that item's ordered log and to a flat cross-item log (§19 E2).
- **Exposes the evaluation context to routing.** `ctx` reaches every item, every item type
  and every recorded visit from inside any pure expression (§19 E3) — and exposes no
  arrival-order information, so §8's scheduling-independence still holds.
- **Enforces the determinism boundary.** `Date`, `Math.random`, `fetch`, `require` and the
  host scope are unreachable from `$expr`/`$do`; two concurrently live branches writing the
  same `objects` key is an error, not a race (§5, §8).

## The worked test

`test/booking.test.ts` books a travel order — two hotel rooms and a flight, against one
payment instrument — through two suppliers with different transaction shapes:

```
Input ──► split_order_lines ─┬─► [hotel_line]  create_hotel_record
            (parallel,       │                 → hold_hotel_room  (failable)
             per-child type  │                 → mark_hotel_reserved
             and route)      │
                             └─► [flight_line] book_flight (failable, one step)
                                               → mark_flight_reserved

await_reservations  (barrier over every line)
     └─► commit_or_rollback  (dispatch, route computed per line)
             ├─ all reserved → commit_hotel_booking / confirm_flight
             └─ otherwise    → release_hotel_hold / cancel_flight_booking
                               / discard_hotel_record
await_settlement (second barrier) ──► return_result | return_error
```

The order books completely or not at all. Nothing commits until every line has reserved;
if any line fails, every line that did reserve is compensated — hotel holds released, the
already-ticketed flight cancelled, unheld draft records discarded. The suite asserts this
holds under six different supplier-latency profiles, with identical results and identical
per-item trajectories each time.
