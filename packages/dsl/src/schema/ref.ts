/**
 * `$ref`s into `definitions` (spec §10). A key is one JSON Pointer token, so
 * `~` and `/` are escaped when written and decoded when read (Ruling R18).
 * The loader, the codegen and the analyzer share these two functions.
 */

const DEFINITIONS_PREFIX = "#/definitions/";

/** The `$ref` to the `definitions` key `key`. */
export const refOfKey = (key: string): string =>
  `${DEFINITIONS_PREFIX}${key.replace(/~/g, "~0").replace(/\//g, "~1")}`;

/** The `definitions` key that `ref` names, or `undefined` when `ref` points elsewhere. */
export function keyOfRef(ref: string): string | undefined {
  if (!ref.startsWith(DEFINITIONS_PREFIX)) return undefined;
  return ref.slice(DEFINITIONS_PREFIX.length).replace(/~1/g, "/").replace(/~0/g, "~");
}
