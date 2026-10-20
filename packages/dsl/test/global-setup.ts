/**
 * vitest global setup: generates the schema registries of the DSL fixture
 * projects (spec §15.7), so the fixtures type-check before any test reads them.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateTypes } from "../src/build.js";

const FIXTURE_PROJECTS = ["booking"];

export function setup(): void {
  const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
  for (const name of FIXTURE_PROJECTS) {
    const { diagnostics } = generateTypes(join(fixtures, name, "tsconfig.json"));
    if (diagnostics.length > 0) {
      throw new Error(`aflow types failed for fixture "${name}":\n${diagnostics.map((d) => d.message).join("\n")}`);
    }
  }
}
