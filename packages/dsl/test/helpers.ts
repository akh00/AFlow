/**
 * Test helpers for the analyzer: in-memory TypeScript programs.
 *
 * DSL sources live in memory under `MEM` (Ruling R3: invalid sources are never
 * files on disk). `@aflow/dsl` and `@aflow/engine` resolve to the real package
 * sources through `paths`. Disk files are parsed once and shared between
 * programs, so each test pays only for its own sources.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The virtual directory that holds the in-memory sources. */
export const MEM = "/mem";

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
    "@aflow/dsl": [resolve(repo, "packages/dsl/src/index.ts")],
    "@aflow/engine": [resolve(repo, "src/index.ts")],
  },
};

const diskCache = new Map<string, ts.SourceFile>();

/**
 * Builds a program from in-memory files. Keys are paths relative to `MEM`
 * (`"header.ts"`); every key becomes a root file.
 */
export function programOf(files: Record<string, string>): ts.Program {
  const mem = new Map(Object.entries(files).map(([name, text]) => [`${MEM}/${name}`, text]));
  const base = ts.createCompilerHost(options, true);
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (f) => mem.has(f) || base.fileExists(f),
    readFile: (f) => mem.get(f) ?? base.readFile(f),
    directoryExists: (d) => d === MEM || (base.directoryExists?.(d) ?? true),
    realpath: (f) => (mem.has(f) ? f : (base.realpath?.(f) ?? f)),
    getSourceFile: (f, languageVersion, onError) => {
      const text = mem.get(f);
      if (text !== undefined) return ts.createSourceFile(f, text, languageVersion, true);
      let sf = diskCache.get(f);
      if (!sf) {
        sf = base.getSourceFile(f, languageVersion, onError, false);
        if (sf) diskCache.set(f, sf);
      }
      return sf;
    },
  };
  return ts.createProgram([...mem.keys()], options, host);
}

/** The pre-emit diagnostics of the in-memory files, formatted one per line. */
export function typeErrors(program: ts.Program): string[] {
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file?.fileName.startsWith(`${MEM}/`))
    .map((d) => `${d.file!.fileName}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}
