# Typed DSL with editor completion — design

Status: draft for review · 2026-10-20

First of three projects that together give AFlow authors editor support in nvim (and any
tsserver-based editor): **(1) this one — the typed DSL and its editor plugin**, (2) the
DSL → JSON/hjson compiler with source locations (§14), (3) a debugger (DAP) that steps
through local runs, replays recorded evaluations and follows live ones read-only. (2) and
(3) get their own designs; this document only fixes what (1) must leave in place for them.

## 1. Intent

Workflows are written today as raw §13 JSON (see `test/fixtures/booking-workflow.ts`):
expressions are opaque strings, types in `definitions` are invisible to the editor, a
misspelled route target or a `Date.now()` in an `$expr` is found only when the engine
runs. The user wants to write workflows in the §15 TypeScript DSL in nvim and have the
editor:

1. **complete fields from the workflow's own types** — `data.`, `objects.`, `parent.`,
   `items[0].` complete from the JSON Schema `definitions`;
2. **complete names** — route targets offer only existing task names; `split` offers
   only declared item types;
3. **flag graph mistakes as you type** — unknown route target, two body kinds on a node,
   a node nothing routes to, a route into a task bound to an item type the routed item
   cannot be;
4. **flag determinism slips inside expressions** — `Date.now()`, `Math.random()`,
   `fetch`, `await`, references to anything outside the expression (§3 below);
5. **hover docs** on DSL methods that cite the spec section and its normative rule
   (e.g. `aggregate` → §7, "`until` MUST be monotonic, `reduce` commutative/associative").

All five are in scope.

### Decisions taken (by the user)

| Question | Decision |
|---|---|
| Authoring surface | TypeScript DSL (§15) in nvim. |
| Where types come from | **JSON Schema files.** The workflow points at the types it uses; they are included into the built workflow's `definitions`. |
| Naming | **snake_case everywhere** — DSL, JSON document, engine. No camelCase translation layer. §15's camelCase examples are wrong and get rewritten. |
| Expression scope | **Option A — parameters are the only way in.** An expression's parameters are exactly the engine's expression scope; any other free identifier is an error in the editor and in build. |
| Scope of editor support | All five behaviours above. |
| Order of projects | DSL + completion first, then compiler, then debugger. |
| How dynamic DSL code may be | **Static, multi-file.** Task names, item-type names and route literals are literals; tasks are declared at module top level (no loops/helpers generating tasks). A workflow may span several files: the workflow entry file imports modules that declare tasks (e.g. one per sub-flow). Both the plugin and `build()` analyse source via the TypeScript program; `build()` is a compile step, not a runtime call. Non-static task declarations are an error. |
| Workflow-private types | **Inline JSON Schema allowed.** Shared message types come from schema files; workflow-private shapes (item `objects`, call results) may be inline JSON Schema literals in DSL files, typed from the literal itself, and included in `definitions` like file schemas (under the workflow's own namespace). |
| Names | **Approved:** `@aflow/dsl`, `@aflow/ts-plugin`, CLI `aflow` with `aflow types` and `aflow build <file>`. |

### Goals

- Authoring the booking workflow in the DSL gives completion and diagnostics for all
  five behaviours, in nvim with stock `ts_ls` or `vtsls`, with no extra language server
  process.
- `build()` produces §13 JSON that the existing engine runs unchanged.
- What you write is what runs: expression bodies appear in the JSON verbatim apart from
  type erasure, readable as hand-written `$expr` today.

### Non-goals

- Completion while editing raw JSON/hjson workflow files (needs `aflow.schema.json`,
  artifact 1 — separate work).
- hjson ↔ JSON converters and source-map output (project 2).
- Debugging (project 3).
- §10 runtime validation of `data`/`input`/`result` in the engine.
- Generating JSON Schema *from* TypeScript types. Types flow one way: Schema → TS.

### Anti-goals (would be a failure even if it technically works)

- An expression that type-checks and shows no editor error but fails in the engine
  because it referenced something outside its scope. The boundary must be enforced in
  the editor **and** in `build()` by the same analysis.
- A second, DSL-only naming or semantics layer that drifts from the engine. The DSL is
  a typed front for §13, not a different language.
- A required manual "regenerate types" step during editing.

## 2. Prerequisite: snake_case across the document format

The §13 document has four camelCase keys: `split.itemType`, `call.output.resultType`,
`call.output.errorType`, and (in the persistence design) `receive.payloadType`. Rename to
`item_type`, `result_type`, `error_type`, `payload_type` in:

- `docs/aflow-workflow-spec.md` (§6.3, §16, §19 E1 and any other occurrence),
- `docs/aflow-api.openapi.yaml`,
- `src/types.ts`, `src/engine.ts`, tests and fixtures,
- `docs/superpowers/specs/2026-10-07-persistence-receive-protocols-design.md`.

**Call (mine):** hard rename, no accepting the old spelling. The engine is `0.1.0`,
private, with no deployed workflows. Land this as its own commit before DSL work.

## 3. Expressions: parameters are the only way in

Every pure callback the DSL accepts — `condition`, `await`/`aggregate` `select`/`until`/
`reduce`, `split` `selector`/`item_type`/`route`, `dispatch` `select`/`route`,
`enrich`, `target_state_setter`, `route` (expr and `switch`), `return` `result`/`error`,
`call` `input`/`request.*`/`output.transform`/`output.enrich`, the default error handler
— is an arrow function whose **single parameter is an object destructuring pattern**
naming members of the engine's expression scope:

```ts
t.target_state(({ items }) =>
  items.some(i => i.target_state === "failure" && !i.optional) ? "failure" : "success");

t.enrich(({ objects, result }) => { objects.save_status = result.status; });   // $do
```

### 3.1 The scope

The available names are exactly what `Engine.scope()` / `prospectiveScope()` in
`src/engine.ts` put in scope, typed for the node's item type:

- always: `id`, `type`, `data`, `objects`, `tasks`, `trajectory`, `items`, `parent`,
  `root`, `next_task`, `target_state`, `logging_context`, `additional_properties`,
  `optional`, `parameters`, `ctx`, `self` (the item view; the engine binds `this` to the
  same object);
- per position, only where the engine provides them: `set` (gate `until`, `reduce`),
  `result` / `input` (call `output.transform` / `output.enrich`), `task_state` / `error`
  / `result` (`target_state_setter`), `error` / `task_state` (default error handler),
  `index` and the prospective-child shape (E1 per-child `item_type`).

A callback's parameter type only contains the names valid at its position, so `set` does
not complete in a `condition`. The builder derives the per-position table from
`engine.ts`, and it becomes a table in the rewritten §15.

Typing: `data`/`objects` from the item type's schema refs (§4); `parent` from the item
declaration's `parent`; `root` from the root item type; `set` from what `select` returns;
`result` from `call.output.result_type` when given, else `unknown`; `parameters` from
`config.parameters`.

### 3.2 What is allowed inside

- Identifiers: the destructured parameters, locals declared inside the arrow, and the
  engine's `SAFE_GLOBALS` (`src/expr.ts`: `Math` without `random`, `JSON`, `Array`,
  `Object`, …).
- `$do` callbacks (block bodies) may assign to members (`objects.x = …`) and rebind
  `data`, `target_state`, `next_task` — the names `Engine.writeBack()` copies back.
- **Rejected**, with a message naming the rule and §5: any other free identifier (module
  constants, imports, helper functions, outer locals); names in the engine's `FORBIDDEN`
  map (with the engine's reason text); `this`; `async`/`await`; `import()`; renamed,
  defaulted, nested or rest destructuring (`{ data: d }`, `{ data = {} }`), or a
  non-destructured parameter — because the body is emitted with the parameter names as
  the engine's bare identifiers.

### 3.3 Effect code

`call.js` scripts are effect-side (§9): they may be `async` and receive `(input, lib)`.
They obey the same "no outside names" rule, because they are shipped as source too; only
the determinism restrictions are lifted. **Call (mine).**

### 3.4 Emission

`build()` emits each arrow's **body** — types stripped, otherwise unchanged — as the
`$expr` string (expression body) or `$do` string (block body). Nothing is renamed. The
DSL output must not depend on how the user's toolchain transpiles: build obtains the
expression text from the TypeScript source, not from `Function.prototype.toString()` of
a down-levelled or bundled function.

### 3.5 One analysis, two consumers

The boundary check (§3.2) and the graph checks (§5) live in one module that both the
editor plugin and `build()` call. A workflow that shows no errors in the editor builds;
one that builds showed no errors. This is the guard against the main anti-goal.

## 4. Types from JSON Schema

- Types live in ordinary JSON Schema files the user owns (possibly shared with other
  services). Schemas are named by `$id`/file + JSON pointer; the workflow references the
  ones it uses, e.g. (syntax for the builder to finalise):

  ```ts
  const schemas = wf.types("./schemas/travelco.json");
  const Input = wf.item("input", { data: schemas.ref("BookingRequest"), objects: …, parent: null });
  ```

- **Codegen** turns referenced schema files into `.d.ts` so the TS server can type
  `data` etc. (§10's "TS DSL projection"). A CLI command regenerates (for CI and `tsc`);
  the editor plugin regenerates automatically when a referenced schema file changes, so
  there is no manual step while editing. **Call (mine):** generated files on disk rather
  than virtual files injected into the language service — they also work for plain
  `tsc`/CI. Location and naming of generated files are the builder's call (gitignored).
- **`build()` includes types.** It copies every referenced schema, plus everything
  reachable through its `$ref`s, into the output's `definitions`, rewriting `$ref`s to
  `#/definitions/…`, and emits `definitions.input`/`definitions.result` and `items`
  declarations as §10 shows. Unreferenced schemas are not copied. The JSON stays
  self-contained; the engine never reads schema files.
- **`definitions` keys** are `<namespace>.<Name>`. The namespace is declared per schema
  file when it is referenced (default: the file's basename without extension), so the
  booking schemas under namespace `travelco` keep the fixture's `travelco.BookingRequest`
  keys. Two included schemas resolving to the same key is a build error. **Call (mine).**
- `call.output.result_type` / `error_type` name a `definitions` key and are part of the
  included closure. The engine ignores them today (annotation only); the fixture's bare
  `"HotelRecord"` becomes `"travelco.HotelRecord"`. **Call (mine).**
- **Supported schema input:** draft-07 (`definitions`) and 2020-12 (`$defs`); `$ref` as
  in-file pointers and relative file paths (with optional pointer). `$id`-URI resolution
  limited to files already referenced; no remote `http(s)` refs — build is offline.
  **Call (mine).**
- The DSL tooling may take npm dependencies (e.g. a JSON-Schema-to-TS generator, the
  `typescript` package). Only `@aflow/engine` keeps the zero-runtime-dependency rule.
  **Call (mine).**

## 5. Graph checks (editor + build)

Reported as TS diagnostics in the editor and as build errors:

| Check | Severity |
|---|---|
| route / `split.route` / `dispatch.route` / `next_task` case targets an unknown task | error |
| more than one body kind on a node (the §16 matrix, from `BODY_KINDS`) | error |
| a route sends an item to a task bound to a different item type (split children: the child type; others: the same item) | error |
| a task no route, split, dispatch or `entry` can reach | warning |
| §3.2 expression-boundary violations | error |
| `target_state` literal not in `allowed_target_states` when that list is declared | error |

Route targets computed by an expression are checked when the expression's result type is
a string-literal union; otherwise not (no false errors). Where TypeScript's own types can
express a check (e.g. task-name completion via literal types), prefer that; the plugin
covers what types cannot (forward references to tasks declared later or in another file
of the workflow, whole-graph reachability). Name completion for route targets must offer
every task of the workflow, wherever it is declared.

## 6. Editor plugin

- A **TypeScript language service plugin**, enabled through `compilerOptions.plugins` in
  the workflow project's `tsconfig.json`. It runs inside `ts_ls`/`vtsls`, so nvim needs no
  new server — only the plugin resolvable from the workspace `node_modules`. **Call
  (mine).**
- Adds: §5 diagnostics, route/item-type name completions, hover text on DSL methods
  (spec section + the normative sentence), schema-change-triggered type regeneration.
- The README gets an nvim section: tsconfig snippet, and the `ts_ls`/`vtsls` settings
  needed for the plugin to load from the workspace.

## 7. DSL API

The builder designs the API from §15's sketch, under these constraints:

- every §13/§16 field and every engine body kind and extension (E1–E5) is expressible;
  bodies that land later (e.g. `receive`, `call.adapter` from the persistence design)
  follow the same pattern without breaking existing DSL code;
- snake_case for every name that corresponds to a document field;
- expressions per §3; types per §4;
- `build()` returns a `WorkflowDefinition` (`src/types.ts`) — the DSL depends on the
  engine's document types, not on a copy;
- `build()` keeps, in memory and exposed through its API, the source location
  (file:line:col) of each task and each expression. Not emitted into the JSON — project 2
  decides the source-map format, project 3 consumes it. **Call (mine).**

Names (approved): packages `@aflow/dsl` (DSL + `build()` + codegen) and
`@aflow/ts-plugin` (editor plugin); CLI `aflow` with `aflow types` (codegen) and
`aflow build <file>` (emit JSON).

Whole-graph checks (§5) span every file of the workflow, reached from the entry file's
imports; diagnostics are reported in the file where the offending task is declared.

## 8. Repository layout

**Call (mine):** npm workspaces. The engine stays at the repo root (`src/`) to avoid churn
in references to it; the new packages go under `packages/dsl` and `packages/ts-plugin`.
The builder may instead move the engine to `packages/engine` if workspace tooling makes
the root package awkward; if so, update `CLAUDE.md` and the README.

## 9. Spec and document changes (spec first)

- §15 rewritten: snake_case, the §3 expression rule and per-position scope table, §4
  type inclusion, the editor behaviours as conformance requirements of artifact 2.
- §10: the "TS DSL projection" paragraph updated to the Schema-files → codegen → include
  flow.
- §1 artifact 2: mentions the editor plugin as part of the DSL artifact.
- §2 renames in spec / OpenAPI / persistence design.
- `CLAUDE.md`: "Not yet built" and "Working with the engine" updated for the new
  packages and commands.

## 10. Testing

- **Booking workflow in the DSL** (`test/fixtures/booking-workflow.dsl.ts` or similar),
  with its types in JSON Schema files. `build()` output deep-equals the (renamed) JSON
  fixture, comparing `$expr`/`$do` strings after whitespace normalisation (the fixture's
  hand-indented template literals are not reproduced; a block body's outer `{ }` is not
  part of the emitted `$do`). The fixture stays hand-written — it is not regenerated from
  the DSL — so the comparison remains an independent check. `booking.test.ts` passes when
  fed the DSL-built definition. **Call (mine).**
- **Plugin tests** drive an in-process TypeScript language service with the plugin
  applied and assert, at given positions: completions (fields, task names incl. forward
  references, item types), diagnostics (each §5 row, each §3.2 rejection class), hover
  text, and no diagnostics on the valid booking workflow.
- **Build/editor agreement:** every invalid fixture used in plugin tests also fails
  `build()` with the same rule.
- Codegen: a schema change produces updated `.d.ts`; `$ref` closure and collision
  detection in `build()`.
- vitest stays at 2 threads.

## 11. Left to the builder

The DSL method names and shapes (within §7), how build gets expression source and
locations from TypeScript (a TS-compiler-based loader or transformer is the expected
route), the codegen library, the generated-file location, the plugin's internal
structure, and whether some checks are done in types vs. the plugin.
