// hotel.ts — the hotel line: reserve (create → hold), then settle.
import { wf } from "./header";

// ── hotel line: create → hold (failable) → reserved ───────────────────────
export const hotel_reserve = wf.tasks({
  create_hotel_record: {
    item: "hotel_line",
    timeout: 5000,
    call: {
      provider: "js",
      implementation: { bundle_name: "hotel-supplier", bundle_version: "2.1.0" },
      input: ({ data, root }) => ({ line: data, order_id: root.data.order_id, customer: root.data.customer }),
      script: async (input, lib) => await lib.createRecord(input),
      output: {
        result_type: "travelco.HotelRecord",
        enrich: ({ objects, result }) => { objects.record_id = result.record_id },
      },
    },
    route: { cases: { success: "hold_hotel_room", failure: "mark_hotel_reserved" } },
  },

  hold_hotel_room: {
    item: "hotel_line",
    timeout: 5000,
    // A technical blip is worth one immediate retry; a sold-out room is not,
    // and the supplier says so by returning `retry_type: null` (§11).
    retry: { inline: { max_count: 1, interval: "5ms" } },
    call: {
      provider: "js",
      implementation: { bundle_name: "hotel-supplier", bundle_version: "2.1.0" },
      input: ({ objects, data, root }) => ({ record_id: objects.record_id, line: data, payment: root.objects.payment }),
      script: async (input, lib) => await lib.hold(input),
      output: {
        result_type: "travelco.HotelHold",
        enrich: ({ objects, result }) => { objects.hold_id = result.hold_id },
      },
    },
    target_state_setter: ({ task_state }) => task_state.status === 'success' ? 'success' : 'failure',
    route: "mark_hotel_reserved",
  },

  mark_hotel_reserved: {
    item: "hotel_line",
    enrich: ({ objects, target_state, tasks }) => {
      objects.phase = 'reserved';
      if (target_state === 'failure') {
        objects.failure_reason =
          tasks.hold_hotel_room?.error?.message
          ?? tasks.create_hotel_record?.error?.message
          ?? 'unknown';
      }
    },
    // Branch ends here: the parent barrier decides commit vs rollback.
    route: null,
  },
});

// ── hotel line, phase 2 ───────────────────────────────────────────────────
export const hotel_settle = wf.tasks({
  commit_hotel_booking: {
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
      input: ({ objects, data }) => ({ hold_id: objects.hold_id, record_id: objects.record_id, order_line_id: data.id }),
      script: async (input, lib) => await lib.commit(input),
      output: {
        result_type: "travelco.HotelConfirmation",
        enrich: ({ objects, result }) => { objects.confirmation = result.confirmation },
      },
    },
    route: "mark_hotel_settled",
  },

  mark_hotel_settled: {
    item: "hotel_line",
    enrich: ({ objects }) => { objects.phase = 'settled' },
    route: null,
  },

  release_hotel_hold: {
    item: "hotel_line",
    idempotent: true,
    durable: true,
    retry: { inline: { max_count: 3, interval: "5ms" } },
    call: {
      provider: "js",
      implementation: { bundle_name: "hotel-supplier", bundle_version: "2.1.0" },
      input: ({ objects, data }) => ({ hold_id: objects.hold_id, order_line_id: data.id }),
      script: async (input, lib) => await lib.release(input),
      output: {
        result_type: "travelco.HotelRelease",
        enrich: ({ objects }) => { objects.released = true },
      },
    },
    // The line reserved successfully but the order did not: not booked.
    target_state_setter: ({}) => 'failure',
    route: "mark_hotel_released",
  },

  mark_hotel_released: {
    item: "hotel_line",
    enrich: ({ objects }) => { objects.phase = 'released' },
    route: null,
  },

  discard_hotel_record: {
    item: "hotel_line",
    idempotent: true,
    retry: { inline: { max_count: 3, interval: "5ms" } },
    call: {
      provider: "js",
      implementation: { bundle_name: "hotel-supplier", bundle_version: "2.1.0" },
      input: ({ objects, data }) => ({ record_id: objects.record_id, order_line_id: data.id }),
      script: async (input, lib) => await lib.discardRecord(input),
      output: {
        result_type: "travelco.HotelDiscard",
        enrich: ({ objects }) => { objects.discarded = true },
      },
    },
    target_state_setter: ({}) => 'failure',
    route: "mark_hotel_abandoned",
  },

  mark_hotel_abandoned: {
    item: "hotel_line",
    enrich: ({ objects }) => { objects.phase = 'abandoned' },
    route: null,
  },
});
