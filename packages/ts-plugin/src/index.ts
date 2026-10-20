/**
 * The tsserver entry of `@aflow/ts-plugin` (spec §15.9). tsserver loads a
 * plugin with `require` and calls `module.exports` as the factory, so this
 * file uses `export =`.
 */

import { init } from "./plugin.js";

export = init;
