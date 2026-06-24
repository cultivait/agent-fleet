import { describe, expect, it } from "vitest";
import {
  evaluateVerdict,
  normalizeVerdict,
  type Verdict,
} from "../loops/verdict.js";

function verdict(partial: Partial<Verdict> = {}): Verdict {
  return {
    status: "partial",
    completeness: 0.5,
    missing: [],
    contradictions: [],
    recommendation: "retry",
    ...partial,
  };
}

describe("normalizeVerdict — validation + coercion at the boundary", () => {
  it("accepts a well-formed verdict and passes optional fields through", () => {
    const v = normalizeVerdict({
      status: "complete",
      completeness: 0.9,
      missing: ["a"],
      contradictions: ["b"],
      recommendation: "accept",
      rationale: "looks good",
      judge: "opus-judge",
    });
    expect(v).toEqual({
      status: "complete",
      completeness: 0.9,
      missing: ["a"],
      contradictions: ["b"],
      recommendation: "accept",
      rationale: "looks good",
      judge: "opus-judge",
    });
  });

  it("clamps completeness into [0, 1]", () => {
    expect(normalizeVerdict(verdict({ completeness: 1.7 })).completeness).toBe(1);
    expect(normalizeVerdict(verdict({ completeness: -3 })).completeness).toBe(0);
  });

  it("coerces missing/contradictions to string arrays (drops non-strings, defaults to [])", () => {
    const v = normalizeVerdict({
      status: "partial",
      completeness: 0.5,
      // biome-ignore lint: intentionally malformed input
      missing: ["ok", 5, null, "fine"],
      recommendation: "retry",
    } as unknown);
    expect(v.missing).toEqual(["ok", "fine"]);
    expect(v.contradictions).toEqual([]); // omitted -> []
  });

  it("throws on a non-object, bad status, bad recommendation, or non-finite completeness", () => {
    expect(() => normalizeVerdict(null)).toThrow(/object/);
    expect(() => normalizeVerdict(verdict({ status: "done" as unknown as Verdict["status"] }))).toThrow(/status/);
    expect(() =>
      normalizeVerdict(verdict({ recommendation: "stop" as unknown as Verdict["recommendation"] })),
    ).toThrow(/recommendation/);
    expect(() => normalizeVerdict(verdict({ completeness: Number.NaN }))).toThrow(/completeness/);
    expect(() => normalizeVerdict({ status: "partial", recommendation: "retry" })).toThrow(/completeness/);
  });

  it("strips unknown keys", () => {
    const v = normalizeVerdict({
      status: "partial",
      completeness: 0.5,
      recommendation: "retry",
      sneaky: "value",
    } as unknown) as Verdict & { sneaky?: unknown };
    expect(v.sneaky).toBeUndefined();
  });
});

describe("evaluateVerdict — accept / escalate / target / plateau / continue", () => {
  it("recommendation 'accept' -> accepted (regardless of config)", () => {
    expect(evaluateVerdict(undefined, [0.4], verdict({ recommendation: "accept" }))).toBe("accepted");
  });

  it("recommendation 'escalate' -> escalated (the Phase-5 HITL seam)", () => {
    expect(evaluateVerdict(undefined, [0.4], verdict({ recommendation: "escalate" }))).toBe("escalated");
  });

  it("recommendation 'retry' with no guardrails -> null (keep iterating)", () => {
    expect(evaluateVerdict(undefined, [0.4], verdict({ recommendation: "retry" }))).toBeNull();
    expect(evaluateVerdict({}, [0.4], verdict({ recommendation: "retry" }))).toBeNull();
  });

  it("completeness_target overrides a stuck 'retry' judge -> accepted", () => {
    const eo = { completeness_target: 0.95 };
    expect(evaluateVerdict(eo, [0.9], verdict({ recommendation: "retry", completeness: 0.9 }))).toBeNull();
    expect(evaluateVerdict(eo, [0.96], verdict({ recommendation: "retry", completeness: 0.96 }))).toBe(
      "accepted",
    );
  });

  it("plateau trips when the last `window` scores span <= epsilon", () => {
    const eo = { plateau: { window: 3, epsilon: 0.02 } };
    // span 0.01 <= 0.02 over the last 3 -> plateau
    expect(evaluateVerdict(eo, [0.4, 0.8, 0.81, 0.8], verdict({ recommendation: "retry" }))).toBe(
      "plateau",
    );
    // last 3 still improving (span 0.2 > 0.02) -> keep going
    expect(evaluateVerdict(eo, [0.4, 0.6, 0.8], verdict({ recommendation: "retry" }))).toBeNull();
    // not enough samples yet -> keep going
    expect(evaluateVerdict(eo, [0.8, 0.8], verdict({ recommendation: "retry" }))).toBeNull();
  });

  it("accept/escalate outrank the guardrails", () => {
    const eo = { completeness_target: 0.1, plateau: { window: 2, epsilon: 1 } };
    expect(evaluateVerdict(eo, [0.9, 0.9], verdict({ recommendation: "accept" }))).toBe("accepted");
    expect(evaluateVerdict(eo, [0.9, 0.9], verdict({ recommendation: "escalate" }))).toBe("escalated");
  });
});
