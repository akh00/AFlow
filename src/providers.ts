/**
 * §9 effect providers — the only place I/O happens.
 *
 * A provider receives the already-computed `input` expression value and returns
 * a value the engine captures into `this.tasks[name].result`. Throwing (or
 * returning a rejected promise) produces a captured error, subject to §11
 * retry.
 */

import type { ItemView } from "./context.js";
import type { WorkflowError } from "./runtime.js";
import { AFlowError } from "./runtime.js";
import type { CallBody, Node, WorkflowDefinition } from "./types.js";

/** A library packed with the workflow, or resolved from an artifactory (§9). */
export type Bundle = Record<string, unknown>;

export interface BundleRegistry {
  /** Resolve `implementation.bundle_name`@`bundle_version`, optionally `entry`. */
  resolve(ref: {
    name?: string;
    version?: string;
    entry?: string;
    registryUrl?: string;
    registryRef?: string;
  }): Promise<Bundle> | Bundle;
}

export interface ProviderInvocation {
  node: Node;
  call: CallBody;
  item: ItemView;
  /** Value of the `call.input` expression. */
  input: unknown;
  parameters: Record<string, unknown>;
  bundles: BundleRegistry | undefined;
  signal: AbortSignal;
  attempt: number;
  definition: WorkflowDefinition;
  /** Recursive evaluation, for `provider: sub_workflow`. */
  evaluateSubWorkflow?: (
    ref: { client_id: string; name: string },
    input: unknown,
  ) => Promise<{ result?: unknown; error?: WorkflowError }>;
}

export type EffectProvider = (inv: ProviderInvocation) => Promise<unknown>;

/** An effect failure carrying the §11 retry hints. */
export class EffectError extends AFlowError {
  constructor(readonly workflowError: WorkflowError) {
    super(workflowError.message);
  }
}

/** Coerce anything thrown by an effect into a `WorkflowError`. */
export function toWorkflowError(cause: unknown): WorkflowError {
  if (cause instanceof EffectError) return cause.workflowError;
  if (cause && typeof cause === "object") {
    const o = cause as Record<string, unknown>;
    if (typeof o.code === "number" && typeof o.message === "string") {
      return o as unknown as WorkflowError;
    }
    if (cause instanceof Error) {
      return {
        code: 500,
        category: "TECHNICAL",
        message: cause.message,
        data: { name: cause.name },
        retry_type: (o.retry_type as WorkflowError["retry_type"]) ?? null,
      };
    }
  }
  return { code: 500, category: "TECHNICAL", message: String(cause) };
}

// ── http ───────────────────────────────────────────────────────────────────

export interface HttpProviderOptions {
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

export interface HttpRequestValues {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * The engine evaluates `call.request`'s expressions and stashes the values
 * here, so the provider itself stays free of expression concerns.
 */
export const HTTP_REQUEST = Symbol("aflow.httpRequest");

export function createHttpProvider(
  opts: HttpProviderOptions = {},
): EffectProvider {
  return async (inv) => {
    const doFetch = opts.fetch ?? globalThis.fetch;
    if (!doFetch) {
      throw new EffectError({
        code: 500,
        category: "TECHNICAL",
        message: "no fetch implementation available for provider `http`",
      });
    }
    const req = (inv as unknown as Record<symbol, HttpRequestValues>)[
      HTTP_REQUEST
    ];
    if (!req) {
      throw new EffectError({
        code: 500,
        category: "TECHNICAL",
        message: `node ${inv.node.name}: provider \`http\` requires a \`request\``,
      });
    }
    const res = await doFetch(req.url, {
      method: req.method,
      headers: req.headers,
      body:
        req.body === undefined || req.method === "GET" || req.method === "HEAD"
          ? undefined
          : typeof req.body === "string"
            ? req.body
            : JSON.stringify(req.body),
      signal: inv.signal,
    });
    const text = await res.text();
    const payload = text ? safeJson(text) : undefined;
    if (!res.ok) {
      throw new EffectError({
        code: res.status,
        category: res.status >= 500 ? "TECHNICAL" : "BUSINESS",
        message: `HTTP ${res.status} ${res.statusText}`,
        data: payload,
        // §11: retry 5xx, surface 4xx as determined.
        retry_type: res.status >= 500 ? "inline_then_offline" : null,
      });
    }
    return payload;
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ── js ─────────────────────────────────────────────────────────────────────

const scriptCache = new Map<string, (input: unknown, lib: Bundle) => unknown>();

/**
 * `provider: js` — inline JavaScript with a resolved library namespace.
 *
 * This is the effect side of the §5 boundary, so the script is *not* run under
 * the pure-expression guard. A production deployment should run it in a real
 * isolate; here it runs in-process, which is sufficient because the workflow
 * document is trusted input to the engine.
 */
export const jsProvider: EffectProvider = async (inv) => {
  const { call, node } = inv;
  if (!call.script) {
    throw new EffectError({
      code: 500,
      category: "TECHNICAL",
      message: `node ${node.name}: provider \`js\` requires a \`script\``,
    });
  }

  let lib: Bundle = {};
  const needsLib = Boolean(call.implementation || call.registry);
  if (needsLib) {
    if (!inv.bundles) {
      throw new EffectError({
        code: 500,
        category: "TECHNICAL",
        message: `node ${node.name}: no bundle registry configured, but the call declares a library`,
      });
    }
    lib = await inv.bundles.resolve({
      name: call.implementation?.bundle_name,
      version: call.implementation?.bundle_version,
      entry: call.implementation?.entry,
      registryUrl: call.registry?.url,
      registryRef: call.registry?.ref,
    });
  }

  let fn = scriptCache.get(call.script);
  if (!fn) {
    // eslint-disable-next-line no-new-func -- §9: `script` is executable code by design
    fn = new Function(`return (${call.script});`)() as typeof fn;
    if (typeof fn !== "function") {
      throw new EffectError({
        code: 500,
        category: "TECHNICAL",
        message: `node ${node.name}: \`script\` did not evaluate to a function`,
      });
    }
    scriptCache.set(call.script, fn);
  }
  return await fn(inv.input, lib);
};

// ── sub_workflow ───────────────────────────────────────────────────────────

export const subWorkflowProvider: EffectProvider = async (inv) => {
  const { call, node } = inv;
  if (!call.name) {
    throw new EffectError({
      code: 500,
      category: "TECHNICAL",
      message: `node ${node.name}: provider \`sub_workflow\` requires \`name\``,
    });
  }
  if (!inv.evaluateSubWorkflow) {
    throw new EffectError({
      code: 500,
      category: "TECHNICAL",
      message: `node ${node.name}: no sub-workflow resolver configured`,
    });
  }
  const out = await inv.evaluateSubWorkflow(
    { client_id: call.client_id ?? inv.definition.client_id, name: call.name },
    inv.input,
  );
  if (out.error) {
    // §11: an offline retry inside a sub-workflow bubbles to the parent, which
    // re-resolves it against this task's own retry config.
    throw new EffectError(out.error);
  }
  return out.result;
};

export function defaultProviders(
  opts: HttpProviderOptions = {},
): Record<string, EffectProvider> {
  return {
    http: createHttpProvider(opts),
    js: jsProvider,
    sub_workflow: subWorkflowProvider,
  };
}

/** In-memory bundle registry: name[@version] → library object. */
export function bundleRegistry(
  bundles: Record<string, Bundle>,
): BundleRegistry {
  return {
    resolve({ name, version, entry, registryRef }) {
      const keys = [
        name && version ? `${name}@${version}` : undefined,
        name,
        registryRef,
      ].filter(Boolean) as string[];
      for (const k of keys) {
        const found = bundles[k];
        if (found) {
          if (!entry) return found;
          const sub = (found as Record<string, unknown>)[entry];
          if (sub === undefined) {
            throw new EffectError({
              code: 500,
              category: "TECHNICAL",
              message: `bundle ${k} has no entry \`${entry}\``,
            });
          }
          return sub as Bundle;
        }
      }
      throw new EffectError({
        code: 500,
        category: "TECHNICAL",
        message: `unresolved bundle: ${keys.join(" / ") || "<unnamed>"}`,
      });
    },
  };
}
