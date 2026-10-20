/**
 * `aflow build` and `aflow types` as library calls (spec §15.7, §15.8).
 *
 * `buildWorkflow` analyses the program rooted at an entry file and adds the
 * schema closure to `definitions`. `generateTypes` writes the `SchemaRegistry`
 * augmentation of every header in a project. Neither throws on bad input:
 * every problem is a diagnostic.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { WorkflowDefinition } from "@aflow/engine";
import ts from "typescript";

import { type AflowDiagnostic, sortedUnique } from "./analyzer/diagnostics.js";
import { analyzeProgram, type SourceLocations, type WorkflowAnalysis } from "./analyzer/index.js";
import { generateRegistry } from "./schema/codegen.js";
import { closure, loadSchemas, type SchemaError, type SchemaSet, type SchemaSource } from "./schema/load.js";

export interface BuildResult {
  /** The §13 document; `null` when any diagnostic is an error (§15.8). */
  definition: WorkflowDefinition | null;
  diagnostics: AflowDiagnostic[];
  /** Where each task and expression is written; `null` when no workflow is assembled in the entry. */
  locations: SourceLocations | null;
}

/** The compiler options when no `tsconfig.json` is found. */
const DEFAULT_OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

/** TS18003 "No inputs were found": harmless here, the program is rooted at the entry. */
const NO_INPUTS = 18003;

/** A diagnostic at the start of `file`, for problems that have no better place. */
function fileDiagnostic(file: string, rule: AflowDiagnostic["rule"], message: string): AflowDiagnostic {
  return { rule, severity: "error", message, file, start: 0, length: 0 };
}

/** Parses `configPath`. Its errors are reported into `diagnostics`; `null` when it cannot be read. */
function parseConfig(configPath: string, diagnostics: AflowDiagnostic[]): ts.ParsedCommandLine | null {
  const report = (d: ts.Diagnostic) => {
    if (d.code === NO_INPUTS) return;
    diagnostics.push(
      fileDiagnostic(
        d.file?.fileName ?? configPath,
        "not-static",
        `tsconfig: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
      ),
    );
  };
  let fatal = false;
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      fatal = true;
      report(d);
    },
  });
  if (fatal || !parsed) return null;
  parsed.errors.forEach(report);
  return parsed;
}

/** The header `workflow(…)` call of `wf`, for diagnostics that belong to the header as a whole. */
function headerNode(program: ts.Program, wf: WorkflowAnalysis): ts.Node | undefined {
  const sf = program.getSourceFile(wf.headerFile);
  for (const stmt of sf?.statements ?? []) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === wf.headerSymbol) return decl.initializer ?? decl;
    }
  }
  return undefined;
}

/** Schema errors as `schema` diagnostics at the header (§15.8). */
function schemaDiagnostics(program: ts.Program, wf: WorkflowAnalysis, errors: SchemaError[]): AflowDiagnostic[] {
  const node = headerNode(program, wf);
  const sf = node?.getSourceFile();
  const start = node && sf ? node.getStart(sf) : 0;
  const length = node ? node.getEnd() - start : 0;
  return errors.map((e) => ({
    rule: "schema" as const,
    severity: "error" as const,
    message: e.file && !e.message.includes(e.file) ? `${e.message} (${e.file})` : e.message,
    file: wf.headerFile,
    start,
    length,
  }));
}

/** The schema sources of a header: `schemas` files relative to the header file, and inline `types` (§15.2). */
function schemaSources(wf: WorkflowAnalysis): SchemaSource[] {
  const { header } = wf;
  const sources: SchemaSource[] = [];
  const dir = dirname(wf.headerFile);
  for (const [namespace, path] of Object.entries(header.schemas ?? {})) {
    if (typeof path === "string") sources.push({ namespace, file: resolve(dir, path) });
  }
  if (header.types !== undefined && typeof header.client_id === "string") {
    sources.push({ namespace: header.client_id, inline: { ...header.types } });
  }
  return sources;
}

/** The schema keys the document names: `input`, `result`, item types, `call.output` types (§10). */
function schemaRoots(wf: WorkflowAnalysis): string[] {
  const roots = new Set<string>();
  const add = (k: unknown) => {
    if (typeof k === "string") roots.add(k);
  };
  add(wf.header.input);
  add(wf.header.result);
  for (const decl of Object.values(wf.header.items ?? {})) {
    if (decl?.data !== "input") add(decl?.data);
    add(decl?.objects);
  }
  for (const task of wf.definition.tasks) {
    add(task.call?.output?.result_type);
    add(task.call?.output?.error_type);
  }
  return [...roots];
}

/**
 * Builds the workflow assembled in `entry` (§15.8). The program is rooted at
 * `entry`, with the compiler options of `opts.tsconfig` or of the nearest
 * `tsconfig.json`.
 */
export function buildWorkflow(entry: string, opts: { tsconfig?: string } = {}): BuildResult {
  const file = resolve(entry);
  const diagnostics: AflowDiagnostic[] = [];
  const fail = (): BuildResult => ({ definition: null, diagnostics: sortedUnique(diagnostics), locations: null });
  if (!existsSync(file)) {
    diagnostics.push(fileDiagnostic(file, "not-static", `The entry file ${file} does not exist.`));
    return fail();
  }

  const configPath = opts.tsconfig ? resolve(opts.tsconfig) : ts.findConfigFile(dirname(file), ts.sys.fileExists);
  const options = configPath ? (parseConfig(configPath, diagnostics)?.options ?? DEFAULT_OPTIONS) : DEFAULT_OPTIONS;
  const program = ts.createProgram({ rootNames: [file], options });
  const wf = analyzeProgram(ts, program).workflows.find((w) => w.entryFile !== null && resolve(w.entryFile) === file);
  if (!wf) {
    diagnostics.push(
      fileDiagnostic(
        file,
        "not-static",
        "The entry file assembles no workflow. Write `export default wf.assemble(…)` in it (§15.1).",
      ),
    );
    return fail();
  }

  diagnostics.push(...wf.diagnostics);
  const set = loadSchemas(schemaSources(wf));
  const { schemas, errors } = closure(set, schemaRoots(wf));
  diagnostics.push(...schemaDiagnostics(program, wf, [...set.errors, ...errors]));

  const all = sortedUnique(diagnostics);
  const definition: WorkflowDefinition = {
    ...wf.definition,
    definitions: { ...wf.definition.definitions, ...schemas },
  };
  return {
    definition: all.some((d) => d.severity === "error") ? null : definition,
    diagnostics: all,
    locations: wf.locations,
  };
}

/** The registry file of a header: `<header dir>/.aflow/types/<client_id>.<name>.d.ts` (§15.7). */
function registryPath(wf: WorkflowAnalysis): string | null {
  const { client_id, name } = wf.header;
  if (typeof client_id !== "string" || typeof name !== "string") return null;
  return join(dirname(wf.headerFile), ".aflow", "types", `${client_id}.${name}.d.ts`);
}

/** Writes `text` to `path` unless the file already holds it. True when it wrote. */
function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

/**
 * Regenerates the `SchemaRegistry` typings of every workflow header in the
 * `project` tsconfig (§15.7). A file is written only when its content changes.
 */
export function generateTypes(project: string): { written: string[]; diagnostics: AflowDiagnostic[] } {
  const configPath = resolve(project);
  const diagnostics: AflowDiagnostic[] = [];
  const written: string[] = [];
  if (!existsSync(configPath)) {
    diagnostics.push(fileDiagnostic(configPath, "not-static", `The project ${configPath} does not exist.`));
    return { written, diagnostics };
  }
  const parsed = parseConfig(configPath, diagnostics);
  if (!parsed) return { written, diagnostics };

  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const done = new Set<string>();
  for (const wf of analyzeProgram(ts, program).workflows) {
    // A header assembled in several entries is one registry.
    const key = `${wf.headerFile}\0${wf.headerSymbol}`;
    if (done.has(key)) continue;
    done.add(key);
    const path = registryPath(wf);
    if (!path) continue;
    const set: SchemaSet = loadSchemas(schemaSources(wf));
    diagnostics.push(...schemaDiagnostics(program, wf, set.errors));
    try {
      if (writeIfChanged(path, generateRegistry(set))) written.push(path);
    } catch (e) {
      diagnostics.push(...schemaDiagnostics(program, wf, [{ kind: "unreadable", message: `cannot write ${path}: ${(e as Error).message}` }]));
    }
  }
  return { written, diagnostics: sortedUnique(diagnostics) };
}
