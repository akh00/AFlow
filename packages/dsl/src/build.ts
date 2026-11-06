/**
 * `aflow build` and `aflow types` as library calls (spec §15.7, §15.8).
 *
 * `buildWorkflow` analyses the program rooted at an entry file and adds the
 * schema closure to `definitions`. `generateTypes` writes the `SchemaRegistry`
 * augmentation of every header in a project. Neither throws on bad input:
 * every problem is a diagnostic.
 */

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { WorkflowDefinition } from "@aflow/engine";
import ts from "typescript";

import { type AflowDiagnostic, sortedUnique } from "./analyzer/diagnostics.js";
import { analyzeProgram, type SourceLocations, type WorkflowAnalysis } from "./analyzer/index.js";
import { registryFor, schemaClosure, writeRegistryFor } from "./registry.js";

export { writeRegistryFor };

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
    diagnostics.push({
      rule: "project-config",
      severity: "error",
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      file: d.file?.fileName ?? configPath,
      start: d.start ?? 0,
      length: d.length ?? 0,
    });
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

/**
 * The TypeScript errors of the workflow's own files (header, groups, entry) as
 * `type-error` diagnostics (R27). It does not check library and declaration files.
 */
function typeErrors(program: ts.Program, wf: WorkflowAnalysis): AflowDiagnostic[] {
  const out: AflowDiagnostic[] = [];
  for (const name of wf.files) {
    const sf = program.getSourceFile(name);
    if (!sf || sf.isDeclarationFile) continue;
    for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
      if (d.category !== ts.DiagnosticCategory.Error && d.category !== ts.DiagnosticCategory.Warning) continue;
      out.push({
        rule: "type-error",
        severity: "error",
        message: `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`,
        file: sf.fileName,
        start: d.start ?? 0,
        length: d.length ?? 0,
      });
    }
  }
  return out;
}

/**
 * A program with the `SchemaRegistry` typings of the workflow from
 * `registry`, not from the disk (§15.7). The registry file is always a root,
 * so the build needs no `.aflow/types` file and no `include` for it. The
 * other source files come from `old`, so the build does not parse them again.
 */
function withRegistry(
  old: ts.Program,
  rootNames: readonly string[],
  options: ts.CompilerOptions,
  registry: { path: string; text: string },
): ts.Program {
  const target = resolve(registry.path);
  const isRegistry = (f: string) => resolve(f) === target;
  const host = ts.createCompilerHost(options, true);
  const { fileExists, readFile, getSourceFile } = host;
  host.fileExists = (f) => isRegistry(f) || fileExists(f);
  host.readFile = (f) => (isRegistry(f) ? registry.text : readFile(f));
  host.getSourceFile = (f, languageVersion, onError, shouldCreate) =>
    isRegistry(f)
      ? ts.createSourceFile(f, registry.text, languageVersion, true)
      : (old.getSourceFile(f) ?? getSourceFile(f, languageVersion, onError, shouldCreate));
  return ts.createProgram({
    rootNames: [...rootNames.filter((f) => !isRegistry(f)), target],
    options,
    host,
    oldProgram: old,
  });
}

/**
 * Builds the workflow assembled in `entry` (§15.8). The program holds
 * `entry` and the files of `opts.tsconfig` or of the nearest `tsconfig.json`,
 * with the compiler options of that file. With no `tsconfig.json`, it uses
 * `DEFAULT_OPTIONS`. The program also holds the `SchemaRegistry` typings of
 * the workflow, made from its schemas at each build. It does not read them
 * from `.aflow/types`, so it does not need `aflow types` first (§15.7).
 */
export function buildWorkflow(entry: string, opts: { tsconfig?: string } = {}): BuildResult {
  const file = resolve(entry);
  const diagnostics: AflowDiagnostic[] = [];
  const fail = (): BuildResult => ({ definition: null, diagnostics: sortedUnique(diagnostics), locations: null });
  if (!existsSync(file)) {
    diagnostics.push(fileDiagnostic(file, "no-entry", `The entry file ${file} does not exist.`));
    return fail();
  }

  const configPath = opts.tsconfig ? resolve(opts.tsconfig) : ts.findConfigFile(dirname(file), ts.sys.fileExists);
  const parsed = configPath ? parseConfig(configPath, diagnostics) : null;
  const rootNames = [file, ...(parsed?.fileNames ?? [])];
  const options = parsed?.options ?? DEFAULT_OPTIONS;
  const assembledIn = (program: ts.Program) =>
    analyzeProgram(ts, program).workflows.find((w) => w.entryFile !== null && resolve(w.entryFile) === file);

  // The first analysis finds the header. Its schemas give the typings, and the
  // build then analyses and type-checks again with those typings (§15.7).
  const first = ts.createProgram({ rootNames, options });
  let program = first;
  let wf = assembledIn(first);
  const registry = wf && registryFor(ts, first, wf);
  if (registry) {
    program = withRegistry(first, rootNames, options, registry);
    wf = assembledIn(program);
  }
  if (!wf) {
    diagnostics.push(
      fileDiagnostic(
        file,
        "no-entry",
        "The entry file assembles no workflow. Write `export default wf.assemble(…)` in it (§15.1).",
      ),
    );
    return fail();
  }

  // R28: the build counts only the diagnostics in the files of this workflow.
  const own = new Set(wf.files);
  diagnostics.push(...wf.diagnostics.filter((d) => own.has(d.file)), ...typeErrors(program, wf));
  const { schemas, diagnostics: schemaErrors } = schemaClosure(ts, program, wf);
  diagnostics.push(...schemaErrors);

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

/**
 * Regenerates the `SchemaRegistry` typings of every workflow header in the
 * `project` tsconfig (§15.7). It writes a file only when the content changes.
 */
export function generateTypes(project: string): { written: string[]; diagnostics: AflowDiagnostic[] } {
  const configPath = resolve(project);
  const diagnostics: AflowDiagnostic[] = [];
  const written: string[] = [];
  if (!existsSync(configPath)) {
    diagnostics.push(fileDiagnostic(configPath, "project-config", `The project ${configPath} does not exist.`));
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
    const result = writeRegistryFor(ts, program, wf);
    diagnostics.push(...result.diagnostics);
    if (result.written) written.push(result.written);
  }
  return { written, diagnostics: sortedUnique(diagnostics) };
}
