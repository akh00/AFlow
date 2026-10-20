/**
 * `@aflow/ts-plugin` — the tsserver plugin of the DSL (spec §15.9).
 *
 * It runs the `@aflow/dsl` analyzer inside tsserver, so the editor shows the
 * errors that `aflow build` reports. It adds these behaviours:
 *
 * - It adds the analyzer diagnostics to `getSemanticDiagnostics` (items 3, 4).
 * - It adds task and item names to string completions at name positions (item 2).
 * - It adds the JSDoc of the DSL field to hovers on object-literal fields (item 5).
 * - It shows the schema errors of the workflow at the header, as `aflow build`
 *   reports them (§15.8).
 * - It writes the `SchemaRegistry` typings again when a schema input changes
 *   (item 1, §15.7). tsserver's file watcher then reads the new `.d.ts`.
 *
 * `ts` is tsserver's instance. The caller gives it, and this module never
 * loads TypeScript. Each override catches every error. It logs the error and
 * returns the base result.
 */

import { statSync } from "node:fs";

import { type AflowDiagnostic, type Analysis, analyzeProgram, RULE_CODES, type WorkflowAnalysis } from "@aflow/dsl";
import { registryPath, schemaClosure, schemaSources, writeRegistryFor } from "@aflow/dsl/registry";
import type * as TS from "typescript";

import { contentEnd, namePositionAt } from "./names.js";

type Ts = typeof TS;

/** The files that hold a workflow. These are the header, the entry and the files of its tasks. */
function filesOf(wf: WorkflowAnalysis): Set<string> {
  const files = new Set([wf.headerFile]);
  if (wf.entryFile) files.add(wf.entryFile);
  for (const loc of Object.values(wf.locations.tasks)) files.add(loc.file);
  return files;
}

/**
 * A value that changes when a registry input of the header changes. The inputs
 * are the schema file mtimes, the inline types, the names and the existence of
 * the registry file.
 */
function registryInputs(wf: WorkflowAnalysis): string {
  const mtime = (file: string) => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null;
  const sources = schemaSources(wf).map((s) => (s.file ? [s.file, mtime(s.file)] : [s.namespace, s.inline]));
  const registry = registryPath(wf);
  return JSON.stringify([wf.header.client_id, wf.header.name, sources, registry !== null && mtime(registry) !== null]);
}

/** Removes repeated diagnostics. Two diagnostics are the same when file, span, rule and message are equal. */
function unique(diagnostics: AflowDiagnostic[]): AflowDiagnostic[] {
  const byKey = new Map(diagnostics.map((d) => [`${d.file}\0${d.start}\0${d.length}\0${d.rule}\0${d.message}`, d]));
  return [...byKey.values()];
}

/** The identifier at `pos` that names a property of an object literal. */
function objectLiteralFieldAt(ts: Ts, sf: TS.SourceFile, pos: number) {
  let found: TS.Identifier | undefined;
  const visit = (n: TS.Node): void => {
    if (pos < n.getStart(sf) || pos > n.end) return;
    if (ts.isIdentifier(n)) found = n;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(sf, visit);
  const p = found?.parent;
  if (!found || !p || !(ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p) || ts.isMethodDeclaration(p))) {
    return undefined;
  }
  if (p.name !== found || !ts.isObjectLiteralExpression(p.parent)) return undefined;
  return { name: found.text, end: found.end };
}

export function init(modules: { typescript: Ts }): TS.server.PluginModule {
  const ts = modules.typescript;

  function create(info: TS.server.PluginCreateInfo): TS.LanguageService {
    const base = info.languageService;
    const log = (message: string) => info.project.projectService.logger.info(`[aflow] ${message}`);
    const analyses = new WeakMap<TS.Program, Analysis>();
    /** For each header id, this map keeps the registry inputs and the diagnostics of the last write. */
    const registries = new Map<string, { inputs: string; diagnostics: AflowDiagnostic[] }>();
    /** For each workflow, this map keeps the registry inputs and the diagnostics of the last closure check. */
    const closures = new WeakMap<WorkflowAnalysis, { inputs: string; diagnostics: AflowDiagnostic[] }>();

    const analysisOf = (program: TS.Program): Analysis => {
      let analysis = analyses.get(program);
      if (!analysis) {
        analysis = analyzeProgram(ts, program);
        analyses.set(program, analysis);
      }
      return analysis;
    };

    /** Writes the registry of the header again when its inputs changed. Returns the diagnostics of the last write. */
    const refreshRegistry = (program: TS.Program, wf: WorkflowAnalysis, inputs: string): AflowDiagnostic[] => {
      const id = `${wf.headerFile}\0${wf.headerSymbol}`;
      const last = registries.get(id);
      if (last?.inputs === inputs) return last.diagnostics;
      const { written, diagnostics } = writeRegistryFor(ts, program, wf);
      if (written) log(`wrote ${written}`);
      registries.set(id, { inputs, diagnostics });
      return diagnostics;
    };

    /** Gives the schema closure errors of `wf`. `aflow build` reports the same errors (§15.8). */
    const closureErrors = (program: TS.Program, wf: WorkflowAnalysis, inputs: string): AflowDiagnostic[] => {
      const last = closures.get(wf);
      if (last?.inputs === inputs) return last.diagnostics;
      const { diagnostics } = schemaClosure(ts, program, wf);
      closures.set(wf, { inputs, diagnostics });
      return diagnostics;
    };

    const toTs = (d: AflowDiagnostic, sf: TS.SourceFile): TS.Diagnostic => ({
      file: sf,
      start: d.start,
      length: d.length,
      messageText: d.message,
      category: d.severity === "error" ? ts.DiagnosticCategory.Error : ts.DiagnosticCategory.Warning,
      code: RULE_CODES[d.rule],
      source: "aflow",
    });

    // The proxy has every member of the base service, bound to the base.
    // The code below replaces three of these members.
    const proxy = Object.create(null) as TS.LanguageService;
    for (const k of Object.keys(base) as (keyof TS.LanguageService)[]) {
      const member: unknown = base[k];
      (proxy as unknown as Record<string, unknown>)[k] =
        typeof member === "function" ? (member as (...args: unknown[]) => unknown).bind(base) : member;
    }

    proxy.getSemanticDiagnostics = (fileName) => {
      const prior = base.getSemanticDiagnostics(fileName);
      try {
        const program = base.getProgram();
        const sf = program?.getSourceFile(fileName);
        if (!program || !sf) return prior;
        const analysis = analysisOf(program);
        const own = analysis.diagnostics.filter((d) => d.file === sf.fileName);
        for (const wf of analysis.workflows) {
          if (!filesOf(wf).has(sf.fileName)) continue;
          const inputs = registryInputs(wf);
          own.push(...refreshRegistry(program, wf, inputs), ...closureErrors(program, wf, inputs));
        }
        return [...prior, ...unique(own.filter((d) => d.file === sf.fileName)).map((d) => toTs(d, sf))];
      } catch (e) {
        log(`getSemanticDiagnostics(${fileName}) failed: ${(e as Error).stack ?? e}`);
        return prior;
      }
    };

    proxy.getCompletionsAtPosition = (fileName, position, options, formatting) => {
      const prior = base.getCompletionsAtPosition(fileName, position, options, formatting);
      try {
        const program = base.getProgram();
        const sf = program?.getSourceFile(fileName);
        if (!program || !sf) return prior;
        const at = namePositionAt(ts, program, analysisOf(program), sf, position);
        if (!at || at.names.length === 0) return prior;
        const start = at.literal.getStart(sf) + 1;
        const replacementSpan = { start, length: contentEnd(sf, at.literal) - start };
        const have = new Set(prior?.entries.map((e) => e.name));
        const added: TS.CompletionEntry[] = at.names
          .filter((name) => !have.has(name))
          .map((name) => ({ name, kind: ts.ScriptElementKind.string, kindModifiers: "", sortText: "0", replacementSpan }));
        if (prior) return { ...prior, entries: [...prior.entries, ...added] };
        return { isGlobalCompletion: false, isMemberCompletion: false, isNewIdentifierLocation: false, entries: added };
      } catch (e) {
        log(`getCompletionsAtPosition(${fileName}) failed: ${(e as Error).stack ?? e}`);
        return prior;
      }
    };

    proxy.getQuickInfoAtPosition = (fileName, position, maximumLength) => {
      const prior = base.getQuickInfoAtPosition(fileName, position, maximumLength);
      try {
        // TypeScript reads the hover text of an object-literal field from the
        // property of the literal, which has no documentation. The DSL rule is
        // on the declared type of the field.
        if (!prior || (prior.documentation?.length ?? 0) > 0) return prior;
        const program = base.getProgram();
        const sf = program?.getSourceFile(fileName);
        if (!program || !sf) return prior;
        const field = objectLiteralFieldAt(ts, sf, position);
        if (!field) return prior;
        // The completion details of the field come from the declared (constraint) type.
        const details = base.getCompletionEntryDetails(fileName, field.end, field.name, undefined, undefined, undefined, undefined);
        if (!details?.documentation?.length) return prior;
        return { ...prior, documentation: details.documentation, tags: [...(prior.tags ?? []), ...(details.tags ?? [])] };
      } catch (e) {
        log(`getQuickInfoAtPosition(${fileName}) failed: ${(e as Error).stack ?? e}`);
        return prior;
      }
    };

    return proxy;
  }

  return { create };
}
