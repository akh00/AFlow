/**
 * Type-level tests for the `@aflow/dsl` surface (§15.2–§15.5). Checked by
 * `npm run typecheck`, never run: every failing line is preceded by
 * `// @ts-expect-error`, so an error that disappears fails the typecheck too.
 *
 * The `SchemaRegistry` augmentation below stands in for a generated
 * `.aflow/types` file (§15.7). It is global to the program it is compiled in.
 */

import { workflow } from "@aflow/dsl";

declare module "@aflow/dsl" {
  interface SchemaRegistry {
    "t.Req": { order_id: string; order_lines: { amount: number; kind: "a" | "b" }[] };
    "t.Res": { ok: boolean };
    "t.OrderObjects": { total?: number; all_done?: boolean };
    "t.Line": { amount: number; kind: "a" | "b" };
    "t.LineObjects": { phase?: "held" | "settled"; hold_id?: string };
    "t.Hold": { hold_id: string };
  }
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<T extends true>(): T | void {}

const wf = workflow({
  client_id: "t",
  name: "typetest",
  input: "t.Req",
  result: "t.Res",
  items: {
    order: { data: "input", objects: "t.OrderObjects", parent: null },
    line: { data: "t.Line", objects: "t.LineObjects", parent: "order" },
  },
  config: {
    parameters: { limit: 10 },
    defaults: {
      item: {
        default_target_state_setter: ({ task_state }) =>
          task_state.status === "error" ? "failure" : undefined,
      },
      task: {
        route: ({ next_task }) => next_task,
        default_error_handler: {
          $do: ({ error, objects }) => {
            objects.last_error = error.message;
          },
        },
      },
    },
  },
});

// A header item whose parent names no declared item type.
workflow({
  client_id: "t",
  name: "bad_parent",
  input: "t.Req",
  result: "t.Res",
  items: {
    order: { data: "input", parent: null },
    // @ts-expect-error — `nope` is not a declared item type
    line: { data: "t.Line", parent: "nope" },
  },
});

// A header naming a key that is not in `definitions`.
workflow({
  client_id: "t",
  name: "bad_key",
  // @ts-expect-error — not a schema key
  input: "t.Nope",
  result: "t.Res",
  items: { order: { data: "input", parent: null } },
});

export const order_tasks = wf.tasks({
  Input: {
    item: "order",
    enrich: ({ objects, data }) => {
      objects.total = data.order_lines.reduce((sum, l) => sum + l.amount, 0);
    },
    route: "read_lines",
  },

  read_lines: {
    item: "order",
    // `data` is the root's input type.
    condition: ({ data }) => data.order_lines,
    route: "bad_field",
  },

  bad_field: {
    item: "order",
    // @ts-expect-error — `nope` is not a field of t.Req
    condition: ({ data }) => data.nope,
  },

  set_not_in_condition: {
    item: "order",
    // @ts-expect-error — `set` is not in scope in a `condition` (§15.5)
    condition: ({ set }) => set.length > 0,
  },

  no_scope_names: {
    item: "order",
    condition: ({}) => true,
    target_state_setter: ({}) => "success",
  },

  split_lines: {
    item: "order",
    split: {
      item_type: "line",
      selector: ({ data }) => data.order_lines,
      // Bound to the produced child: `data` is the line's.
      route: ({ data }) => (data.kind === "a" ? "hold_line" : null),
      parallel: true,
    },
    route: "await_lines",
  },

  split_per_child: {
    item: "order",
    split: {
      // §19 E1: `data` is the selector element; `index` a number.
      item_type: ({ data, index }) => (data.kind === "a" && index >= 0 ? "line" : "line"),
      selector: ({ data }) => data.order_lines,
      route: ({ type }) => (type === "line" ? "hold_line" : null),
    },
  },

  item_type_without_self: {
    item: "order",
    split: {
      // @ts-expect-error — `self` is not in scope in `split.item_type` (§15.5)
      item_type: ({ self }) => self.type,
      selector: ({ data }) => data.order_lines,
    },
  },

  await_lines: {
    item: "order",
    aggregate: {
      select: ({ items }) => items,
      until: ({ set }) => set.every((i) => i.objects.phase === "held"),
      reduce: ({ objects, set }) => {
        objects.all_done = set.every((i) => i.target_state === "success");
      },
    },
    target_state_setter: ({ objects }) => (objects.all_done ? "success" : "failure"),
    route: { cases: { success: "settle", failure: "settle" } },
  },

  settle: {
    item: "order",
    dispatch: {
      select: ({ items }) => items,
      // Bound to the dispatched item.
      route: ({ root, objects }) =>
        root.objects.all_done && objects.hold_id !== undefined ? "commit_line" : null,
    },
    route: "done",
  },

  await_by_ctx: {
    item: "order",
    await: { select: ({ ctx }) => ctx.byType("line"), until: ({ set }) => set.length > 0 },
    route: "done",
  },

  done: {
    item: "order",
    return: { result: ({ objects }) => ({ ok: objects.all_done === true }) },
  },

  // @ts-expect-error — `nope` is not a declared item type
  wrong_item: { item: "nope" },

  // @ts-expect-error — at most one body kind per node (§6, §16)
  two_bodies: {
    item: "order",
    enrich: ({ objects }) => {
      objects.total = 0;
    },
    split: { item_type: "line", selector: ({ data }) => data.order_lines },
  },
});

export const line_tasks = wf.tasks({
  hold_line: {
    item: "line",
    timeout: 5000,
    retry: { inline: { max_count: 1, interval: "5ms" } },
    call: {
      provider: "js",
      implementation: { bundle_name: "b", bundle_version: "1.0.0" },
      input: ({ data, root }) => ({ amount: data.amount, order_id: root.data.order_id }),
      script: async (input, lib) => await lib.hold(input),
      output: {
        result_type: "t.Hold",
        // `result` is typed from `result_type` (§15.4).
        transform: ({ result }) => (result.hold_id === "" ? { error: { code: 503 } } : result),
        enrich: ({ objects, result }) => {
          objects.hold_id = result.hold_id;
        },
      },
    },
    target_state_setter: ({ task_state }) => (task_state.status === "success" ? "success" : "failure"),
    route: "commit_line",
  },

  wrong_result_field: {
    item: "line",
    call: {
      provider: "http",
      request: { method: "GET", url: ({ parameters }) => `https://x/${parameters.limit}` },
      output: {
        result_type: "t.Hold",
        enrich: ({ objects, result }) => {
          // @ts-expect-error — `nope` is not a field of t.Hold
          objects.hold_id = result.nope;
        },
      },
    },
  },

  output_without_result_type: {
    item: "line",
    call: {
      provider: "http",
      // @ts-expect-error — the DSL requires `call.output.result_type` (§15.4)
      output: { error_type: "t.Res" },
    },
  },

  commit_line: {
    item: "line",
    enrich: ({ objects }) => {
      objects.phase = "settled";
    },
    route: null,
  },
});

// Item-tree typing.
wf.tasks({
  tree: {
    item: "order",
    condition: ({ items, parent, root }) => {
      assertType<Equal<(typeof items)[0]["type"], "line">>();
      assertType<Equal<typeof parent, null>>();
      assertType<Equal<(typeof root)["type"], "order">>();
      return true;
    },
  },
  leaf: {
    item: "line",
    condition: ({ parent, items }) => {
      assertType<Equal<(typeof parent)["type"], "order">>();
      assertType<Equal<typeof items, readonly never[]>>();
      return parent.data.order_lines.length > 0;
    },
  },
});

export default wf.assemble(order_tasks, line_tasks);

// A group of another workflow cannot be assembled into this one.
const other = workflow({
  client_id: "t",
  name: "other",
  input: "t.Req",
  result: "t.Res",
  items: { order: { data: "input", parent: null } },
});
const other_tasks = other.tasks({ Input: { item: "order", route: null } });
// @ts-expect-error — `other_tasks` belongs to another workflow
wf.assemble(order_tasks, other_tasks);
