// header.ts — types, items and config of `book_travel_order` (spec §15.10).
//
// The flow is the one of `test/fixtures/booking-workflow.ts`. `aflow build`
// of `book_travel_order.ts` gives that document.
import { workflow } from "@aflow/dsl";

export const wf = workflow({
  client_id: "travelco",
  name: "book_travel_order",
  version: "1.0.0",
  // Message types: BookingRequest, BookingResponse, OrderLine, …
  schemas: { travelco: "./schemas/travelco.json" },
  // Workflow-private types → "travelco.<Name>".
  types: {
    OrderObjects: {
      type: "object",
      required: ["payment"],
      properties: { payment: { $ref: "#/definitions/PaymentInstrument" } },
    },
    HotelLineData: { $ref: "#/definitions/OrderLine" },
    // `phase` is what the barriers wait on (§7).
    HotelLineObjects: {
      type: "object",
      required: ["phase"],
      properties: { phase: { enum: ["reserved", "settled", "released", "abandoned"] } },
    },
    FlightLineData: { $ref: "#/definitions/OrderLine" },
    FlightLineObjects: {
      type: "object",
      required: ["phase"],
      properties: { phase: { enum: ["reserved", "settled", "released", "abandoned"] } },
    },
    // Supplier results, one per call (§9).
    HotelRecord: { type: "object", required: ["record_id"], properties: { record_id: { type: "string" } } },
    HotelHold: { type: "object", required: ["hold_id"], properties: { hold_id: { type: "string" } } },
    HotelConfirmation: {
      type: "object",
      required: ["confirmation"],
      properties: { confirmation: { type: "string" } },
    },
    HotelRelease: { type: "object", properties: { released: { type: "boolean" } } },
    HotelDiscard: { type: "object", properties: { discarded: { type: "boolean" } } },
    FlightBooking: {
      type: "object",
      required: ["confirmation", "ticket_numbers"],
      properties: {
        confirmation: { type: "string" },
        ticket_numbers: { type: "array", items: { type: "string" } },
      },
    },
    FlightCancellation: { type: "object", properties: { cancelled: { type: "boolean" } } },
  },
  input: "travelco.BookingRequest",
  result: "travelco.BookingResponse",
  items: {
    order: { data: "input", objects: "travelco.OrderObjects", parent: null },
    hotel_line: { data: "travelco.HotelLineData", objects: "travelco.HotelLineObjects", parent: "order" },
    flight_line: { data: "travelco.FlightLineData", objects: "travelco.FlightLineObjects", parent: "order" },
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
});
