/**
 * `@aflow/ts-plugin` — the tsserver plugin of the DSL (spec §15.9).
 *
 * It runs the `@aflow/dsl` analyzer inside tsserver, so the editor shows the
 * errors that `aflow build` reports. It adds:
 *
 * - the analyzer diagnostics to `getSemanticDiagnostics` (items 3, 4);
 * - task and item names to string completions at name positions (item 2);
 * - the JSDoc of the DSL field to hovers on object-literal fields (item 5);
 * - regeneration of the `SchemaRegistry` typings when schema inputs change
 *   (item 1, §15.7). tsserver's file watcher then reloads the `.d.ts`.
 *
 * `ts` is tsserver's instance, injected; this module never loads TypeScript.
 * Each override catches every error, logs it and returns the base result.
 */

import { statSync } from "node:fs";

import { type AflowDiagnostic, type Analysis, analyzeProgram, RULE_CODES, type WorkflowAnalysis } from "@aflow/dsl";
import { schemaSources, writeRegistryFor } from "@aflow/dsl/registry";
import type * as TS from "typescript";

import { contentEnd, namePositionAt } from "./names.js";

type Ts = typeof TS;

/** The files a workflow is written in: header, entry and the files of its tasks. */
function filesOf(wf: WorkflowAnalysis): Set<string> {
  const files = new Set([wf.headerFile]);
  if (wf.entryFile) files.add(wf.entryFile);
  for (const loc of Object.values(wf.locations.tasks)) files.add(loc.file);
  return files;
}

/** A value that changes when any registry input of the header changes: schema file mtimes, inline types, names. */
function registryInputs(wf: WorkflowAnalysis): string {
  const mtime = (file: string) => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? null;
  const sources = schemaSources(wf).map((s) => (s.file ? [s.file, mtime(s.file)] : [s.namespace, s.inline]));
  return JSON.stringify([wf.header.client_id, wf.header.name, sources]);
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
    /** Header id → the registry inputs at the last write, and that write's diagnostics. */
    const registries = new Map<string, { inputs: string; diagnostics: AflowDiagnostic[] }>();

    const analysisOf = (program: TS.Program): Analysis => {
      let analysis = analyses.get(program);
      if (!analysis) {
        analysis = analyzeProgram(ts, program);
        analyses.set(program, analysis);
      }
      return analysis;
    };

    /** Rewrites the header's registry when its inputs changed; returns the schema diagnostics of the last write. */
    const refreshRegistry = (program: TS.Program, wf: WorkflowAnalysis): AflowDiagnostic[] => {
      const id = `${wf.headerFile}\0${wf.headerSymbol}`;
      const inputs = registryInputs(wf);
      const last = registries.get(id);
      if (last?.inputs === inputs) return last.diagnostics;
      const { written, diagnostics } = writeRegistryFor(ts, program, wf);
      if (written) log(`wrote ${written}`);
      registries.set(id, { inputs, diagnostics });
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

    // Every member of the base service, bound to it; the overrides below replace three.
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
        const seen = new Set<string>();
        for (const wf of analysis.workflows) {
          const id = `${wf.headerFile}\0${wf.headerSymbol}`;
          if (seen.has(id) || !filesOf(wf).has(sf.fileName)) continue;
          seen.add(id);
          own.push(...refreshRegistry(program, wf).filter((d) => d.file === sf.fileName));
        }
        return [...prior, ...own.map((d) => toTs(d, sf))];
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
        // TypeScript documents an object-literal field from the literal's own
        // (undocumented) property; the DSL rule lives on the contextual type.
        if (!prior || (prior.documentation?.length ?? 0) > 0) return prior;
        const program = base.getProgram();
        const sf = program?.getSourceFile(fileName);
        if (!program || !sf) return prior;
        const field = objectLiteralFieldAt(ts, sf, position);
        if (!field) return prior;
        // The completion details of the field read the declared (constraint) type.
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
