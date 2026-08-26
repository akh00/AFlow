/**
 * Compilation and evaluation of pure expressions (§5).
 *
 * `$expr` compiles to `return (<src>)`, `$do` to a statement block. Both run
 * inside `with (scopeProxy) { … }`, so the bare identifiers the spec uses —
 * `data`, `objects`, `items`, `parent`, `root`, `set`, `result`, `error`,
 * `task_state`, `parameters`, `ctx` — resolve against the supplied scope, and
 * `this` is the item.
 *
 * The proxy is also the determinism guard: anything that would let an
 * expression read the clock, the RNG, or the outside world (§5) is not in the
 * scope and raises `DeterminismViolation` rather than resolving to a host
 * global.
 */

import { DeterminismViolation, ExpressionError } from "./runtime.js";
import type { Expr } from "./types.js";

/** Bindings an expression may reach beyond its scope. All deterministic. */
const SAFE_GLOBALS: Record<string, unknown> = {
  Object,
  Array,
  String,
  Number,
  Boolean,
  JSON,
  RegExp,
  Map,
  Set,
  Symbol,
  Error,
  TypeError,
  RangeError,
  BigInt,
  isNaN,
  isFinite,
  parseInt,
  parseFloat,
  encodeURIComponent,
  decodeURIComponent,
  NaN,
  Infinity,
  undefined,
};

/** `Math` without `random` — everything else is a pure function. */
const SAFE_MATH: Record<string, unknown> = Object.freeze(
  Object.fromEntries([
    ...Object.getOwnPropertyNames(Math)
      .filter((k) => k !== "random")
      .map((k) => [k, (Math as unknown as Record<string, unknown>)[k]]),
    [
      "random",
      () => {
        throw new DeterminismViolation(
          "Math.random() is not available in a pure expression (§5)",
        );
      },
    ],
  ]),
);
SAFE_GLOBALS.Math = SAFE_MATH;

/**
 * Identifiers an expression must never resolve. Naming one is a determinism
 * violation with a pointed message rather than a bare `ReferenceError`.
 */
const FORBIDDEN = new Map<string, string>([
  ["Date", "reading the clock"],
  ["performance", "reading the clock"],
  ["fetch", "performing I/O"],
  ["XMLHttpRequest", "performing I/O"],
  ["WebSocket", "performing I/O"],
  ["require", "loading modules"],
  ["import", "loading modules"],
  ["process", "reading host state"],
  ["globalThis", "reaching the host scope"],
  ["global", "reaching the host scope"],
  ["Function", "constructing code"],
  ["eval", "constructing code"],
  ["setTimeout", "scheduling"],
  ["setInterval", "scheduling"],
  ["setImmediate", "scheduling"],
  ["queueMicrotask", "scheduling"],
  ["Promise", "asynchrony (all I/O belongs in a `call` body, §5)"],
  ["Atomics", "shared state"],
  ["SharedArrayBuffer", "shared state"],
  ["crypto", "the RNG"],
]);

export type Scope = Record<string, unknown>;

type CompiledFn = (this: unknown, scope: Scope) => unknown;

const cache = new Map<string, CompiledFn>();

function makeScopeProxy(scope: Scope): Scope {
  return new Proxy(scope, {
    // Claim every name so `with` routes all unqualified lookups here.
    has: () => true,
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      if (typeof key !== "string") return (target as never)[key];
      if (key in target) return target[key];
      if (key in SAFE_GLOBALS) return SAFE_GLOBALS[key];
      const why = FORBIDDEN.get(key);
      if (why) {
        throw new DeterminismViolation(
          `\`${key}\` is not available in a pure expression: ${why} is forbidden (§5)`,
        );
      }
      throw new ReferenceError(`${key} is not defined in this expression scope`);
    },
    set(target, key, value) {
      // Assignments land on the scope. A `$do` writing `objects.x` mutates the
      // real object (the proxy only intercepts the *bare* name); a `$do`
      // assigning an unqualified name — including a hoisted `var` — gets a
      // scope-local slot rather than a host global.
      if (typeof key === "string" && FORBIDDEN.has(key)) {
        throw new DeterminismViolation(
          `cannot assign to \`${key}\` in a pure expression (§5)`,
        );
      }
      target[key as string] = value;
      return true;
    },
  });
}

function compile(source: string, kind: "expr" | "do"): CompiledFn {
  const key = `${kind}:${source}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const body =
    kind === "expr"
      ? `with (__scope__) { return (\n${source}\n); }`
      : `with (__scope__) {\n${source}\n}`;

  let fn: CompiledFn;
  try {
    // eslint-disable-next-line no-new-func -- the compiler for $expr/$do
    fn = new Function("__scope__", body) as CompiledFn;
  } catch (cause) {
    throw new ExpressionError(
      `cannot compile ${kind === "expr" ? "$expr" : "$do"}: ${(cause as Error).message}`,
      { source },
    );
  }
  cache.set(key, fn);
  return fn;
}

/** Normalize the three §16 spellings of an expression into source + kind. */
export function exprSource(e: Expr): { source: string; kind: "expr" | "do" } {
  if (typeof e === "string") return { source: e, kind: "expr" };
  if ("$expr" in e && e.$expr !== undefined)
    return { source: e.$expr, kind: "expr" };
  if ("$do" in e && e.$do !== undefined) return { source: e.$do, kind: "do" };
  throw new ExpressionError("expression has neither $expr nor $do", {
    value: e as unknown,
  });
}

export interface EvalOptions {
  /** `this` inside the expression — normally the item view. */
  self?: unknown;
  /** Where the expression came from, for error messages. */
  where?: string;
}

/** Evaluate a `$expr` (or a bare string) and return its value. */
export function evalExpr(e: Expr, scope: Scope, opts: EvalOptions = {}): unknown {
  const { source, kind } = exprSource(e);
  if (kind === "do") {
    // A `$do` used where a value is expected: run it, yield undefined.
    return runDo(e, scope, opts);
  }
  const fn = compile(source, "expr");
  try {
    return fn.call(opts.self, makeScopeProxy(scope));
  } catch (cause) {
    throw wrap(cause, source, opts.where);
  }
}

/** Run a `$do` statement block for its writes into the scope. */
export function runDo(e: Expr, scope: Scope, opts: EvalOptions = {}): void {
  const { source } = exprSource(e);
  const fn = compile(source, "do");
  try {
    fn.call(opts.self, makeScopeProxy(scope));
  } catch (cause) {
    throw wrap(cause, source, opts.where);
  }
}

function wrap(cause: unknown, source: string, where?: string): Error {
  if (cause instanceof DeterminismViolation) return cause;
  const msg = cause instanceof Error ? cause.message : String(cause);
  return new ExpressionError(
    `${where ? `${where}: ` : ""}${msg}`,
    { source, cause: msg },
  );
}

/** Truthiness with an explicit contract, used for `condition` and `until`. */
export function truthy(v: unknown): boolean {
  return Boolean(v);
}

/** Clear the compilation cache (tests). */
export function resetExprCache(): void {
  cache.clear();
}
