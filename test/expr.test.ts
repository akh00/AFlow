import { describe, expect, it } from "vitest";

import {
  DeterminismViolation,
  FORBIDDEN_REASONS,
  SAFE_GLOBAL_NAMES,
  evalExpr,
} from "../src/index.js";

describe("the expression name lists (§5)", () => {
  it("exports the name lists the proxy enforces", () => {
    expect(FORBIDDEN_REASONS.size).toBeGreaterThan(0);
    for (const name of FORBIDDEN_REASONS.keys()) {
      expect(() => evalExpr(name, {}), name).toThrow(DeterminismViolation);
    }

    expect(SAFE_GLOBAL_NAMES).toContain("Math");
    for (const name of SAFE_GLOBAL_NAMES) {
      const kind = evalExpr(`typeof ${name}`, {});
      if (name === "undefined") expect(kind, name).toBe("undefined");
      else expect(kind, name).not.toBe("undefined");
    }
  });
});
