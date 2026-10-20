/**
 * Analyzer diagnostics (spec §15.4, §15.9): the rule set, stable numeric
 * codes for the editor, and the diagnostic shape the build and the plugin
 * share.
 */

import type * as TS from "typescript";

/** The analyzer rules. Their order fixes `RULE_CODES`; append new rules at the end. */
const RULES = [
  "not-static",
  "unknown-task",
  "multiple-bodies",
  "item-type-mismatch",
  "unreachable",
  "outside-reference",
  "forbidden-global",
  "this",
  "async",
  "dynamic-import",
  "param-shape",
  "target-state",
  "unassembled-group",
  "duplicate-task",
  "schema",
  "body-form",
] as const;

export type RuleId = (typeof RULES)[number];

export interface AflowDiagnostic {
  rule: RuleId;
  severity: "error" | "warning";
  message: string;
  /** The file name, as the program knows it. */
  file: string;
  /** Character offset of the reported span. */
  start: number;
  length: number;
}

/** The editor diagnostic code of each rule: `77001`, `77002`, … in rule order. */
export const RULE_CODES = Object.fromEntries(RULES.map((r, i) => [r, 77001 + i])) as Record<
  RuleId,
  number
>;

/** A diagnostic that spans `node` (leading trivia excluded). */
export function diagnosticAt(
  node: TS.Node,
  rule: RuleId,
  message: string,
  severity: AflowDiagnostic["severity"] = "error",
): AflowDiagnostic {
  const sf = node.getSourceFile();
  const start = node.getStart(sf);
  return { rule, severity, message, file: sf.fileName, start, length: node.getEnd() - start };
}
