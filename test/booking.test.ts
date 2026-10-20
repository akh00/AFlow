import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildWorkflow } from "../packages/dsl/src/build.js";
import { evaluate } from "../src/index.js";
import type { Evaluation, TrajectoryEntry } from "../src/runtime.js";
import type { WorkflowDefinition } from "../src/types.js";
import { bookingRequest, ORDER_TOTAL } from "./fixtures/booking-input.js";
import { bookingWorkflow } from "./fixtures/booking-workflow.js";
import {
  createSupplierHarness,
  type SupplierHarness,
  type SupplierHarnessOptions,
} from "./fixtures/suppliers.js";

/**
 * The same workflow, written in the DSL (spec §15.10) and built by
 * `@aflow/dsl`. Every scenario runs on both documents.
 */
const builtBooking: WorkflowDefinition = (() => {
  const built = buildWorkflow(
    fileURLToPath(new URL("../packages/dsl/test/fixtures/booking/book_travel_order.ts", import.meta.url)),
  );
  if (!built.definition) {
    throw new Error(`the DSL booking fixture does not build:\n${built.diagnostics.map((d) => d.message).join("\n")}`);
  }
  return built.definition;
})();

describe.each([
  ["json", bookingWorkflow],
  ["dsl", builtBooking],
] as const)("%s definition", (_source, workflow) => {
  async function book(
    opts: SupplierHarnessOptions = {},
  ): Promise<{ evaluation: Evaluation; harness: SupplierHarness }> {
    const harness = createSupplierHarness(opts);
    const evaluation = await evaluate(workflow, bookingRequest, {
      bundles: harness.bundles,
      includeTrace: true,
      includeTrajectory: true,
    });
    return { evaluation, harness };
  }

  /** `item_id → [task, …]` in visit order. */
  function trajectoryByItem(
    entries: readonly TrajectoryEntry[],
  ): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const e of entries) (out[e.item_id] ??= []).push(e.task);
    return out;
  }

  describe("book_travel_order — the whole order books, or none of it does", () => {
    it("books all three lines when every supplier says yes", async () => {
      const { evaluation, harness } = await book();

      expect(evaluation.status).toBe("succeeded");
      expect(evaluation.target_state).toBe("success");
      expect(evaluation.error).toBeUndefined();

      const result = evaluation.result as {
        order_id: string;
        status: string;
        total: number;
        payment: { instrument: string; last4: string };
        bookings: Array<{
          order_line_id: string;
          product_type: string;
          confirmation: string;
        }>;
        audit: { items: number; hotel_lines: number; flight_lines: number };
      };

      expect(result.order_id).toBe("ORD-1001");
      expect(result.status).toBe("BOOKED");
      expect(result.total).toBe(ORDER_TOTAL);
      expect(result.payment).toEqual({ instrument: "card", last4: "4242" });

      // One confirmation per line, from the right supplier.
      expect(result.bookings).toEqual([
        {
          order_line_id: "OL-1",
          product_type: "hotel",
          supplier: "acme_hotels",
          confirmation: "HTL-ORD-1001-OL-1",
          amount: 320,
        },
        {
          order_line_id: "OL-2",
          product_type: "hotel",
          supplier: "acme_hotels",
          confirmation: "HTL-ORD-1001-OL-2",
          amount: 180,
        },
        {
          order_line_id: "OL-3",
          product_type: "flight",
          supplier: "sky_air",
          confirmation: "FLT-ORD-1001-OL-3",
          amount: 540,
        },
      ]);

      // [E3] the `ctx` binding, read from inside the terminal expression.
      expect(result.audit).toEqual({
        items: 4, // the order plus three lines
        hotel_lines: 2,
        flight_lines: 1,
        supplier_calls: 7, // 2×(create+hold+commit) + 1×book
      });

      // No compensation ran.
      expect(harness.ops("release")).toHaveLength(0);
      expect(harness.ops("cancel")).toHaveLength(0);
      expect(harness.ops("discardRecord")).toHaveLength(0);
      expect(harness.ops("commit").map((c) => c.order_line_id).sort()).toEqual([
        "OL-1",
        "OL-2",
      ]);
    });

    it("rolls the whole order back when one hotel hold fails", async () => {
      const { evaluation, harness } = await book({ failHoldFor: ["OL-2"] });

      expect(evaluation.status).toBe("failed");
      expect(evaluation.target_state).toBe("failure");
      expect(evaluation.result).toBeUndefined();

      const error = evaluation.error!;
      expect(error.code).toBe(4090);
      expect(error.category).toBe("BUSINESS");

      const data = error.data as {
        order_id: string;
        failed_lines: Array<{ order_line_id: string; reason: string }>;
        rolled_back: string[];
        abandoned: string[];
        compensations: Array<{ item_id: string; task: string; status: string }>;
      };

      expect(data.order_id).toBe("ORD-1001");
      expect(data.failed_lines).toEqual([
        { order_line_id: "OL-2", product_type: "hotel", reason: "no inventory for order line OL-2" },
      ]);

      // Nothing was committed anywhere.
      expect(harness.ops("commit")).toHaveLength(0);

      // The hold that succeeded was released; the ticketed flight was cancelled;
      // the failed line's draft record was discarded.
      expect(harness.ops("release").map((c) => c.order_line_id)).toEqual(["OL-1"]);
      expect(harness.ops("cancel").map((c) => c.order_line_id)).toEqual(["OL-3"]);
      expect(harness.ops("discardRecord").map((c) => c.order_line_id)).toEqual(["OL-2"]);

      expect(data.rolled_back.sort()).toEqual(["OL-1", "OL-3"]);
      expect(data.abandoned).toEqual(["OL-2"]);
      expect(data.compensations).toHaveLength(3);
    });

    it("rolls back the hotel rooms when the flight is the line that fails", async () => {
      const { evaluation, harness } = await book({ failBookFor: ["OL-3"] });

      expect(evaluation.status).toBe("failed");
      expect(harness.ops("commit")).toHaveLength(0);
      // Both hotel holds were taken, so both must be released.
      expect(harness.ops("release").map((c) => c.order_line_id).sort()).toEqual([
        "OL-1",
        "OL-2",
      ]);
      // Nothing to cancel: the flight was never ticketed.
      expect(harness.ops("cancel")).toHaveLength(0);
    });

    it("rolls everything back when every line fails", async () => {
      const { evaluation, harness } = await book({
        failHoldFor: ["OL-1", "OL-2"],
        failBookFor: ["OL-3"],
      });

      expect(evaluation.status).toBe("failed");
      expect(harness.ops("commit")).toHaveLength(0);
      expect(harness.ops("release")).toHaveLength(0);
      expect(harness.ops("cancel")).toHaveLength(0);
      // Only the two hotel draft records need discarding.
      expect(harness.ops("discardRecord").map((c) => c.order_line_id).sort()).toEqual([
        "OL-1",
        "OL-2",
      ]);
    });
  });

  describe("items, routing and the item tree (§3, §6.3, [E1])", () => {
    it("splits the order into one item per line, typed per line", async () => {
      const { evaluation } = await book();
      const trace = evaluation.trace!;

      expect(trace.id).toBe("1");
      expect(trace.type).toBe("order");
      expect(trace.parent).toBeNull();
      expect(trace.items).toHaveLength(3);

      // [E1] one `split`, two item types, chosen per produced child.
      expect(trace.items.map((i) => i.type)).toEqual([
        "hotel_line",
        "hotel_line",
        "flight_line",
      ]);

      // Structural ids: reproducible, no counters and no RNG (§8).
      expect(trace.items.map((i) => i.id)).toEqual(["1.1", "1.2", "1.3"]);
      for (const child of trace.items) expect(child.parent).toBe("1");
    });

    it("sends hotel and flight lines down different paths from birth", async () => {
      const { evaluation } = await book();
      const byItem = trajectoryByItem(evaluation.trajectory!);

      // [E1] per-child `split.route`: the two kinds of line never share a node.
      expect(byItem["1.1"]).toEqual([
        "create_hotel_record",
        "hold_hotel_room",
        "mark_hotel_reserved",
        "commit_hotel_booking",
        "mark_hotel_settled",
      ]);
      expect(byItem["1.2"]).toEqual(byItem["1.1"]);
      expect(byItem["1.3"]).toEqual([
        "book_flight",
        "mark_flight_reserved",
        "confirm_flight",
      ]);
    });

    it("routes each line to its own compensation on rollback", async () => {
      const { evaluation } = await book({ failHoldFor: ["OL-2"] });
      const byItem = trajectoryByItem(evaluation.trajectory!);

      // The line that held: released.
      expect(byItem["1.1"]).toEqual([
        "create_hotel_record",
        "hold_hotel_room",
        "mark_hotel_reserved",
        "release_hotel_hold",
        "mark_hotel_released",
      ]);
      // The line that failed: only its draft record is discarded.
      expect(byItem["1.2"]).toEqual([
        "create_hotel_record",
        "hold_hotel_room",
        "mark_hotel_reserved",
        "discard_hotel_record",
        "mark_hotel_abandoned",
      ]);
      // The line that was already ticketed: cancelled.
      expect(byItem["1.3"]).toEqual([
        "book_flight",
        "mark_flight_reserved",
        "cancel_flight_booking",
        "mark_flight_released",
      ]);
    });

    it("[E4] dispatch re-activates ended branches and records what it dispatched", async () => {
      const { evaluation } = await book();
      const root = evaluation.trace!;

      const dispatch = root.trajectory.find((e) => e.task === "commit_or_rollback")!;
      expect(dispatch.status).toBe("success");
      expect(dispatch.result).toEqual({
        dispatched: [
          { item_id: "1.1", next_task: "commit_hotel_booking" },
          { item_id: "1.2", next_task: "commit_hotel_booking" },
          { item_id: "1.3", next_task: "confirm_flight" },
        ],
      });

      // Every branch ended before the dispatch, and ended again after it.
      for (const child of root.items) expect(child.next_task).toBeNull();
    });
  });

  describe("trajectory (§3, [E2])", () => {
    it("keeps an ordered, per-item record of node, status and result", async () => {
      const { evaluation } = await book();
      const hotel = evaluation.trace!.items[0]!;

      expect(hotel.trajectory.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
      for (const e of hotel.trajectory) {
        expect(e.item_id).toBe("1.1");
        expect(e.item_type).toBe("hotel_line");
        expect(e.attempt).toBe(1);
      }

      const hold = hotel.trajectory.find((e) => e.task === "hold_hotel_room")!;
      expect(hold.status).toBe("success");
      expect(hold.target_state).toBe("success");
      expect(hold.next_task).toBe("mark_hotel_reserved");
      expect(hold.result).toMatchObject({ hold_id: "HOLD-HR-ORD-1001-OL-1", state: "HELD" });

      const commit = hotel.trajectory.find((e) => e.task === "commit_hotel_booking")!;
      expect(commit.result).toMatchObject({ confirmation: "HTL-ORD-1001-OL-1" });
      expect(commit.next_task).toBe("mark_hotel_settled");
    });

    it("records the failing call's error on the trajectory entry", async () => {
      const { evaluation } = await book({ failHoldFor: ["OL-2"] });
      const failed = evaluation.trace!.items[1]!;

      const hold = failed.trajectory.find((e) => e.task === "hold_hotel_room")!;
      expect(hold.status).toBe("error");
      expect(hold.target_state).toBe("failure");
      expect(hold.error).toMatchObject({
        code: 4091,
        category: "BUSINESS",
        message: "no inventory for order line OL-2",
      });

      // The record on the item agrees with the trajectory entry (§3).
      expect(failed.tasks.hold_hotel_room.status).toBe("error");
      expect(failed.tasks.hold_hotel_room.attempts).toBe(1);
    });

    it("covers every item, and the flat log holds every visit exactly once", async () => {
      const { evaluation } = await book();
      const flat = evaluation.trajectory!;

      const perItem = [
        evaluation.trace!,
        ...evaluation.trace!.items,
      ].flatMap((i) => i.trajectory);
      expect(flat).toHaveLength(perItem.length);
      expect(new Set(flat.map((e) => `${e.item_id}#${e.seq}`)).size).toBe(flat.length);

      // Every item in the tree appears in the log.
      expect(new Set(flat.map((e) => e.item_id))).toEqual(
        new Set(["1", "1.1", "1.2", "1.3"]),
      );
    });

    it("counts attempts when an inline retry re-runs a call (§11)", async () => {
      let attempts = 0;
      const harness = createSupplierHarness();
      const flaky = {
        ...(harness.bundles["flight-supplier@1.0.3"] as Record<string, unknown>),
        async book(input: unknown) {
          if (++attempts === 1) {
            throw {
              code: 503,
              category: "TECHNICAL",
              message: "supplier unavailable",
              retry_type: "inline",
            };
          }
          return (
            harness.bundles["flight-supplier@1.0.3"] as {
              book: (i: unknown) => Promise<unknown>;
            }
          ).book(input);
        },
      };

      const evaluation = await evaluate(workflow, bookingRequest, {
        bundles: { ...harness.bundles, "flight-supplier@1.0.3": flaky },
        includeTrace: true,
      });

      expect(evaluation.status).toBe("succeeded");
      expect(attempts).toBe(2);
      // One visit, two attempts — the retry is inside the call, not a re-route.
      const flight = evaluation.trace!.items[2]!;
      expect(flight.trajectory.filter((e) => e.task === "book_flight")).toHaveLength(1);
    });
  });

  describe("async & parallel execution (§8)", () => {
    it("runs the three lines' supplier calls concurrently", async () => {
      const { harness } = await book({ latency: () => 15 });

      // All three lines start their first supplier call before any finishes.
      expect(harness.peakConcurrency).toBeGreaterThanOrEqual(3);

      const firstCalls = harness.calls.filter(
        (c) => c.op === "createRecord" || c.op === "book",
      );
      expect(firstCalls).toHaveLength(3);
      expect(Math.max(...firstCalls.map((c) => c.concurrent))).toBe(3);
    });

    it("honours the [E5] concurrency cap", async () => {
      const harness = createSupplierHarness({ latency: () => 15 });
      await evaluate(workflow, bookingRequest, {
        bundles: harness.bundles,
        maxParallel: 1,
      });
      expect(harness.peakConcurrency).toBe(1);
    });

    it("produces the same outcome and per-item trajectories under any timing", async () => {
      // Six latency profiles that reorder which supplier answers first.
      const profiles: Array<SupplierHarnessOptions["latency"]> = [
        () => 0,
        () => 5,
        (_op, id) => (id === "OL-1" ? 30 : 1),
        (_op, id) => (id === "OL-3" ? 30 : 1),
        (op) => (op === "hold" ? 25 : 2),
        (op, id) => (id === "OL-2" ? 20 : op === "book" ? 1 : 12),
      ];

      const runs = await Promise.all(
        profiles.map(async (latency) => {
          const r = await book({ latency, failHoldFor: ["OL-2"] });
          return {
            status: r.evaluation.status,
            error: r.evaluation.error,
            byItem: trajectoryByItem(r.evaluation.trajectory!),
          };
        }),
      );

      // §8: the final item tree and result are scheduling-independent.
      for (const run of runs.slice(1)) {
        expect(run.status).toEqual(runs[0]!.status);
        expect(run.error).toEqual(runs[0]!.error);
        expect(run.byItem).toEqual(runs[0]!.byItem);
      }
    });

    it("proves the same for the happy path", async () => {
      const a = await book({ latency: () => 0 });
      const b = await book({ latency: (op, id) => (id === "OL-3" ? 40 : op === "hold" ? 20 : 3) });
      expect(b.evaluation.result).toEqual(a.evaluation.result);
      expect(trajectoryByItem(b.evaluation.trajectory!)).toEqual(
        trajectoryByItem(a.evaluation.trajectory!),
      );
    });
  });
});
