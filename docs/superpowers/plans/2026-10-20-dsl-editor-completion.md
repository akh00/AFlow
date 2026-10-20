# Typed DSL with Editor Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author AFlow workflows in a typed TypeScript DSL with completion, diagnostics and hover in nvim (`ts_ls`/`vtsls`), and build them into §13 JSON the existing engine runs.

**Architecture:** The DSL is **types only at authoring time**: DSL files are never executed. One static analyzer (TypeScript compiler API, `ts` module injected) reads the workflow's source and produces the §13 document, source locations and diagnostics. `aflow build` and the tsserver plugin both call that analyzer, which is how "no editor errors ⇔ builds" holds. Types come from JSON Schema files plus inline schemas, via a codegen step that writes a `SchemaRegistry` module augmentation.

**Tech Stack:** TypeScript 5.7 compiler API, npm workspaces, vitest 4 (2 threads), esbuild (bundling the CLI and the plugin only). No JSON-Schema-to-TS dependency: the codegen is in-house so it shares one `$ref` resolver with build.

**Spec:** `docs/superpowers/specs/2026-10-20-dsl-editor-completion-design.md` (plus `docs/aflow-workflow-spec.md` §5, §10, §13, §15, §16).

## Global Constraints

- snake_case for every name that corresponds to a §13 document field. No camelCase anywhere in the DSL surface or the document.
- Names: packages `@aflow/dsl` and `@aflow/ts-plugin`; CLI `aflow` with `aflow types` and `aflow build <file>`.
- `@aflow/engine` (repo root, `src/`) keeps zero runtime dependencies. New packages may take dependencies.
- The DSL is static and multi-file: task names, item-type names and route literals are literals; tasks are declared only in top-level `wf.tasks({...})` groups. Anything non-static at a position the analyzer reads is an error.
- Expression callbacks take exactly one object-destructuring parameter naming engine scope members. There are no renames, defaults, nesting or rest, and no free identifiers except params, inner locals and the engine's safe globals.
- Build is offline: `$ref`s may be in-file pointers or relative file paths. Draft-07 `definitions` and 2020-12 `$defs` are both supported.
- `definitions` keys are `<namespace>.<Name>`. File schemas get their namespace from the header's `schemas` map; inline schemas use `client_id`.
- vitest stays at `maxThreads: 2`. Never run builds with more than 2 processes.
- Spec first: §15/§10/§1 text lands before DSL code (Task 2).
- Validate YAML with `yq`, JSON with `jq`; never with Python.

## Review Focus

1. **String/template literals and comments inside an expression** that contain `=>`, `{`, `}` or `this` must be emitted unchanged and never flagged. Test in Task 6 and Task 7.
2. **Shadowing and nested lambdas:** a module-level `const items = …` must not taint an expression that destructures `items`; `set.every(i => i.x)` uses inner local `i`. Both are allowed. Test in Task 7.
3. **Property and key names that equal forbidden globals** (`objects.Date`, `{ fetch: 1 }`, `i.process`) are not references and must not be flagged. Test in Task 7.
4. **Recursive schemas** (a tree node referencing itself, or two files referencing each other) must not loop in the `$ref` closure or in codegen. Test in Task 4 and Task 5.
5. **Half-typed source in the editor** (syntax errors, an unfinished `wf.tasks({` literal) must never throw out of the plugin. It returns the base language-service results plus whatever analysis succeeded. Test in Task 10.

---

## File map

```
src/expr.ts                              modify: export SAFE_GLOBAL_NAMES, FORBIDDEN_REASONS
src/index.ts                             modify: re-export them
src/types.ts, src/engine.ts, test/**     modify: snake_case rename (Task 1)
package.json                             modify: workspaces, esbuild devDep, scripts
tsconfig.json                            modify: paths @aflow/engine, include packages
vitest.config.ts                         modify: include packages tests, alias, globalSetup
packages/dsl/
  package.json, README.md
  src/index.ts                           public DSL surface (workflow(), types)
  src/surface/header.ts                  WorkflowHeader, SchemaRegistry, SchemaKey, item typing
  src/surface/scope.ts                   per-position expression scope types
  src/surface/node.ts                    NodeSpec union, body kinds, Route, JSDoc w/ § refs
  src/schema/load.ts                     load files, resolve $ref, closure, key naming
  src/schema/codegen.ts                  JSON Schema → registry .d.ts
  src/analyzer/index.ts                  analyzeProgram()
  src/analyzer/literal.ts                static literal evaluation
  src/analyzer/extract.ts                header / groups / assemble → document + locations
  src/analyzer/emit.ts                   arrow → $expr/$do text
  src/analyzer/boundary.ts               §3.2 expression-boundary checks
  src/analyzer/graph.ts                  §5 graph checks
  src/analyzer/diagnostics.ts            AflowDiagnostic, RuleId, codes
  src/build.ts                           buildWorkflow(), generateTypes()
  src/cli.ts                             `aflow` entry
  test/…                                 per-module tests + fixtures/
packages/ts-plugin/
  package.json
  src/index.ts                           tsserver plugin
  test/plugin.test.ts
```

---

### Task 1: snake_case rename across the document format

**Files:**
- Modify: `docs/aflow-workflow-spec.md` (§6.3, §16, §19 E1, every `itemType`), `docs/aflow-api.openapi.yaml`, `docs/superpowers/specs/2026-10-07-persistence-receive-protocols-design.md` (`payloadType`)
- Modify: `src/types.ts`, `src/engine.ts`, `test/engine.test.ts`, `test/fixtures/booking-workflow.ts`
- Test: `test/engine.test.ts`

**Interfaces:**
- Produces: `SplitBody.item_type`, `CallOutput.result_type`, `CallOutput.error_type` in `src/types.ts`. The fixture's `resultType: "HotelRecord"` becomes `result_type: "travelco.HotelRecord"`, and `travelco.HotelRecord: { type: "object" }` is added to its `definitions`.

- [ ] **Step 1: Write the failing test** in `test/engine.test.ts`: `it("rejects the pre-rename spelling split.itemType")` expects `validateDefinition` on a definition with a split using `itemType` and no `item_type` to throw `WorkflowDefinitionError` matching `/item_type/`. Rename all other test usages to `item_type`.
- [ ] **Step 2: Run** `npx vitest run test/engine.test.ts`. Expected: FAIL (the new test, plus type errors on renamed fields).
- [ ] **Step 3: Rename in `src/types.ts` and `src/engine.ts`.** Have `validateDefinition` reject a `split` lacking `item_type` with a message naming `item_type`. Rename in the docs and the fixture. Run `grep -rn 'itemType\|resultType\|errorType\|payloadType' src test docs`; expected: no hits except the new rejection test.
- [ ] **Step 4: Verify** with `npm test && npm run typecheck && yq . docs/aflow-api.openapi.yaml > /dev/null`. Expected: all pass.
- [ ] **Step 5: Commit** with `refactor!: snake_case item_type/result_type/error_type/payload_type`.

### Task 2: Spec text for the DSL (spec first)

**Files:**
- Modify: `docs/aflow-workflow-spec.md` §1 (artifact 2), §10 ("TS DSL projection"), §15 (rewrite), TOC if headings change
- Modify: `CLAUDE.md` ("Not yet built", "Working with the engine": packages, `aflow` commands)

- [ ] **Step 1: Rewrite §15.** It must state, normatively (MUST/SHOULD, `§n` cross-refs, `jsonc`/`typescript` fences):
  - the header / `wf.tasks` / `wf.assemble` shape from Task 3;
  - the static, multi-file rule;
  - the one-destructured-parameter expression rule;
  - the **per-position scope table** (rows below);
  - that `call.js` `script` is effect code under the same no-outside-names rule;
  - emission (`$expr` for expression bodies, `$do` for block bodies without the outer braces; `script` emitted as full arrow text);
  - the five editor behaviours as conformance requirements of artifact 2;
  - the booking workflow as the worked example, snake_case.

  Per-position scope (base = `id type data objects tasks trajectory items parent root next_task target_state logging_context additional_properties optional parameters ctx self`, from `Engine.scope()`):

  | Position | Scope |
  |---|---|
  | `condition`, `await.select`, `aggregate.select`, `split.selector`, `split.route` (expr), `dispatch.select`, `route` expr/`switch`, `return.result`/`error`, `call.input`, `call.request.*` | base |
  | `await.until`, `aggregate.until`, `aggregate.reduce` | base + `set` |
  | `call.output.transform`, `call.output.enrich` | base + `result`, `input` |
  | `target_state_setter`, `config.defaults.item.default_target_state_setter` | base + `task_state`, `error`, `result` |
  | `config.defaults.task.default_error_handler` | base + `error`, `task_state` |
  | `split.item_type` (expr) | `data index objects tasks items parent root parameters ctx` (`prospectiveScope`) |
  | `dispatch.route` (expr) | base, bound to the dispatched item |

- [ ] **Step 2: Update §10 and §1.** §10 describes schema files plus inline schemas, then codegen into the `SchemaRegistry` augmentation, then build including the closure under `<namespace>.<Name>` keys. §1 artifact 2 names `@aflow/dsl` + `@aflow/ts-plugin`.
- [ ] **Step 3: Check cross-refs.** Every new `§n` resolves to an existing heading, and the TOC matches the headings (`grep -n '^## ' docs/aflow-workflow-spec.md`).
- [ ] **Step 4: Commit** with `docs(spec): §15 typed DSL — static, snake_case, destructured-scope expressions`.

### Task 3: Workspace scaffold and DSL surface types

**Files:**
- Modify: `package.json` (`"workspaces": ["packages/*"]`, devDep `esbuild`, script `"typecheck": "tsc -p tsconfig.json --noEmit"` unchanged, `"pretypecheck"` added in Task 9), `tsconfig.json` (`"paths": { "@aflow/engine": ["./src/index.ts"] }`, include `packages/*/src/**/*.ts`, `packages/*/test/**/*.ts`, `**/.aflow/types/*.d.ts`), `vitest.config.ts` (include `packages/*/test/**/*.test.ts`, `resolve.alias` `@aflow/engine` → `src/index.ts`), `.gitignore` (`.aflow/`)
- Modify: `src/expr.ts`, `src/index.ts`
- Create: `packages/dsl/package.json`, `packages/dsl/src/index.ts`, `packages/dsl/src/surface/{header,scope,node}.ts`
- Test: `packages/dsl/test/surface.typetest.ts` (type-only, checked by `npm run typecheck`), `test/expr.test.ts` (append)

**Interfaces:**
- Produces (engine): `export const SAFE_GLOBAL_NAMES: readonly string[]` and `export const FORBIDDEN_REASONS: ReadonlyMap<string, string>`. The existing `SAFE_GLOBALS` / `FORBIDDEN` in `src/expr.ts` derive from or are these, so the lists can't drift.
- Produces (`@aflow/dsl`, exported from `src/index.ts`):
  - `interface SchemaRegistry {}`, augmented by generated files.
  - `type SchemaKey = [keyof SchemaRegistry] extends [never] ? string : Extract<keyof SchemaRegistry, string>`
  - `interface WorkflowHeader { client_id: string; name: string; version?: string; schemas?: Record<string, string>; types?: Record<string, JsonSchema>; input: SchemaKey; result: SchemaKey; items: Record<string, { data?: SchemaKey | "input"; objects?: SchemaKey; parent: string | null }>; config?: ConfigSpec<…> }` (`ConfigSpec` mirrors engine `WorkflowConfig`, with its expression positions as arrows). `schemas` maps namespace to a path relative to the header file.
  - `function workflow<const H extends WorkflowHeader>(header: H): Workflow<H>`
  - `interface Workflow<H> { tasks<const T extends Record<string, NodeSpec<H>>>(tasks: T): TaskGroup<H, T>; assemble(...groups: TaskGroup<H, any>[]): Assembled<H> }`
  - `type NodeSpec<H>`: a union over item names `I` of `{ item: I } & NodeFields<H, I>`. `NodeFields` mirrors engine `Node` minus `name`/`item`, with every `Expr` position typed as `(scope: ScopeAt<Position, H, I>) => R` and `$do` positions as `(scope) => void`. The bodies `enrich | split | aggregate | dispatch | call | return` are mutually exclusive: each variant sets the others to `?: never`.
  - Scope typing: `data` = `SchemaRegistry[key]` (`"input"` → `H["input"]`); `objects` defaults to `Record<string, unknown>`; `items` = union of views of item types whose `parent === I`, discriminated by `type`; `parent` = view of `H["items"][I]["parent"]` or `null`; `root` = view of the item with `parent: null`; `parameters` = `H["config"]["parameters"]`; `ctx` = engine `CtxView`; `task_state` = engine `TaskRecord`; `error` = engine `WorkflowError | null`.
  - Every node field and body kind carries JSDoc citing its spec section and normative sentence. Hover comes from tsserver natively; e.g. `aggregate`: "§7 — `until` MUST be monotonic; `reduce` MUST be commutative and associative."
  - Runtime: `workflow()`, `.tasks()` and `.assemble()` return their argument unchanged (inert; DSL files are analysed, not run).

- [ ] **Step 1: Write the failing engine test** `it("exports the name lists the proxy enforces")`. For every name in `FORBIDDEN_REASONS`, `evalExpr(name, {})` throws `DeterminismViolation`. For every name in `SAFE_GLOBAL_NAMES`, `evalExpr(\`typeof ${name}\`, {})` is not `"undefined"`, except `undefined`, where it is.
- [ ] **Step 2: Run** `npx vitest run test/expr.test.ts`. Expected: FAIL (exports missing).
- [ ] **Step 3: Add the exports** in `src/expr.ts` / `src/index.ts`.
- [ ] **Step 4: Write `surface.typetest.ts`.** It uses a hand-written `declare module "@aflow/dsl" { interface SchemaRegistry { "t.Req": { order_lines: { amount: number }[] }; … } }` and a two-item header (`order` root, `line` child). Cases (each failing line preceded by `// @ts-expect-error`):
  - `({ data }) => data.order_lines` compiles on `item: "order"`;
  - `data.nope` errors;
  - `({ set }) => …` errors in `condition` and compiles in `aggregate.until`;
  - a node with both `enrich` and `split` errors;
  - `item: "nope"` errors;
  - `items[0].type` is `"line"`;
  - `parent` on `order` is `null`.
- [ ] **Step 5: Implement `packages/dsl/src/surface/*` and `index.ts`.** Run `npm install` (creates the workspace links), then `npm run typecheck`. Expected: PASS.
- [ ] **Step 6: Run** `npm test`. Expected: all pass.
- [ ] **Step 7: Commit** with `feat(dsl): workspace, @aflow/dsl surface types, engine name-list exports`.

### Task 4: Schema loading, `$ref` closure and key naming

**Files:**
- Create: `packages/dsl/src/schema/load.ts`
- Test: `packages/dsl/test/schema-load.test.ts`, fixtures under `packages/dsl/test/fixtures/schemas/`

**Interfaces:**
- Produces: `interface SchemaSource { namespace: string; file?: string /* absolute */; inline?: Record<string, JsonSchema> }`
- Produces: `function loadSchemas(sources: SchemaSource[]): SchemaSet` where `SchemaSet = { byKey: Map<string, JsonSchema /* $refs rewritten to #/definitions/<key> */>; errors: SchemaError[] }`. Each named schema becomes key `<namespace>.<Name>`. Names are the members of top-level `definitions` / `$defs`, plus the file's root schema under its `title` when it has one.
- Produces: `function closure(set: SchemaSet, roots: string[]): Record<string, JsonSchema>`, the transitive `$ref` closure in sorted key order.
- `SchemaError = { kind: "collision" | "unresolved-ref" | "remote-ref" | "unreadable"; message: string; file?: string }`

- [ ] **Step 1: Write the failing tests:**
  - draft-07 `definitions` and 2020-12 `$defs` both load;
  - `{"$ref": "#/definitions/PaymentInstrument"}` is rewritten to `#/definitions/travelco.PaymentInstrument`;
  - a relative `./common.json#/$defs/Money` with namespace `common` is rewritten to `#/definitions/common.Money`;
  - `closure(["travelco.BookingRequest"])` contains exactly `travelco.BookingRequest`, `travelco.PaymentInstrument`;
  - two sources yielding the same key give a `collision` error;
  - `https://…` gives a `remote-ref` error;
  - **recursive** `TreeNode → TreeNode` and a two-file cycle terminate, and each key appears once.
- [ ] **Step 2: Run** `npx vitest run packages/dsl/test/schema-load.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement `load.ts`.** A file referenced by relative `$ref` but absent from `sources` is an `unresolved-ref` error. Its namespace must come from the header.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(dsl): JSON Schema loading, $ref rewrite and closure`.

### Task 5: Codegen — registry `.d.ts`

**Files:**
- Create: `packages/dsl/src/schema/codegen.ts`
- Test: `packages/dsl/test/codegen.test.ts`

**Interfaces:**
- Consumes: `SchemaSet` (Task 4).
- Produces: `function generateRegistry(set: SchemaSet): string`. This is a `.d.ts` module: `export {}` followed by `declare module "@aflow/dsl" { interface SchemaRegistry { "<key>": <TS type>; … } }`. `$ref`s become `SchemaRegistry["<key>"]`, which makes recursion free.
- Mapping: `type` (incl. arrays of types), `properties` + `required` (optional `?` otherwise), `additionalProperties` (`false` → closed, schema → index signature, absent → `[k: string]: unknown`), `items`, `enum`, `const`, `oneOf`/`anyOf` → union, `allOf` → intersection, `nullable`-free. Anything else → `unknown`.

- [ ] **Step 1: Write the failing tests.** Generate for a fixture set, write it to a temp dir with a probe `.ts` file, then type-check with `ts.createProgram` and assert zero diagnostics. The probe asserts:
  - `SchemaRegistry["travelco.BookingRequest"]["order_id"]` is `string`;
  - the optional `currency` is `string | undefined`;
  - the enum `type` is `"card" | "invoice"`;
  - a recursive `TreeNode.children[0].children` type-checks.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Output is deterministic (sorted keys) so regeneration is idempotent.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(dsl): JSON Schema → SchemaRegistry codegen`.

### Task 6: Analyzer — static extraction and emission

**Files:**
- Create: `packages/dsl/src/analyzer/{index,literal,extract,emit,diagnostics}.ts`
- Test: `packages/dsl/test/extract.test.ts`, small fixtures in `packages/dsl/test/fixtures/mini/`

**Interfaces:**
- Produces (`diagnostics.ts`):
  - `type RuleId = "not-static" | "unknown-task" | "multiple-bodies" | "item-type-mismatch" | "unreachable" | "outside-reference" | "forbidden-global" | "this" | "async" | "dynamic-import" | "param-shape" | "target-state" | "unassembled-group" | "duplicate-task" | "schema"`
  - `interface AflowDiagnostic { rule: RuleId; severity: "error" | "warning"; message: string; file: string; start: number; length: number }`
  - `const RULE_CODES: Record<RuleId, number>`, codes `77001`…, in declaration order.
- Produces (`index.ts`): `function analyzeProgram(ts: typeof import("typescript"), program: Program): Analysis` with:
  - `Analysis = { workflows: WorkflowAnalysis[]; diagnostics: AflowDiagnostic[] }`
  - `WorkflowAnalysis = { headerFile: string; headerSymbol: string; entryFile: string | null; header: WorkflowHeader /* literal value */; definition: WorkflowDefinition /* definitions: input/result refs + items only; schema closure added by build */; locations: SourceLocations; taskNames: string[]; diagnostics: AflowDiagnostic[] }`
  - `SourceLocations = { tasks: Record<string, Loc>; expressions: Record<string /* JSON pointer, e.g. "/tasks/3/split/selector" */, Loc> }`, `Loc = { file: string; line: number; column: number }` (1-based)
  - `ts` is injected, never imported, because the plugin must use tsserver's instance.
- Produces (`emit.ts`): `function emitArrow(ts, arrow: ArrowFunction): { $expr: string } | { $do: string }` and `function emitScript(ts, arrow): string`.
- Recognition rules:
  - header = top-level `const X = workflow({…})` (callee resolves to `@aflow/dsl`'s `workflow`);
  - group = top-level `const G = X.tasks({…})`;
  - entry = a file whose `export default X.assemble(G1, G2, …)` lists group identifiers. They are resolved through the checker, so groups may live in other files.
  - `tasks` order = assemble argument order, then property order.
  - Header `items` / `input` / `result` become `definitions.input`/`result` `$ref`s and `items` declarations exactly as `test/fixtures/booking-workflow.ts` shapes them.
- `literal.ts`: `function evaluateLiteral(ts, node): { value: unknown } | { diagnostic }`. It accepts string, number, boolean and `null` literals; unary minus; object and array literals; no-substitution templates; `as const` / `satisfies` / parens. Anything else → `not-static`. An arrow function is legal only at a scope position from the Task 2 table, or as `call.script`.
- Emission:
  - type-erase with `ts.transpileModule` (target ESNext, comments kept) on a wrapped snippet, then unwrap;
  - expression body → `{ $expr }`;
  - block body → `{ $do }` with the outer braces and the common indentation removed;
  - the `$expr` / `$do` object form is always used, except for literal route strings.

- [ ] **Step 1: Write the failing tests** (via an in-memory `ts.createProgram` helper `programOf(files: Record<string, string>)` in `test/helpers.ts`):
  - a one-group mini workflow yields the expected `definition.tasks` (names, order, `item`, literal fields, `route`);
  - a two-file workflow (group in another file) yields the same tasks;
  - `({ data }) => data.order_lines` emits `{ $expr: "data.order_lines" }`;
  - `({ data }: S) => (data as any).x!` emits type-erased text;
  - a block body emits `$do` without braces;
  - `script: async (input, lib) => await lib.hold(input)` emits `"async (input, lib) => await lib.hold(input)"`;
  - `timeout: 2 * 1000` gives `not-static`;
  - task names computed by a variable give `not-static`;
  - **Review Focus 1:** `({ data }) => data.s === "a => {b}" ? 'this' : \`x\`` emits verbatim;
  - `locations.expressions["/tasks/0/split/selector"]` has the arrow's 1-based line/column.
- [ ] **Step 2: Run** `npx vitest run packages/dsl/test/extract.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(dsl): static analyzer — extraction, emission, locations`.

### Task 7: Analyzer — expression boundary (§3.2)

**Files:**
- Create: `packages/dsl/src/analyzer/boundary.ts` (called from `extract.ts` for every emitted arrow)
- Test: `packages/dsl/test/boundary.test.ts`

**Interfaces:**
- Consumes: `SAFE_GLOBAL_NAMES`, `FORBIDDEN_REASONS` from `@aflow/engine`; the scope table (Task 2) as `SCOPE_AT: Record<Position, readonly string[]>` in `boundary.ts`.
- Produces: `function checkBoundary(ts, checker, arrow, position: Position, kind: "pure" | "effect"): AflowDiagnostic[]`.
- Algorithm (not determined by the tests alone):
  - For every `Identifier` in the arrow that is a *reference*, resolve it with `checker.getSymbolAtLocation`. Skip property names in property access, object-literal keys, and declaration names.
  - The reference is allowed if its declaration lies inside the arrow (params, inner locals, nested lambda params).
  - Otherwise it is allowed if its name is in `SAFE_GLOBAL_NAMES` and it resolves to a lib declaration.
  - Otherwise, if the name is in `FORBIDDEN_REASONS`, report `forbidden-global` with the engine's reason and "(§5)".
  - Otherwise report `outside-reference`, naming the identifier and where it is declared.
  - `this` → `this`; `await`/`async` → `async` (pure only); `import(` → `dynamic-import`.
  - Report `param-shape` when the parameter is not exactly one object binding pattern of shorthand names drawn from `SCOPE_AT[position]`. Effect `script` is exempt from the shape rule and from `async`, but not from `outside-reference`.

- [ ] **Step 1: Write the failing tests:**
  - module `const MAX = 3` used inside → `outside-reference` mentioning `MAX`;
  - an imported helper → `outside-reference`;
  - `Date.now()` → `forbidden-global` with "reading the clock";
  - `Math.random()` → `forbidden-global`;
  - `Math.max(1,2)`, `JSON.stringify(data)` → none;
  - `this.data` → `this`;
  - an `async` pure arrow → `async`;
  - `({ data: d }) => d` and `({ data = {} }) => data` → `param-shape`;
  - `(s) => s.data` → `param-shape`;
  - `({ set }) =>` in `condition` → `param-shape` (name not in scope there);
  - **Review Focus 2:** module `const items = []` plus `({ items }) => items.length` → none, and `({ set }) => set.every(i => i.x)` → none;
  - **Review Focus 3:** `({ objects }) => objects.Date ?? { fetch: 1 }` → none;
  - **Review Focus 1:** `"Date.now()"` inside a string → none;
  - script `async (input, lib) => await lib.x(input)` → none, but the script referencing module `const URL_BASE` → `outside-reference`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(dsl): expression boundary analysis (§5, design §3.2)`.

### Task 8: Analyzer — graph checks (§5 of the design)

**Files:**
- Create: `packages/dsl/src/analyzer/graph.ts`
- Test: `packages/dsl/test/graph.test.ts`

**Interfaces:**
- Consumes: `WorkflowAnalysis.definition`, `.locations`, `BODY_KINDS` from `@aflow/engine`.
- Produces: `function checkGraph(ts, checker, wf: WorkflowAnalysis, routeExprTypes: Map<string /* pointer */, Type>): AflowDiagnostic[]`.
- Rules:
  - `unknown-task`: a literal route string, a `cases`/`default` value, a `split.route`, a `dispatch.route`, `config.defaults.entry`, or a string-literal-union member of a route expression's return type that names no task;
  - `multiple-bodies`: more than one `BODY_KINDS` member on a node (this backs up the type error with a readable message);
  - `item-type-mismatch`: a plain route targets a task whose `item` differs from the node's `item`. A `split.route` / `dispatch.route` targets a task whose `item` is not a child type of the node's item (for `split` with a literal `item_type`, it must equal it);
  - `unreachable` (warning): a task not reachable from `config.defaults.entry` (default `Input`, else first task) through any route, split, or dispatch target. A route expression without a literal-union type makes reachability unknown, so suppress `unreachable` for that workflow;
  - `target-state`: a literal returned by `target_state_setter` that is not in `allowed_target_states`, when that list is declared;
  - `duplicate-task`: the same name in two groups;
  - `unassembled-group` (warning, reported by `analyzeProgram`): a `X.tasks()` group that no `assemble` lists.

- [ ] **Step 1: Write the failing tests:** one passing and one failing mini workflow per rule. Also:
  - a route expression typed `"a" | "zz"` where `zz` doesn't exist → `unknown-task` at the expression;
  - a route expression typed `string` → no `unknown-task`, no `unreachable`;
  - the diagnostic for a task in `hotel.ts` is reported with `file` = `hotel.ts`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(dsl): graph checks — targets, bodies, item types, reachability`.

### Task 9: `buildWorkflow`, `aflow` CLI, booking workflow in the DSL

**Files:**
- Create: `packages/dsl/src/build.ts`, `packages/dsl/src/cli.ts`
- Create: `packages/dsl/test/fixtures/booking/{schemas/travelco.json,header.ts,order.ts,hotel.ts,flight.ts,book_travel_order.ts}`. The JSON file holds the message types; `OrderObjects`, `HotelLineData` etc. are inline in `header.ts` `types`. `book_travel_order.ts` is the entry.
- Create: `packages/dsl/test/global-setup.ts` (generates fixture registries via `generateTypes`), `packages/dsl/test/build.test.ts`
- Modify: `test/booking.test.ts` (run every scenario for both definitions), `vitest.config.ts` (`globalSetup`), `package.json` (`"pretypecheck": "npm run build -w @aflow/dsl && node packages/dsl/dist/cli.mjs types"`), `packages/dsl/package.json` (`"bin": { "aflow": "./dist/cli.mjs" }`, `"build": "esbuild src/cli.ts --bundle --platform=node --format=esm --outfile=dist/cli.mjs --external:typescript"`, dependency `typescript`)

**Interfaces:**
- Consumes: `analyzeProgram`, `loadSchemas`, `closure`, `generateRegistry`.
- Produces: `function buildWorkflow(entry: string, opts?: { tsconfig?: string }): BuildResult` where `BuildResult = { definition: WorkflowDefinition | null; diagnostics: AflowDiagnostic[]; locations: SourceLocations | null }`.
  - It builds a program rooted at `entry` with compiler options from the nearest `tsconfig.json`, analyses it, and picks the workflow whose `entryFile === entry`.
  - It merges `closure(…roots from input/result/items/result_type/error_type)` into `definitions`.
  - `definition` is `null` if any error diagnostic exists. Schema errors become `schema` diagnostics at the header.
- Produces: `function generateTypes(project: string /* tsconfig path */): { written: string[]; diagnostics: AflowDiagnostic[] }`. For each header in the project it writes `<header dir>/.aflow/types/<client_id>.<name>.d.ts`, and only when the content changed.
- CLI: `aflow types [--project <tsconfig>]` and `aflow build <entry> [-o <file>]` (JSON to stdout, 2-space indent). Diagnostics go to stderr as `file:line:col  severity  rule  message`. Exit code is 1 on any error.

- [ ] **Step 1: Write the failing tests** in `build.test.ts`:
  - `buildWorkflow(fixtures/booking/book_travel_order.ts).definition` deep-equals `bookingWorkflow` from `test/fixtures/booking-workflow.ts`, after mapping every `$expr`/`$do` string through `s.replace(/\s+/g, " ").trim()` on both sides;
  - diagnostics are empty;
  - the CLI (spawned on `dist/cli.mjs` after building it) exits 0 for the fixture and 1 for a fixture with an `unknown-task`, and stderr contains `unknown-task`.

  In `test/booking.test.ts`, wrap the existing describes in `describe.each([["json", bookingWorkflow], ["dsl", builtBooking]])`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement `build.ts`, `cli.ts`, and the fixture.** The fixture's `commit_or_rollback.dispatch.route` arrow carries the `DISPATCH_ROUTE` text inline, comments included.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Run** `node packages/dsl/dist/cli.mjs build packages/dsl/test/fixtures/booking/book_travel_order.ts | jq -e '.tasks | length'`. Expected: the fixture's task count.
- [ ] **Step 6: Commit** with `feat(dsl): buildWorkflow, aflow CLI, booking workflow in the DSL`.

### Task 10: `@aflow/ts-plugin`

**Files:**
- Create: `packages/ts-plugin/package.json` (`"main": "./dist/index.cjs"`, `"build": "esbuild src/index.ts --bundle --platform=node --format=cjs --outfile=dist/index.cjs --external:typescript"`, dependency `@aflow/dsl`), `packages/ts-plugin/src/index.ts`
- Test: `packages/ts-plugin/test/plugin.test.ts`
- Modify: `packages/dsl/README.md` (nvim section)

**Interfaces:**
- Consumes: `analyzeProgram`, `RULE_CODES`, `generateTypes`'s per-header writer (export `writeRegistryFor(ts, program, header): string | null` from `build.ts` for reuse).
- Produces: `export = function init(modules: { typescript: typeof ts }): ts.server.PluginModule`. Its `create(info)` returns a proxy of `info.languageService` that overrides:
  - `getSemanticDiagnostics(file)`: base diagnostics plus the analysis diagnostics for `file` (`category` from severity, `code` = `RULE_CODES[rule]`, `source: "aflow"`);
  - `getCompletionsAtPosition(file, pos, opts)`: inside a string literal at a route-target position or a header `items.*.parent`, it adds the workflow's task names (or item names) as `ts.ScriptElementKind.string` entries, merged with the base results.
- The analysis is cached per `Program` object (`WeakMap`). On a semantic-diagnostics request for a header file, or a file in its workflow, it calls `writeRegistryFor` when the header's schema files' mtimes changed. tsserver's file watcher then picks up the regenerated `.d.ts`.
- Every override is wrapped in `try { … } catch { return base }` with an `info.project.projectService.logger.info` line (Review Focus 5).

- [ ] **Step 1: Write the failing tests.** Use an in-memory `LanguageServiceHost` over fixture files, apply `init({ typescript: ts }).create({ languageService, languageServiceHost, project: fakeProject, config: {} })`, and assert:
  - completions inside `route: "|"` in `hotel.ts` include `mark_hotel_reserved` and `commit_hotel_booking` (declared in another group/file);
  - completions inside `parent: "|"` include `order`;
  - a misspelled route gives a diagnostic with code `RULE_CODES["unknown-task"]` at the string;
  - `Date.now()` in an expression gives `forbidden-global`;
  - the valid booking fixture has zero aflow diagnostics;
  - hover (`getQuickInfoAtPosition`) on `aggregate` contains "§7" and "monotonic". This comes from Task 3's JSDoc and confirms it reaches tsserver;
  - **Review Focus 5:** a header file with an unterminated `wf.tasks({` doesn't throw, and returns at least the base syntax diagnostics;
  - touching `schemas/travelco.json` (new property `loyalty_id`) then requesting diagnostics rewrites the `.d.ts`, and `data.loyalty_id` then completes.
- [ ] **Step 2: Run** `npx vitest run packages/ts-plugin`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build -w @aflow/ts-plugin`. Expected: PASS; `dist/index.cjs` exists.
- [ ] **Step 5: Write the README nvim section:**
  - `tsconfig.json` with `"compilerOptions": { "plugins": [{ "name": "@aflow/ts-plugin" }] }` and `include` covering `.aflow/types`;
  - `vtsls`: `settings.vtsls.autoUseWorkspaceTsdk = true`;
  - `ts_ls`: `init_options.plugins = { { name = "@aflow/ts-plugin", location = "<repo>/node_modules/@aflow/ts-plugin" } }`;
  - note that the plugin must be built (`npm run build -w @aflow/ts-plugin`).
- [ ] **Step 6: Manual smoke test** (report what you saw): open `packages/dsl/test/fixtures/booking/hotel.ts` in `nvim --headless` with vtsls, or with an LSP client script, and request completion in a `route` string.
- [ ] **Step 7: Commit** with `feat(ts-plugin): aflow diagnostics, route/item completions, schema regen in tsserver`.
