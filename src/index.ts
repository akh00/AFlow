/**
 * `@aflow/engine` — the AFlow workflow evaluation engine (spec §1 artifact 4).
 *
 *   const evaluation = await evaluate(definition, input, { bundles, includeTrace: true });
 *
 * `definition` is the canonical workflow JSON of §13; `input` is the root
 * item's `data`; the return value is the OpenAPI `Evaluation`.
 */

export { evaluate, Engine, validateDefinition } from "./engine.js";
export type { EvaluateOptions } from "./engine.js";

export {
  bundleRegistry,
  createHttpProvider,
  defaultProviders,
  EffectError,
  jsProvider,
  subWorkflowProvider,
  toWorkflowError,
} from "./providers.js";
export type {
  Bundle,
  BundleRegistry,
  EffectProvider,
  ProviderInvocation,
} from "./providers.js";

export { EvaluationContext, ItemView } from "./context.js";
export type { CtxView, ItemNode, ItemStatus } from "./context.js";

export {
  evalExpr,
  FORBIDDEN_REASONS,
  resetExprCache,
  runDo,
  SAFE_GLOBAL_NAMES,
} from "./expr.js";
export { parseDuration, resolveRetry } from "./retry.js";

export {
  AFlowError,
  DeadlockError,
  DeterminismViolation,
  ExpressionError,
  WorkflowDefinitionError,
} from "./runtime.js";
export type {
  Evaluation,
  EvaluationStatus,
  ItemSnapshot,
  Suspension,
  TaskRecord,
  TaskStatus,
  TrajectoryEntry,
  WorkflowError,
  WorkflowRef,
} from "./runtime.js";

export { BODY_KINDS } from "./types.js";
export type {
  BodyKind,
  CallBody,
  CallProvider,
  DispatchBody,
  Expr,
  Gate,
  ItemTypeDeclaration,
  Node,
  RetryConfig,
  RetryTier,
  Route,
  SplitBody,
  WorkflowConfig,
  WorkflowDefinition,
} from "./types.js";
