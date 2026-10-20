// order.ts — the root item: normalise, fan out, the two barriers, dispatch.
import { wf } from "./header";

// ── root: normalize the order and fan it out ──────────────────────────────
export const order_intake = wf.tasks({
  Input: {
    item: "order",
    enrich: ({ objects, data, logging_context }) => {
      objects.payment = data.payment_instrument;
      objects.lines_total = data.order_lines.reduce((sum, l) => sum + l.amount, 0);
      logging_context.order_id = data.order_id;
      logging_context.customer_id = data.customer.id;
    },
    route: "split_order_lines",
  },

  split_order_lines: {
    item: "order",
    split: {
      // [E1] one split, two item types — chosen per produced child.
      item_type: ({ data }) => data.product_type === 'hotel' ? 'hotel_line' : 'flight_line',
      selector: ({ data }) => data.order_lines,
      // [E1] and two entry nodes — the lines take different paths from birth.
      route: ({ type }) => type === 'hotel_line' ? 'create_hotel_record' : 'book_flight',
      parallel: true,
    },
    route: "await_reservations",
  },
});

// ── barrier 1, then [E4] re-activate every line onto its phase-2 node ─────
export const order_barrier = wf.tasks({
  await_reservations: {
    item: "order",
    aggregate: {
      select: ({ items }) => items,
      // Monotonic (§7): a line's `phase` only ever moves forward.
      until: ({ set }) => set.every(i => i.objects.phase === 'reserved'),
      // Commutative & associative (§7): every/filter over the whole set.
      reduce: ({ objects, set }) => {
        objects.all_reserved = set.every(i => i.target_state === 'success');
        objects.reserved = set.filter(i => i.target_state === 'success').map(i => i.data.id);
        objects.rejected = set.filter(i => i.target_state !== 'success').map(i => i.data.id);
      },
    },
    target_state_setter: ({ objects }) => objects.all_reserved ? 'success' : 'failure',
    route: "commit_or_rollback",
  },

  commit_or_rollback: {
    item: "order",
    dispatch: {
      select: ({ items }) => items,
      // Route computed per line, once for the commit phase and once for rollback.
      route: ({ root, type, target_state, objects }) =>
        root.objects.all_reserved
          // Every line reserved: commit the holds, leave the ticketed flight alone.
          ? (type === 'hotel_line' ? 'commit_hotel_booking' : 'confirm_flight')
          // Some line failed: undo whatever this line actually achieved.
          : (target_state === 'success'
              ? (type === 'hotel_line' ? 'release_hotel_hold' : 'cancel_flight_booking')
              : (type === 'hotel_line'
                  ? (objects.record_id !== undefined ? 'discard_hotel_record' : 'mark_hotel_abandoned')
                  : 'mark_flight_abandoned')),
    },
    route: "await_settlement",
  },
});

// ── barrier 2: every line has settled, released or been abandoned ─────────
export const order_settlement = wf.tasks({
  await_settlement: {
    item: "order",
    aggregate: {
      select: ({ items }) => items,
      until: ({ set }) => set.every(i => ['settled', 'released', 'abandoned'].includes(i.objects.phase)),
      reduce: ({ objects, set }) => {
        objects.settled = set.filter(i => i.objects.phase === 'settled').map(i => i.data.id);
        objects.rolled_back = set.filter(i => i.objects.phase === 'released').map(i => i.data.id);
        objects.abandoned = set.filter(i => i.objects.phase === 'abandoned').map(i => i.data.id);
      },
    },
    target_state_setter: ({ objects }) => objects.all_reserved ? 'success' : 'failure',
    route: { cases: { success: "return_result", failure: "return_error" } },
  },

  // ── terminals (§6.6) ──────────────────────────────────────────────────
  return_result: {
    item: "order",
    return: {
      result: ({ data, objects, items, ctx }) => ({
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
          }),
    },
  },

  return_error: {
    item: "order",
    return: {
      error: ({ data, objects, items, ctx }) => ({
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
          }),
    },
  },
});
