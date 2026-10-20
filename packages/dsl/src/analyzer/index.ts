/**
 * The `@aflow/dsl` static analyzer (spec §15.1, §15.8, §15.9).
 *
 * One analysis serves `aflow build` and the editor plugin, so a workflow that
 * shows no error in the editor builds, and one that builds showed none.
 * `ts` is injected, never imported: the plugin passes tsserver's instance.
 */

import type { WorkflowDefinition } from "@aflow/engine";
import type * as TS from "typescript";

import type { WorkflowHeader } from "../surface/header.js";
import type { AflowDiagnostic } from "./diagnostics.js";
import { extractWorkflows } from "./extract.js";

/** A 1-based source position. */
export interface Loc {
  file: string;
  line: number;
  column: number;
}

/** Where each task and expression is written (§15.8). Not part of the emitted JSON. */
export interface SourceLocations {
  /** Task name → the location of its property name. */
  tasks: Record<string, Loc>;
  /** JSON pointer into the document (e.g. `/tasks/3/split/selector`) → the arrow's location. */
  expressions: Record<string, Loc>;
}

/** One workflow: a header, assembled in `entryFile`. */
export interface WorkflowAnalysis {
  headerFile: string;
  /** The name of the header constant. */
  headerSymbol: string;
  /** The file whose default export assembles the workflow; `null` when no file does. */
  entryFile: string | null;
  /** The header literal; its `config` arrows are in emitted form. */
  header: WorkflowHeader;
  /**
   * The §13 document. `definitions` holds the `input` / `result` `$ref`s only;
   * `aflow build` adds the schema closure.
   */
  definition: WorkflowDefinition;
  locations: SourceLocations;
  /** Task names in emitted order. */
  taskNames: string[];
  /** The diagnostics of the header, the assembled groups and the entry. */
  diagnostics: AflowDiagnostic[];
}

export interface Analysis {
  workflows: WorkflowAnalysis[];
  /** Every diagnostic of the program, including groups no assembly lists. */
  diagnostics: AflowDiagnostic[];
}

/** Ruling R2: the arrow node of every expression pointer. Internal; not exported from the package. */
const ARROWS = new WeakMap<WorkflowAnalysis, Map<string, TS.ArrowFunction>>();

/** The arrow node behind each expression pointer of `wf`. Internal to the analyzer. */
export function arrowsOf(wf: WorkflowAnalysis): Map<string, TS.ArrowFunction> | undefined {
  return ARROWS.get(wf);
}

/** Analyses every workflow declared in `program`. */
export function analyzeProgram(ts: typeof TS, program: TS.Program): Analysis {
  const { workflows, diagnostics } = extractWorkflows(ts, program);
  for (const w of workflows) ARROWS.set(w.analysis, w.arrows);
  return { workflows: workflows.map((w) => w.analysis), diagnostics };
}
