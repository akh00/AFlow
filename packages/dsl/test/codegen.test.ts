import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { generateRegistry } from "../src/schema/codegen.js";
import { loadSchemas } from "../src/schema/load.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const fx = (n: string) => join(here, "fixtures", "schemas", n);
const tmp = mkdtempSync(join(tmpdir(), "aflow-codegen-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function check(registry: string, probe: string): string[] {
  const reg = join(tmp, "registry.d.ts");
  const prb = join(tmp, "probe.ts");
  writeFileSync(reg, registry);
  writeFileSync(prb, `import type { SchemaRegistry } from "@aflow/dsl";\n${probe}\nexport {};\n`);
  const program = ts.createProgram([reg, prb], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    types: [],
    baseUrl: root,
    paths: {
      "@aflow/dsl": ["packages/dsl/src/index.ts"],
      "@aflow/engine": ["src/index.ts"],
    },
  });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && (d.file.fileName === reg || d.file.fileName === prb))
    .map((d) => `${d.file!.fileName}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

const set = loadSchemas([
  { namespace: "travelco", file: fx("travelco.json") },
  {
    namespace: "inline",
    inline: {
      Booking: {
        type: "object",
        required: ["order_id", "type"],
        properties: {
          order_id: { type: "string" },
          currency: { type: "string" },
          type: { enum: ["card", "invoice"] },
        },
        additionalProperties: false,
      },
    },
  },
]);

describe("generateRegistry", () => {
  const out = generateRegistry(set);

  it("loads the fixture without errors", () => expect(set.errors).toEqual([]));

  it("emits a module augmentation of SchemaRegistry", () => {
    expect(out).toContain('declare module "@aflow/dsl"');
    expect(out).toContain('"travelco.TreeNode"');
  });

  it("is deterministic regardless of insertion order", () => {
    const reversed = { byKey: new Map([...set.byKey].reverse()), errors: [] };
    expect(generateRegistry(reversed)).toBe(out);
  });

  it("type-checks and yields the expected types", () => {
    const probe = `
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const ok = <T extends true>(): T | void => {};
type B = SchemaRegistry["inline.Booking"];
ok<Eq<B["order_id"], string>>();
ok<Eq<B["currency"], string | undefined>>();
ok<Eq<B["type"], "card" | "invoice">>();
declare const n: SchemaRegistry["travelco.TreeNode"];
const deep: unknown = n.children?.[0]?.children;
declare const r: SchemaRegistry["travelco.BookingRequest"];
const tok: string | undefined = r.payment?.token;
// @ts-expect-error closed object
const bad: B = { order_id: "a", type: "card", extra: 1 };
`;
    expect(check(out, probe)).toEqual([]);
  });

  it("maps unions, intersections, arrays, consts and unknown keywords", () => {
    const s = loadSchemas([
      {
        namespace: "m",
        inline: {
          U: { oneOf: [{ type: "string" }, { type: "integer" }] },
          N: { type: ["string", "null"] },
          I: { allOf: [{ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, { type: "object", properties: { b: { type: "number" } }, required: ["b"] }] },
          A: { type: "array", items: { anyOf: [{ type: "string" }, { type: "boolean" }] } },
          C: { const: "x" },
          O: { type: "object", additionalProperties: { type: "number" } },
          Open: { type: "object", properties: { a: { type: "string" } } },
          Weird: { not: { type: "string" } },
          Key: { type: "object", properties: { "a.b-c": { type: "string" } }, required: ["a.b-c"] },
        },
      },
    ]);
    const probe = `
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const ok = <T extends true>(): T | void => {};
ok<Eq<SchemaRegistry["m.U"], string | number>>();
ok<Eq<SchemaRegistry["m.N"], string | null>>();
ok<Eq<SchemaRegistry["m.A"], (string | boolean)[]>>();
ok<Eq<SchemaRegistry["m.C"], "x">>();
ok<Eq<SchemaRegistry["m.Weird"], unknown>>();
const i: SchemaRegistry["m.I"] = { a: "s", b: 1 };
const o: SchemaRegistry["m.O"] = { q: 1 };
const op: SchemaRegistry["m.Open"] = { a: "s", anything: 1 };
const k: string = ({} as SchemaRegistry["m.Key"])["a.b-c"];
`;
    expect(check(generateRegistry(s), probe)).toEqual([]);
  });
});
