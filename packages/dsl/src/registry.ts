/**
 * The `SchemaRegistry` typings of one workflow header (spec §15.7).
 *
 * `aflow types` and the editor plugin both write the registry through
 * `writeRegistryFor`. `ts` is injected, never imported: the plugin passes
 * tsserver's instance, so this module loads no second TypeScript.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type * as TS from "typescript";

import type { AflowDiagnostic } from "./analyzer/diagnostics.js";
import type { WorkflowAnalysis } from "./analyzer/index.js";
import { generateRegistry } from "./schema/codegen.js";
import { loadSchemas, type SchemaError, type SchemaSource } from "./schema/load.js";

/** The header `workflow(…)` call of `wf`, for diagnostics that belong to the header as a whole. */
function headerNode(ts: typeof TS, program: TS.Program, wf: WorkflowAnalysis): TS.Node | undefined {
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
export function schemaDiagnostics(
  ts: typeof TS,
  program: TS.Program,
  wf: WorkflowAnalysis,
  errors: SchemaError[],
): AflowDiagnostic[] {
  const node = headerNode(ts, program, wf);
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
export function schemaSources(wf: WorkflowAnalysis): SchemaSource[] {
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
 * Regenerates the `SchemaRegistry` typings of the header of `wf` (§15.7).
 * The file is written only when its content changes. `written` is the path
 * when it wrote, else `null`. Schema problems are `schema` diagnostics at the
 * header; this function does not throw on them.
 */
export function writeRegistryFor(
  ts: typeof TS,
  program: TS.Program,
  wf: WorkflowAnalysis,
): { written: string | null; diagnostics: AflowDiagnostic[] } {
  const path = registryPath(wf);
  if (!path) return { written: null, diagnostics: [] };
  const set = loadSchemas(schemaSources(wf));
  const diagnostics = schemaDiagnostics(ts, program, wf, set.errors);
  try {
    return { written: writeIfChanged(path, generateRegistry(set)) ? path : null, diagnostics };
  } catch (e) {
    const error: SchemaError = { kind: "unreadable", message: `cannot write ${path}: ${(e as Error).message}` };
    return { written: null, diagnostics: [...diagnostics, ...schemaDiagnostics(ts, program, wf, [error])] };
  }
}
