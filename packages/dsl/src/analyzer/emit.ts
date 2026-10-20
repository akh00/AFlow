/**
 * Expression emission (spec §15.8).
 *
 * The text comes from the TypeScript source, never from a compiled function.
 * Types are erased with `ts.transpileModule` on a wrapped snippet, and the
 * wrapper is then removed by parsing the output. The emitter keeps literal
 * text and comments; it can change whitespace between tokens.
 */

import type * as TS from "typescript";

type Ts = typeof TS;

const WRAP_EXPR = "let __aflow_expr = ";
const WRAP_DO = "function __aflow_do() ";

/** Type-erases `snippet` (TypeScript) and returns it parsed as a JavaScript source file. */
function erase(ts: Ts, snippet: string): TS.SourceFile {
  const out = ts.transpileModule(snippet, {
    fileName: "aflow-snippet.ts",
    compilerOptions: {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      removeComments: false,
      newLine: ts.NewLineKind.LineFeed,
    },
  }).outputText;
  return ts.createSourceFile("aflow-snippet.js", out, ts.ScriptTarget.ESNext, true);
}

/** The type-erased text of an expression. */
function eraseExpression(ts: Ts, expr: TS.Node): string {
  const sf = erase(ts, `${WRAP_EXPR}${expr.getText()};`);
  const stmt = sf.statements.find(ts.isVariableStatement)!;
  return stmt.declarationList.declarations[0]!.initializer!.getText(sf);
}

/** The type-erased statements of a block, without the braces and the common indentation. */
function eraseBlock(ts: Ts, block: TS.Block): string {
  const sf = erase(ts, `${WRAP_DO}${block.getText()}`);
  const fn = sf.statements.find(ts.isFunctionDeclaration)!;
  const body = fn.body!;
  const open = body.getStart(sf) + 1;
  const close = body.getEnd() - 1;
  return dedent(sf.text.slice(open, close), open, templateSpans(ts, body, sf));
}

/** The [start, end) offsets of every template literal under `node`. */
function templateSpans(ts: Ts, node: TS.Node, sf: TS.SourceFile): [number, number][] {
  const spans: [number, number][] = [];
  const visit = (n: TS.Node): void => {
    if (ts.isTemplateExpression(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      spans.push([n.getStart(sf), n.getEnd()]);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return spans;
}

/**
 * Removes the blank lines at both ends and the common indentation. A line that
 * starts inside a template literal is content, so it is neither measured nor
 * changed. `offset` is the position of `text` in the file the spans refer to.
 */
function dedent(text: string, offset: number, templates: [number, number][]): string {
  const lines: { text: string; content: boolean }[] = [];
  let at = offset;
  for (const line of text.split("\n")) {
    const content = templates.some(([s, e]) => at > s && at < e);
    lines.push({ text: line, content });
    at += line.length + 1;
  }
  const blank = (l: { text: string; content: boolean }) => !l.content && l.text.trim() === "";
  while (lines.length && blank(lines[0]!)) lines.shift();
  while (lines.length && blank(lines[lines.length - 1]!)) lines.pop();
  const indents = lines
    .filter((l) => !l.content && l.text.trim() !== "")
    .map((l) => /^[ \t]*/.exec(l.text)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines
    .map((l) => (l.content ? l.text : l.text.slice(cut).trimEnd()))
    .join("\n")
    .trim();
}

/**
 * Emits a DSL arrow as a §13 expression: an expression body as `{ $expr }`,
 * a block body as `{ $do }` (§15.8).
 */
export function emitArrow(ts: Ts, arrow: TS.ArrowFunction): { $expr: string } | { $do: string } {
  return ts.isBlock(arrow.body)
    ? { $do: eraseBlock(ts, arrow.body) }
    : { $expr: eraseExpression(ts, arrow.body) };
}

/**
 * The statement text of an arrow, for positions the engine runs only as `$do`
 * (`default_error_handler`, §15.8): a block body without its braces, or the
 * expression body as is.
 */
export function emitStatements(ts: Ts, arrow: TS.ArrowFunction): string {
  const e = emitArrow(ts, arrow);
  return "$do" in e ? e.$do : e.$expr;
}

/** Emits `call.script` as the full type-erased arrow text, parameters included (§15.6, §15.8). */
export function emitScript(ts: Ts, arrow: TS.ArrowFunction): string {
  return eraseExpression(ts, arrow);
}
