import ts from "typescript";
import { describe, expect, it } from "vitest";
import { analyzeProgram, arrowsOf } from "../src/analyzer/index.js";
import { type AflowDiagnostic, RULE_CODES } from "../src/analyzer/diagnostics.js";
import { emitArrow, emitScript } from "../src/analyzer/emit.js";
import { evaluateLiteral } from "../src/analyzer/literal.js";
import { MEM, programOf, typeErrors } from "./helpers.js";

// ── sources ────────────────────────────────────────────────────────────────

const REGISTRY = `
import "@aflow/dsl";
declare module "@aflow/dsl" {
  interface SchemaRegistry {
    "acme.In": { order_id: string; order_lines: { id: string; amount: number }[] };
    "acme.Out": { order_id: string };
    "acme.Line": { id: string; amount: number };
    "acme.Hold": { hold_id: string };
  }
}
`;

const HEADER = `
import { workflow } from "@aflow/dsl";

export const wf = workflow({
  client_id: "acme",
  name: "mini",
  version: "1.0.0",
  types: { Hold: { type: "object" } },
  input: "acme.In",
  result: "acme.Out",
  items: {
    order: { data: "input", parent: null },
    line: { data: "acme.Line", objects: "acme.Line", parent: "order" },
  },
  config: {
    defaults: {
      item: { target_state: "success", allowed_target_states: ["success", "failure"] },
      task: { default_error_handler: { $do: ({ error, logging_context }) => logging_context.err = error } },
      entry: "split_lines",
    },
  },
});
`;

const ORDER_GROUP = `
export const order_tasks = wf.tasks({
  split_lines: {
    item: "order",
    split: {
      item_type: "line",
      selector: ({ data }) => data.order_lines,
      route: "hold_line",
      parallel: true,
    },
    route: "finish",
  },
  finish: {
    item: "order",
    timeout: -5,
    return: { result: ({ data }) => ({ order_id: data.order_id }) },
    route: null,
  },
});
`;

const LINE_GROUP = `
export const line_tasks = wf.tasks({
  "hold_line": {
    item: "line",
    retry: { inline: { max_count: 1, interval: \`5ms\` } } as const,
    call: {
      provider: "js",
      input: ({ data }) => data,
      script: async (input, lib) => await lib.hold(input),
      output: {
        result_type: "acme.Hold",
        enrich: ({ objects, result }) => { objects.id = result.hold_id; },
      },
    },
    route: { switch: ({ target_state }) => target_state, cases: { success: null, failure: null } },
  },
});
`;

const EXPECTED_TASKS = [
  {
    name: "split_lines",
    item: "order",
    split: {
      item_type: "line",
      selector: { $expr: "data.order_lines" },
      route: "hold_line",
      parallel: true,
    },
    route: "finish",
  },
  {
    name: "finish",
    item: "order",
    timeout: -5,
    return: { result: { $expr: "({ order_id: data.order_id })" } },
    route: null,
  },
  {
    name: "hold_line",
    item: "line",
    retry: { inline: { max_count: 1, interval: "5ms" } },
    call: {
      provider: "js",
      input: { $expr: "data" },
      script: "async (input, lib) => await lib.hold(input)",
      output: {
        result_type: "acme.Hold",
        enrich: { $do: "objects.id = result.hold_id;" },
      },
    },
    route: { switch: { $expr: "target_state" }, cases: { success: null, failure: null } },
  },
];

/** One file: header, both groups and the assembly. */
const oneFile = () =>
  programOf({
    "registry.d.ts": REGISTRY,
    "mini.ts": `${HEADER}${ORDER_GROUP}${LINE_GROUP}\nexport default wf.assemble(order_tasks, line_tasks);\n`,
  });

/** Four files: the groups live in their own modules. */
const multiFile = () =>
  programOf({
    "registry.d.ts": REGISTRY,
    "header.ts": HEADER,
    "order.ts": `import { wf } from "./header";\n${ORDER_GROUP}`,
    "line.ts": `import { wf } from "./header";\n${LINE_GROUP}`,
    "main.ts": [
      `import { wf } from "./header";`,
      `import { order_tasks } from "./order";`,
      `import { line_tasks } from "./line";`,
      `export default wf.assemble(order_tasks, line_tasks);`,
    ].join("\n"),
  });

/** A one-file workflow whose `split_lines` task carries `fields` instead of its usual body. */
function withTask(fields: string, extra = "") {
  return programOf({
    "registry.d.ts": REGISTRY,
    "w.ts": `${HEADER}
${extra}
export const g = wf.tasks({
  split_lines: { item: "order", ${fields} },
});
export default wf.assemble(g);
`,
  });
}

const only = (program: ts.Program) => {
  const a = analyzeProgram(ts, program);
  expect(a.workflows).toHaveLength(1);
  return { a, wf: a.workflows[0]! };
};

/** The source text a diagnostic points at. */
const textAt = (program: ts.Program, d: { file: string; start: number; length: number }) =>
  program.getSourceFile(d.file)!.text.slice(d.start, d.start + d.length);

/** The first arrow function in `src`. */
function arrowIn(src: string): ts.ArrowFunction {
  const sf = ts.createSourceFile("/x.ts", src, ts.ScriptTarget.ESNext, true);
  let found: ts.ArrowFunction | undefined;
  const visit = (n: ts.Node): void => {
    if (!found && ts.isArrowFunction(n)) found = n;
    else ts.forEachChild(n, visit);
  };
  visit(sf);
  return found!;
}

// ── extraction ─────────────────────────────────────────────────────────────

describe("analyzeProgram — extraction", () => {
  it("the mini workflow type-checks (fixture sanity)", () => {
    expect(typeErrors(oneFile())).toEqual([]);
    expect(typeErrors(multiFile())).toEqual([]);
  });

  it("extracts a one-file workflow: header, items, config and tasks in order", () => {
    const { a, wf } = only(oneFile());
    expect(a.diagnostics).toEqual([]);
    expect(wf.headerFile).toBe(`${MEM}/mini.ts`);
    expect(wf.headerSymbol).toBe("wf");
    expect(wf.entryFile).toBe(`${MEM}/mini.ts`);
    expect(wf.taskNames).toEqual(["split_lines", "finish", "hold_line"]);
    expect(wf.definition).toEqual({
      client_id: "acme",
      name: "mini",
      version: "1.0.0",
      definitions: {
        input: { $ref: "#/definitions/acme.In" },
        result: { $ref: "#/definitions/acme.Out" },
      },
      items: {
        order: { data: { $ref: "#/definitions/input" }, parent: null },
        line: {
          data: { $ref: "#/definitions/acme.Line" },
          objects: { $ref: "#/definitions/acme.Line" },
          parent: "order",
        },
      },
      config: {
        defaults: {
          item: { target_state: "success", allowed_target_states: ["success", "failure"] },
          // §15.8: always `$do`, even for an expression body.
          task: { default_error_handler: { $do: "logging_context.err = error" } },
          entry: "split_lines",
        },
      },
      tasks: EXPECTED_TASKS,
    });
    expect(wf.header).toMatchObject({ client_id: "acme", types: { Hold: { type: "object" } } });
  });

  it("extracts the same tasks when the groups live in other files", () => {
    const { a, wf } = only(multiFile());
    expect(a.diagnostics).toEqual([]);
    expect(wf.headerFile).toBe(`${MEM}/header.ts`);
    expect(wf.entryFile).toBe(`${MEM}/main.ts`);
    expect(wf.definition.tasks).toEqual(EXPECTED_TASKS);
    expect(wf.locations.tasks.hold_line!.file).toBe(`${MEM}/line.ts`);
  });

  it("orders tasks by assemble argument order, then property order", () => {
    const program = programOf({
      "registry.d.ts": REGISTRY,
      "mini.ts": `${HEADER}${ORDER_GROUP}${LINE_GROUP}\nexport default wf.assemble(line_tasks, order_tasks);\n`,
    });
    expect(only(program).wf.taskNames).toEqual(["hold_line", "split_lines", "finish"]);
  });

  it("reports a header without an entry with no tasks", () => {
    const { wf } = only(programOf({ "registry.d.ts": REGISTRY, "header.ts": HEADER }));
    expect(wf.entryFile).toBeNull();
    expect(wf.definition.tasks).toEqual([]);
  });

  it("ignores a `workflow` function that is not the one from @aflow/dsl", () => {
    const program = programOf({
      "w.ts": `
        function workflow<T>(x: T) { return x; }
        export const wf = workflow({ client_id: "a", name: "b" });
      `,
    });
    expect(analyzeProgram(ts, program)).toEqual({ workflows: [], diagnostics: [] });
  });

  it("records the 1-based location of every task and expression", () => {
    const program = multiFile();
    const { wf } = only(program);
    const text = program.getSourceFile(`${MEM}/order.ts`)!.text;
    const lc = (needle: string) => {
      const before = text.slice(0, text.indexOf(needle)).split("\n");
      return { line: before.length, column: before[before.length - 1]!.length + 1 };
    };
    expect(wf.locations.expressions["/tasks/0/split/selector"]).toEqual({
      file: `${MEM}/order.ts`,
      ...lc("({ data }) => data.order_lines"),
    });
    expect(wf.locations.tasks.split_lines).toEqual({ file: `${MEM}/order.ts`, ...lc("split_lines:") });
    expect(Object.keys(wf.locations.expressions).sort()).toEqual([
      "/config/defaults/task/default_error_handler/$do",
      "/tasks/0/split/selector",
      "/tasks/1/return/result",
      "/tasks/2/call/input",
      "/tasks/2/call/output/enrich",
      "/tasks/2/call/script",
      "/tasks/2/route/switch",
    ]);
  });

  it("keeps the arrow node of every expression pointer in the internal map (R2)", () => {
    const { wf } = only(multiFile());
    const arrows = arrowsOf(wf)!;
    expect([...arrows.keys()].sort()).toEqual(Object.keys(wf.locations.expressions).sort());
    expect(arrows.get("/tasks/2/route/switch")!.getText()).toBe("({ target_state }) => target_state");
  });

  it("accepts `({}) => …` (R6)", () => {
    const { a, wf } = only(withTask(`condition: ({}) => true`));
    expect(a.diagnostics).toEqual([]);
    expect(wf.definition.tasks[0]).toEqual({ name: "split_lines", item: "order", condition: { $expr: "true" } });
  });
});

// ── diagnostics ────────────────────────────────────────────────────────────

describe("analyzeProgram — diagnostics", () => {
  it("numbers rule codes from 77001 in declaration order, `body-form` included (R8)", () => {
    expect(RULE_CODES["not-static"]).toBe(77001);
    expect(RULE_CODES.schema).toBe(77015);
    expect(RULE_CODES["body-form"]).toBe(77016);
    expect(RULE_CODES["no-entry"]).toBe(77017);
    expect(RULE_CODES["project-config"]).toBe(77018);
    expect(RULE_CODES["type-error"]).toBe(77019);
    expect(RULE_CODES["scope-rebind"]).toBe(77020);
  });

  it("`timeout: 2 * 1000` is not-static", () => {
    const program = withTask(`timeout: 2 * 1000`);
    const { a, wf } = only(program);
    expect(a.diagnostics).toHaveLength(1);
    expect(a.diagnostics[0]).toMatchObject({ rule: "not-static", severity: "error", file: `${MEM}/w.ts` });
    expect(textAt(program, a.diagnostics[0]!)).toBe("2 * 1000");
    expect(wf.diagnostics).toEqual(a.diagnostics);
  });

  it("a task name computed from a variable is not-static", () => {
    const program = programOf({
      "w.ts": `${HEADER}
const NAME = "split_lines";
export const g = wf.tasks({ [NAME]: { item: "order" } });
export default wf.assemble(g);
`,
    });
    const { a } = only(program);
    expect(a.diagnostics.map((d) => [d.rule, textAt(program, d)])).toEqual([
      // The header's `entry` now names no task: the computed name is dropped.
      ["unknown-task", `"split_lines"`],
      ["not-static", "[NAME]"],
    ]);
  });

  it("a variable, a helper call and a spread are not-static", () => {
    const program = withTask(
      `timeout: T, retry: make(), ...extra`,
      `const T = 5; const make = () => ({}); const extra = {};`,
    );
    const { a } = only(program);
    expect(a.diagnostics.map((d) => [d.rule, textAt(program, d)])).toEqual([
      ["not-static", "T"],
      ["not-static", "make()"],
      ["not-static", "...extra"],
    ]);
  });

  it("an arrow outside a §15.5 position or `call.script` is not-static", () => {
    const program = withTask(`route: { cases: { success: (() => "x") } }`);
    const { a } = only(program);
    expect(a.diagnostics.map((d) => [d.rule, textAt(program, d)])).toEqual([
      ["not-static", '() => "x"'],
    ]);
  });

  it("a block body at a value position is a body-form error at the body (R8)", () => {
    const program = withTask(`condition: ({ data }) => { return data.order_id !== ""; }`);
    const { a } = only(program);
    expect(a.diagnostics.map((d) => [d.rule, textAt(program, d)])).toEqual([
      ["body-form", '{ return data.order_id !== ""; }'],
    ]);
  });

  it("a construct that type erasure cannot remove is not-static (R19)", () => {
    const program = withTask(`enrich: ({ objects }) => { enum E { A } objects.e = E.A; }`);
    const { a } = only(program);
    expect(a.diagnostics.map((d) => [d.rule, textAt(program, d)])).toEqual([["not-static", "enum E { A }"]]);
  });

  it("a block body at a statement position is fine", () => {
    const { a, wf } = only(withTask(`enrich: ({ objects }) => {\n    objects.a = 1;\n  }`));
    expect(a.diagnostics).toEqual([]);
    expect(wf.definition.tasks[0]!.enrich).toEqual({ $do: "objects.a = 1;" });
  });

  it("a group declared inside a function is not-static", () => {
    const program = programOf({
      "w.ts": `${HEADER}
export function make() { return wf.tasks({ a: { item: "order" } }); }
`,
    });
    const { a } = only(program);
    expect(a.diagnostics.map((d) => d.rule)).toEqual(["not-static"]);
    expect(textAt(program, a.diagnostics[0]!)).toMatch(/^wf\.tasks\(/);
  });

  it("an assemble argument that is not a group identifier is not-static", () => {
    const program = programOf({
      "w.ts": `${HEADER}
export default wf.assemble(wf.tasks({ a: { item: "order" } }));
`,
    });
    const { a } = only(program);
    expect(a.diagnostics.map((d) => d.rule)).toContain("not-static");
  });
});

// ── emission ───────────────────────────────────────────────────────────────

describe("emitArrow / emitScript", () => {
  it("an expression body becomes `$expr`", () => {
    expect(emitArrow(ts, arrowIn(`f(({ data }) => data.order_lines)`))).toEqual({
      $expr: "data.order_lines",
    });
  });

  it("types are erased by deleting their spans; parentheses stay (R19)", () => {
    expect(emitArrow(ts, arrowIn(`f(({ data }: S) => (data as any).x!)`))).toEqual({ $expr: "(data).x" });
    expect(emitArrow(ts, arrowIn(`f(({ data }) => (data.a as any) * (data.b + 1 as number))`))).toEqual({
      $expr: "(data.a) * (data.b + 1)",
    });
  });

  it("spacing and line breaks are verbatim (R19)", () => {
    expect(emitArrow(ts, arrowIn(`f(({ a, b }) => a  ===   b)`))).toEqual({ $expr: "a  ===   b" });
    const chain = [
      "root.objects.all_reserved",
      "  // Every line reserved: commit",
      "  ? (type === 'hotel_line' ? 'commit' : 'confirm')",
      "  : (target_state === 'success'",
      "      ? 'release'",
      "      : 'abandon')",
    ].join("\n");
    expect(emitArrow(ts, arrowIn(`f(({ root, type, target_state }) =>\n  ${chain})`))).toEqual({ $expr: chain });
  });

  it("erases annotations, assertions, type arguments, type parameters and type declarations", () => {
    const arrow = arrowIn(`
      f(({ data, objects }) => {
        type Row = { id: string };
        interface Ignored { x: number }
        const rows: Row[] = data.rows as Row[];
        let n!: number;
        const pick = <T,>(xs: T[], i?: number): T => xs[i ?? 0]!;
        objects.first = pick<Row>(rows);
        objects.m = new Map<string, Row>();
        objects.c = (<any>data).c satisfies unknown;
        function g(this: void, y: number): number { return y; }
      })`);
    expect(emitArrow(ts, arrow)).toEqual({
      $do: [
        "const rows = data.rows;",
        "let n;",
        "const pick = (xs, i) => xs[i ?? 0];",
        "objects.first = pick(rows);",
        "objects.m = new Map();",
        "objects.c = (data).c;",
        "function g(y) { return y; }",
      ].join("\n"),
    });
  });

  it("an `enum`, a `namespace`, a parameter property or a decorator in an expression is not-static", () => {
    for (const body of [
      "enum E { A }",
      "namespace N { export const a = 1; }",
      "class C { constructor(private x: number) {} }",
      "class D { @dec m() {} }",
    ]) {
      const diagnostics: AflowDiagnostic[] = [];
      emitArrow(ts, arrowIn(`f(({ objects }) => { ${body} })`), diagnostics);
      expect(diagnostics.map((d) => d.rule), body).toEqual(["not-static"]);
      expect(diagnostics[0]!.message).toMatch(/not allowed in expressions/);
    }
  });

  it("a block body becomes `$do` without braces and common indentation", () => {
    const arrow = arrowIn(`
      f(({ objects, data }) => {
        objects.a = data.x as number; // keep me
        if (data.y) {
          objects.b = \`multi
  line\`;
        }
      })`);
    expect(emitArrow(ts, arrow)).toEqual({
      $do: "objects.a = data.x; // keep me\nif (data.y) {\n  objects.b = `multi\n  line`;\n}",
    });
  });

  it("keeps trailing spaces of a line that ends inside a template literal", () => {
    const arrow = arrowIn("f(({ o }) => {\n  o.s = `abc   \n  def`;\n})");
    expect(emitArrow(ts, arrow)).toEqual({ $do: "o.s = `abc   \n  def`;" });
  });

  it("a script is the full arrow text", () => {
    expect(emitScript(ts, arrowIn(`f(async (input, lib) => await lib.hold(input))`))).toBe(
      "async (input, lib) => await lib.hold(input)",
    );
    expect(emitScript(ts, arrowIn(`f(async (input: In, lib: any): Promise<unknown> => lib.x(input))`))).toBe(
      "async (input, lib) => lib.x(input)",
    );
    expect(emitScript(ts, arrowIn(`f(async (input,   lib) =>\n  lib.x(input as any))`))).toBe(
      "async (input,   lib) =>\n  lib.x(input)",
    );
  });

  it("strings, quotes and templates that look like code are verbatim (Review Focus 1)", () => {
    const arrow = arrowIn("f(({ data }) => data.s === \"a => {b} as T!\" ? 'this' : `x<T>(y: Z)`)");
    expect(emitArrow(ts, arrow)).toEqual({ $expr: "data.s === \"a => {b} as T!\" ? 'this' : `x<T>(y: Z)`" });
  });

  it("comments inside the body are kept", () => {
    expect(emitArrow(ts, arrowIn(`f(({ a }) => a\n  // pick b\n  ? 1 : 2)`))).toEqual({
      $expr: "a\n  // pick b\n  ? 1 : 2",
    });
  });
});

// ── literals ───────────────────────────────────────────────────────────────

describe("evaluateLiteral", () => {
  const value = (src: string) => {
    const sf = ts.createSourceFile("/l.ts", `x = ${src};`, ts.ScriptTarget.ESNext, true);
    const stmt = sf.statements[0] as ts.ExpressionStatement;
    return evaluateLiteral(ts, (stmt.expression as ts.BinaryExpression).right);
  };

  it("accepts literals, unary minus, objects, arrays, plain templates, `as const`, `satisfies`, parens", () => {
    expect(value(`{ a: -1.5, "b": [true, false, null], 3: \`t\`, ["c"]: "s" }`)).toEqual({
      value: { a: -1.5, b: [true, false, null], "3": "t", c: "s" },
    });
    expect(value(`(["x"] as const)`)).toEqual({ value: ["x"] });
    expect(value(`{ n: 1_000 } satisfies object`)).toEqual({ value: { n: 1000 } });
  });

  it("keeps `__proto__` as a plain key", () => {
    const r = value(`{ "__proto__": 1 }`) as { value: object };
    expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
    expect(Object.keys(r.value)).toEqual(["__proto__"]);
  });

  it.each([
    ["an identifier", "undefined"],
    ["a computation", "1 + 2"],
    ["a template with substitutions", "`a${1}`"],
    ["an arrow", "() => 1"],
    ["a function expression", "function () { return 1; }"],
    ["a non-const assertion", "1 as number"],
    ["a shorthand property", "{ a }"],
    ["an array hole", "[1, , 2]"],
    ["a unary minus on a string", `-"a"`],
  ])("rejects %s as not-static", (_what, src) => {
    const r = value(src);
    expect(r).toMatchObject({ diagnostic: { rule: "not-static", severity: "error" } });
  });
});
