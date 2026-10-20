import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeProgram } from "../src/analyzer/index.js";
import type { AflowDiagnostic, RuleId } from "../src/analyzer/diagnostics.js";
import { programOf } from "./helpers.js";

// ── sources ────────────────────────────────────────────────────────────────

const REGISTRY = `
import "@aflow/dsl";
declare module "@aflow/dsl" {
  interface SchemaRegistry {
    "acme.In": { order_id: string; lines: { id: string; amount: number }[] };
    "acme.Line": { id: string; amount: number; x: boolean };
    "acme.Hold": { hold_id: string };
  }
}
`;

const HEADER = `
import { workflow } from "@aflow/dsl";

export const wf = workflow({
  client_id: "acme",
  name: "boundary",
  input: "acme.In",
  items: {
    order: { data: "input", parent: null },
    line: { data: "acme.Line", objects: "acme.Line", parent: "order" },
  },
  config: { defaults: { entry: "t" } },
});
`;

const HELPERS = `export const helper = (n: number) => n + 1;\n`;

/**
 * A one-task workflow: task `t` on item `order` carries `fields`; `extra` is module code before the group.
 * With `node`, the program also loads `@types/node`, as a real project does.
 */
function program(fields: string, extra = "", node = false) {
  return programOf({
    ...(node && { "node-types.d.ts": `/// <reference types="node" />\n` }),
    "registry.d.ts": REGISTRY,
    "header.ts": HEADER,
    "helpers.ts": HELPERS,
    "w.ts": `import { wf } from "./header";
${extra}
export const g = wf.tasks({
  t: { item: "order", ${fields}, route: null },
});
export default wf.assemble(g);
`,
  });
}

const BOUNDARY_RULES: readonly RuleId[] = [
  "outside-reference",
  "forbidden-global",
  "this",
  "async",
  "dynamic-import",
  "param-shape",
  "scope-rebind",
];

/** The boundary diagnostics of the program built from `fields` / `extra`. */
function boundary(fields: string, extra = "", node = false): AflowDiagnostic[] {
  return analyzeProgram(ts, program(fields, extra, node)).diagnostics.filter((d) => BOUNDARY_RULES.includes(d.rule));
}

const rules = (ds: AflowDiagnostic[]) => ds.map((d) => d.rule);

// ── identifiers ────────────────────────────────────────────────────────────

describe("checkBoundary — free identifiers (§15.4)", () => {
  it("a module constant is an outside-reference naming it", () => {
    const ds = boundary(`condition: ({ data }) => data.lines.length < MAX`, `const MAX = 3;`);
    expect(rules(ds)).toEqual(["outside-reference"]);
    expect(ds[0]!.message).toContain("`MAX`");
    expect(ds[0]!.message).toContain("w.ts");
  });

  it("an imported helper is an outside-reference", () => {
    const ds = boundary(`condition: ({ data }) => helper(data.lines.length) > 2`, `import { helper } from "./helpers";`);
    expect(rules(ds)).toEqual(["outside-reference"]);
    expect(ds[0]!.message).toContain("`helper`");
  });

  it("Date.now() is a forbidden-global with the engine's reason", () => {
    const ds = boundary(`condition: ({}) => Date.now() > 0`);
    expect(rules(ds)).toEqual(["forbidden-global"]);
    expect(ds[0]!.message).toContain("reading the clock");
    expect(ds[0]!.message).toContain("§5");
  });

  it("Math.random() is a forbidden-global", () => {
    const ds = boundary(`condition: ({}) => Math.random() > 0.5`);
    expect(rules(ds)).toEqual(["forbidden-global"]);
    expect(ds[0]!.message).toContain("Math.random");
  });

  it("Math.max and JSON.stringify are safe globals", () => {
    expect(boundary(`condition: ({ data }) => Math.max(1, 2) > JSON.stringify(data).length`)).toEqual([]);
  });

  it("a safe-global name declared by the user is an outside-reference", () => {
    const ds = boundary(`condition: ({}) => JSON.ok`, `const JSON = { ok: true };`);
    expect(rules(ds)).toEqual(["outside-reference"]);
  });

  it("a scope name shadowing a module constant is the parameter (Review Focus 2)", () => {
    expect(boundary(`condition: ({ items }) => items.length > 0`, `const items: unknown[] = [];`)).toEqual([]);
  });

  it("nested lambda parameters are locals (Review Focus 2)", () => {
    const fields = `await: { select: ({ items }) => items, until: ({ set }) => set.every(i => i.data.x) }`;
    expect(boundary(fields)).toEqual([]);
  });

  it("property names and object keys are not references (Review Focus 3)", () => {
    expect(boundary(`enrich: ({ objects }) => objects.Date ?? { fetch: 1 }`)).toEqual([]);
  });

  it("a shorthand object member is a reference", () => {
    const ds = boundary(`enrich: ({ objects }) => ({ objects, MAX })`, `const MAX = 3;`);
    expect(rules(ds)).toEqual(["outside-reference"]);
  });

  it("a forbidden name inside a string is not a reference (Review Focus 1)", () => {
    expect(boundary(`condition: ({}) => "Date.now()".length > 0`)).toEqual([]);
  });

  it("type annotations are erased, so a module type is not a reference", () => {
    expect(boundary(`condition: ({ data }: { data: Lines }) => data.lines.length > 0`, `type Lines = { lines: unknown[] };`)).toEqual(
      [],
    );
  });
});

// ── syntax ─────────────────────────────────────────────────────────────────

describe("checkBoundary — this, async, import()", () => {
  it("this is reported", () => {
    expect(rules(boundary(`condition: ({}) => this.data`))).toContain("this");
  });

  it("this in a nested function of a pure expression is reported: the engine binds it to globalThis", () => {
    const fields =
      "condition: ({ data }) => [data].map(function (this: typeof globalThis) { return this.Date.now(); }).length > 0";
    expect(rules(boundary(fields))).toEqual(["this"]);
  });

  it("this in a nested class of a pure expression is reported", () => {
    const fields = "condition: ({ data }) => new (class { v = this; })() !== data";
    expect(rules(boundary(fields))).toEqual(["this"]);
  });

  it("an async pure arrow is reported", () => {
    expect(rules(boundary(`condition: async ({ data }) => data.lines.length > 0`))).toContain("async");
  });

  it("await inside a pure arrow is reported", () => {
    expect(rules(boundary(`enrich: ({ objects, items }) => { objects.x = items.map(async (i) => await i); }`))).toContain("async");
  });

  it("import() is a dynamic-import", () => {
    expect(rules(boundary(`condition: ({}) => !!import("./helpers")`))).toContain("dynamic-import");
  });
});

// ── parameter shape ────────────────────────────────────────────────────────

describe("checkBoundary — param-shape", () => {
  it("({}) is valid (R6)", () => {
    expect(boundary(`condition: ({}) => true`)).toEqual([]);
  });

  it.each([
    ["renamed", `condition: ({ data: d }) => d.lines.length > 0`],
    ["defaulted", `condition: ({ data = {} as never }) => !!data`],
    ["non-destructured", `condition: (s) => !!s.data`],
    ["zero parameters", `condition: () => true`],
    ["rest", `condition: ({ data, ...rest }) => !!rest`],
    ["name not in scope", `condition: ({ set }) => !!set`],
  ])("%s is param-shape", (_label, fields) => {
    expect(rules(boundary(fields))).toContain("param-shape");
  });
});

// ── effect code ────────────────────────────────────────────────────────────

describe("checkBoundary — call.script (§15.6)", () => {
  const call = (script: string) =>
    `call: { provider: "js", input: ({ data }) => data, script: ${script}, output: { result_type: "acme.Hold" } }`;

  it("an async (input, lib) script is valid", () => {
    expect(boundary(call(`async (input, lib) => await lib.x(input)`))).toEqual([]);
  });

  it("a script referencing a module constant is an outside-reference", () => {
    const ds = boundary(call(`async (input, lib) => await lib.x(URL_BASE + input)`), `const URL_BASE = "https://x";`);
    expect(rules(ds)).toEqual(["outside-reference"]);
    expect(ds[0]!.message).toContain("`URL_BASE`");
  });
});

// ── ambient globals (fix round 1) ──────────────────────────────────────────

describe("checkBoundary — ambient globals", () => {
  it("@types/node is really loaded (fixture sanity)", () => {
    const p = program(`condition: ({}) => true`, "", true);
    expect(p.getSourceFiles().some((sf) => sf.fileName.includes("@types/node/compatibility/indexable.d.ts"))).toBe(true);
  });

  it("safe globals stay safe when @types/node adds declarations to them", () => {
    expect(boundary(`condition: ({ data }) => Array.isArray(data.lines) && String(1) === "1"`, "", true)).toEqual([]);
  });

  it("a user augmentation of a lib interface keeps the global safe", () => {
    const extra = `declare global { interface Array<T> { aflowExtra?: T } }`;
    expect(boundary(`condition: ({ data }) => Array.isArray(data.lines)`, extra)).toEqual([]);
  });

  it("Math.random stays forbidden when Math is augmented", () => {
    const ds = boundary(`condition: ({}) => Math.random() > 0.5`, `declare global { interface Math { aflowExtra?: number } }`);
    expect(rules(ds)).toEqual(["forbidden-global"]);
  });

  it("an ambient global that is not safe is an outside-reference in a pure expression", () => {
    expect(rules(boundary(`condition: ({ data }) => { console.log(data); return true; }`, "", true))).toEqual([
      "outside-reference",
    ]);
  });

  it("text in a template literal or a comment is not a reference", () => {
    const fields = "condition: ({ data }) => /* Date.now() */ `Date.now() => { this ${data.order_id}`.length > 0";
    expect(boundary(fields)).toEqual([]);
  });
});

describe("checkBoundary — call.script and ambient globals (R20)", () => {
  const call = (script: string) =>
    `call: { provider: "js", input: ({ data }) => data, script: ${script}, output: { result_type: "acme.Hold" } }`;

  it("a script may use forbidden and ambient globals", () => {
    const script = `async (input, lib) => {
      const t = Date.now() + Math.random();
      setTimeout(() => process.exit(0), 1);
      const r = await fetch(new URL(String(input), "https://x"));
      return lib.x(t, r);
    }`;
    expect(boundary(call(script), "", true)).toEqual([]);
  });

  it("a script still may not use a module constant", () => {
    const ds = boundary(call(`async (input, lib) => await lib.x(URL_BASE + input)`), `const URL_BASE = "https://x";`, true);
    expect(rules(ds)).toEqual(["outside-reference"]);
  });
});

describe("checkBoundary — this in effect code (§15.6)", () => {
  it("a nested function of a script binds its own this", () => {
    const script = `async (input, lib) => [input].map(function (this: unknown) { return this; })`;
    const fields = `call: { provider: "js", input: ({ data }) => data, script: ${script}, output: { result_type: "acme.Hold" } }`;
    expect(boundary(fields)).toEqual([]);
  });
});

// ── assignment to scope names ──────────────────────────────────────────────

describe("checkBoundary — scope-rebind (§15.4)", () => {
  it.each([
    ["assigning objects in a statement block", `enrich: ({ objects }) => { objects = { a: 1 }; }`, "objects"],
    ["assigning next_task at a value position", `target_state_setter: ({ next_task }) => (next_task = "zz", "success")`, "next_task"],
    ["assigning data at a value position", `condition: ({ data }) => (data = data) !== null`, "data"],
    ["a compound assignment to tasks", `enrich: ({ tasks }) => { tasks ??= {}; }`, "tasks"],
    ["an increment of id", `enrich: ({ id }) => { (id as unknown as number)++; }`, "id"],
    ["a destructuring assignment to objects", `enrich: ({ objects }) => { [objects] = [{}]; }`, "objects"],
  ])("%s is scope-rebind", (_label, fields, name) => {
    const ds = boundary(fields);
    expect(rules(ds)).toEqual(["scope-rebind"]);
    expect(ds[0]!.message).toContain(`\`${name}\``);
  });

  it.each([
    ["assigning target_state in a statement block", `enrich: ({ target_state }) => { target_state = "failure"; }`],
    ["assigning data and next_task in reduce", `aggregate: { select: ({ items }) => items, reduce: ({ data, next_task, set }) => { data = set; next_task = null; } }`],
    ["assigning a member of objects", `enrich: ({ objects }) => { objects.x = 1; }`],
    ["assigning a local that shadows a scope name", `enrich: ({ objects }) => { [1].forEach((objects) => { objects = 2; }); }`],
    ["assigning a local copy", `enrich: ({ objects }) => { let o = objects; o = {}; }`],
  ])("%s is valid", (_label, fields) => {
    expect(boundary(fields)).toEqual([]);
  });
});
