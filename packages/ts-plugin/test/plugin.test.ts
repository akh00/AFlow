/**
 * `@aflow/ts-plugin` in process (spec §15.9): the plugin wraps a real
 * LanguageService over a copy of the booking DSL fixture. Edits stay in
 * memory; schema files and the generated typings are on disk, as in tsserver.
 */

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { RULE_CODES } from "@aflow/dsl";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import { init } from "../src/plugin.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURE = join(repo, "packages/dsl/test/fixtures/booking");
const FILES = ["header.ts", "order.ts", "hotel.ts", "flight.ts", "book_travel_order.ts"];
const REGISTRY = ".aflow/types/travelco.book_travel_order.d.ts";

const options: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  lib: ["lib.es2023.d.ts"],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  types: [],
  paths: {
    "@aflow/dsl": [join(repo, "packages/dsl/src/index.ts")],
    "@aflow/engine": [join(repo, "src/index.ts")],
  },
};

/** One registry for every service: lib and package sources are parsed once. */
const registry = ts.createDocumentRegistry();
const dirs: string[] = [];

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Session {
  dir: string;
  ls: ts.LanguageService;
  logs: string[];
  /** Replaces the text of `file` in memory; returns the full path. */
  edit(file: string, from: string, to: string): string;
  path(file: string): string;
  text(file: string): string;
}

/**
 * A plugin-wrapped LanguageService over a fresh copy of the booking fixture.
 * `wrap` may replace the base service before the plugin sees it.
 */
function session(wrap: (base: ts.LanguageService) => ts.LanguageService = (b) => b): Session {
  const dir = mkdtempSync(join(tmpdir(), "aflow-plugin-"));
  dirs.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  const memory = new Map<string, { text: string; version: number }>();
  const path = (f: string) => join(dir, f);
  const read = (f: string) => memory.get(f)?.text ?? (existsSync(f) ? readFileSync(f, "utf8") : undefined);
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options,
    getScriptFileNames: () => [...FILES.map(path), path(REGISTRY)],
    getScriptVersion: (f) => {
      const m = memory.get(f);
      if (m) return `m${m.version}`;
      return existsSync(f) ? String(statSync(f).mtimeMs) : "0";
    },
    getScriptSnapshot: (f) => {
      const text = read(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dir,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: (f) => memory.has(f) || ts.sys.fileExists(f),
    readFile: (f) => read(f),
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  const logs: string[] = [];
  const project = { projectService: { logger: { info: (m: string) => logs.push(m) } } };
  const base = wrap(ts.createLanguageService(host, registry));
  const info = {
    languageService: base,
    languageServiceHost: host,
    project,
    config: {},
  } as unknown as ts.server.PluginCreateInfo;
  const ls = init({ typescript: ts }).create(info);
  return {
    dir,
    ls,
    logs,
    path,
    text: (f) => read(path(f))!,
    edit(file, from, to) {
      const full = path(file);
      const text = read(full)!;
      expect(text, `${file} holds ${from}`).toContain(from);
      memory.set(full, { text: text.replace(from, to), version: (memory.get(full)?.version ?? 0) + 1 });
      return full;
    },
  };
}

/** The offset just after `marker`'s `|` in `file`. `marker` without the `|` must occur in the file. */
function offsetOf(s: Session, file: string, marker: string): number {
  const bar = marker.indexOf("|");
  const at = s.text(file).indexOf(marker.replace("|", ""));
  expect(at, `${file} holds ${marker}`).toBeGreaterThanOrEqual(0);
  return at + bar;
}

const completionNames = (s: Session, file: string, pos: number) =>
  (s.ls.getCompletionsAtPosition(s.path(file), pos, {})?.entries ?? []).map((e) => e.name);

const aflowDiagnostics = (s: Session, file: string) =>
  s.ls.getSemanticDiagnostics(s.path(file)).filter((d) => d.source === "aflow");

describe("route and item-name completion (§15.9 item 2)", () => {
  const s = session();
  // hold_hotel_room routes to mark_hotel_reserved; empty it in memory.
  s.edit("hotel.ts", 'route: "mark_hotel_reserved",\n  },\n\n  mark_hotel_reserved', 'route: "",\n  },\n\n  mark_hotel_reserved');

  it("offers every task of the workflow in `route`, from any group or file", () => {
    const names = completionNames(s, "hotel.ts", offsetOf(s, "hotel.ts", 'route: "|",\n  },\n\n  mark_hotel_reserved'));
    // Same group, later group in the same file, other files.
    expect(names).toEqual(expect.arrayContaining(["mark_hotel_reserved", "commit_hotel_booking", "confirm_flight", "Input"]));
    const entry = s.ls
      .getCompletionsAtPosition(s.path("hotel.ts"), offsetOf(s, "hotel.ts", 'route: "|",\n  },\n\n  mark_hotel_reserved'), {})!
      .entries.find((e) => e.name === "commit_hotel_booking")!;
    expect(entry.kind).toBe(ts.ScriptElementKind.string);
  });

  it("offers task names in `cases` values", () => {
    const pos = offsetOf(s, "hotel.ts", 'failure: "|mark_hotel_reserved"');
    expect(completionNames(s, "hotel.ts", pos)).toContain("commit_hotel_booking");
  });

  it("offers item names in `items.*.parent`", () => {
    s.edit("header.ts", 'parent: "order" },\n    flight_line', 'parent: "" },\n    flight_line');
    const names = completionNames(s, "header.ts", offsetOf(s, "header.ts", 'parent: "|" },\n    flight_line'));
    expect(names).toContain("order");
    expect(names).not.toContain("Input");
  });

  it("offers task names in `config.defaults.entry`", () => {
    const pos = offsetOf(s, "header.ts", 'entry: "|Input"');
    expect(completionNames(s, "header.ts", pos)).toContain("await_reservations");
  });

  it("offers item names, not task names, in `item`", () => {
    const pos = offsetOf(s, "hotel.ts", 'create_hotel_record: {\n    item: "|hotel_line"');
    const names = completionNames(s, "hotel.ts", pos);
    expect(names).toEqual(expect.arrayContaining(["order", "hotel_line", "flight_line"]));
    expect(names).not.toContain("create_hotel_record");
  });

  it("offers names in the results of a route or item_type arrow, not in its comparisons", () => {
    const route = offsetOf(s, "order.ts", "type === 'hotel_line' ? 'create_hotel_record' : '|book_flight'");
    expect(completionNames(s, "order.ts", route)).toContain("commit_hotel_booking");
    const operand = offsetOf(s, "order.ts", "type === '|hotel_line' ? 'create_hotel_record'");
    expect(completionNames(s, "order.ts", operand)).not.toContain("commit_hotel_booking");
    const itemType = offsetOf(s, "order.ts", "data.product_type === 'hotel' ? '|hotel_line'");
    expect(completionNames(s, "order.ts", itemType)).toContain("flight_line");
  });

  it("adds nothing to strings in other positions", () => {
    const pos = offsetOf(s, "hotel.ts", 'bundle_name: "|hotel-supplier"');
    expect(completionNames(s, "hotel.ts", pos)).not.toContain("commit_hotel_booking");
  });
});

describe("diagnostics (§15.9 items 3 and 4)", () => {
  it("reports no aflow diagnostic for the valid booking fixture", () => {
    const s = session();
    for (const f of FILES) expect(aflowDiagnostics(s, f), f).toEqual([]);
  });

  it("reports a misspelled route as unknown-task at the string", () => {
    const s = session();
    s.edit("hotel.ts", 'route: "mark_hotel_settled"', 'route: "mark_hotel_setled"');
    const found = aflowDiagnostics(s, "hotel.ts");
    // The task the route named before is now unreachable.
    expect(found.map((d) => d.code)).toEqual([RULE_CODES["unknown-task"], RULE_CODES.unreachable]);
    const d = found[0];
    expect(d!.code).toBe(RULE_CODES["unknown-task"]);
    expect(d!.category).toBe(ts.DiagnosticCategory.Error);
    expect(d!.start).toBe(s.text("hotel.ts").indexOf('"mark_hotel_setled"'));
    expect(d!.length).toBe('"mark_hotel_setled"'.length);
  });

  it("reports Date.now() in an expression as forbidden-global", () => {
    const s = session();
    s.edit("hotel.ts", "objects.phase = 'settled'", "objects.phase = Date.now() > 0 ? 'settled' : 'settled'");
    const found = aflowDiagnostics(s, "hotel.ts");
    expect(found.map((d) => d.code)).toEqual([RULE_CODES["forbidden-global"]]);
    expect(found[0]!.start).toBe(s.text("hotel.ts").indexOf("Date.now"));
  });

  it("reports an unreachable task as a warning in the file that declares it", () => {
    const s = session();
    s.edit("hotel.ts", 'route: "mark_hotel_settled"', "route: null");
    const found = aflowDiagnostics(s, "hotel.ts");
    expect(found.map((d) => [d.code, d.category])).toEqual([[RULE_CODES.unreachable, ts.DiagnosticCategory.Warning]]);
  });
});

describe("hover (§15.9 item 5)", () => {
  it("shows the §7 rule on `aggregate`", () => {
    const s = session();
    const info = s.ls.getQuickInfoAtPosition(s.path("order.ts"), offsetOf(s, "order.ts", "|aggregate: {"));
    const text = ts.displayPartsToString(info?.documentation);
    expect(text).toContain("§7");
    expect(text).toContain("monotonic");
  });
});

describe("failure isolation (Review Focus 5)", () => {
  it("does not throw on an unterminated `wf.tasks({`", () => {
    const s = session();
    s.edit("hotel.ts", "export const hotel_settle = wf.tasks({", "export const broken = wf.tasks({\nexport const hotel_settle = wf.tasks({");
    expect(() => s.ls.getSemanticDiagnostics(s.path("hotel.ts"))).not.toThrow();
    expect(s.ls.getSyntacticDiagnostics(s.path("hotel.ts")).length).toBeGreaterThan(0);
    expect(() => s.ls.getCompletionsAtPosition(s.path("hotel.ts"), offsetOf(s, "hotel.ts", 'route: "|mark_hotel_settled"'), {})).not.toThrow();
  });

  it("returns the base result and logs when the analysis fails", () => {
    let fail = false;
    const s = session((base) => ({
      ...base,
      getProgram: () => {
        if (fail) throw new Error("boom");
        return base.getProgram();
      },
    }));
    const file = s.path("hotel.ts");
    const pos = offsetOf(s, "hotel.ts", 'route: "|mark_hotel_settled"');
    fail = true;
    expect(s.ls.getSemanticDiagnostics(file)).toEqual([]);
    expect(s.ls.getCompletionsAtPosition(file, pos, {})?.entries.map((e) => e.name) ?? []).not.toContain("commit_hotel_booking");
    expect(s.logs.filter((l) => l.includes("boom"))).toHaveLength(2);
  });
});

describe("schema typings regeneration (§15.7, §15.9 item 1)", () => {
  it("reports a schema key that no schema defines, as `aflow build` does (§15.8)", () => {
    const s = session();
    s.edit("header.ts", 'result: "travelco.BookingResponse"', 'result: "travelco.Nope"');
    const found = aflowDiagnostics(s, "header.ts");
    expect(found.map((d) => d.code)).toEqual([RULE_CODES.schema]);
    expect(ts.flattenDiagnosticMessageText(found[0]!.messageText, "\n")).toContain("travelco.Nope");
  });

  it("writes a deleted registry again", () => {
    const s = session();
    expect(aflowDiagnostics(s, "header.ts")).toEqual([]);
    rmSync(s.path(REGISTRY));
    expect(aflowDiagnostics(s, "header.ts")).toEqual([]);
    expect(existsSync(s.path(REGISTRY))).toBe(true);
  });

  it("rewrites the registry when a schema file changes, and the new field completes", () => {
    const s = session();
    const registryFile = s.path(REGISTRY);
    const dataDot = () => completionNames(s, "order.ts", offsetOf(s, "order.ts", "logging_context.order_id = data.|order_id"));

    expect(aflowDiagnostics(s, "header.ts")).toEqual([]);
    expect(dataDot()).toContain("order_id");
    expect(dataDot()).not.toContain("loyalty_id");

    const schemaFile = s.path("schemas/travelco.json");
    const schema = JSON.parse(readFileSync(schemaFile, "utf8"));
    schema.definitions.BookingRequest.properties.loyalty_id = { type: "string" };
    writeFileSync(schemaFile, JSON.stringify(schema, null, 2));
    // A later mtime, whatever the file system's clock resolution.
    const later = new Date(statSync(schemaFile).mtimeMs + 2000);
    utimesSync(schemaFile, later, later);

    expect(aflowDiagnostics(s, "order.ts")).toEqual([]);
    expect(readFileSync(registryFile, "utf8")).toContain("loyalty_id");
    expect(dataDot()).toContain("loyalty_id");
  });
});
