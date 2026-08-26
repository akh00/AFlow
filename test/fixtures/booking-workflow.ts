/**
 * `book_travel_order` — the canonical §13 workflow document for the test.
 *
 * Shape of the flow:
 *
 *   Input ──► split_order_lines ─┬─► [hotel_line]  create_hotel_record
 *               (parallel)       │                 → hold_hotel_room  (failable)
 *               [E1] per-child   │                 → mark_hotel_reserved
 *               type + route     │
 *                                └─► [flight_line] book_flight (failable, one step)
 *                                                  → mark_flight_reserved
 *
 *   await_reservations  (§7 parent barrier over every line)
 *        └─► commit_or_rollback  ([E4] dispatch, per-line route)
 *                ├─ all reserved → commit_hotel_booking / confirm_flight
 *                └─ otherwise    → release_hotel_hold / cancel_flight_booking
 *                                  / discard_hotel_record
 *   await_settlement (§7 second barrier) ──► return_result | return_error
 *
 * The order books completely or not at all: nothing is committed until every
 * line has reserved, and if any line fails, every line that did reserve is
 * compensated — the hotel holds released, the already-ticketed flight
 * cancelled.
 */

import type { WorkflowDefinition } from "../../src/types.js";

/** Route computed per line, once for the commit phase and once for rollback. */
const DISPATCH_ROUTE = `
root.objects.all_reserved
  // Every line reserved: commit the holds, leave the ticketed flight alone.
  ? (type === 'hotel_line' ? 'commit_hotel_booking' : 'confirm_flight')
  // Some line failed: undo whatever this line actually achieved.
  : (target_state === 'success'
      ? (type === 'hotel_line' ? 'release_hotel_hold' : 'cancel_flight_booking')
      : (type === 'hotel_line'
          ? (objects.record_id !== undefined ? 'discard_hotel_record' : 'mark_hotel_abandoned')
          : 'mark_flight_abandoned'))
`;

export const bookingWorkflow: WorkflowDefinition = {
  client_id: "travelco",
  name: "book_travel_order",
  version: "1.0.0",

  definitions: {
    input: { $ref: "#/definitions/travelco.BookingRequest" },
    result: { $ref: "#/definitions/travelco.BookingResponse" },
    "travelco.BookingRequest": {
      type: "object",
      required: ["order_id", "payment_instrument", "order_lines"],
      properties: {
        order_id: { type: "string" },
        currency: { type: "string" },
        customer: { type: "object" },
        payment_instrument: { $ref: "#/definitions/travelco.PaymentInstrument" },
        order_lines: { type: "array", items: { type: "object" } },
      },
    },
    "travelco.PaymentInstrument": {
      type: "object",
      required: ["type", "token"],
      properties: {
        type: { enum: ["card", "invoice"] },
        token: { type: "string" },
        holder: { type: "string" },
        expiry: { type: "string" },
        billing_country: { type: "string" },
      },
    },
    "travelco.BookingResponse": {
      type: "object",
      required: ["order_id", "status", "bookings"],
      properties: {
        order_id: { type: "string" },
        status: { enum: ["BOOKED"] },
        currency: { type: "string" },
        total: { type: "number" },
        payment: { type: "object" },
        bookings: { type: "array", items: { type: "object" } },
        audit: { type: "object" },
      },
    },
    "travelco.OrderObjects": { type: "object" },
    "travelco.HotelLineData": { type: "object" },
    "travelco.HotelLineObjects": { type: "object" },
    "travelco.FlightLineData": { type: "object" },
    "travelco.FlightLineObjects": { type: "object" },
  },

  items: {
    order: {
      data: { $ref: "#/definitions/input" },
      objects: { $ref: "#/definitions/travelco.OrderObjects" },
      parent: null,
    },
    hotel_line: {
      data: { $ref: "#/definitions/travelco.HotelLineData" },
      objects: { $ref: "#/definitions/travelco.HotelLineObjects" },
      parent: "order",
    },
    flight_line: {
      data: { $ref: "#/definitions/travelco.FlightLineData" },
      objects: { $ref: "#/definitions/travelco.FlightLineObjects" },
      parent: "order",
    },
  },

  config: {
    bundles: [
      { name: "hotel-supplier", version: "2.1.0" },
      { name: "flight-supplier", version: "1.0.3" },
    ],
    defaults: {
      item: {
        objects: {},
        target_state: "success",
        allowed_target_states: ["success", "failure"],
      },
      concurrency: { max_parallel: 8 },
      entry: "Input",
    },
  },

  tasks: [
    // ── root: normalize the order and fan it out ──────────────────────────
    {
      name: "Input",
      item: "order",
      enrich: {
        $do: `
          objects.payment = data.payment_instrument;
          objects.lines_total = data.order_lines.reduce((sum, l) => sum + l.amount, 0);
          logging_context.order_id = data.order_id;
          logging_context.customer_id = data.customer.id;
        `,
      },
      route: "split_order_lines",
    },

    {
      name: "split_order_lines",
      item: "order",
      split: {
        // [E1] one split, two item types — chosen per produced child.
        itemType: {
          $expr: "data.product_type === 'hotel' ? 'hotel_line' : 'flight_line'",
        },
        selector: { $expr: "data.order_lines" },
        // [E1] and two entry nodes — the lines take different paths from birth.
        route: {
          $expr: "type === 'hotel_line' ? 'create_hotel_record' : 'book_flight'",
        },
        parallel: true,
      },
      route: "await_reservations",
    },

    // ── hotel line: create → hold (failable) → reserved ───────────────────
    {
      name: "create_hotel_record",
      item: "hotel_line",
      timeout: 5000,
      call: {
        provider: "js",
        implementation: { bundle_name: "hotel-supplier", bundle_version: "2.1.0" },
        input: {
          $expr:
            "({ line: data, order_id: root.data.order_id, customer: root.data.customer })",
        },
        script: "async (input, lib) => await lib.createRecord(input)",
        output: {
          resultType: "HotelRecord",
          enrich: { $do: "objects.record_id = result.record_id" },
        },
      },
      route: {
        cases: { success: "hold_hotel_room", failure: "mark_hotel_reserved" },
      },
    },

    {
      name: "hold_hotel_room",
      item: "hotel_line",
      timeout: 5000,
      // A technical blip is worth one immediate retry; a sold-out room is not,
      // and the supplier says so by returning `retry_type: null` (§11).
      retry: { inline: { max_count: 1, interval: "5ms" } },
      call: {
        provider: "js",
        implementation: { bundle_name: "hotel-supplier", bundle_version: "2.1.0" },
        input: {
          $expr:
            "({ record_id: objects.record_id, line: data, payment: root.objects.payment })",
        },
        script: "async (input, lib) => await lib.hold(input)",
        output: {
          enrich: { $do: "objects.hold_id = result.hold_id" },
        },
      },
      target_state_setter: {
        $expr: "task_state.status === 'success' ? 'success' : 'failure'",
      },
      route: "mark_hotel_reserved",
    },

    {
      name: "mark_hotel_reserved",
      item: "hotel_line",
      enrich: {
        $do: `
          objects.phase = 'reserved';
          if (target_state === 'failure') {
            objects.failure_reason =
              tasks.hold_hotel_room?.error?.message
              ?? tasks.create_hotel_record?.error?.message
              ?? 'unknown';
          }
        `,
      },
      // Branch ends here: the parent barrier decides commit vs rollback.
      route: null,
    },

    // ── flight line: one-step booking ─────────────────────────────────────
    {
      name: "book_flight",
      item: "flight_line",
      timeout: 5000,
      retry: { inline: { max_count: 1, interval: "5ms" } },
      call: {
        provider: "js",
        implementation: { bundle_name: "flight-supplier", bundle_version: "1.0.3" },
        input: {
          $expr:
            "({ line: data, order_id: root.data.order_id, payment: root.objects.payment })",
        },
        script: "async (input, lib) => await lib.book(input)",
        output: {
          enrich: {
            $do: `
              objects.confirmation = result.confirmation;
              objects.ticket_numbers = result.ticket_numbers;
            `,
          },
        },
      },
      target_state_setter: {
        $expr: "task_state.status === 'success' ? 'success' : 'failure'",
      },
      route: "mark_flight_reserved",
    },

    {
      name: "mark_flight_reserved",
      item: "flight_line",
      enrich: {
        $do: `
          objects.phase = 'reserved';
          if (target_state === 'failure') {
            objects.failure_reason = tasks.book_flight?.error?.message ?? 'unknown';
          }
        `,
      },
      route: null,
    },

    // ── barrier 1: every line has reserved, or tried and failed ───────────
    {
      name: "await_reservations",
      item: "order",
      aggregate: {
        select: { $expr: "items" },
        // Monotonic (§7): a line's `phase` only ever moves forward.
        until: { $expr: "set.every(i => i.objects.phase === 'reserved')" },
        // Commutative & associative (§7): every/filter over the whole set.
        reduce: {
          $do: `
            objects.all_reserved = set.every(i => i.target_state === 'success');
            objects.reserved = set.filter(i => i.target_state === 'success').map(i => i.data.id);
            objects.rejected = set.filter(i => i.target_state !== 'success').map(i => i.data.id);
          `,
        },
      },
      target_state_setter: { $expr: "objects.all_reserved ? 'success' : 'failure'" },
      route: "commit_or_rollback",
    },

    // ── [E4] re-activate every line onto its phase-2 node ─────────────────
    {
      name: "commit_or_rollback",
      item: "order",
      dispatch: {
        select: { $expr: "items" },
        route: { $expr: DISPATCH_ROUTE },
      },
      route: "await_settlement",
    },

    // ── hotel line, phase 2 ───────────────────────────────────────────────
    {
      name: "commit_hotel_booking",
      item: "hotel_line",
      idempotent: true,
      durable: true,
      timeout: 5000,
      // Committing an existing hold is not failable, but a technical blip is
      // still worth retrying — the operation is idempotent.
      retry: { inline: { max_count: 3, interval: "5ms" } },
      call: {
        provider: "js",
        implementation: { bundle_name: "hotel-supplier", bundle_version: "2.1.0" },
        input: {
          $expr:
            "({ hold_id: objects.hold_id, record_id: objects.record_id, order_line_id: data.id })",
        },
        script: "async (input, lib) => await lib.commit(input)",
        output: { enrich: { $do: "objects.confirmation = result.confirmation" } },
      },
      route: "mark_hotel_settled",
    },

    {
      name: "mark_hotel_settled",
      item: "hotel_line",
      enrich: { $do: "objects.phase = 'settled'" },
      route: null,
    },

    {
      name: "release_hotel_hold",
      item: "hotel_line",
      idempotent: true,
      durable: true,
      retry: { inline: { max_count: 3, interval: "5ms" } },
      call: {
        provider: "js",
        implementation: { bundle_name: "hotel-supplier", bundle_version: "2.1.0" },
        input: { $expr: "({ hold_id: objects.hold_id, order_line_id: data.id })" },
        script: "async (input, lib) => await lib.release(input)",
        output: { enrich: { $do: "objects.released = true" } },
      },
      // The line reserved successfully but the order did not: not booked.
      target_state_setter: { $expr: "'failure'" },
      route: "mark_hotel_released",
    },

    {
      name: "mark_hotel_released",
      item: "hotel_line",
      enrich: { $do: "objects.phase = 'released'" },
      route: null,
    },

    {
      name: "discard_hotel_record",
      item: "hotel_line",
      idempotent: true,
      retry: { inline: { max_count: 3, interval: "5ms" } },
      call: {
        provider: "js",
        implementation: { bundle_name: "hotel-supplier", bundle_version: "2.1.0" },
        input: { $expr: "({ record_id: objects.record_id, order_line_id: data.id })" },
        script: "async (input, lib) => await lib.discardRecord(input)",
        output: { enrich: { $do: "objects.discarded = true" } },
      },
      target_state_setter: { $expr: "'failure'" },
      route: "mark_hotel_abandoned",
    },

    {
      name: "mark_hotel_abandoned",
      item: "hotel_line",
      enrich: { $do: "objects.phase = 'abandoned'" },
      route: null,
    },

    // ── flight line, phase 2 ──────────────────────────────────────────────
    {
      // A one-step booking has nothing to commit; it is already ticketed.
      name: "confirm_flight",
      item: "flight_line",
      enrich: { $do: "objects.phase = 'settled'" },
      route: null,
    },

    {
      name: "cancel_flight_booking",
      item: "flight_line",
      idempotent: true,
      durable: true,
      retry: { inline: { max_count: 3, interval: "5ms" } },
      call: {
        provider: "js",
        implementation: { bundle_name: "flight-supplier", bundle_version: "1.0.3" },
        input: { $expr: "({ confirmation: objects.confirmation, order_line_id: data.id })" },
        script: "async (input, lib) => await lib.cancel(input)",
        output: { enrich: { $do: "objects.cancelled = true" } },
      },
      target_state_setter: { $expr: "'failure'" },
      route: "mark_flight_released",
    },

    {
      name: "mark_flight_released",
      item: "flight_line",
      enrich: { $do: "objects.phase = 'released'" },
      route: null,
    },

    {
      name: "mark_flight_abandoned",
      item: "flight_line",
      enrich: { $do: "objects.phase = 'abandoned'" },
      route: null,
    },

    // ── barrier 2: every line has settled, released or been abandoned ─────
    {
      name: "await_settlement",
      item: "order",
      aggregate: {
        select: { $expr: "items" },
        until: {
          $expr:
            "set.every(i => ['settled', 'released', 'abandoned'].includes(i.objects.phase))",
        },
        reduce: {
          $do: `
            objects.settled = set.filter(i => i.objects.phase === 'settled').map(i => i.data.id);
            objects.rolled_back = set.filter(i => i.objects.phase === 'released').map(i => i.data.id);
            objects.abandoned = set.filter(i => i.objects.phase === 'abandoned').map(i => i.data.id);
          `,
        },
      },
      target_state_setter: { $expr: "objects.all_reserved ? 'success' : 'failure'" },
      route: { cases: { success: "return_result", failure: "return_error" } },
    },

    // ── terminals (§6.6) ──────────────────────────────────────────────────
    {
      name: "return_result",
      item: "order",
      return: {
        result: {
          $expr: `({
            order_id: data.order_id,
            status: 'BOOKED',
            currency: data.currency,
            total: objects.lines_total,
            payment: {
              instrument: objects.payment.type,
              last4: objects.payment.token.slice(-4)
            },
            bookings: items.map(i => ({
              order_line_id: i.data.id,
              product_type: i.data.product_type,
              supplier: i.data.supplier,
              confirmation: i.objects.confirmation,
              amount: i.data.amount
            })),
            audit: {
              items: ctx.count(),
              hotel_lines: ctx.count('hotel_line'),
              flight_lines: ctx.count('flight_line'),
              supplier_calls:
                ctx.visits('create_hotel_record').length +
                ctx.visits('hold_hotel_room').length +
                ctx.visits('commit_hotel_booking').length +
                ctx.visits('book_flight').length
            }
          })`,
        },
      },
    },

    {
      name: "return_error",
      item: "order",
      return: {
        error: {
          $expr: `({
            code: 4090,
            category: 'BUSINESS',
            message: 'Order could not be booked completely; every reservation was rolled back',
            data: {
              order_id: data.order_id,
              failed_lines: items
                .filter(i => i.objects.failure_reason !== undefined)
                .map(i => ({
                  order_line_id: i.data.id,
                  product_type: i.data.product_type,
                  reason: i.objects.failure_reason
                })),
              rolled_back: objects.rolled_back,
              abandoned: objects.abandoned,
              compensations: ctx.visits('release_hotel_hold')
                .concat(ctx.visits('cancel_flight_booking'))
                .concat(ctx.visits('discard_hotel_record'))
                .map(v => ({ item_id: v.item_id, task: v.task, status: v.status }))
            }
          })`,
        },
      },
    },
  ],
};
