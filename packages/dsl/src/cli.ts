/**
 * The `aflow` command line (spec §15):
 *
 *   aflow types [--project <tsconfig>]   regenerate the schema typings (§15.7)
 *   aflow build <entry> [-o <file>]      emit the §13 JSON of the workflow assembled in <entry> (§15.8)
 *
 * Diagnostics go to stderr as `file:line:col  severity  rule  message`. The
 * exit code is 1 when any diagnostic is an error.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import type { AflowDiagnostic } from "./analyzer/diagnostics.js";
import { buildWorkflow, generateTypes } from "./build.js";

const USAGE = `usage:
  aflow types [--project <tsconfig>]
  aflow build <entry> [-o <file>]
`;

/** The 1-based line and column of `offset` in `file`; 1:1 when the file cannot be read. */
function lineAndColumn(file: string, offset: number, cache: Map<string, string>): [number, number] {
  let text = cache.get(file);
  if (text === undefined) {
    try {
      text = readFileSync(file, "utf8");
    } catch {
      text = "";
    }
    cache.set(file, text);
  }
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  return [line, offset - (before.lastIndexOf("\n") + 1) + 1];
}

/** Prints `diagnostics` to stderr. True when any is an error. */
function report(diagnostics: AflowDiagnostic[]): boolean {
  const cache = new Map<string, string>();
  for (const d of diagnostics) {
    const [line, col] = lineAndColumn(d.file, d.start, cache);
    const rel = relative(process.cwd(), d.file);
    const shown = rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : d.file;
    process.stderr.write(`${shown}:${line}:${col}  ${d.severity}  ${d.rule}  ${d.message}\n`);
  }
  return diagnostics.some((d) => d.severity === "error");
}

/** Runs one command; returns the exit code. */
function main(args: string[]): number {
  const [command, ...rest] = args;
  if (command === "types") {
    let project = "tsconfig.json";
    if (rest.length === 2 && rest[0] === "--project") project = rest[1]!;
    else if (rest.length !== 0) return usage();
    const { diagnostics } = generateTypes(resolve(project));
    return report(diagnostics) ? 1 : 0;
  }
  if (command === "build") {
    let entry: string | undefined;
    let out: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i]!;
      if (arg === "-o" && i + 1 < rest.length) out = rest[++i];
      else if (!arg.startsWith("-") && entry === undefined) entry = arg;
      else return usage();
    }
    if (entry === undefined) return usage();
    const { definition, diagnostics } = buildWorkflow(entry);
    const failed = report(diagnostics);
    if (failed || !definition) return 1;
    const json = `${JSON.stringify(definition, null, 2)}\n`;
    if (out === undefined) process.stdout.write(json);
    else writeFileSync(out, json);
    return 0;
  }
  return usage();
}

function usage(): number {
  process.stderr.write(USAGE);
  return 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`aflow: ${(e as Error).message ?? String(e)}\n`);
  process.exitCode = 1;
}
