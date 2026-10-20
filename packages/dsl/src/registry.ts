/**
 * The schemas of one workflow header (spec §10, §15.7, §15.8).
 *
 * `aflow types` and the editor plugin both write the registry through
 * `writeRegistryFor`. `aflow build` type-checks against the same text, from
 * `registryFor`, without a write. `aflow build` and the plugin both check the schema
 * closure through `schemaClosure`, so the two report the same errors.
 * The caller gives `ts`, and this module does not import it. The plugin gives
 * the instance of tsserver, so this module loads no second TypeScript.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type * as TS from "typescript";

import type { JsonSchema } from "./surface/header.js";
import type { AflowDiagnostic } from "./analyzer/diagnostics.js";
import type { WorkflowAnalysis } from "./analyzer/index.js";
import { generateRegistry } from "./schema/codegen.js";
import { closure, loadSchemas, type SchemaError, type SchemaSource } from "./schema/load.js";

/** The header `workflow(…)` call of `wf`. Diagnostics for the full header go here. */
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
function schemaDiagnostics(
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

/** The schema sources of a header. These are the `schemas` files (relative to the header file) and the inline `types` (§15.2). */
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

/** The schema keys that the document names. These are `input`, `result`, the item types and the `call.output` types (§10). */
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
 * The schemas that the document of `wf` reaches from its schema keys (§10).
 * Load errors and unknown keys are `schema` diagnostics at the header.
 */
export function schemaClosure(
  ts: typeof TS,
  program: TS.Program,
  wf: WorkflowAnalysis,
): { schemas: Record<string, JsonSchema>; diagnostics: AflowDiagnostic[] } {
  const set = loadSchemas(schemaSources(wf));
  const { schemas, errors } = closure(set, schemaRoots(wf));
  return { schemas, diagnostics: schemaDiagnostics(ts, program, wf, [...set.errors, ...errors]) };
}

/** The registry file of a header. The path is `<header dir>/.aflow/types/<client_id>.<name>.d.ts` (§15.7). */
export function registryPath(wf: WorkflowAnalysis): string | null {
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
 * The `SchemaRegistry` typings of the header of `wf` (§15.7): the registry
 * file path and its text. Schema load problems are `schema` diagnostics at the
 * header. The result is `null` when the header has no literal `client_id` and
 * `name`. This function writes no file.
 */
export function registryFor(
  ts: typeof TS,
  program: TS.Program,
  wf: WorkflowAnalysis,
): { path: string; text: string; diagnostics: AflowDiagnostic[] } | null {
  const path = registryPath(wf);
  if (!path) return null;
  const set = loadSchemas(schemaSources(wf));
  return { path, text: generateRegistry(set), diagnostics: schemaDiagnostics(ts, program, wf, set.errors) };
}

/**
 * Regenerates the `SchemaRegistry` typings of the header of `wf` (§15.7).
 * It writes the file only when the content changes. `written` is the path
 * when it wrote, else `null`. Schema problems are `schema` diagnostics at the
 * header. This function does not throw on them.
 */
export function writeRegistryFor(
  ts: typeof TS,
  program: TS.Program,
  wf: WorkflowAnalysis,
): { written: string | null; diagnostics: AflowDiagnostic[] } {
  const registry = registryFor(ts, program, wf);
  if (!registry) return { written: null, diagnostics: [] };
  const { path, text, diagnostics } = registry;
  try {
    return { written: writeIfChanged(path, text) ? path : null, diagnostics };
  } catch (e) {
    const error: SchemaError = { kind: "unreadable", message: `cannot write ${path}: ${(e as Error).message}` };
    return { written: null, diagnostics: [...diagnostics, ...schemaDiagnostics(ts, program, wf, [error])] };
  }
}
