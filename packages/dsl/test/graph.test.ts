import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { AflowDiagnostic } from "../src/analyzer/diagnostics.js";
import { analyzeProgram } from "../src/analyzer/index.js";
import { MEM, programOf } from "./helpers.js";

// ── sources ────────────────────────────────────────────────────────────────

/** `order` is the root; `line` is its child; `note` is a child of `line`. */
const header = (config = "") => `
import { workflow } from "@aflow/dsl";

export const wf = workflow({
  client_id: "acme",
  name: "graph",
  items: {
    order: { parent: null },
    line: { parent: "order" },
    note: { parent: "line" },
  },
  ${config}
});
`;

const ALLOWED = `config: { defaults: { item: { allowed_target_states: ["success", "failure"] } } },`;

/** One file: the header, one group `g` with `tasks`, and the assembly. */
function oneGroup(tasks: string, config = "") {
  return programOf({
    "w.ts": `${header(config)}
export const g = wf.tasks({
${tasks}
});
export default wf.assemble(g);
`,
  });
}

const GRAPH_RULES = new Set([
  "unknown-task",
  "multiple-bodies",
  "item-type-mismatch",
  "unreachable",
  "target-state",
  "duplicate-task",
  "unassembled-group",
]);

/** `[rule, severity, reported text]` of each graph diagnostic of the program. */
function graphOf(program: ts.Program, pick: (a: ReturnType<typeof analyzeProgram>) => AflowDiagnostic[] = (a) => a.diagnostics) {
  const a = analyzeProgram(ts, program);
  return pick(a)
    .filter((d) => GRAPH_RULES.has(d.rule))
    .map((d) => [d.rule, d.severity, program.getSourceFile(d.file)!.text.slice(d.start, d.start + d.length)]);
}

const graph = (tasks: string, config = "") => graphOf(oneGroup(tasks, config));

// ── unknown-task ───────────────────────────────────────────────────────────

describe("unknown-task", () => {
  it("accepts literal routes, cases and default that name tasks", () => {
    expect(
      graph(`
  a: { item: "order", route: { cases: { success: "b", failure: null }, default: "c" } },
  b: { item: "order", route: "c" },
  c: { item: "order", route: null },`),
    ).toEqual([]);
  });

  it("reports a literal route that names no task", () => {
    expect(graph(`a: { item: "order", route: "nope" },`)).toEqual([["unknown-task", "error", `"nope"`]]);
  });

  it("reports a `cases` value and a `default` that name no task", () => {
    expect(graph(`a: { item: "order", route: { cases: { success: "x1", failure: null }, default: "x2" } },`)).toEqual([
      ["unknown-task", "error", `"x1"`],
      ["unknown-task", "error", `"x2"`],
    ]);
  });

  it("reports a `split.route` and a `dispatch.route` that name no task", () => {
    expect(
      graph(`
  a: { item: "order", split: { item_type: "line", selector: ({ data }) => [data], route: "s1" }, route: "b" },
  b: { item: "order", dispatch: { select: ({ items }) => items, route: "d1" } },`),
    ).toEqual([
      ["unknown-task", "error", `"s1"`],
      ["unknown-task", "error", `"d1"`],
    ]);
  });

  it("reports `config.defaults.entry` and `config.defaults.task.route` that name no task", () => {
    expect(
      graph(`a: { item: "order" },`, `config: { defaults: { entry: "e1", task: { route: "r1" } } },`),
    ).toEqual([
      ["unknown-task", "error", `"e1"`],
      ["unknown-task", "error", `"r1"`],
    ]);
  });

  it("reports the unknown members of a route expression typed `\"a\" | \"zz\"` at the expression", () => {
    const program = oneGroup(
      `a: { item: "order", route: ({ target_state }): "a" | "zz" => (target_state === "x" ? "a" : "zz") },`,
    );
    const diags = analyzeProgram(ts, program).diagnostics.filter((d) => GRAPH_RULES.has(d.rule));
    expect(graphOf(program)).toEqual([
      ["unknown-task", "error", `({ target_state }): "a" | "zz" => (target_state === "x" ? "a" : "zz")`],
    ]);
    expect(diags[0]!.message).toContain("`zz`");
    expect(diags[0]!.message).not.toContain("`a`");
  });

  it("does not check a route expression typed `string`, and does not report `unreachable`", () => {
    expect(
      graph(`
  a: { item: "order", route: ({ data }): string => String(data) },
  orphan: { item: "order" },`),
    ).toEqual([]);
  });
});

// ── multiple-bodies ────────────────────────────────────────────────────────

describe("multiple-bodies", () => {
  it("accepts one body kind", () => {
    expect(graph(`a: { item: "order", enrich: ({ objects }) => { objects.x = 1; } },`)).toEqual([]);
  });

  it("reports a second body kind once, at the second body key", () => {
    expect(
      graph(`
  a: {
    item: "order",
    enrich: ({ objects }) => { objects.x = 1; },
    return: { result: ({ data }) => data },
    aggregate: { select: ({ items }) => items },
  },`),
    ).toEqual([["multiple-bodies", "error", "return"]]);
  });
});

// ── item-type-mismatch ─────────────────────────────────────────────────────

describe("item-type-mismatch", () => {
  it("accepts a route to the same item, and split / dispatch routes to a child type", () => {
    expect(
      graph(`
  a: { item: "order", split: { item_type: "line", selector: ({ data }) => [data], route: "l" }, route: "b" },
  b: { item: "order", dispatch: { select: ({ items }) => items, route: "l2" } },
  c: { item: "order", split: { item_type: ({}) => "line", selector: ({ data }) => [data], route: "l" }, route: "b" },
  l: { item: "line" },
  l2: { item: "line" },`,
        `config: { defaults: { entry: "a" } },`,
      ).filter(([rule]) => rule !== "unreachable"),
    ).toEqual([]);
  });

  it("reports a route to a task bound to another item type", () => {
    expect(
      graph(`
  a: { item: "order", route: "l" },
  l: { item: "line" },`),
    ).toEqual([["item-type-mismatch", "error", `"l"`]]);
  });

  it("reports a `split.route` to a task that is not bound to the literal `item_type`", () => {
    expect(
      graph(`
  a: { item: "order", split: { item_type: "line", selector: ({ data }) => [data], route: "o" } },
  o: { item: "order" },`),
    ).toEqual([["item-type-mismatch", "error", `"o"`]]);
  });

  it("reports a `split.route` with an expression `item_type` to a task that is not a child type", () => {
    expect(
      graph(`
  a: { item: "order", split: { item_type: ({}) => "line", selector: ({ data }) => [data], route: "n" } },
  n: { item: "note" },`),
    ).toEqual([["item-type-mismatch", "error", `"n"`]]);
  });

  it("reports a `dispatch.route` to a task that is not a child type", () => {
    expect(
      graph(`
  a: { item: "order", dispatch: { select: ({ items }) => items, route: "b" } },
  b: { item: "order" },`),
    ).toEqual([["item-type-mismatch", "error", `"b"`]]);
  });

  it("reports an inherited `config.defaults.task.route` at the task that inherits it", () => {
    expect(
      graph(
        `
  a: { item: "order", split: { item_type: "line", selector: ({ data }) => [data], route: "l" }, route: null },
  l: { item: "line" },`,
        `config: { defaults: { task: { route: { cases: { success: null } } } } },`,
      ),
    ).toEqual([]);
    expect(
      graph(
        `
  a: { item: "order", split: { item_type: "line", selector: ({ data }) => [data], route: "l" }, route: null },
  l: { item: "line" },`,
        `config: { defaults: { task: { route: "a" } } },`,
      ),
    ).toEqual([["item-type-mismatch", "error", "l"]]);
  });
});

// ── unreachable ────────────────────────────────────────────────────────────

describe("unreachable", () => {
  it("accepts tasks reached through route, split and dispatch targets", () => {
    expect(
      graph(`
  a: { item: "order", split: { item_type: "line", selector: ({ data }) => [data], route: "l" }, route: "b" },
  b: { item: "order", dispatch: { select: ({ items }) => items, route: { cases: { success: "l2" } } }, route: ({}): "c" | null => null },
  c: { item: "order" },
  l: { item: "line" },
  l2: { item: "line" },`),
    ).toEqual([]);
  });

  it("warns at a task that nothing reaches", () => {
    expect(
      graph(`
  a: { item: "order", route: null },
  orphan: { item: "order" },`),
    ).toEqual([["unreachable", "warning", "orphan"]]);
  });

  it("starts at `Input` before the first task, and at `config.defaults.entry` before both", () => {
    expect(
      graph(`
  a: { item: "order" },
  Input: { item: "order" },`),
    ).toEqual([["unreachable", "warning", "a"]]);
    expect(
      graph(
        `
  a: { item: "order" },
  Input: { item: "order" },
  b: { item: "order" },`,
        `config: { defaults: { entry: "b" } },`,
      ),
    ).toEqual([
      ["unreachable", "warning", "a"],
      ["unreachable", "warning", "Input"],
    ]);
  });
});

// ── target-state ───────────────────────────────────────────────────────────

describe("target-state", () => {
  it("accepts literals in `allowed_target_states`", () => {
    expect(
      graph(`a: { item: "order", target_state_setter: ({ items }) => (items.length ? "success" : "failure") },`, ALLOWED),
    ).toEqual([]);
  });

  it("reports a literal outside `allowed_target_states`", () => {
    expect(
      graph(`a: { item: "order", target_state_setter: ({ items }) => (items.length ? "success" : "lost") },`, ALLOWED),
    ).toEqual([["target-state", "error", `"lost"`]]);
  });

  it("checks nothing when no `allowed_target_states` is declared", () => {
    expect(graph(`a: { item: "order", target_state_setter: ({}) => "lost" },`)).toEqual([]);
  });
});

// ── duplicate-task ─────────────────────────────────────────────────────────

describe("duplicate-task", () => {
  const twoGroups = (second: string) =>
    programOf({
      "w.ts": `${header()}
export const g1 = wf.tasks({ a: { item: "order", route: "b" }, b: { item: "order" } });
export const g2 = wf.tasks({ ${second}: { item: "order" } });
export default wf.assemble(g1, g2);
`,
    });

  it("accepts distinct names across groups", () => {
    expect(graphOf(twoGroups("c")).filter(([r]) => r !== "unreachable")).toEqual([]);
  });

  it("reports the second declaration and keeps the location of the first", () => {
    const program = twoGroups("b");
    expect(graphOf(program)).toEqual([["duplicate-task", "error", "b"]]);
    const wf = analyzeProgram(ts, program).workflows[0]!;
    const text = program.getSourceFile(`${MEM}/w.ts`)!.text;
    const firstLine = text.slice(0, text.indexOf("b: { item")).split("\n").length;
    expect(wf.locations.tasks.b!.line).toBe(firstLine);
  });

  it("reports a group listed twice in `assemble`", () => {
    const program = programOf({
      "w.ts": `${header()}
export const g = wf.tasks({ a: { item: "order" } });
export default wf.assemble(g, g);
`,
    });
    expect(graphOf(program)).toEqual([["duplicate-task", "error", "g"]]);
  });
});

// ── unassembled-group ──────────────────────────────────────────────────────

describe("unassembled-group", () => {
  it("accepts groups that an assembly lists", () => {
    expect(graph(`a: { item: "order" },`)).toEqual([]);
  });

  it("warns at a group that no assembly lists, in the program diagnostics only", () => {
    const program = programOf({
      "w.ts": `${header()}
export const g = wf.tasks({ a: { item: "order" } });
export const spare = wf.tasks({ s: { item: "order" } });
export default wf.assemble(g);
`,
    });
    expect(graphOf(program)).toEqual([["unassembled-group", "warning", "spare"]]);
    expect(graphOf(program, (a) => a.workflows[0]!.diagnostics)).toEqual([]);
  });

  it("warns at the groups of a header that no file assembles", () => {
    const program = programOf({ "w.ts": `${header()}\nexport const g = wf.tasks({ a: { item: "order" } });\n` });
    expect(graphOf(program)).toEqual([["unassembled-group", "warning", "g"]]);
  });
});

// ── files ──────────────────────────────────────────────────────────────────

describe("graph diagnostics across files", () => {
  it("reports a task's diagnostic in the file that declares the task", () => {
    const program = programOf({
      "header.ts": header(),
      "order.ts": `import { wf } from "./header";\nexport const order_tasks = wf.tasks({ a: { item: "order", route: "h" } });\n`,
      "hotel.ts": `import { wf } from "./header";\nexport const hotel_tasks = wf.tasks({ h: { item: "order", route: "gone" } });\n`,
      "main.ts": [
        `import { wf } from "./header";`,
        `import { order_tasks } from "./order";`,
        `import { hotel_tasks } from "./hotel";`,
        `export default wf.assemble(order_tasks, hotel_tasks);`,
      ].join("\n"),
    });
    const a = analyzeProgram(ts, program);
    const graphDiags = a.diagnostics.filter((d) => GRAPH_RULES.has(d.rule));
    expect(graphDiags.map((d) => [d.rule, d.file])).toEqual([["unknown-task", `${MEM}/hotel.ts`]]);
    expect(a.workflows[0]!.diagnostics.filter((d) => GRAPH_RULES.has(d.rule))).toEqual(graphDiags);
  });
});
