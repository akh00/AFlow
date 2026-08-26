/**
 * The test input: one order, three order lines — two hotel rooms and one
 * flight — plus the payment instrument the order is charged against.
 */

export interface PaymentInstrument {
  type: "card" | "invoice";
  token: string;
  holder: string;
  expiry: string;
  billing_country: string;
}

export interface HotelOrderLine {
  id: string;
  product_type: "hotel";
  supplier: "acme_hotels";
  hotel_id: string;
  room_type: string;
  check_in: string;
  check_out: string;
  guests: number;
  amount: number;
  currency: string;
}

export interface FlightOrderLine {
  id: string;
  product_type: "flight";
  supplier: "sky_air";
  flight_no: string;
  origin: string;
  destination: string;
  departure: string;
  passengers: number;
  amount: number;
  currency: string;
}

export interface BookingRequest {
  order_id: string;
  currency: string;
  customer: { id: string; email: string; name: string };
  payment_instrument: PaymentInstrument;
  order_lines: Array<HotelOrderLine | FlightOrderLine>;
}

export const bookingRequest: BookingRequest = {
  order_id: "ORD-1001",
  currency: "EUR",
  customer: {
    id: "CUST-77",
    email: "ada@example.com",
    name: "Ada Lovelace",
  },
  payment_instrument: {
    type: "card",
    token: "tok_visa_4242424242424242",
    holder: "Ada Lovelace",
    expiry: "2029-04",
    billing_country: "NL",
  },
  order_lines: [
    {
      id: "OL-1",
      product_type: "hotel",
      supplier: "acme_hotels",
      hotel_id: "H-BER-01",
      room_type: "double",
      check_in: "2026-09-10",
      check_out: "2026-09-12",
      guests: 2,
      amount: 320.0,
      currency: "EUR",
    },
    {
      id: "OL-2",
      product_type: "hotel",
      supplier: "acme_hotels",
      hotel_id: "H-BER-01",
      room_type: "single",
      check_in: "2026-09-10",
      check_out: "2026-09-12",
      guests: 1,
      amount: 180.0,
      currency: "EUR",
    },
    {
      id: "OL-3",
      product_type: "flight",
      supplier: "sky_air",
      flight_no: "SK-451",
      origin: "AMS",
      destination: "BER",
      departure: "2026-09-10T07:20:00Z",
      passengers: 3,
      amount: 540.0,
      currency: "EUR",
    },
  ],
};

export const ORDER_TOTAL = 320.0 + 180.0 + 540.0;
