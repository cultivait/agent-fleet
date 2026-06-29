import { describe, expect, it } from "vitest";
import {
  buildLoopView,
  buildLoopViews,
  type LoopRow,
  loopFmtDuration,
  loopFmtInt,
  loopSparkPath,
} from "../cockpit-loops.js";

// Fixture builder — minimal Loop row with overridable config/state.
function row(o: Partial<LoopRow> & { id: string }): LoopRow {
  return {
    id: o.id,
    kind: o.kind ?? "generic",
    label: o.label ?? "loop " + o.id,
    owner_callsign: o.owner_callsign ?? "linux-x",
    status: o.status ?? "running",
    stop_reason: o.stop_reason ?? null,
    created_at: o.created_at ?? 0,
    config: o.config ?? {},
    state: o.state ?? {},
  };
}

describe("loopFmtInt", () => {
  it("compresses thousands with a k suffix", () => {
    expect(loopFmtInt(0)).toBe("0");
    expect(loopFmtInt(999)).toBe("999");
    expect(loopFmtInt(1000)).toBe("1k");
    expect(loopFmtInt(12500)).toBe("13k");
  });
});

describe("loopFmtDuration", () => {
  it("formats m:ss under an hour and h:mm:ss over", () => {
    expect(loopFmtDuration(0)).toBe("0:00");
    expect(loopFmtDuration(90_000)).toBe("1:30");
    expect(loopFmtDuration(5 * 60_000)).toBe("5:00");
    expect(loopFmtDuration(3_661_000)).toBe("1:01:01");
    expect(loopFmtDuration(-50)).toBe("0:00");
  });
});

describe("buildLoopView — gauges", () => {
  it("renders iteration/token gauges only when a cap is configured", () => {
    const v = buildLoopView(
      row({ id: "a", config: { max_iterations: 10 }, state: { iterations: 3, tokens: 500 } }),
      1000,
    );
    expect(v.iter).toEqual({ ratio: 0.3, shown: true, label: "3 / 10" });
    // no token_budget configured → not shown, label is the raw running count
    expect(v.tokens.shown).toBe(false);
    expect(v.tokens.label).toBe("500");
    expect(v.tokens.ratio).toBeNull();
  });

  it("computes the wall-clock gauge from now - created_at", () => {
    const v = buildLoopView(row({ id: "t", created_at: 1000, config: { wall_clock_timeout_ms: 10_000 } }), 6000);
    expect(v.time.ratio).toBeCloseTo(0.5, 5);
    expect(v.time.label).toBe("0:05 / 0:10");
  });

  it("shows completeness as a percentage info gauge", () => {
    const v = buildLoopView(
      row({ id: "c", config: { completeness_threshold: 0.9 }, state: { last_completeness: 0.6 } }),
      0,
    );
    expect(v.completeness).toEqual({ ratio: 0.6, shown: true, label: "60% / 90%" });
  });

  it("treats a null completeness as an em-dash, not 0%", () => {
    const v = buildLoopView(row({ id: "c2", state: {} }), 0);
    expect(v.completeness.shown).toBe(false);
    expect(v.completeness.label).toBe("—");
  });
});

describe("buildLoopView — pressure", () => {
  it("is ok well below the warn threshold", () => {
    const v = buildLoopView(row({ id: "ok", config: { max_iterations: 10 }, state: { iterations: 5 } }), 0);
    expect(v.pressure).toBe("ok");
  });

  it("goes amber at >=75% of any cap", () => {
    const v = buildLoopView(row({ id: "w", config: { max_iterations: 10 }, state: { iterations: 8 } }), 0);
    expect(v.pressure).toBe("warn");
  });

  it("goes red at >=90% of any cap", () => {
    const v = buildLoopView(row({ id: "r", config: { token_budget: 1000 }, state: { tokens: 950 } }), 0);
    expect(v.pressure).toBe("crit");
    expect(v.pressureRatio).toBeCloseTo(0.95, 5);
  });

  it("takes the WORST ratio across all configured resource caps", () => {
    const v = buildLoopView(
      row({
        id: "mix",
        created_at: 0,
        config: { max_iterations: 100, token_budget: 1000, wall_clock_timeout_ms: 10_000 },
        state: { iterations: 10, tokens: 920 }, // iter 10%, token 92% → crit drives it
      }),
      1000, // time 10%
    );
    expect(v.pressure).toBe("crit");
    expect(v.pressureRatio).toBeCloseTo(0.92, 5);
  });

  it("does NOT let completeness drive danger pressure (it is a success signal)", () => {
    const v = buildLoopView(
      row({ id: "comp", config: { completeness_threshold: 0.9 }, state: { last_completeness: 0.95 } }),
      0,
    );
    expect(v.pressure).toBe("ok");
  });

  it("mutes pressure for terminal loops even past a cap", () => {
    const stopped = buildLoopView(
      row({
        id: "done",
        status: "stopped",
        stop_reason: "max_iterations",
        config: { max_iterations: 10 },
        state: { iterations: 10 },
      }),
      0,
    );
    expect(stopped.pressure).toBe("ok");
    expect(stopped.active).toBe(false);
  });

  it("clamps pressureRatio to 1 when a cap is exceeded", () => {
    const v = buildLoopView(row({ id: "over", config: { max_iterations: 10 }, state: { iterations: 25 } }), 0);
    expect(v.pressureRatio).toBe(1);
  });
});

describe("buildLoopViews — ordering", () => {
  it("orders running → paused → terminal, then by descending pressure", () => {
    const loops: LoopRow[] = [
      row({ id: "done1", status: "stopped" }),
      row({ id: "run-low", status: "running", config: { max_iterations: 10 }, state: { iterations: 1 } }),
      row({ id: "paused1", status: "paused" }),
      row({ id: "run-hot", status: "running", config: { max_iterations: 10 }, state: { iterations: 9 } }),
    ];
    const ids = buildLoopViews(loops, 0).map((v) => v.id);
    expect(ids).toEqual(["run-hot", "run-low", "paused1", "done1"]);
  });

  it("tolerates a non-array input", () => {
    expect(buildLoopViews(undefined as unknown as LoopRow[], 0)).toEqual([]);
  });
});

describe("buildLoopView — Phase 4 scores/verdict (optional)", () => {
  it("defaults scores to [] and verdict to null on a basic loop", () => {
    const v = buildLoopView(row({ id: "basic" }), 0);
    expect(v.scores).toEqual([]);
    expect(v.verdict).toBeNull();
  });

  it("surfaces a completeness trajectory + verdict when present", () => {
    const v = buildLoopView(
      row({
        id: "ev",
        state: {
          scores: [0.2, 0.5, 0.8],
          last_verdict: {
            status: "partial",
            completeness: 0.8,
            missing: ["x"],
            contradictions: [],
            recommendation: "retry",
          },
        },
      }),
      0,
    );
    expect(v.scores).toEqual([0.2, 0.5, 0.8]);
    expect(v.verdict?.recommendation).toBe("retry");
    expect(v.verdict?.missing).toEqual(["x"]);
  });

  it("filters non-numeric junk out of scores", () => {
    const v = buildLoopView(row({ id: "junk", state: { scores: [0.1, "nope" as unknown as number, 0.3] } }), 0);
    expect(v.scores).toEqual([0.1, 0.3]);
  });
});

describe("loopSparkPath", () => {
  it("returns empty for <2 points", () => {
    expect(loopSparkPath([], 100, 20)).toBe("");
    expect(loopSparkPath([0.5], 100, 20)).toBe("");
    expect(loopSparkPath(undefined as unknown as number[], 100, 20)).toBe("");
  });

  it("maps 0..1 scores to an inverted polyline across the width", () => {
    // [0,1] over 100x20: first point bottom-left (0,20), last top-right (100,0)
    expect(loopSparkPath([0, 1], 100, 20)).toBe("M0,20 L100,0");
  });

  it("clamps out-of-range scores into the box", () => {
    expect(loopSparkPath([-1, 2], 100, 20)).toBe("M0,20 L100,0");
  });
});
