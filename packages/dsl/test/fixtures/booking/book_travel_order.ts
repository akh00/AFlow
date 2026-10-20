// book_travel_order.ts — the entry file (spec §15.1, §15.3).
//
// The groups are listed so that `tasks` comes out in the order of
// `test/fixtures/booking-workflow.ts`: argument order, then property order.
import { wf } from "./header";
import { flight_reserve, flight_settle } from "./flight";
import { hotel_reserve, hotel_settle } from "./hotel";
import { order_barrier, order_intake, order_settlement } from "./order";

export default wf.assemble(
  order_intake,
  hotel_reserve,
  flight_reserve,
  order_barrier,
  hotel_settle,
  flight_settle,
  order_settlement,
);
