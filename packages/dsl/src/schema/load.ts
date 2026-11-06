/**
 * JSON Schema loading for `@aflow/dsl` (spec §10, §15.7).
 *
 * Turns header `schemas` files and inline `types` into `definitions` entries keyed
 * `<namespace>.<Name>`, rewriting every `$ref` to `#/definitions/<key>`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { JsonSchema } from "../surface/header.js";
import { keyOfRef, refOfKey } from "./ref.js";

export interface SchemaSource {
  /** The header `schemas` key, or the workflow's `client_id` for inline types. */
  namespace: string;
  /** Absolute path of a JSON Schema file. */
  file?: string;
  inline?: Record<string, JsonSchema>;
}

export interface SchemaError {
  kind: "collision" | "unresolved-ref" | "remote-ref" | "unreadable";
  message: string;
  file?: string;
}

export interface SchemaSet {
  byKey: Map<string, JsonSchema>;
  errors: SchemaError[];
}

/** Keywords whose value is a map of name -> schema (names are not keywords). */
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "definitions", "$defs", "dependentSchemas"]);
/** Keywords whose value is data, never a schema. */
const DATA_KEYWORDS = new Set(["enum", "const", "default", "examples"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep-copies a schema, replacing each `$ref` string with `fn(ref)`. */
function mapRefs(node: unknown, fn: (ref: string) => string, inNameMap = false): unknown {
  if (Array.isArray(node)) return node.map((n) => mapRefs(n, fn));
  if (!isObj(node)) return node;
  const out: Obj = {};
  for (const [k, v] of Object.entries(node)) {
    if (inNameMap) out[k] = mapRefs(v, fn);
    else if (k === "$ref" && typeof v === "string") out[k] = fn(v);
    else if (DATA_KEYWORDS.has(k)) out[k] = v;
    else out[k] = mapRefs(v, fn, SCHEMA_MAPS.has(k));
  }
  return out;
}

const isRemote = (ref: string) => /^[a-z][a-z0-9+.-]*:/i.test(ref);

export function loadSchemas(sources: SchemaSource[]): SchemaSet {
  const set: SchemaSet = { byKey: new Map(), errors: [] };
  const nsByFile = new Map<string, string>();
  for (const s of sources) if (s.file) nsByFile.set(resolve(s.file), s.namespace);

  const fileOf = new Map<string, string | undefined>();
  const add = (key: string, schema: JsonSchema, file?: string) => {
    if (set.byKey.has(key)) {
      set.errors.push({ kind: "collision", message: `schema key "${key}" is defined more than once`, file });
      return;
    }
    set.byKey.set(key, schema);
    fileOf.set(key, file);
  };

  /** Resolves one `$ref` found in a schema of `namespace` (file `file`, if any). */
  const rewrite = (ref: string, namespace: string, file: string | undefined, titles: Set<string>): string => {
    const err = (kind: SchemaError["kind"], message: string): string => {
      set.errors.push({ kind, message, file });
      return ref;
    };
    if (isRemote(ref)) return err("remote-ref", `remote $ref "${ref}" is not supported`);
    const hash = ref.indexOf("#");
    const path = hash < 0 ? ref : ref.slice(0, hash);
    const pointer = hash < 0 ? "" : ref.slice(hash + 1);
    let ns = namespace;
    let targetFile = file;
    if (path !== "") {
      if (!file) return err("unresolved-ref", `relative $ref "${ref}" in an inline schema`);
      targetFile = resolve(dirname(file), path);
      const other = nsByFile.get(targetFile);
      if (other === undefined) return err("unresolved-ref", `$ref "${ref}" points at ${targetFile}, which is not listed in schemas`);
      ns = other;
    }
    const m = /^\/(?:definitions|\$defs)\/([^/]+)$/.exec(pointer);
    if (m) {
      let name: string;
      try {
        name = decodeURIComponent(m[1]!).replace(/~1/g, "/").replace(/~0/g, "~");
      } catch {
        return err("unresolved-ref", `$ref "${ref}" has a malformed percent escape`);
      }
      return refOfKey(`${ns}.${name}`);
    }
    if (pointer === "" || pointer === "/") {
      const title = path === "" ? [...titles][0] : rootTitle(targetFile!);
      if (title) return refOfKey(`${ns}.${title}`);
    }
    return err("unresolved-ref", `$ref "${ref}" does not name a definition or a titled root schema`);
  };

  const titleCache = new Map<string, string | undefined>();
  const rootTitle = (file: string): string | undefined => {
    if (!titleCache.has(file)) {
      try {
        const doc: unknown = JSON.parse(readFileSync(file, "utf8"));
        titleCache.set(file, isObj(doc) && typeof doc.title === "string" ? doc.title : undefined);
      } catch {
        titleCache.set(file, undefined);
      }
    }
    return titleCache.get(file);
  };

  for (const src of sources) {
    if (src.inline) {
      for (const [name, schema] of Object.entries(src.inline)) {
        add(`${src.namespace}.${name}`, mapRefs(schema, (r) => rewrite(r, src.namespace, undefined, new Set())) as JsonSchema);
      }
    }
    if (src.file) {
      let doc: unknown;
      try {
        doc = JSON.parse(readFileSync(src.file, "utf8"));
      } catch (e) {
        set.errors.push({ kind: "unreadable", message: `cannot read ${src.file}: ${(e as Error).message}`, file: src.file });
        continue;
      }
      if (!isObj(doc)) {
        set.errors.push({ kind: "unreadable", message: `${src.file} is not a JSON Schema object`, file: src.file });
        continue;
      }
      const titles = new Set(typeof doc.title === "string" ? [doc.title] : []);
      const rw = (r: string) => rewrite(r, src.namespace, src.file, titles);
      for (const kw of ["definitions", "$defs"]) {
        const defs = doc[kw];
        if (!isObj(defs)) continue;
        for (const [name, schema] of Object.entries(defs)) {
          add(`${src.namespace}.${name}`, mapRefs(schema, rw) as JsonSchema, src.file);
        }
      }
      if (typeof doc.title === "string") {
        const { definitions: _d, $defs: _e, $schema: _s, $id: _i, ...root } = doc;
        add(`${src.namespace}.${doc.title}`, mapRefs(root, rw) as JsonSchema, src.file);
      }
    }
  }
  // Post-load pass: every rewritten ref must name a loaded key.
  for (const [key, schema] of set.byKey) {
    mapRefs(schema, (ref) => {
      const target = keyOfRef(ref);
      if (target !== undefined) {
        if (!set.byKey.has(target)) {
          set.errors.push({ kind: "unresolved-ref", message: `"${key}" references undefined schema "${target}"`, file: fileOf.get(key) });
        }
      }
      return ref;
    });
  }
  return set;
}

/** The transitive `$ref` closure of `roots`, in sorted key order; unknown keys become errors. */
export function closure(
  set: SchemaSet,
  roots: string[],
): { schemas: Record<string, JsonSchema>; errors: SchemaError[] } {
  const errors: SchemaError[] = [];
  const missing = new Set<string>();
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const key = stack.pop()!;
    if (seen.has(key)) continue;
    const schema = set.byKey.get(key);
    if (schema === undefined) {
      if (!missing.has(key)) {
        missing.add(key);
        errors.push({ kind: "unresolved-ref", message: `unknown schema "${key}"` });
      }
      continue;
    }
    seen.add(key);
    mapRefs(schema, (ref) => {
      const target = keyOfRef(ref);
      if (target !== undefined) stack.push(target);
      return ref;
    });
  }
  const out: Record<string, JsonSchema> = {};
  for (const key of [...seen].sort()) out[key] = set.byKey.get(key)!;
  return { schemas: out, errors };
}
