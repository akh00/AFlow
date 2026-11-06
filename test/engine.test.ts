import { describe, expect, it } from "vitest";

import {
  DeadlockError,
  DeterminismViolation,
  WorkflowDefinitionError,
  evaluate,
  validateDefinition,
} from "../src/index.js";
import type { Node, WorkflowDefinition } from "../src/types.js";

/** Minimal single-item-type workflow scaffold. */
function wf(tasks: WorkflowDefinition["tasks"], extra: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    client_id: "test",
    name: "t",
    version: "1",
    definitions: { input: {}, result: {} },
    items: { input: { parent: null }, child: { parent: "input" } },
    config: { defaults: { item: { target_state: "success", objects: {} } } },
    tasks,
    ...extra,
  };
}

describe("the determinism boundary (§5)", () => {
  it("refuses to read the clock from a pure expression", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        enrich: { $do: "objects.t = Date.now()" },
        route: null,
      },
    ]);
    await expect(evaluate(def, {})).rejects.toThrow(DeterminismViolation);
    await expect(evaluate(def, {})).rejects.toThrow(/reading the clock/);
  });

  it("refuses the RNG", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        enrich: { $do: "objects.r = Math.random()" },
        route: null,
      },
    ]);
    await expect(evaluate(def, {})).rejects.toThrow(/Math\.random/);
  });

  it("refuses I/O and module loading", async () => {
    for (const src of ["objects.x = fetch('http://x')", "objects.x = require('fs')"]) {
      await expect(
        evaluate(wf([{ name: "Input", item: "input", enrich: { $do: src }, route: null }]), {}),
      ).rejects.toThrow(DeterminismViolation);
    }
  });

  it("still allows the pure parts of Math and the collection helpers", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        enrich: {
          $do: `
            objects.max = Math.max(...data.values);
            objects.evens = data.values.filter(v => v % 2 === 0);
            objects.sum = data.values.reduce((a, b) => a + b, 0);
          `,
        },
        route: "out",
      },
      {
        name: "out",
        item: "input",
        return: { result: { $expr: "objects" } },
      },
    ]);
    const ev = await evaluate(def, { values: [3, 8, 5, 2] });
    expect(ev.result).toEqual({ max: 8, evens: [8, 2], sum: 18 });
  });

  it("rejects an unknown identifier instead of silently yielding undefined", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        enrich: { $do: "objects.x = totl" },
        route: null,
      },
    ]);
    await expect(evaluate(def, {})).rejects.toThrow(/totl is not defined/);
  });

  it("lets a $do use local variables", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        enrich: {
          $do: `
            let acc = 0;
            for (const v of data.values) acc += v;
            var doubled = acc * 2;
            objects.total = doubled;
          `,
        },
        route: "out",
      },
      { name: "out", item: "input", return: { result: { $expr: "objects.total" } } },
    ]);
    expect((await evaluate(def, { values: [1, 2, 3] })).result).toBe(12);
  });
});

describe("routing (§4 route phase)", () => {
  it("switches on target_state by default", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        target_state_setter: { $expr: "data.ok ? 'success' : 'failure'" },
        route: { cases: { success: "yes", failure: "no" } },
      },
      { name: "yes", item: "input", return: { result: { $expr: "'yes'" } } },
      { name: "no", item: "input", return: { result: { $expr: "'no'" } } },
    ]);
    expect((await evaluate(def, { ok: true })).result).toBe("yes");
    expect((await evaluate(def, { ok: false })).result).toBe("no");
  });

  it("switches on an explicit expression, with a default", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        route: {
          switch: { $expr: "data.kind" },
          cases: { a: "out_a" },
          default: "out_b",
        },
      },
      { name: "out_a", item: "input", return: { result: { $expr: "'a'" } } },
      { name: "out_b", item: "input", return: { result: { $expr: "'b'" } } },
    ]);
    expect((await evaluate(def, { kind: "a" })).result).toBe("a");
    expect((await evaluate(def, { kind: "zzz" })).result).toBe("b");
  });

  it("reports an unmatched case with no default", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        route: { switch: { $expr: "data.kind" }, cases: { a: "out_a" } },
      },
      { name: "out_a", item: "input", return: { result: { $expr: "'a'" } } },
    ]);
    await expect(evaluate(def, { kind: "q" })).rejects.toThrow(/no case for `q`/);
  });

  it("rejects a route to a node that does not exist", async () => {
    const def = wf([{ name: "Input", item: "input", route: "nowhere" }]);
    await expect(evaluate(def, {})).rejects.toThrow(/unknown node `nowhere`/);
  });
});

describe("split (§6.3)", () => {
  const splitDef = (parallel: boolean): WorkflowDefinition =>
    wf([
      {
        name: "Input",
        item: "input",
        split: {
          item_type: "child",
          selector: { $expr: "data.parts.map((p, n) => ({ name: p, order: n }))" },
          route: "work",
          parallel,
        },
        route: "join",
      },
      {
        name: "work",
        item: "child",
        call: {
          provider: "js",
          implementation: { bundle_name: "probe" },
          input: { $expr: "data" },
          script: "async (input, lib) => await lib.touch(input)",
          output: { enrich: { $do: "objects.done = result" } },
        },
        route: null,
      },
      {
        name: "join",
        item: "input",
        aggregate: {
          select: { $expr: "items" },
          until: { $expr: "set.every(i => i.next_task === null)" },
          reduce: { $do: "objects.names = set.map(i => i.objects.done)" },
        },
        route: "out",
      },
      { name: "out", item: "input", return: { result: { $expr: "objects.names" } } },
    ]);

  function probe() {
    let inflight = 0;
    const state = { peak: 0, order: [] as string[] };
    return {
      state,
      bundles: {
        probe: {
          async touch(input: { name: string }) {
            inflight++;
            state.peak = Math.max(state.peak, inflight);
            await new Promise((r) => setTimeout(r, 10));
            state.order.push(input.name);
            inflight--;
            return input.name;
          },
        },
      },
    };
  }

  it("parallel: true runs the children concurrently", async () => {
    const p = probe();
    const ev = await evaluate(splitDef(true), { parts: ["a", "b", "c"] }, { bundles: p.bundles });
    expect(ev.result).toEqual(["a", "b", "c"]);
    expect(p.state.peak).toBe(3);
  });

  it("parallel: false runs the children in selector order, one at a time", async () => {
    const p = probe();
    const ev = await evaluate(splitDef(false), { parts: ["a", "b", "c"] }, { bundles: p.bundles });
    expect(ev.result).toEqual(["a", "b", "c"]);
    expect(p.state.peak).toBe(1);
    expect(p.state.order).toEqual(["a", "b", "c"]);
  });

  it("creates items from a captured task result, not just from data", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        call: {
          provider: "js",
          implementation: { bundle_name: "catalogue" },
          input: { $expr: "({ region: data.region })" },
          script: "async (input, lib) => await lib.list(input)",
        },
        route: "fan_out",
      },
      {
        name: "fan_out",
        item: "input",
        split: {
          // The selector reads the recorded effect result (§5), never a live call.
          item_type: { $expr: "data.kind === 'room' ? 'child' : 'input'" },
          selector: { $expr: "tasks.Input.result.offers" },
          route: "price",
          parallel: true,
        },
        route: "join",
      },
      {
        name: "price",
        item: "child",
        enrich: { $do: "objects.price = data.amount * 2" },
        route: null,
      },
      {
        name: "join",
        item: "input",
        aggregate: {
          select: { $expr: "items" },
          until: { $expr: "set.every(i => i.next_task === null)" },
          reduce: { $do: "objects.total = set.reduce((s, i) => s + i.objects.price, 0)" },
        },
        route: "out",
      },
      {
        name: "out",
        item: "input",
        return: {
          result: {
            $expr: "({ total: objects.total, ids: items.map(i => i.data.id) })",
          },
        },
      },
    ]);

    const ev = await evaluate(def, { region: "EU" }, {
      bundles: {
        catalogue: {
          async list(input: { region: string }) {
            return {
              offers: [
                { id: `${input.region}-1`, kind: "room", amount: 10 },
                { id: `${input.region}-2`, kind: "room", amount: 15 },
              ],
            };
          },
        },
      },
      includeTrace: true,
    });

    expect(ev.result).toEqual({ total: 50, ids: ["EU-1", "EU-2"] });
    expect(ev.trace!.items.map((i) => i.id)).toEqual(["1.1", "1.2"]);
  });

  it("rejects a selector that does not return an array", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        split: { item_type: "child", selector: { $expr: "data.parts" }, route: null },
        route: null,
      },
    ]);
    await expect(evaluate(def, { parts: 7 })).rejects.toThrow(/must return an array/);
  });

  it("rejects an undeclared item type from [E1] per-child typing", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        split: {
          item_type: { $expr: "'ghost'" },
          selector: { $expr: "[{}]" },
          route: null,
        },
        route: null,
      },
    ]);
    await expect(evaluate(def, {})).rejects.toThrow(/undeclared item type `ghost`/);
  });
});

describe("async transitions (§8)", () => {
  const asyncDef = wf([
    {
      name: "Input",
      item: "input",
      enrich: { $do: "objects.log = []" },
      route: "fire",
    },
    {
      name: "fire",
      item: "input",
      async: true,
      call: {
        provider: "js",
        implementation: { bundle_name: "slow" },
        input: { $expr: "data" },
        script: "async (input, lib) => await lib.work(input)",
        output: { enrich: { $do: "objects.async_result = result" } },
      },
      route: "meanwhile",
    },
    {
      name: "meanwhile",
      item: "input",
      enrich: { $do: "objects.other = 'done-first'" },
      route: "rejoin",
    },
    {
      name: "rejoin",
      item: "input",
      // §8 sugar: block until the named branch has settled.
      await: ["fire"],
      enrich: { $do: "objects.joined = tasks.fire.result" },
      route: "out",
    },
    {
      name: "out",
      item: "input",
      return: { result: { $expr: "({ other: objects.other, joined: objects.joined })" } },
    },
  ]);

  const slow = {
    slow: {
      async work() {
        await new Promise((r) => setTimeout(r, 25));
        return "branch-value";
      },
    },
  };

  it("continues past the node, then rejoins on await:[name]", async () => {
    const ev = await evaluate(asyncDef, {}, { bundles: slow, includeTrace: true });

    expect(ev.status).toBe("succeeded");
    expect(ev.result).toEqual({ other: "done-first", joined: "branch-value" });

    const trace = ev.trace!;
    // `meanwhile` ran while the branch was still in flight.
    const tasks = trace.trajectory.map((e) => e.task);
    expect(tasks.indexOf("meanwhile")).toBeLessThan(tasks.lastIndexOf("fire"));

    // [E2] the branch shows up twice: pending at spawn, settled at completion.
    const fires = trace.trajectory.filter((e) => e.task === "fire");
    expect(fires.map((e) => e.status)).toEqual(["pending", "success"]);
    expect(trace.tasks.fire.status).toBe("success");
    expect(trace.tasks.fire.result).toBe("branch-value");
  });

  it("flags two live branches writing the same objects path (§8 rule 1)", async () => {
    const clash = wf([
      { name: "Input", item: "input", route: "fire" },
      {
        name: "fire",
        item: "input",
        async: true,
        call: {
          provider: "js",
          implementation: { bundle_name: "slow" },
          script: "async (input, lib) => await lib.work(input)",
          // The branch folds into `objects.shared`…
          output: { enrich: { $do: "objects.shared = result" } },
        },
        route: "meanwhile",
      },
      {
        name: "meanwhile",
        item: "input",
        // …and so does the main trajectory, concurrently.
        enrich: { $do: "objects.shared = 'main'" },
        route: "rejoin",
      },
      { name: "rejoin", item: "input", await: ["fire"], route: null },
    ]);

    await expect(evaluate(clash, {}, { bundles: slow })).rejects.toThrow(
      DeterminismViolation,
    );
    await expect(evaluate(clash, {}, { bundles: slow })).rejects.toThrow(
      /two live branches write `objects.shared`/,
    );
  });
});

describe("call providers (§9)", () => {
  it("http: builds the request from expressions and captures the response", async () => {
    const seen: Array<{ url: string; method: string; body: unknown }> = [];
    const def = wf(
      [
        {
          name: "Input",
          item: "input",
          call: {
            provider: "http",
            request: {
              method: "POST",
              url: { $expr: "`${parameters['orders.base-url']}/orders/${data.order_id}`" },
              headers: { $expr: "({ 'content-type': 'application/json' })" },
              body: { $expr: "({ order_id: data.order_id })" },
            },
            output: { enrich: { $do: "objects.saved = result" } },
          },
          route: "out",
        },
        { name: "out", item: "input", return: { result: { $expr: "objects.saved" } } },
      ],
      { config: { parameters: { "orders.base-url": "https://api.example.test" } } },
    );

    const ev = await evaluate(def, { order_id: "A-1" }, {
      fetch: async (url, init) => {
        seen.push({
          url: String(url),
          method: init!.method!,
          body: JSON.parse(String(init!.body)),
        });
        return new Response(JSON.stringify({ status: "SAVED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    expect(ev.result).toEqual({ status: "SAVED" });
    expect(seen).toEqual([
      {
        url: "https://api.example.test/orders/A-1",
        method: "POST",
        body: { order_id: "A-1" },
      },
    ]);
  });

  it("http: turns a 4xx into a determined failure and a 5xx into a retry", async () => {
    const def = (status: number) =>
      wf([
        {
          name: "Input",
          item: "input",
          retry: { inline: { max_count: 2, interval: "1ms" } },
          call: {
            provider: "http",
            request: { method: "GET", url: { $expr: "'https://x.test/'" } },
          },
          target_state_setter: { $expr: "task_state.status === 'error' ? 'failure' : 'success'" },
          route: { cases: { success: "ok", failure: "bad" } },
        },
        { name: "ok", item: "input", return: { result: { $expr: "'ok'" } } },
        {
          name: "bad",
          item: "input",
          return: { error: { $expr: "({ code: 1, message: tasks.Input.error.message })" } },
        },
      ]);

    let calls = 0;
    const ev4 = await evaluate(def(404), {}, {
      fetch: async () => {
        calls++;
        return new Response("nope", { status: 404 });
      },
    });
    expect(ev4.status).toBe("failed");
    expect(calls).toBe(1); // no retry on 4xx

    calls = 0;
    const ev5 = await evaluate(def(500), {}, {
      fetch: async () => {
        calls++;
        return new Response("boom", { status: 500 });
      },
    });
    expect(ev5.status).toBe("failed");
    expect(calls).toBe(3); // initial + 2 inline retries
  });

  it("sub_workflow: captures the child's result", async () => {
    const child = wf([
      {
        name: "Input",
        item: "input",
        return: { result: { $expr: "({ doubled: data.n * 2 })" } },
      },
    ]);
    child.name = "double";

    const parent = wf([
      {
        name: "Input",
        item: "input",
        call: {
          provider: "sub_workflow",
          name: "double",
          input: { $expr: "({ n: data.n })" },
          output: { enrich: { $do: "objects.sub = result" } },
        },
        route: "out",
      },
      { name: "out", item: "input", return: { result: { $expr: "objects.sub" } } },
    ]);

    const ev = await evaluate(parent, { n: 21 }, {
      resolveWorkflow: (ref) => (ref.name === "double" ? child : undefined),
    });
    expect(ev.result).toEqual({ doubled: 42 });
  });

  it("sub_workflow: the child's declared error becomes the parent's captured error", async () => {
    const child = wf([
      {
        name: "Input",
        item: "input",
        return: { error: { $expr: "({ code: 7001, category: 'BUSINESS', message: 'nope' })" } },
      },
    ]);
    child.name = "failing";

    const parent = wf([
      {
        name: "Input",
        item: "input",
        call: { provider: "sub_workflow", name: "failing", input: { $expr: "data" } },
        target_state_setter: { $expr: "task_state.status === 'error' ? 'failure' : 'success'" },
        route: { cases: { success: "ok", failure: "bad" } },
      },
      { name: "ok", item: "input", return: { result: { $expr: "'ok'" } } },
      { name: "bad", item: "input", return: { error: { $expr: "tasks.Input.error" } } },
    ]);

    const ev = await evaluate(parent, {}, {
      resolveWorkflow: () => child,
    });
    expect(ev.status).toBe("failed");
    expect(ev.error).toMatchObject({ code: 7001, message: "nope" });
  });
});

describe("retry & suspension (§11)", () => {
  const failing = {
    flaky: {
      async go() {
        throw {
          code: 503,
          category: "TECHNICAL",
          message: "downstream down",
          retry_type: "inline_then_offline",
        };
      },
    },
  };

  const def = (catchOffline: boolean) =>
    wf([
      {
        name: "Input",
        item: "input",
        retry: {
          inline: { max_count: 1, interval: "1ms" },
          offline: { max_count: 5, interval: "5m", max_interval: "1h" },
          catch_offline_retry_error: catchOffline,
        },
        call: {
          provider: "js",
          implementation: { bundle_name: "flaky" },
          script: "async (input, lib) => await lib.go(input)",
        },
        target_state_setter: { $expr: "task_state.status === 'error' ? 'failure' : 'success'" },
        route: { cases: { success: "ok", failure: "bad" } },
      },
      { name: "ok", item: "input", return: { result: { $expr: "'ok'" } } },
      {
        name: "bad",
        item: "input",
        return: { error: { $expr: "tasks.Input.error" } },
      },
    ]);

  it("exhausts inline retries, then parks the evaluation on the offline schedule", async () => {
    const t0 = new Date("2026-08-26T12:00:00Z");
    const ev = await evaluate(def(false), {}, {
      bundles: failing,
      now: () => t0,
    });

    expect(ev.status).toBe("suspended");
    expect(ev.completed_at).toBeNull();
    expect(ev.suspension).toEqual({
      reason: "offline_retry",
      task: "Input",
      item_id: "1",
      attempt: 0,
      next_retry_at: "2026-08-26T12:05:00.000Z", // t0 + the 5m interval
    });
  });

  it("catch_offline_retry_error lets the flow continue and decide the outcome", async () => {
    const ev = await evaluate(def(true), {}, { bundles: failing });
    expect(ev.status).toBe("failed");
    expect(ev.error).toMatchObject({
      code: 503,
      retry_type: "offline",
      message: "downstream down",
    });
    expect(ev.error!.next_retry).toBeTypeOf("string");
  });

  it("times a call out and treats the timeout as retryable", async () => {
    let attempts = 0;
    const ev = await evaluate(
      wf([
        {
          name: "Input",
          item: "input",
          timeout: 15,
          retry: { inline: { max_count: 1, interval: "1ms" } },
          call: {
            provider: "js",
            implementation: { bundle_name: "hang" },
            script: "async (input, lib) => await lib.go(input)",
          },
          target_state_setter: { $expr: "task_state.status === 'error' ? 'failure' : 'success'" },
          route: { cases: { success: "ok", failure: "bad" } },
        },
        { name: "ok", item: "input", return: { result: { $expr: "'ok'" } } },
        { name: "bad", item: "input", return: { error: { $expr: "tasks.Input.error" } } },
      ]),
      {},
      {
        bundles: {
          hang: {
            async go(_i: unknown) {
              attempts++;
              await new Promise((r) => setTimeout(r, 200));
            },
          },
        },
      },
    );

    expect(ev.status).toBe("failed");
    expect(ev.error).toMatchObject({ code: 504 });
    expect(attempts).toBe(2);
  });
});

describe("the [E3] ctx binding", () => {
  it("exposes items, types and per-item trajectories, and no global ordering", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        split: {
          item_type: "child",
          selector: { $expr: "[{ n: 1 }, { n: 2 }]" },
          route: "touch",
          parallel: true,
        },
        route: "join",
      },
      { name: "touch", item: "child", enrich: { $do: "objects.n = data.n" }, route: null },
      {
        name: "join",
        item: "input",
        aggregate: {
          select: { $expr: "items" },
          until: { $expr: "set.every(i => i.next_task === null)" },
        },
        route: "out",
      },
      {
        name: "out",
        item: "input",
        return: {
          result: {
            $expr: `({
              count: ctx.count(),
              children: ctx.count('child'),
              ids: ctx.items.map(i => i.id),
              byId: ctx.item('1.2').objects.n,
              visited: ctx.byTask('touch').map(i => i.id),
              touchVisits: ctx.visits('touch').map(v => v.item_id + '#' + v.seq),
              perItem: Object.keys(ctx.trajectory()),
              oneItem: ctx.trajectory('1.1').map(v => v.task),
              hasFlatLog: typeof ctx.log
            })`,
          },
        },
      },
    ]);

    const ev = await evaluate(def, {});
    expect(ev.result).toEqual({
      count: 3,
      children: 2,
      ids: ["1", "1.1", "1.2"],
      byId: 2,
      visited: ["1.1", "1.2"],
      // Ordered by (item creation, per-item seq) — never by arrival time.
      touchVisits: ["1.1#0", "1.2#0"],
      perItem: ["1", "1.1", "1.2"],
      oneItem: ["touch"],
      // §8: there is deliberately no flat chronological log on `ctx`.
      hasFlatLog: "undefined",
    });
  });
});

describe("definition validation (§16)", () => {
  it("rejects two body kinds on one node (§6)", () => {
    expect(() =>
      validateDefinition(
        wf([
          {
            name: "Input",
            item: "input",
            enrich: { $do: "objects.a = 1" },
            return: { result: { $expr: "1" } },
          },
        ]),
      ),
    ).toThrow(WorkflowDefinitionError);
    expect(() =>
      validateDefinition(
        wf([
          {
            name: "Input",
            item: "input",
            enrich: { $do: "objects.a = 1" },
            return: { result: { $expr: "1" } },
          },
        ]),
      ),
    ).toThrow(/carries 2 body kinds \(enrich, return\)/);
  });

  it("rejects the pre-rename spelling split.itemType", () => {
    expect(() =>
      validateDefinition(
        wf([
          {
            name: "Input",
            item: "input",
            split: { itemType: "child", selector: { $expr: "[]" }, route: null },
          } as unknown as Node,
        ]),
      ),
    ).toThrow(WorkflowDefinitionError);
    expect(() =>
      validateDefinition(
        wf([
          {
            name: "Input",
            item: "input",
            split: { itemType: "child", selector: { $expr: "[]" }, route: null },
          } as unknown as Node,
        ]),
      ),
    ).toThrow(/item_type/);
  });

  it("rejects duplicate node names and undeclared item types", () => {
    expect(() =>
      validateDefinition(
        wf([
          { name: "a", item: "input", route: null },
          { name: "a", item: "input", route: null },
        ]),
      ),
    ).toThrow(/duplicate node name `a`/);

    expect(() =>
      validateDefinition(wf([{ name: "a", item: "ghost", route: null }])),
    ).toThrow(/undeclared item type `ghost`/);
  });

  it("reports an unparseable expression at load time, not at visit time", () => {
    expect(() =>
      validateDefinition(
        wf([{ name: "Input", item: "input", condition: {} as never, route: null }]),
      ),
    ).toThrow(/neither \$expr nor \$do/);
  });
});

describe("blocked evaluations", () => {
  it("reports a deadlock rather than spinning, naming the blocked items", async () => {
    const def = wf([
      { name: "Input", item: "input", route: "never" },
      {
        name: "never",
        item: "input",
        condition: { $expr: "false" },
        route: null,
      },
    ]);
    await expect(evaluate(def, {})).rejects.toThrow(DeadlockError);
    await expect(evaluate(def, {})).rejects.toThrow(/1@never \[condition\]/);
  });

  it("reports a barrier whose until can never hold", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        split: { item_type: "child", selector: { $expr: "[{}]" }, route: null },
        route: "join",
      },
      {
        name: "join",
        item: "input",
        aggregate: {
          select: { $expr: "items" },
          until: { $expr: "set.every(i => i.objects.never_set === true)" },
        },
        route: null,
      },
    ]);
    await expect(evaluate(def, {})).rejects.toThrow(/1@join \[until\]/);
  });
});

describe("terminal mapping (§12 step 3)", () => {
  it("maps a root target_state of failure to a failed evaluation without a return node", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        target_state_setter: { $expr: "'failure'" },
        route: null,
      },
    ]);
    const ev = await evaluate(def, {});
    expect(ev.status).toBe("failed");
    expect(ev.target_state).toBe("failure");
    expect(ev.error).toMatchObject({ code: 500 });
  });

  it("returns objects.result when the root succeeds without a return node", async () => {
    const def = wf([
      {
        name: "Input",
        item: "input",
        enrich: { $do: "objects.result = { ok: true }" },
        route: null,
      },
    ]);
    const ev = await evaluate(def, {});
    expect(ev.status).toBe("succeeded");
    expect(ev.result).toEqual({ ok: true });
  });
});
