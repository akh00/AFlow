/**
 * §9 library bundles for `provider: js`.
 *
 * Two suppliers with different transaction shapes:
 *
 *   hotel-supplier  — three steps: createRecord → hold (failable) → commit
 *                     (not failable), with `release` / `discardRecord` as the
 *                     compensations.
 *   flight-supplier — one step: book (failable), with `cancel` as the
 *                     compensation.
 *
 * The harness records every call so tests can assert what the suppliers were
 * actually asked to do, and can force a specific hold or booking to fail.
 */

export interface SupplierCall {
  supplier: "hotel" | "flight";
  op: string;
  order_line_id: string;
  /** Concurrent in-flight call count at the moment this call started. */
  concurrent: number;
  ok: boolean;
}

export interface SupplierHarnessOptions {
  /** `order_line_id`s whose hotel `hold` must fail. */
  failHoldFor?: string[];
  /** `order_line_id`s whose flight `book` must fail. */
  failBookFor?: string[];
  /** Per-op latency in ms; used to prove the outcome is timing-independent. */
  latency?: (op: string, orderLineId: string) => number;
}

export interface SupplierHarness {
  bundles: Record<string, Record<string, unknown>>;
  calls: SupplierCall[];
  /** Highest number of supplier calls in flight at any one moment. */
  peakConcurrency: number;
  ops(op?: string): SupplierCall[];
}

const tick = (ms: number) =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();

export function createSupplierHarness(
  opts: SupplierHarnessOptions = {},
): SupplierHarness {
  const calls: SupplierCall[] = [];
  const failHold = new Set(opts.failHoldFor ?? []);
  const failBook = new Set(opts.failBookFor ?? []);
  const latency = opts.latency ?? (() => 0);

  let inflight = 0;
  const harness = { peakConcurrency: 0 };

  async function op<T>(
    supplier: "hotel" | "flight",
    name: string,
    orderLineId: string,
    body: () => T,
  ): Promise<T> {
    inflight++;
    harness.peakConcurrency = Math.max(harness.peakConcurrency, inflight);
    const entry: SupplierCall = {
      supplier,
      op: name,
      order_line_id: orderLineId,
      concurrent: inflight,
      ok: true,
    };
    calls.push(entry);
    try {
      await tick(latency(name, orderLineId));
      return body();
    } catch (e) {
      entry.ok = false;
      throw e;
    } finally {
      inflight--;
    }
  }

  const hotel = {
    async createRecord(input: {
      line: { id: string; hotel_id: string; room_type: string };
      order_id: string;
      customer: { id: string };
    }) {
      return op("hotel", "createRecord", input.line.id, () => ({
        record_id: `HR-${input.order_id}-${input.line.id}`,
        hotel_id: input.line.hotel_id,
        room_type: input.line.room_type,
        state: "DRAFT",
      }));
    },

    /** Failable: the supplier may have no inventory left. */
    async hold(input: {
      record_id: string;
      line: { id: string; amount: number; currency: string };
      payment: { type: string; token: string };
    }) {
      return op("hotel", "hold", input.line.id, () => {
        if (failHold.has(input.line.id)) {
          throw {
            code: 4091,
            category: "BUSINESS",
            message: `no inventory for order line ${input.line.id}`,
            data: { record_id: input.record_id },
            // A sold-out room is not worth retrying.
            retry_type: null,
          };
        }
        return {
          hold_id: `HOLD-${input.record_id}`,
          amount: input.line.amount,
          currency: input.line.currency,
          state: "HELD",
        };
      });
    },

    /** Not failable: committing an existing hold always succeeds. */
    async commit(input: { hold_id: string; record_id: string; order_line_id: string }) {
      return op("hotel", "commit", input.order_line_id, () => ({
        confirmation: `HTL-${input.record_id.replace(/^HR-/, "")}`,
        state: "CONFIRMED",
      }));
    },

    /** Compensation for a hold that was taken but must not be committed. */
    async release(input: { hold_id: string; order_line_id: string }) {
      return op("hotel", "release", input.order_line_id, () => ({
        released: true,
        hold_id: input.hold_id,
        state: "RELEASED",
      }));
    },

    /** Compensation for a record whose hold never succeeded. */
    async discardRecord(input: { record_id: string; order_line_id: string }) {
      return op("hotel", "discardRecord", input.order_line_id, () => ({
        discarded: true,
        record_id: input.record_id,
        state: "DISCARDED",
      }));
    },
  };

  const flight = {
    /** One-step booking: failable, and immediately committing. */
    async book(input: {
      line: { id: string; flight_no: string; passengers: number };
      order_id: string;
      payment: { type: string; token: string };
    }) {
      return op("flight", "book", input.line.id, () => {
        if (failBook.has(input.line.id)) {
          throw {
            code: 4092,
            category: "BUSINESS",
            message: `flight ${input.line.flight_no} is sold out`,
            retry_type: null,
          };
        }
        return {
          confirmation: `FLT-${input.order_id}-${input.line.id}`,
          ticket_numbers: Array.from(
            { length: input.line.passengers },
            (_, i) => `TKT-${input.line.flight_no}-${i + 1}`,
          ),
          state: "TICKETED",
        };
      });
    },

    /** Compensation: a booked flight can only be undone by cancelling it. */
    async cancel(input: { confirmation: string; order_line_id: string }) {
      return op("flight", "cancel", input.order_line_id, () => ({
        cancelled: true,
        confirmation: input.confirmation,
        state: "CANCELLED",
      }));
    },
  };

  return {
    bundles: {
      "hotel-supplier@2.1.0": hotel as unknown as Record<string, unknown>,
      "hotel-supplier": hotel as unknown as Record<string, unknown>,
      "flight-supplier@1.0.3": flight as unknown as Record<string, unknown>,
      "flight-supplier": flight as unknown as Record<string, unknown>,
    },
    calls,
    get peakConcurrency() {
      return harness.peakConcurrency;
    },
    ops(name?: string) {
      return name ? calls.filter((c) => c.op === name) : calls;
    },
  };
}
