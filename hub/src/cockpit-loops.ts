// Pure view-model + cap-pressure derivation for the cockpit's Loops panel (Phase 2).
// DOM-free so it is unit-testable; a verbatim copy lives in the cockpit <script>
// (cockpit-ui.ts COCKPIT_SCRIPT). KEEP THE TWO IDENTICAL — this is the tested logic.
//
// The hub is the loop GOVERNOR (see loops/store.ts); this module is read-only
// presentation. Given a Loop row + a server clock it derives the operator gauges
// (iteration / token / wall-clock / completeness progress) and ONE "pressure" level
// so a loop nearing any RESOURCE cap lights amber/red before it trips. Completeness
// is a success condition, not a resource cap, so it is shown but never drives the
// danger colour. No engine semantics here.

// Phase-4 verdict (loop.state.last_verdict). LOCKED schema — names mirrored verbatim,
// never redefined here. Optional/absent on basic (non-evaluator) loops.
export interface LoopVerdict {
  status: string; // "complete" | "partial" | "incomplete"
  completeness: number; // 0..1
  missing: string[];
  contradictions: string[];
  recommendation: string; // "accept" | "retry" | "escalate"
  rationale?: string;
  judge?: string;
}

// The subset of the engine's Loop shape this view needs. Tolerant of loose JSON.
// scores/last_verdict are Phase-4 additions on the SAME state blob — read optionally;
// they are simply absent on basic loops and until Phase 4 integrates.
export interface LoopRow {
  id: string;
  kind: string;
  label: string;
  owner_callsign: string;
  status: string; // running | paused | stopped | completed
  stop_reason: string | null;
  created_at: number;
  config: {
    max_iterations?: number;
    token_budget?: number;
    wall_clock_timeout_ms?: number;
    completeness_threshold?: number;
  };
  state: {
    iterations?: number;
    tokens?: number;
    last_completeness?: number | null;
    scores?: number[]; // Phase 4: completeness per iteration (trajectory)
    last_verdict?: LoopVerdict | null; // Phase 4
  };
}

export type LoopPressure = "ok" | "warn" | "crit";

export interface LoopGauge {
  ratio: number | null; // progress toward the cap (0..1+), or null if the cap isn't configured
  shown: boolean; // whether a cap/value exists to render a bar for
  label: string; // operator-facing label, e.g. "3 / 10", "12k / 50k", "1:30 / 5:00", "60%"
}

export interface LoopView {
  id: string;
  label: string;
  kind: string;
  owner: string;
  status: string;
  stop_reason: string | null;
  active: boolean; // running|paused → controllable; stopped|completed → terminal
  iter: LoopGauge;
  tokens: LoopGauge;
  time: LoopGauge;
  completeness: LoopGauge;
  pressure: LoopPressure; // worst across the iter/token/time RESOURCE caps
  pressureRatio: number; // 0..1 (clamped) driving the headline bar
  scores: number[]; // Phase 4 completeness trajectory ([] when absent)
  verdict: LoopVerdict | null; // Phase 4 last verdict (null when absent)
}

const LOOP_WARN_AT = 0.75;
const LOOP_CRIT_AT = 0.9;

// k-suffix big numbers (iterations stay raw; tokens compress). Matches the cockpit's
// existing fmtCtx convention so loop token counts read like the context gauge.
export function loopFmtInt(n: number): string {
  return n >= 1000 ? Math.round(n / 1000) + "k" : String(n);
}

// h:mm:ss / m:ss elapsed/budget label.
export function loopFmtDuration(ms: number): string {
  let t = ms < 0 ? 0 : ms;
  const totalSec = Math.floor(t / 1000);
  const sec = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const min = totalMin % 60;
  const hr = Math.floor(totalMin / 60);
  function p2(n: number): string {
    return n < 10 ? "0" + n : "" + n;
  }
  return hr > 0 ? hr + ":" + p2(min) + ":" + p2(sec) : min + ":" + p2(sec);
}

function loopRatio(value: number, cap: number | undefined | null): number | null {
  if (cap == null || cap <= 0) return null;
  return value / cap;
}

export function buildLoopView(loop: LoopRow, now: number): LoopView {
  const cfg = loop.config || {};
  const st = loop.state || {};
  const iterN = typeof st.iterations === "number" ? st.iterations : 0;
  const tokN = typeof st.tokens === "number" ? st.tokens : 0;
  const elapsed = now - loop.created_at;

  const iterRatio = loopRatio(iterN, cfg.max_iterations);
  const tokRatio = loopRatio(tokN, cfg.token_budget);
  const timeRatio = loopRatio(elapsed, cfg.wall_clock_timeout_ms);

  const iter: LoopGauge = {
    ratio: iterRatio,
    shown: cfg.max_iterations != null,
    label: cfg.max_iterations != null ? iterN + " / " + cfg.max_iterations : String(iterN),
  };
  const tokens: LoopGauge = {
    ratio: tokRatio,
    shown: cfg.token_budget != null,
    label:
      cfg.token_budget != null
        ? loopFmtInt(tokN) + " / " + loopFmtInt(cfg.token_budget)
        : loopFmtInt(tokN),
  };
  const time: LoopGauge = {
    ratio: timeRatio,
    shown: cfg.wall_clock_timeout_ms != null,
    label:
      cfg.wall_clock_timeout_ms != null
        ? loopFmtDuration(elapsed) + " / " + loopFmtDuration(cfg.wall_clock_timeout_ms)
        : loopFmtDuration(elapsed),
  };

  // completeness: last reported 0..1 (info gauge). Show vs threshold when configured.
  const lc = typeof st.last_completeness === "number" ? st.last_completeness : null;
  const completeness: LoopGauge = {
    ratio: lc,
    shown: lc != null,
    label:
      lc != null
        ? Math.round(lc * 100) +
          "%" +
          (cfg.completeness_threshold != null
            ? " / " + Math.round(cfg.completeness_threshold * 100) + "%"
            : "")
        : "—",
  };

  // pressure: worst of the three RESOURCE caps only; terminal loops are muted (ok).
  let worst = 0;
  const terminal = loop.status === "stopped" || loop.status === "completed";
  if (!terminal) {
    [iterRatio, tokRatio, timeRatio].forEach((r) => {
      if (r != null && r > worst) worst = r;
    });
  }
  const pressure: LoopPressure = worst >= LOOP_CRIT_AT ? "crit" : worst >= LOOP_WARN_AT ? "warn" : "ok";

  const scores = Array.isArray(st.scores) ? st.scores.filter((n) => typeof n === "number") : [];
  const verdict = st.last_verdict && typeof st.last_verdict === "object" ? st.last_verdict : null;

  return {
    id: loop.id,
    label: loop.label,
    kind: loop.kind,
    owner: loop.owner_callsign,
    status: loop.status,
    stop_reason: loop.stop_reason != null ? loop.stop_reason : null,
    active: loop.status === "running" || loop.status === "paused",
    iter,
    tokens,
    time,
    completeness,
    pressure,
    pressureRatio: worst > 1 ? 1 : worst,
    scores,
    verdict,
  };
}

// SVG polyline path for a completeness trajectory (scores are 0..1, hub-clamped).
// Returns "" when there is nothing meaningful to draw (<2 points). x spreads evenly
// across w; y is inverted so high completeness sits near the top. Coordinates are in
// the caller's viewBox space (rendered with preserveAspectRatio=none to stretch).
export function loopSparkPath(scores: number[], w: number, h: number): string {
  if (!Array.isArray(scores) || scores.length < 2) return "";
  const n = scores.length;
  let d = "";
  for (let i = 0; i < n; i++) {
    const raw = scores[i];
    const v = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    const x = (i / (n - 1)) * w;
    const y = h - v * h;
    d += (i === 0 ? "M" : " L") + Math.round(x * 100) / 100 + "," + Math.round(y * 100) / 100;
  }
  return d;
}

function loopGroupRank(status: string): number {
  if (status === "running") return 0;
  if (status === "paused") return 1;
  return 2; // stopped | completed
}

// running first, then paused, then terminal; within a group highest pressure first.
// Stable: equal items keep the server's created_at-DESC order from listLoops().
export function buildLoopViews(loops: LoopRow[], now: number): LoopView[] {
  if (!Array.isArray(loops)) return [];
  return loops
    .map((l) => buildLoopView(l, now))
    .sort((a, b) => {
      const ga = loopGroupRank(a.status);
      const gb = loopGroupRank(b.status);
      if (ga !== gb) return ga - gb;
      if (a.pressureRatio !== b.pressureRatio) return b.pressureRatio - a.pressureRatio;
      return 0;
    });
}
