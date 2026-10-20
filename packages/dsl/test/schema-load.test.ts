import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { closure, loadSchemas } from "../src/schema/load.js";

const fx = (n: string) => join(dirname(fileURLToPath(import.meta.url)), "fixtures", "schemas", n);

describe("loadSchemas", () => {
  it("loads draft-07 definitions and 2020-12 $defs", () => {
    const set = loadSchemas([
      { namespace: "travelco", file: fx("travelco.json") },
      { namespace: "common", file: fx("common.json") },
      { namespace: "other", file: fx("other.json") },
    ]);
    expect(set.errors).toEqual([]);
    expect(set.byKey.has("travelco.PaymentInstrument")).toBe(true);
    expect(set.byKey.has("common.Money")).toBe(true);
  });

  it("rewrites local refs into the namespace", () => {
    const set = loadSchemas([{ namespace: "travelco", file: fx("travelco.json") }]);
    expect(set.byKey.get("travelco.BookingRequest")).toMatchObject({
      properties: { payment: { $ref: "#/definitions/travelco.PaymentInstrument" } },
    });
  });

  it("rewrites relative file refs using the namespace of the referenced file", () => {
    const set = loadSchemas([
      { namespace: "common", file: fx("common.json") },
      { namespace: "other", file: fx("other.json") },
      { namespace: "pricing", file: fx("priced.json") },
    ]);
    expect(set.errors).toEqual([]);
    expect(set.byKey.get("pricing.Priced")).toMatchObject({
      properties: { price: { $ref: "#/definitions/common.Money" } },
    });
  });

  it("loads inline schemas under the given namespace", () => {
    const set = loadSchemas([
      { namespace: "acme", inline: { A: { $ref: "#/definitions/B" }, B: { type: "string" } } },
    ]);
    expect(set.errors).toEqual([]);
    expect(set.byKey.get("acme.A")).toEqual({ $ref: "#/definitions/acme.B" });
  });

  it("reports a collision", () => {
    const set = loadSchemas([
      { namespace: "travelco", file: fx("travelco.json") },
      { namespace: "travelco", inline: { Unrelated: { type: "number" } } },
    ]);
    expect(set.errors.map((e) => e.kind)).toEqual(["collision"]);
  });

  it("reports remote refs", () => {
    const set = loadSchemas([{ namespace: "r", file: fx("remote.json") }]);
    expect(set.errors.map((e) => e.kind)).toEqual(["remote-ref"]);
  });

  it("reports a relative ref to a file absent from sources", () => {
    const set = loadSchemas([{ namespace: "m", file: fx("missingfile.json") }]);
    expect(set.errors.map((e) => e.kind)).toEqual(["unresolved-ref"]);
    const only = loadSchemas([{ namespace: "pricing", file: fx("priced.json") }]);
    expect(only.errors.map((e) => e.kind)).toEqual(["unresolved-ref"]);
  });

  it("reports an unreadable file", () => {
    const set = loadSchemas([{ namespace: "x", file: fx("does-not-exist.json") }]);
    expect(set.errors.map((e) => e.kind)).toEqual(["unreadable"]);
  });
});

describe("closure", () => {
  const set = loadSchemas([
    { namespace: "travelco", file: fx("travelco.json") },
    { namespace: "common", file: fx("common.json") },
    { namespace: "other", file: fx("other.json") },
  ]);

  it("is the transitive ref closure only", () => {
    expect(Object.keys(closure(set, ["travelco.BookingRequest"]))).toEqual([
      "travelco.BookingRequest",
      "travelco.PaymentInstrument",
    ]);
  });

  it("terminates on a recursive type, each key once", () => {
    expect(Object.keys(closure(set, ["travelco.TreeNode"]))).toEqual(["travelco.TreeNode"]);
  });

  it("terminates on a two-file cycle", () => {
    expect(Object.keys(closure(set, ["common.PingA"]))).toEqual(["common.PingA", "other.PingB"]);
  });
});
