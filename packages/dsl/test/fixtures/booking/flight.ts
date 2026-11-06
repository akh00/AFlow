// flight.ts — the flight line: a one-step booking, then settle.
import { wf } from "./header";

// ── flight line: one-step booking ─────────────────────────────────────────
export const flight_reserve = wf.tasks({
  book_flight: {
    item: "flight_line",
    timeout: 5000,
    retry: { inline: { max_count: 1, interval: "5ms" } },
    call: {
      provider: "js",
      implementation: { bundle_name: "flight-supplier", bundle_version: "1.0.3" },
      input: ({ data, root }) => ({ line: data, order_id: root.data.order_id, payment: root.objects.payment }),
      script: async (input, lib) => await lib.book(input),
      output: {
        result_type: "travelco.FlightBooking",
        enrich: ({ objects, result }) => {
          objects.confirmation = result.confirmation;
          objects.ticket_numbers = result.ticket_numbers;
        },
      },
    },
    target_state_setter: ({ task_state }) => task_state.status === 'success' ? 'success' : 'failure',
    route: "mark_flight_reserved",
  },

  mark_flight_reserved: {
    item: "flight_line",
    enrich: ({ objects, target_state, tasks }) => {
      objects.phase = 'reserved';
      if (target_state === 'failure') {
        objects.failure_reason = tasks.book_flight?.error?.message ?? 'unknown';
      }
    },
    route: null,
  },
});

// ── flight line, phase 2 ──────────────────────────────────────────────────
export const flight_settle = wf.tasks({
  // A one-step booking has nothing to commit; it is already ticketed.
  confirm_flight: {
    item: "flight_line",
    enrich: ({ objects }) => { objects.phase = 'settled' },
    route: null,
  },

  cancel_flight_booking: {
    item: "flight_line",
    idempotent: true,
    durable: true,
    retry: { inline: { max_count: 3, interval: "5ms" } },
    call: {
      provider: "js",
      implementation: { bundle_name: "flight-supplier", bundle_version: "1.0.3" },
      input: ({ objects, data }) => ({ confirmation: objects.confirmation, order_line_id: data.id }),
      script: async (input, lib) => await lib.cancel(input),
      output: {
        result_type: "travelco.FlightCancellation",
        enrich: ({ objects }) => { objects.cancelled = true },
      },
    },
    target_state_setter: ({}) => 'failure',
    route: "mark_flight_released",
  },

  mark_flight_released: {
    item: "flight_line",
    enrich: ({ objects }) => { objects.phase = 'released' },
    route: null,
  },

  mark_flight_abandoned: {
    item: "flight_line",
    enrich: ({ objects }) => { objects.phase = 'abandoned' },
    route: null,
  },
});
