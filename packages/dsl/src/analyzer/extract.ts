/**
 * Static extraction of the §13 document from DSL source (spec §15.1–§15.3,
 * §15.8).
 *
 * The header, the task groups and the assembly are recognised by their call
 * sites, resolved through the checker: the header callee resolves to
 * `@aflow/dsl`'s `workflow`, `X.tasks` / `X.assemble` resolve `X` to a header
 * constant. Groups may live in any file.
 */

import type { Node, WorkflowDefinition } from "@aflow/engine";
import type * as TS from "typescript";

import type { WorkflowHeader } from "../surface/header.js";
import { type Position, SCOPE_AT, STATEMENT_POSITIONS } from "../surface/scope.js";
import { type AflowDiagnostic, diagnosticAt } from "./diagnostics.js";
import { emitArrow, emitScript, emitStatements } from "./emit.js";
import type { Loc, SourceLocations, WorkflowAnalysis } from "./index.js";
import { type ArrowHandler, type LiteralPath, propertyNameText, readLiteral, snippet, unwrapLiteral } from "./literal.js";

type Ts = typeof TS;

/** An expression found during extraction; `pointer` is relative to its task or to the document. */
interface ExprRecord {
  pointer: string;
  loc: Loc;
  arrow: TS.ArrowFunction;
}

interface TaskRecord {
  name: string;
  node: Node;
  loc: Loc;
  exprs: ExprRecord[];
}

interface HeaderDecl {
  symbol: TS.Symbol;
  name: string;
  call: TS.CallExpression;
  /** Diagnostics of the header literal and of misplaced calls on this header. */
  diagnostics: AflowDiagnostic[];
  header: WorkflowHeader;
  base: Omit<WorkflowDefinition, "tasks">;
  exprs: ExprRecord[];
  groups: GroupDecl[];
  entries: EntryDecl[];
}

interface GroupDecl {
  symbol: TS.Symbol;
  call: TS.CallExpression;
  tasks: TaskRecord[];
  diagnostics: AflowDiagnostic[];
}

interface EntryDecl {
  file: string;
  groups: GroupDecl[];
  diagnostics: AflowDiagnostic[];
}

/** One extracted workflow, with the arrow node of every expression pointer (Ruling R2). */
export interface Extracted {
  analysis: WorkflowAnalysis;
  arrows: Map<string, TS.ArrowFunction>;
}

const DSL_MODULE = "@aflow/dsl";

/** The route positions whose `switch` member is an expression at the same position (§15.5). */
const ROUTE_POSITIONS: readonly string[] = ["route", "split.route", "dispatch.route", "config.defaults.task.route"];
const ERROR_HANDLER: Position = "config.defaults.task.default_error_handler";

const escapePointer = (s: string | number) => String(s).replace(/~/g, "~0").replace(/\//g, "~1");
const pointerOf = (path: LiteralPath) => path.map((p) => `/${escapePointer(p)}`).join("");
const refTo = (key: string) => ({ $ref: `#/definitions/${escapePointer(key)}` });

function locOf(node: TS.Node): Loc {
  const sf = node.getSourceFile();
  const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return { file: sf.fileName, line: lc.line + 1, column: lc.character + 1 };
}

/**
 * The §15.5 position of a value at `path`, or `null`. `base` says whether the
 * path is relative to a node or to the header (`config.*`).
 */
function positionAt(path: LiteralPath, base: "node" | "config"): Position | null {
  let key = path.join(".");
  if (base === "config") {
    if (key === `${ERROR_HANDLER}.$do`) return ERROR_HANDLER;
    if (key === ERROR_HANDLER || !key.startsWith("config.")) return null;
  } else if (key.startsWith("config.")) {
    return null;
  }
  if (key.endsWith(".switch") && ROUTE_POSITIONS.includes(key.slice(0, -".switch".length))) {
    key = key.slice(0, -".switch".length);
  }
  return Object.hasOwn(SCOPE_AT, key) ? (key as Position) : null;
}

/** The arrow handler for one literal walk: emits arrows at legal positions and records them. */
function arrowHandler(
  ts: Ts,
  base: "node" | "config",
  exprs: ExprRecord[],
  diagnostics: AflowDiagnostic[],
): ArrowHandler {
  return (arrow, path) => {
    const record = () => exprs.push({ pointer: pointerOf(path), loc: locOf(arrow), arrow });
    if (base === "node" && path.join(".") === "call.script") {
      record();
      return { value: emitScript(ts, arrow) };
    }
    const position = positionAt(path, base);
    if (!position) return null;
    record();
    if (position === ERROR_HANDLER) return { value: emitStatements(ts, arrow) };
    if (ts.isBlock(arrow.body) && !(STATEMENT_POSITIONS as readonly string[]).includes(position)) {
      diagnostics.push(
        diagnosticAt(
          arrow.body,
          "body-form",
          `\`${position}\` is a value position: use an expression body. The engine yields undefined for a block body here (§15.4).`,
        ),
      );
    }
    return { value: emitArrow(ts, arrow) };
  };
}

// ── recognition ────────────────────────────────────────────────────────────

/** True if `node` is the initializer of a top-level `const <identifier> = …`. */
function topLevelConst(ts: Ts, node: TS.Node): node is TS.Expression & { parent: TS.VariableDeclaration } {
  const decl = node.parent;
  return (
    decl !== undefined &&
    ts.isVariableDeclaration(decl) &&
    decl.initializer === node &&
    ts.isIdentifier(decl.name) &&
    (decl.parent.flags & ts.NodeFlags.Const) !== 0 &&
    ts.isVariableStatement(decl.parent.parent) &&
    ts.isSourceFile(decl.parent.parent.parent)
  );
}

/** True if `node` is the expression of a top-level `export default …`. */
function topLevelDefaultExport(ts: Ts, node: TS.Node): boolean {
  const exp = node.parent;
  return exp !== undefined && ts.isExportAssignment(exp) && !exp.isExportEquals && ts.isSourceFile(exp.parent);
}

/** The symbol behind `node`, through import and re-export aliases. */
function resolvedSymbol(ts: Ts, checker: TS.TypeChecker, node: TS.Node): TS.Symbol | undefined {
  const sym = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(node) ? node.name : node);
  return sym && sym.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(sym) : sym;
}

/** The `workflow` symbols of `@aflow/dsl`, as the program resolves the module. */
function dslWorkflowSymbols(ts: Ts, checker: TS.TypeChecker, files: readonly TS.SourceFile[]): Set<TS.Symbol> {
  const found = new Set<TS.Symbol>();
  for (const sf of files) {
    for (const stmt of sf.statements) {
      if (!(ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt))) continue;
      const spec = stmt.moduleSpecifier;
      if (!spec || !ts.isStringLiteral(spec) || spec.text !== DSL_MODULE) continue;
      const mod = checker.getSymbolAtLocation(spec);
      const exp = mod && checker.tryGetMemberInModuleExports("workflow", mod);
      if (exp) found.add(exp.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exp) : exp);
    }
  }
  return found;
}

function allCalls(ts: Ts, sf: TS.SourceFile): TS.CallExpression[] {
  const calls: TS.CallExpression[] = [];
  const visit = (n: TS.Node): void => {
    if (ts.isCallExpression(n)) calls.push(n);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return calls;
}

/** The object literal passed as the first argument of `call`, or a `not-static` diagnostic. */
function objectArgument(ts: Ts, call: TS.CallExpression, diagnostics: AflowDiagnostic[]) {
  const arg = call.arguments[0];
  const lit = arg && unwrapLiteral(ts, arg);
  if (lit && ts.isObjectLiteralExpression(lit)) return lit;
  diagnostics.push(
    diagnosticAt(arg ?? call, "not-static", `\`${snippet(arg ?? call)}\` needs an object literal argument (§15.1).`),
  );
  return undefined;
}

// ── extraction ─────────────────────────────────────────────────────────────

function extractHeader(ts: Ts, h: HeaderDecl): void {
  const lit = objectArgument(ts, h.call, h.diagnostics);
  if (!lit) return;
  const walk = { diagnostics: h.diagnostics, onArrow: arrowHandler(ts, "config", h.exprs, h.diagnostics) };
  const header = (readLiteral(ts, lit, walk) ?? {}) as WorkflowHeader;
  h.header = header;
  const definitions: Record<string, unknown> = {};
  if (typeof header.input === "string") definitions.input = refTo(header.input);
  if (typeof header.result === "string") definitions.result = refTo(header.result);
  const items: NonNullable<WorkflowDefinition["items"]> = {};
  for (const [name, decl] of Object.entries(header.items ?? {})) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(decl ?? {})) {
      out[k] = (k === "data" || k === "objects") && typeof v === "string" ? refTo(v) : v;
    }
    items[name] = out;
  }
  h.base = {
    client_id: header.client_id,
    name: header.name,
    ...(header.version !== undefined && { version: header.version }),
    definitions,
    items,
    ...(header.config !== undefined && { config: header.config as WorkflowDefinition["config"] }),
  };
}

function extractGroup(ts: Ts, g: GroupDecl): void {
  const lit = objectArgument(ts, g.call, g.diagnostics);
  if (!lit) return;
  for (const p of lit.properties) {
    if (!ts.isPropertyAssignment(p)) {
      g.diagnostics.push(
        diagnosticAt(p, "not-static", `\`${snippet(p)}\` is not a task. Write each task as \`name: { item: …, … }\` (§15.3).`),
      );
      continue;
    }
    const name = propertyNameText(ts, p.name);
    if (name === undefined) {
      g.diagnostics.push(
        diagnosticAt(p.name, "not-static", `\`${snippet(p.name)}\` is a computed task name. Task names MUST be literals (§15.1).`),
      );
      continue;
    }
    const value = unwrapLiteral(ts, p.initializer);
    if (!ts.isObjectLiteralExpression(value)) {
      g.diagnostics.push(
        diagnosticAt(value, "not-static", `\`${snippet(value)}\` is not a node literal. Write the task as an object literal (§15.1).`),
      );
      continue;
    }
    const exprs: ExprRecord[] = [];
    const walk = { diagnostics: g.diagnostics, onArrow: arrowHandler(ts, "node", exprs, g.diagnostics) };
    const { name: _ignored, ...fields } = readLiteral(ts, value, walk) as Record<string, unknown>;
    g.tasks.push({ name, node: { name, ...fields } as Node, loc: locOf(p.name), exprs });
  }
}

function sortedUnique(diags: Iterable<AflowDiagnostic>): AflowDiagnostic[] {
  const byKey = new Map<string, AflowDiagnostic>();
  for (const d of diags) byKey.set(`${d.file}\0${d.start}\0${d.length}\0${d.rule}`, d);
  return [...byKey.values()].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.start - b.start));
}

function compose(h: HeaderDecl, entry: EntryDecl | null): Extracted {
  const arrows = new Map<string, TS.ArrowFunction>();
  const locations: SourceLocations = { tasks: {}, expressions: {} };
  for (const e of h.exprs) {
    locations.expressions[e.pointer] = e.loc;
    arrows.set(e.pointer, e.arrow);
  }
  const tasks: Node[] = [];
  const groups = entry?.groups ?? [];
  for (const t of groups.flatMap((g) => g.tasks)) {
    const at = `/tasks/${tasks.length}`;
    tasks.push(t.node);
    locations.tasks[t.name] = t.loc;
    for (const e of t.exprs) {
      locations.expressions[at + e.pointer] = e.loc;
      arrows.set(at + e.pointer, e.arrow);
    }
  }
  const sf = h.call.getSourceFile();
  const analysis: WorkflowAnalysis = {
    headerFile: sf.fileName,
    headerSymbol: h.name,
    entryFile: entry?.file ?? null,
    header: h.header,
    definition: { ...h.base, tasks },
    locations,
    taskNames: tasks.map((t) => t.name),
    diagnostics: sortedUnique([
      ...h.diagnostics,
      ...groups.flatMap((g) => g.diagnostics),
      ...(entry?.diagnostics ?? []),
    ]),
  };
  return { analysis, arrows };
}

/** Extracts every workflow of `program`. */
export function extractWorkflows(
  ts: Ts,
  program: TS.Program,
): { workflows: Extracted[]; diagnostics: AflowDiagnostic[] } {
  const checker = program.getTypeChecker();
  const files = program
    .getSourceFiles()
    .filter((sf) => !sf.isDeclarationFile && !program.isSourceFileFromExternalLibrary(sf));
  const workflowFns = dslWorkflowSymbols(ts, checker, files);
  const calls = files.flatMap((sf) => allCalls(ts, sf));
  const stray: AflowDiagnostic[] = [];

  // Pass 1: headers.
  const headers = new Map<TS.Symbol, HeaderDecl>();
  for (const call of calls) {
    const fn = resolvedSymbol(ts, checker, call.expression);
    if (!fn || !workflowFns.has(fn)) continue;
    if (!topLevelConst(ts, call)) {
      stray.push(
        diagnosticAt(call, "not-static", "Declare the workflow header at module top level as `const X = workflow({…})` (§15.1)."),
      );
      continue;
    }
    const decl = call.parent;
    const symbol = checker.getSymbolAtLocation(decl.name)!;
    headers.set(symbol, {
      symbol,
      name: (decl.name as TS.Identifier).text,
      call,
      diagnostics: [],
      header: {} as WorkflowHeader,
      base: { client_id: "", name: "" },
      exprs: [],
      groups: [],
      entries: [],
    });
  }

  // Pass 2: groups and assemblies on a header.
  const groups = new Map<TS.Symbol, GroupDecl>();
  const assemblies: { header: HeaderDecl; call: TS.CallExpression }[] = [];
  for (const call of calls) {
    const callee = call.expression;
    if (!ts.isPropertyAccessExpression(callee)) continue;
    const method = callee.name.text;
    if (method !== "tasks" && method !== "assemble") continue;
    const target = resolvedSymbol(ts, checker, callee.expression);
    const header = target && headers.get(target);
    if (!header) continue;
    if (method === "tasks") {
      if (!topLevelConst(ts, call)) {
        header.diagnostics.push(
          diagnosticAt(call, "not-static", `Declare a task group at module top level as \`const G = ${header.name}.tasks({…})\` (§15.1).`),
        );
        continue;
      }
      const g: GroupDecl = { symbol: checker.getSymbolAtLocation(call.parent.name)!, call, tasks: [], diagnostics: [] };
      groups.set(g.symbol, g);
      header.groups.push(g);
    } else if (!topLevelDefaultExport(ts, call)) {
      header.diagnostics.push(
        diagnosticAt(call, "not-static", `Declare the assembly at module top level as \`export default ${header.name}.assemble(…)\` (§15.1).`),
      );
    } else {
      assemblies.push({ header, call });
    }
  }

  for (const h of headers.values()) extractHeader(ts, h);
  for (const g of groups.values()) extractGroup(ts, g);

  for (const { header, call } of assemblies) {
    const entry: EntryDecl = { file: call.getSourceFile().fileName, groups: [], diagnostics: [] };
    for (const arg of call.arguments) {
      const g = ts.isIdentifier(arg) ? groups.get(resolvedSymbol(ts, checker, arg)!) : undefined;
      if (g && header.groups.includes(g)) entry.groups.push(g);
      else {
        entry.diagnostics.push(
          diagnosticAt(
            arg,
            "not-static",
            `\`${snippet(arg)}\` is not a task group of \`${header.name}\`. List the constants declared with \`${header.name}.tasks({…})\` (§15.3).`,
          ),
        );
      }
    }
    header.entries.push(entry);
  }

  const workflows: Extracted[] = [];
  for (const h of headers.values()) {
    if (h.entries.length === 0) workflows.push(compose(h, null));
    for (const e of h.entries) workflows.push(compose(h, e));
  }
  const diagnostics = sortedUnique([
    ...stray,
    ...[...headers.values()].flatMap((h) => [...h.diagnostics, ...h.entries.flatMap((e) => e.diagnostics)]),
    ...[...groups.values()].flatMap((g) => g.diagnostics),
  ]);
  return { workflows, diagnostics };
}
