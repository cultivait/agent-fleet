// Loop governor — Phase 4: structured ResultVerifier verdict + evaluator-optimizer decisions.
//
// Formalizes the existing review→done gate as a first-class loop TYPE. The shape is the
// classic evaluator-optimizer (a.k.a. generator-critic / producer-judge) loop:
//   producer emits a candidate  →  a JUDGE evaluates it and reports a structured Verdict
//   →  the hub records the verdict + the completeness-score trajectory  →  accept / iterate / escalate.
//
// As everywhere else in the governor, the hub does NOT run the producer or the judge — it
// GOVERNS the loop from the verdicts the agent reports. This module is pure data + decision
// logic (no DB, no I/O) so it is unit-testable in isolation and carries no import of store.ts
// (store.ts imports THIS, never the reverse — keeps the dependency acyclic).
//
// BIAS MITIGATION (judge design, enforced agent-side, recorded here): an LLM-as-judge should
// not grade its own un-blinded draft. The Verdict carries an optional `judge` provenance field
// so a separate judge identity can be recorded for later bias audits; the hub stores it but does
// not interpret it. Choosing a judge distinct from the producer is the caller's responsibility.

export type VerdictStatus = "complete" | "partial" | "incomplete";
export type VerdictRecommendation = "accept" | "retry" | "escalate";

// Terminal reasons an evaluator-optimizer loop can stop for. Folded into store.ts's StopReason
// union (store imports this) so the rest of the engine treats them like any other stop reason.
export type VerdictStopReason = "accepted" | "escalated" | "plateau";

// A judge's structured assessment of one producer iteration.
export interface Verdict {
  status: VerdictStatus; // overall judgment of the candidate
  completeness: number; // 0..1 (clamped); plotted by the cockpit as the score trajectory
  missing: string[]; // gaps the judge identified
  contradictions: string[]; // internal inconsistencies the judge found
  recommendation: VerdictRecommendation; // the action: accept=done, retry=iterate, escalate=hand to a human
  rationale?: string; // optional judge explanation (stored verbatim, never interpreted)
  judge?: string; // optional judge id/model — provenance for bias audits
}

// Evaluator-optimizer guardrails layered ON TOP of the judge's recommendation, so a judge that
// is stuck saying "retry" forever cannot loop unbounded. (max_iterations / token_budget /
// wall_clock_timeout from the base LoopConfig still apply as hard backstops underneath these.)
export interface EvaluatorOptimizerConfig {
  // Accept anyway (guardrail) once reported completeness reaches this, even if the judge said retry.
  completeness_target?: number;
  // Stop with "plateau" when the last `window` completeness scores span <= epsilon (no real progress).
  plateau?: { window: number; epsilon: number };
}

// Item 2 (loop-goal): the Referee-proposed, operator-approved acceptance bundle for a
// goal-driven loop. The qualitative `rubric` is how the Referee-as-judge scores each wave;
// completeness_target/plateau are the numeric guardrails (mirrored into
// config.evaluator_optimizer on approval so this verdict engine trips on them). Defined in
// this acyclic leaf so both store.ts and approvals.ts can reference it without a cycle.
export interface AcceptanceCriteria {
  rubric: string;
  completeness_target?: number;
  plateau?: { window: number; epsilon: number };
}

const STATUSES: VerdictStatus[] = ["complete", "partial", "incomplete"];
const RECOMMENDATIONS: VerdictRecommendation[] = ["accept", "retry", "escalate"];

function toStringArray(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
}

// Validate + coerce an untrusted verdict at the system boundary. Throws on invalid enum / score;
// clamps completeness to [0,1]; coerces missing/contradictions to string arrays; drops unknown keys.
export function normalizeVerdict(raw: unknown): Verdict {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("verdict must be an object");
  }
  const v = raw as Record<string, unknown>;
  if (!STATUSES.includes(v.status as VerdictStatus)) {
    throw new Error(`verdict.status must be one of: ${STATUSES.join(", ")}`);
  }
  if (!RECOMMENDATIONS.includes(v.recommendation as VerdictRecommendation)) {
    throw new Error(`verdict.recommendation must be one of: ${RECOMMENDATIONS.join(", ")}`);
  }
  if (typeof v.completeness !== "number" || !Number.isFinite(v.completeness)) {
    throw new Error("verdict.completeness must be a finite number in [0, 1]");
  }
  const completeness = Math.min(1, Math.max(0, v.completeness));
  return {
    status: v.status as VerdictStatus,
    completeness,
    missing: toStringArray(v.missing),
    contradictions: toStringArray(v.contradictions),
    recommendation: v.recommendation as VerdictRecommendation,
    ...(typeof v.rationale === "string" ? { rationale: v.rationale } : {}),
    ...(typeof v.judge === "string" ? { judge: v.judge } : {}),
  };
}

// ── The verdict evaluator (pure) ────────────────────────────────────────────────
// Decides the evaluator-optimizer outcome for one verdict, or null to keep iterating.
// `scores` is the completeness trajectory WITH this verdict's score already appended.
// Priority: the judge's explicit accept/escalate wins; otherwise (retry) the hub guardrails
// (completeness_target, then plateau) get a chance to stop a stuck loop.
export function evaluateVerdict(
  eo: EvaluatorOptimizerConfig | undefined,
  scores: number[],
  verdict: Verdict,
): VerdictStopReason | null {
  if (verdict.recommendation === "accept") return "accepted";
  if (verdict.recommendation === "escalate") return "escalated";

  // recommendation === "retry": apply hub-side guardrails.
  if (eo?.completeness_target !== undefined && verdict.completeness >= eo.completeness_target) {
    return "accepted";
  }
  if (eo?.plateau) {
    const { window: w, epsilon } = eo.plateau;
    if (w >= 2 && scores.length >= w) {
      const recent = scores.slice(-w);
      const span = Math.max(...recent) - Math.min(...recent);
      if (span <= epsilon) return "plateau";
    }
  }
  return null;
}
