/**
 * `buildWorkflow`, `generateTypes` and the `aflow` CLI (spec §15.7, §15.8,
 * §15.10), proven on the booking workflow of the engine's test suite.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bookingWorkflow } from "../../../test/fixtures/booking-workflow.js";
import { buildWorkflow, generateTypes } from "../src/build.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const booking = join(here, "fixtures", "booking");
const entry = join(booking, "book_travel_order.ts");
const cli = join(repo, "packages", "dsl", "dist", "cli.mjs");

/** Collapses the whitespace of every `$expr` / `$do` string; everything else stays exact (Ruling R11). */
function normalise(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalise);
  if (typeof v !== "object" || v === null) return v;
  return Object.fromEntries(
    Object.entries(v).map(([k, x]) => [
      k,
      (k === "$expr" || k === "$do") && typeof x === "string" ? x.replace(/\s+/g, " ").trim() : normalise(x),
    ]),
  );
}

// Workflows that must not build live in a temporary directory (Ruling R3).
const tmp = mkdtempSync(join(tmpdir(), "aflow-build-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Writes `files` into a fresh directory under `tmp`, with a tsconfig that resolves the packages. */
function project(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  const tsconfig = {
    compilerOptions: {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      types: [],
      paths: {
        "@aflow/dsl": [join(repo, "packages/dsl/src/index.ts")],
        "@aflow/engine": [join(repo, "src/index.ts")],
      },
    },
    include: ["*.ts", ".aflow/types/*.d.ts"],
  };
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify(tsconfig, null, 2));
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
}

const HEADER = `import { workflow } from "@aflow/dsl";
export const wf = workflow({
  client_id: "acme",
  name: "tiny",
  schemas: { acme: "./acme.json" },
  input: "acme.In",
  result: "acme.Out",
  items: { order: { data: "input", parent: null } },
});
`;
const SCHEMA = JSON.stringify({ definitions: { In: { type: "object" }, Out: { type: "object" } } });

describe("buildWorkflow — the booking workflow in the DSL", () => {
  const built = buildWorkflow(entry);

  it("has no diagnostics", () => {
    expect(built.diagnostics).toEqual([]);
  });

  it("builds the JSON fixture, expression whitespace aside", () => {
    expect(normalise(built.definition)).toEqual(normalise(bookingWorkflow));
  });

  it("keeps the source location of every task", () => {
    expect(built.locations?.tasks.hold_hotel_room).toMatchObject({ file: join(booking, "hotel.ts") });
    expect(Object.keys(built.locations?.tasks ?? {})).toHaveLength(bookingWorkflow.tasks.length);
  });
});

describe("the JSON fixture's schemas describe the runtime state (§10, R26)", () => {
  it("requires no objects member that the item does not have when it is created", () => {
    const created = Object.keys(bookingWorkflow.config?.defaults?.item?.objects ?? {});
    const defs = bookingWorkflow.definitions as Record<string, { required?: string[] }>;
    for (const decl of Object.values(bookingWorkflow.items ?? {})) {
      const ref = (decl.objects as { $ref?: string } | undefined)?.$ref;
      const key = ref?.replace("#/definitions/", "");
      const required = (key && defs[key]?.required) || [];
      expect({ key, missing: required.filter((m) => !created.includes(m)) }).toEqual({ key, missing: [] });
    }
  });
});

describe("buildWorkflow — problems are diagnostics, never throws", () => {
  it("reports an entry file that does not exist", () => {
    const r = buildWorkflow(join(tmp, "nope.ts"));
    expect(r.definition).toBeNull();
    expect(r.locations).toBeNull();
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ rule: "no-entry", severity: "error" });
  });

  it("reports an entry file that assembles no workflow", () => {
    const dir = project("no-assembly", { "header.ts": HEADER, "acme.json": SCHEMA });
    const r = buildWorkflow(join(dir, "header.ts"));
    expect(r.definition).toBeNull();
    expect(r.diagnostics.map((d) => d.rule)).toEqual(["no-entry"]);
  });

  it("reports tsconfig errors as project-config, at their position (R21)", () => {
    const dir = project("bad-config", { "header.ts": HEADER, "acme.json": SCHEMA });
    const config = join(dir, "broken.json");
    writeFileSync(config, '{\n  "compilerOptions": {\n    "target": "nope"\n  }\n}\n');
    const r = buildWorkflow(join(dir, "header.ts"), { tsconfig: config });
    const d = r.diagnostics.find((x) => x.file === config);
    expect(d).toMatchObject({ rule: "project-config", severity: "error" });
    expect(d!.start).toBeGreaterThan(0);
    expect(d!.length).toBeGreaterThan(0);
  });

  it("reports schema errors at the header", () => {
    const dir = project("bad-schema", {
      "header.ts": HEADER.replace('result: "acme.Out"', 'result: "acme.Missing"'),
      "acme.json": SCHEMA,
      "entry.ts": `import { wf } from "./header";
const g = wf.tasks({ Input: { item: "order", route: null } });
export default wf.assemble(g);
`,
    });
    const r = buildWorkflow(join(dir, "entry.ts"));
    expect(r.definition).toBeNull();
    // The typings come from the schemas, so the unknown key is also a TypeScript error, as in the editor.
    expect(r.diagnostics.map((d) => [d.rule, d.file])).toEqual([
      ["schema", join(dir, "header.ts")],
      ["type-error", join(dir, "header.ts")],
    ]);
    expect(r.diagnostics[0]!.message).toContain("acme.Missing");
  });

  it("reports TypeScript errors in the workflow's files as type-error, and does not build (R27)", () => {
    const dir = project("type-error", {
      "header.ts": HEADER,
      "acme.json": JSON.stringify({
        definitions: {
          In: { type: "object", properties: { a: { type: "string" } }, additionalProperties: false },
          Out: { type: "object" },
        },
      }),
      "group.ts": `import { wf } from "./header";
export const g = wf.tasks({
  Input: { item: "order", enrich: ({ data, logging_context }) => { logging_context.n = data.nope }, route: null },
});
`,
      "entry.ts": `import { wf } from "./header";
import { g } from "./group";
export default wf.assemble(g);
`,
    });
    expect(generateTypes(join(dir, "tsconfig.json")).diagnostics).toEqual([]);
    const r = buildWorkflow(join(dir, "entry.ts"));
    expect(r.definition).toBeNull();
    expect(r.diagnostics.map((d) => [d.rule, d.severity, d.file])).toEqual([["type-error", "error", join(dir, "group.ts")]]);
    expect(r.diagnostics[0]!.message).toContain("nope");
    expect(r.diagnostics[0]!.start).toBe(readFileSync(join(dir, "group.ts"), "utf8").indexOf("nope"));
  });

  it("ignores header misuse in a file that the entry does not import (R28)", () => {
    const dir = project("stray", {
      "header.ts": HEADER,
      "acme.json": SCHEMA,
      "group.ts": `import { wf } from "./header";
export const g = wf.tasks({ Input: { item: "order", route: null } });
`,
      "entry.ts": `import { wf } from "./header";
import { g } from "./group";
export default wf.assemble(g);
`,
      // In the tsconfig, but not imported by the entry: a second assembly that is not top level.
      "stray.ts": `import { wf } from "./header";
import { g } from "./group";
const y = wf.assemble(g);
`,
    });
    const r = buildWorkflow(join(dir, "entry.ts"));
    expect(r.diagnostics).toEqual([]);
    expect(r.definition).not.toBeNull();
  });

  it("checks a listed group file whose task names are all duplicates (R28)", () => {
    const dir = project("dup-group", {
      "header.ts": HEADER,
      "acme.json": SCHEMA,
      "group.ts": `import { wf } from "./header";
export const g = wf.tasks({ Input: { item: "order", route: null } });
`,
      "dup.ts": `import { wf } from "./header";
const n: number = "not a number";
export const d = wf.tasks({ Input: { item: "order", route: null } });
`,
      "entry.ts": `import { wf } from "./header";
import { g } from "./group";
import { d } from "./dup";
export default wf.assemble(g, d);
`,
    });
    const r = buildWorkflow(join(dir, "entry.ts"));
    expect(r.definition).toBeNull();
    expect(r.diagnostics.filter((x) => x.rule === "type-error").map((x) => x.file)).toEqual([join(dir, "dup.ts")]);
  });

  it("merges the schema closure into definitions", () => {
    const dir = project("tiny", {
      "header.ts": HEADER,
      "acme.json": SCHEMA,
      "entry.ts": `import { wf } from "./header";
const g = wf.tasks({ Input: { item: "order", route: null } });
export default wf.assemble(g);
`,
    });
    const r = buildWorkflow(join(dir, "entry.ts"));
    expect(r.diagnostics).toEqual([]);
    expect(r.definition?.definitions).toEqual({
      input: { $ref: "#/definitions/acme.In" },
      result: { $ref: "#/definitions/acme.Out" },
      "acme.In": { type: "object" },
      "acme.Out": { type: "object" },
    });
  });
});

describe("generateTypes", () => {
  it("writes a registry for a header that no assembly lists yet", () => {
    const dir = project("unassembled", {
      "header.ts": `${HEADER}export const g = wf.tasks({ Input: { item: "order", route: null } });\n`,
      "acme.json": SCHEMA,
    });
    const out = join(dir, ".aflow", "types", "acme.tiny.d.ts");
    expect(generateTypes(join(dir, "tsconfig.json"))).toEqual({ written: [out], diagnostics: [] });
  });

  it("writes the registry next to the header, and only when it changed", () => {
    const dir = project("types", { "header.ts": HEADER, "acme.json": SCHEMA });
    const out = join(dir, ".aflow", "types", "acme.tiny.d.ts");
    const first = generateTypes(join(dir, "tsconfig.json"));
    expect(first).toEqual({ written: [out], diagnostics: [] });
    expect(readFileSync(out, "utf8")).toContain('"acme.In": { [k: string]: unknown };');
    const mtime = statSync(out).mtimeMs;
    expect(generateTypes(join(dir, "tsconfig.json"))).toEqual({ written: [], diagnostics: [] });
    expect(statSync(out).mtimeMs).toBe(mtime);
  });

  it("types the booking fixture: it type-checks against its generated registry", () => {
    // The global setup ran `generateTypes` on the fixture project.
    const config = ts.getParsedCommandLineOfConfigFile(join(booking, "tsconfig.json"), {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    })!;
    expect(config.fileNames).toContain(join(booking, ".aflow", "types", "travelco.book_travel_order.d.ts"));
    const program = ts.createProgram(config.fileNames, config.options);
    const errors = ts
      .getPreEmitDiagnostics(program)
      .map((d) => `${d.file?.fileName}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
    expect(errors).toEqual([]);
  });
});

describe("the aflow CLI", () => {
  beforeAll(() => {
    // CLAUDE.md: at most 2 processors for builds.
    execFileSync("npm", ["run", "build", "-w", "@aflow/dsl"], {
      cwd: repo,
      stdio: "pipe",
      env: { ...process.env, GOMAXPROCS: "2" },
    });
  }, 60_000);

  const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: "utf8" });

  it("starts with a shebang, so the `aflow` bin runs directly", () => {
    expect(readFileSync(cli, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  it("builds the booking fixture: exit 0, the document on stdout", () => {
    const r = run("build", entry);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(normalise(JSON.parse(r.stdout))).toEqual(normalise(bookingWorkflow));
  });

  it("writes the document to -o", () => {
    const out = join(tmp, "booking.json");
    const r = run("build", entry, "-o", out);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(JSON.parse(readFileSync(out, "utf8")).tasks).toHaveLength(bookingWorkflow.tasks.length);
  });

  it("fails on an unknown task: exit 1, the diagnostic on stderr", () => {
    const dir = project("unknown-task", {
      "header.ts": HEADER,
      "acme.json": SCHEMA,
      "entry.ts": `import { wf } from "./header";
const g = wf.tasks({ Input: { item: "order", route: "nowhere" } });
export default wf.assemble(g);
`,
    });
    const r = run("build", join(dir, "entry.ts"));
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/entry\.ts:2:\d+ {2}error {2}unknown-task {2}/);
  });

  it("generates types for a project", () => {
    const dir = project("cli-types", { "header.ts": HEADER, "acme.json": SCHEMA });
    const r = run("types", "--project", join(dir, "tsconfig.json"));
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, ".aflow", "types", "acme.tiny.d.ts"), "utf8")).toContain("SchemaRegistry");
  });

  it("rejects an unknown command with exit 1", () => {
    const r = run("frobnicate");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("usage");
  });
});

describe("buildWorkflow — the schema typings come from the schemas, not from .aflow/types (§15.7, §15.8)", () => {
  /** A copy of the booking fixture under `tmp`, without `.aflow`, with a tsconfig that resolves the packages. */
  function bookingCopy(name: string): string {
    const dir = project(name, {});
    cpSync(booking, dir, { recursive: true, filter: (src) => !src.includes(".aflow") && !src.endsWith("tsconfig.json") });
    return dir;
  }

  it("builds a fresh copy that has no .aflow directory", () => {
    const dir = bookingCopy("fresh");
    const r = buildWorkflow(join(dir, "book_travel_order.ts"));
    expect(r.diagnostics).toEqual([]);
    expect(normalise(r.definition)).toEqual(normalise(bookingWorkflow));
  });

  it("fails on stale typings: a schema member type that the DSL reads changed after `aflow types`", () => {
    const dir = bookingCopy("stale");
    expect(generateTypes(join(dir, "tsconfig.json")).diagnostics).toEqual([]);
    const schemaFile = join(dir, "schemas", "travelco.json");
    const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
    schema.definitions.PaymentInstrument.properties.token = { type: "number" };
    writeFileSync(schemaFile, JSON.stringify(schema, null, 2));
    const r = buildWorkflow(join(dir, "book_travel_order.ts"));
    expect(r.definition).toBeNull();
    expect(r.diagnostics.map((d) => [d.rule, d.file])).toEqual([["type-error", join(dir, "order.ts")]]);
    expect(r.diagnostics[0]!.message).toContain("slice");
  });

  it("builds without a tsconfig", () => {
    // An installed layout: the packages are in node_modules, and no tsconfig.json is on the path.
    const dir = join(tmp, "no-tsconfig");
    const install = (from: string, name: string) => {
      const to = join(dir, "node_modules", "@aflow", name);
      cpSync(join(from, "package.json"), join(to, "package.json"));
      cpSync(join(from, "src"), join(to, "src"), { recursive: true });
    };
    install(join(repo, "packages", "dsl"), "dsl");
    install(repo, "engine");
    writeFileSync(
      join(dir, "acme.json"),
      JSON.stringify({ definitions: { In: { type: "object", required: ["a"], properties: { a: { type: "string" } } }, Out: { type: "object" } } }),
    );
    writeFileSync(join(dir, "header.ts"), HEADER);
    writeFileSync(
      join(dir, "entry.ts"),
      `import { wf } from "./header";
const g = wf.tasks({
  Input: { item: "order", enrich: ({ data, logging_context }) => { logging_context.n = data.a.length; }, route: null },
});
export default wf.assemble(g);
`,
    );
    expect(ts.findConfigFile(dir, ts.sys.fileExists)).toBeUndefined();
    const r = buildWorkflow(join(dir, "entry.ts"));
    expect(r.diagnostics).toEqual([]);
    expect(r.definition).not.toBeNull();
  });
});

describe("buildWorkflow — header misuse in the workflow's own files (R28)", () => {
  it("reports a workflow() call that is not top level in the entry file, as the editor does", () => {
    const dir = project("stray-own", {
      "header.ts": HEADER,
      "acme.json": SCHEMA,
      "entry.ts": `import { workflow } from "@aflow/dsl";
import { wf } from "./header";
export const make = () => workflow({ client_id: "acme", name: "other", input: "acme.In", result: "acme.Out", items: {} });
const g = wf.tasks({ Input: { item: "order", route: null } });
export default wf.assemble(g);
`,
    });
    const r = buildWorkflow(join(dir, "entry.ts"));
    expect(r.definition).toBeNull();
    expect(r.diagnostics.map((d) => [d.rule, d.file])).toEqual([["not-static", join(dir, "entry.ts")]]);
  });
});
