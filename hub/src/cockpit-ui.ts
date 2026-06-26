// Cockpit UI — the live task-graph "cockpit" mode for the dashboard. Delivered as
// three string builders injected into dashboard.ts (styles → <style>, markup →
// body, script → inline <script>), so it ships with the existing single hub
// build + restart: no new routes, no static-file serving.
//
// The browser script carries verbatim copies of the unit-tested pure modules
// (cockpit-lease / cockpit-feed / cockpit-model / cockpit-dag) — the browser
// can't import them. KEEP THESE COPIES IDENTICAL to the .ts sources; they are the
// tested logic. The render layer builds DOM with createElement/textContent (never
// innerHTML) so agent-authored titles/handoffs can't inject and so this file
// stays free of nested template literals.
//
// Mobile-first: every view is a single vertical-scroll panel; the desktop-only
// dependency DAG simply does not mount below 820px (the dep meaning is delivered
// on mobile through the drawer's inline chips).

import { STALL_BEAT_MS } from "./constants.js";

export function cockpitStyles(): string {
  return `
/* ===== Cockpit ===== */
.mode-switch { display: flex; gap: 2px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 2px; margin: 0 4px; flex: none; }
.mode-btn { appearance: none; border: none; background: transparent; color: var(--text-secondary); font: inherit; font-size: 12px; padding: 4px 11px; border-radius: 6px; cursor: pointer; }
.mode-btn.active { background: var(--accent-soft); color: var(--accent-text); }
body.cockpit-mode .mobile-toggle { display: none; }
#cockpit { display: none; flex: 1; flex-direction: column; overflow: hidden; background: var(--bg-base); }
body.cockpit-mode #cockpit { display: flex; }
body.cockpit-mode > .container { display: none; }
.ck-bar { display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--border-subtle); background: var(--bg-raised); flex-wrap: wrap; }
.ck-proj { display: flex; align-items: center; gap: 6px; }
.ck-proj select { background: var(--bg-surface); color: var(--text-primary); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 5px 8px; font: inherit; font-size: 12px; max-width: 52vw; }
.ck-demo-flag { font-size: 10px; font-weight: 600; letter-spacing: .04em; color: var(--bg-base); background: var(--yellow); padding: 2px 6px; border-radius: 5px; }
.ck-del-plan { background: var(--bg-surface); color: var(--text-secondary); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 5px 8px; font: inherit; font-size: 12px; cursor: pointer; }
.ck-del-plan:hover:not(:disabled) { border-color: var(--red); color: var(--red); }
.ck-del-plan.armed { background: var(--red); color: var(--bg-base); border-color: var(--red); }
.ck-del-plan:disabled { opacity: .45; cursor: default; }
.ck-conn { font-size: 11px; color: var(--text-tertiary); margin-left: auto; display: flex; align-items: center; gap: 5px; }
.ck-conn .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); }
.ck-conn.stale .dot { background: transparent; box-shadow: inset 0 0 0 2px var(--yellow); }
.ck-tabs { display: flex; gap: 2px; padding: 6px 10px 0; border-bottom: 1px solid var(--border-subtle); background: var(--bg-raised); }
.ck-tab { appearance: none; border: none; background: transparent; color: var(--text-secondary); font: inherit; font-size: 13px; padding: 8px 12px; border-radius: 8px 8px 0 0; cursor: pointer; border-bottom: 2px solid transparent; }
.ck-tab.active { color: var(--text-primary); border-bottom-color: var(--accent-text); }
.ck-tab .n { color: var(--text-tertiary); font-size: 11px; margin-left: 4px; }
.ck-views { flex: 1; overflow: hidden; position: relative; }
.ck-view { position: absolute; inset: 0; overflow-y: auto; padding: 12px; display: none; }
.ck-view.active { display: block; }
.ck-empty { color: var(--text-tertiary); text-align: center; padding: 40px 16px; font-size: 13px; line-height: 1.6; }

/* Right Now rail */
.ck-inst { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius); padding: 10px 12px; margin-bottom: 8px; }
.ck-inst-head { display: flex; align-items: center; gap: 7px; margin-bottom: 4px; }
.ck-inst-head .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-tertiary); flex: none; }
.ck-inst-head .dot.online { background: var(--green); }
.ck-inst-name { font-weight: 600; font-size: 13px; }
.ck-inst-status { font-size: 11px; color: var(--text-tertiary); margin-left: auto; }
.ck-inst-task { font-size: 13px; color: var(--text-primary); margin: 2px 0 6px; }
.ck-inst-hand { font-size: 11px; color: var(--text-secondary); margin-top: 5px; border-left: 2px solid var(--border); padding-left: 8px; }
.ck-lease { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-secondary); }
.ck-lease-bar { flex: 1; height: 5px; border-radius: 3px; background: var(--bg-hover); overflow: hidden; }
.ck-lease-fill { height: 100%; background: var(--green); transition: width .9s linear; }
.ck-lease.soon .ck-lease-fill { background: var(--yellow); }
.ck-lease.urgent .ck-lease-fill { background: var(--red); }
.ck-lease.expired .ck-lease-fill { background: var(--red); width: 100% !important; }
.ck-lease-time { font-variant-numeric: tabular-nums; min-width: 60px; text-align: right; }
.ck-lease.urgent .ck-lease-time, .ck-lease.expired .ck-lease-time { color: var(--red); }
.ck-reclaim { color: var(--red); font-size: 10px; font-weight: 600; }

/* Board lanes */
.ck-lane { margin-bottom: 8px; border: 1px solid var(--border-subtle); border-radius: var(--radius); overflow: hidden; background: var(--bg-raised); }
.ck-lane-head { display: flex; align-items: center; gap: 8px; padding: 9px 11px; cursor: pointer; user-select: none; }
.ck-lane-head .caret { color: var(--text-tertiary); font-size: 10px; transition: transform .15s; }
.ck-lane.open .ck-lane-head .caret { transform: rotate(90deg); }
.ck-lane-label { font-size: 12px; font-weight: 600; letter-spacing: .02em; }
.ck-lane-count { font-size: 11px; color: var(--text-tertiary); }
.ck-lane-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.ck-lane-body { display: none; padding: 0 8px 8px; flex-direction: column; gap: 6px; }
.ck-lane.open .ck-lane-body { display: flex; }
.ck-chip { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-left: 3px solid var(--border-subtle); border-radius: 8px; padding: 8px 10px; cursor: pointer; }
.ck-chip:hover { background: var(--bg-hover); }
.ck-chip.lease-urgent { border-left-color: var(--red); }
.ck-chip.lease-soon { border-left-color: var(--yellow-text); }
.ck-chip.blocked { border-left-color: var(--red); }
.ck-chip-title { font-size: 13px; color: var(--text-primary); margin-bottom: 3px; }
.ck-chip-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--text-tertiary); flex-wrap: wrap; }
.ck-chip-owner { display: flex; align-items: center; gap: 4px; }
.ck-chip-owner .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-tertiary); }
.ck-chip-owner .dot.online { background: var(--green); }
.ck-prio { font-weight: 600; }
.ck-prio-0 { color: var(--red); } .ck-prio-1 { color: var(--yellow-text); }
.ck-ring { font-variant-numeric: tabular-nums; }
.ck-ring.urgent, .ck-ring.expired { color: var(--red); }
.ck-badge { font-size: 10px; padding: 1px 5px; border-radius: 5px; background: var(--bg-hover); color: var(--text-secondary); }
.ck-badge.ck-wedged { background: var(--red-soft); color: var(--red); font-weight: 600; } /* W4.1-a: dead-blocker wedge */

/* Feed */
.ck-feed-row { display: flex; gap: 9px; padding: 7px 4px; border-bottom: 1px solid var(--border-subtle); font-size: 12px; align-items: baseline; }
.ck-feed-time { color: var(--text-tertiary); font-variant-numeric: tabular-nums; font-size: 11px; min-width: 52px; flex: none; }
.ck-feed-kind { font-size: 10px; font-weight: 600; padding: 1px 5px; border-radius: 4px; background: var(--bg-hover); color: var(--text-secondary); flex: none; text-transform: uppercase; letter-spacing: .03em; }
.ck-feed-kind.transition { background: var(--accent-soft); color: var(--accent-text); }
.ck-feed-kind.handoff { background: var(--yellow); color: var(--bg-base); }
.ck-feed-kind.claim { background: var(--green); color: var(--bg-base); }
.ck-feed-kind.lease_expired, .ck-feed-kind.force { background: var(--red); color: var(--bg-base); }
.ck-feed-text { color: var(--text-secondary); }
.ck-feed-text b { color: var(--text-primary); font-weight: 600; }

/* DAG (desktop only) */
.ck-dag-wrap { width: 100%; height: 100%; overflow: auto; }
.ck-dag-svg { display: block; }
.ck-dag-node rect { rx: 7; stroke: var(--border-subtle); stroke-width: 1; }
.ck-dag-node text { fill: var(--text-primary); font-size: 11px; }
.ck-dag-node.flagged rect { stroke: var(--red); stroke-dasharray: 3 2; }
.ck-dag-edge { stroke: var(--text-tertiary); stroke-width: 1.4; fill: none; opacity: .55; }
.ck-dag-edge.flagged { stroke: var(--red); stroke-dasharray: 4 3; }
@media (max-width: 819px) { .ck-tab.dag-tab { display: none; } }

/* Drawer */
.ck-drawer-back { position: fixed; inset: 0; background: rgba(26,28,24,0.32); z-index: 60; display: none; }
.ck-drawer-back.open { display: block; }
.ck-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 92vw); background: var(--bg-raised); border-left: 1px solid var(--border-subtle); z-index: 61; transform: translateX(100%); transition: transform .2s cubic-bezier(.16,1,.3,1); display: flex; flex-direction: column; }
.ck-drawer.open { transform: translateX(0); }
.ck-drawer-head { display: flex; align-items: flex-start; gap: 8px; padding: 14px; border-bottom: 1px solid var(--border-subtle); }
.ck-drawer-title { font-size: 15px; font-weight: 600; flex: 1; }
.ck-drawer-close { appearance: none; border: none; background: var(--bg-surface); color: var(--text-secondary); width: 28px; height: 28px; border-radius: 7px; cursor: pointer; font-size: 16px; flex: none; }
.ck-drawer-body { flex: 1; overflow-y: auto; padding: 14px; }
.ck-section { margin-bottom: 16px; }
.ck-section h4 { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-tertiary); margin: 0 0 7px; }
.ck-kv { display: flex; gap: 8px; font-size: 12px; margin-bottom: 4px; }
.ck-kv span:first-child { color: var(--text-tertiary); min-width: 78px; }
.ck-dep { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; padding: 3px 7px; border-radius: 6px; background: var(--bg-surface); border: 1px solid var(--border-subtle); margin: 0 5px 5px 0; cursor: pointer; }
.ck-dep.missing { color: var(--text-tertiary); cursor: default; }
.ck-hand { border-left: 2px solid var(--border-subtle); padding: 0 0 0 10px; margin-bottom: 12px; }
.ck-hand.system { border-left-color: var(--red); }
.ck-hand-meta { font-size: 10px; color: var(--text-tertiary); margin-bottom: 3px; }
.ck-hand-summary { font-size: 12px; color: var(--text-primary); }
.ck-hand-next { font-size: 11px; color: var(--text-secondary); margin-top: 3px; }

/* A2: hide radio-only header controls in cockpit mode (ck-conn handles connection) */
body.cockpit-mode #status,
body.cockpit-mode .header-spacer,
body.cockpit-mode #filter-btn,
body.cockpit-mode #clear-btn { display: none !important; }

/* A1: "Needs you" pinned strip (Right-Now rail) */
.ck-needs { background: var(--red-soft); border: 1px solid var(--red-border); border-radius: var(--radius); padding: 9px 12px; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
.ck-needs-label { font-size: 12px; font-weight: 600; color: var(--red); flex: 1; }
.ck-needs-sub { font-size: 11px; color: var(--text-secondary); }

/* A1: needs-you count badge on Board tab */
.n.needs { background: var(--red); color: var(--bg-base); border-radius: 10px; padding: 1px 5px; font-size: 10px; font-weight: 700; margin-left: 3px; }

/* A3: stalled chip (expired lease = dead agent) — dimmer than lease-urgent */
.ck-chip.lease-stalled { border-left-color: rgba(162,59,35,0.45); opacity: 0.8; }

/* C5: beat-stall radar (owner quiet past threshold, lease STILL valid). Amber so it
   reads as a warning, visually distinct from the red expired/reclaim (A3) chip. */
.ck-chip.beat-stalled { border-left-color: var(--yellow-text); }
.ck-stall { color: var(--yellow-text); font-size: 10px; font-weight: 600; white-space: nowrap; }

/* A4: rail secondary task sub-chips */
.ck-inst-secondary { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.ck-inst-sec-chip { font-size: 10px; padding: 2px 7px; border-radius: 5px; cursor: pointer; background: var(--bg-hover); color: var(--text-secondary); border: 1px solid var(--border-subtle); white-space: nowrap; }
.ck-inst-sec-chip.review { background: var(--accent-soft); color: var(--accent-text); border-color: transparent; }
.ck-inst-sec-chip.blocked { background: var(--red-soft); color: var(--red); border-color: transparent; }

/* A4: feed filter row */
.ck-feed-filters { display: flex; gap: 4px; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle); margin-bottom: 6px; }
.ck-feed-fbtn { appearance: none; border: 1px solid var(--border-subtle); background: transparent; color: var(--text-secondary); font: inherit; font-size: 11px; padding: 3px 9px; border-radius: 6px; cursor: pointer; }
.ck-feed-fbtn.active { background: var(--accent-soft); color: var(--accent-text); border-color: transparent; }
.ck-feed-fbtn:hover:not(.active) { background: var(--bg-hover); }

/* A4: feed row coloring for blocked transitions */
.ck-feed-row.to-blocked .ck-feed-kind { background: var(--red-soft); color: var(--red); }
.ck-feed-row.to-blocked .ck-feed-text { color: var(--text-primary); }

/* A4: "N new" sticky pill in feed view */
.ck-feed-new-pill { position: sticky; top: 0; z-index: 5; display: flex; justify-content: center; padding: 4px 0 8px; pointer-events: none; }
.ck-feed-new-pill button { pointer-events: auto; background: var(--accent); color: var(--bg-base); border: none; border-radius: 12px; font: inherit; font-size: 11px; font-weight: 600; padding: 4px 12px; cursor: pointer; box-shadow: 0 2px 8px rgba(26,28,24,0.12); }

/* A5: mobile-only top-blockers strip on Board */
.ck-blockers-strip { background: var(--bg-raised); border: 1px solid var(--border-subtle); border-radius: var(--radius); padding: 8px 10px; margin-bottom: 10px; display: none; }
@media (max-width: 819px) { .ck-blockers-strip { display: block; } }
.ck-blockers-title { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; color: var(--text-tertiary); margin-bottom: 6px; }
.ck-blocker-row { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 3px 0; cursor: pointer; }
.ck-blocker-row:hover { color: var(--text-primary); }
.ck-blocker-count { font-size: 10px; font-weight: 700; color: var(--red); min-width: 14px; }
.ck-blocker-title { color: var(--text-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* A5: prefers-reduced-motion guards */
@media (prefers-reduced-motion: reduce) {
  .ck-lease-fill { transition: none !important; }
  .ck-drawer { transition: none !important; }
  .ck-lane-head .caret { transition: none !important; }
}

/* E1: Loop/Plan main toggle */
.ck-main-toggle { display: flex; gap: 2px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 2px; flex: none; }
.ck-main-btn { appearance: none; border: none; background: transparent; color: var(--text-secondary); font: inherit; font-size: 12px; padding: 4px 11px; border-radius: 6px; cursor: pointer; }
.ck-main-btn.active { background: var(--accent-soft); color: var(--accent-text); }
/* Pinned pending-approvals badge in the top bar — always visible (even off the Loop page); click jumps to the Loop page approvals. */
.ck-appr-badge { appearance: none; border: 1px solid transparent; background: var(--red-soft); color: var(--red); font: inherit; font-size: 11px; font-weight: 600; letter-spacing: .02em; padding: 3px 9px; border-radius: 999px; cursor: pointer; flex: none; }
.ck-appr-badge:hover { filter: brightness(1.06); }

/* E1: Loop view container (loop control + schedule + approvals) */
#ck-view-loop { display: none; flex: 1; overflow-y: auto; padding: 12px; flex-direction: column; }
body.ck-main-loop #ck-view-loop { display: flex; }
body.ck-main-loop #ck-plan-wrap { display: none; }
body.ck-main-loop .ck-proj { display: none; }
#ck-plan-wrap { display: flex; flex: 1; flex-direction: column; overflow: hidden; }

/* E1: Live fleet cards */
.ck-live-card { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius); padding: 10px 12px; margin-bottom: 8px; }
.ck-live-card.stale { opacity: 0.75; border-color: var(--yellow-border); }
.ck-live-card.offline { opacity: 0.45; }
.ck-live-head { display: flex; align-items: center; gap: 7px; margin-bottom: 4px; }
.ck-live-head .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-tertiary); flex: none; }
.ck-live-head .dot.online { background: var(--green); }
.ck-live-head .dot.stale { background: transparent; box-shadow: inset 0 0 0 2px var(--yellow); }
.ck-live-name { font-weight: 600; font-size: 13px; }
.ck-live-node { font-size: 10px; color: var(--text-tertiary); background: var(--bg-hover); padding: 1px 5px; border-radius: 4px; }
.ck-live-badge { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 5px; margin-left: auto; }
.ck-live-badge.live { background: var(--green-soft); color: var(--accent-text); }
.ck-live-badge.ghost { background: var(--yellow-soft); color: var(--yellow-text); }
.ck-live-badge.offline { background: var(--bg-hover); color: var(--text-tertiary); }
.ck-live-mission { font-size: 12px; color: var(--text-secondary); margin: 3px 0 4px; }
.ck-live-activity { display: flex; align-items: baseline; gap: 5px; font-size: 12px; color: var(--text-primary); margin-bottom: 5px; }
.ck-live-act-icon { color: var(--accent-text); font-size: 10px; flex: none; }
.ck-live-todos { display: flex; flex-direction: column; gap: 3px; margin-bottom: 5px; }
.ck-live-todo { display: flex; align-items: baseline; gap: 5px; font-size: 11px; color: var(--text-secondary); }
.ck-live-todo.done .ck-live-todo-text { text-decoration: line-through; color: var(--text-tertiary); }
.ck-live-todo.inprog .ck-live-todo-text { color: var(--accent-text); }
.ck-live-todo-icon { flex: none; font-size: 11px; }
.ck-live-sub { font-size: 10px; color: var(--text-tertiary); margin-top: 4px; }
/* WS2: per-agent context gauge — mirrors the FROZEN consumer contract (absolute thresholds, bar max = red trigger, grey on ts-stale) */
.ck-live-ctx { display: flex; align-items: center; gap: 7px; margin: 4px 0 2px; }
.ck-live-ctx-label { font-size: 10px; color: var(--text-tertiary); flex: none; letter-spacing: .03em; }
.ck-live-ctx-bar { flex: 1; height: 5px; border-radius: 3px; background: var(--bg-hover); overflow: hidden; }
.ck-live-ctx-fill { height: 100%; width: 0; border-radius: 3px; background: var(--green); transition: width .9s linear; }
.ck-live-ctx.amber .ck-live-ctx-fill { background: var(--yellow); }
.ck-live-ctx.red .ck-live-ctx-fill { background: var(--red); }
.ck-live-ctx-val { font-size: 10px; font-variant-numeric: tabular-nums; color: var(--text-secondary); flex: none; min-width: 34px; text-align: right; }
.ck-live-ctx.amber .ck-live-ctx-val { color: var(--yellow-text); }
.ck-live-ctx.red .ck-live-ctx-val { color: var(--red); font-weight: 600; }
/* parked = gauge frozen (ts-stale) but agent still present: count is still accurate, so KEEP the band color and mark with a dashed track — never grey (would lie) */
.ck-live-ctx.parked .ck-live-ctx-bar { border: 1px dashed var(--text-tertiary); }
/* ts-stale AND presence gone = value untrusted: grey the gauge — NOT a compaction signal (conductor stays ts-keyed) */
.ck-live-ctx.stale { opacity: 0.5; }
.ck-live-ctx.stale .ck-live-ctx-fill { background: var(--text-tertiary); }
.ck-live-ctx.stale .ck-live-ctx-val { color: var(--text-tertiary); font-weight: 400; }
/* pending = gauge not yet reported (null tokens or null ts) */
.ck-live-ctx.pending .ck-live-ctx-bar { display: none; }
.ck-live-ctx.pending .ck-live-ctx-val { color: var(--text-tertiary); min-width: 0; }
/* compact gauge variant: board chips + Right-Now rail — bar only (full count on hover), tighter margins, no label/value */
.ck-live-ctx.ck-ctx-compact { margin: 5px 0 1px; }

/* ===== Operator Control Panel (WS-C) ===== */
.ck-launch-ref { appearance: none; border: 1px solid var(--border-subtle); background: var(--bg-surface); color: var(--text-secondary); font: inherit; font-size: 12px; padding: 4px 11px; border-radius: 6px; cursor: pointer; flex: none; }
.ck-launch-ref:hover { border-color: var(--accent-text); color: var(--accent-text); background: var(--accent-soft); }
.ck-launch-ref:disabled { opacity: 0.5; cursor: default; }
/* "+ New Plan" — create a project from the cockpit (admin-bearer /admin-project-create) */
.ck-new-plan { appearance: none; border: 1px solid var(--border-subtle); background: var(--bg-surface); color: var(--text-secondary); font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer; flex: none; }
.ck-new-plan:hover { border-color: var(--accent-text); color: var(--accent-text); background: var(--accent-soft); }
.ck-newplan-pop { position: relative; }
.ck-newplan-form { position: absolute; top: calc(100% + 6px); left: 0; z-index: 70; display: none; flex-direction: column; gap: 6px; width: 280px; padding: 12px; background: var(--bg-raised); border: 1px solid var(--border-subtle); border-radius: 10px; box-shadow: 0 6px 24px rgba(26,28,24,0.18); }
.ck-newplan-form.open { display: flex; }
.ck-newplan-form input { background: var(--bg-surface); color: var(--text-primary); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 12px; }
.ck-newplan-row { display: flex; gap: 6px; justify-content: flex-end; align-items: center; }
.ck-newplan-row button { appearance: none; border: 1px solid var(--border-subtle); background: var(--bg-surface); color: var(--text-secondary); font: inherit; font-size: 12px; padding: 4px 11px; border-radius: 6px; cursor: pointer; }
.ck-newplan-create { background: var(--accent) !important; color: var(--bg-base) !important; border-color: transparent !important; font-weight: 600; }
.ck-newplan-create:disabled { opacity: 0.5; cursor: default; }
.ck-newplan-msg { font-size: 11px; color: var(--text-secondary); margin-right: auto; }
.ck-newplan-msg.err { color: var(--red, #c0392b); }
/* Conductor card — persistent operator section, outside the render-wiped views */
.ck-cond { flex: none; border-bottom: 1px solid var(--border-subtle); background: var(--bg-raised); }
.ck-cond-head { display: flex; align-items: center; gap: 8px; padding: 7px 12px; cursor: pointer; user-select: none; }
.ck-cond-head .ck-cond-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-tertiary); flex: none; }
.ck-cond-head .ck-cond-dot.running { background: var(--green); }
.ck-cond-title { font-size: 12px; font-weight: 600; letter-spacing: .02em; }
.ck-cond-state { font-size: 11px; color: var(--text-tertiary); }
.ck-cond-state.armed { color: var(--red); font-weight: 600; }
.ck-cond-caret { margin-left: auto; color: var(--text-tertiary); font-size: 10px; transition: transform .15s; }
.ck-cond.open .ck-cond-caret { transform: rotate(90deg); }
.ck-cond-body { padding: 2px 12px 11px; display: none; flex-direction: column; gap: 9px; }
.ck-cond.open .ck-cond-body { display: flex; }
.ck-cond-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ck-cond-btn { appearance: none; border: 1px solid var(--border-subtle); background: var(--bg-surface); color: var(--text-secondary); font: inherit; font-size: 12px; padding: 4px 10px; border-radius: 6px; cursor: pointer; }
.ck-cond-btn:hover { border-color: var(--accent-text); color: var(--accent-text); }
.ck-cond-btn:disabled { opacity: 0.5; cursor: default; }
.ck-cond-seg { display: flex; gap: 2px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 2px; }
.ck-cond-seg-btn { appearance: none; border: none; background: transparent; color: var(--text-secondary); font: inherit; font-size: 12px; padding: 4px 11px; border-radius: 6px; cursor: pointer; }
.ck-cond-seg-btn.active { background: var(--accent-soft); color: var(--accent-text); }
.ck-cond-seg-btn.active[data-mode="armed"] { background: var(--red-soft); color: var(--red); }
.ck-cond-seg-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ck-cond-field { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--text-secondary); }
.ck-cond-field input { width: 62px; background: var(--bg-surface); color: var(--text-primary); border: 1px solid var(--border-subtle); border-radius: 6px; padding: 4px 6px; font: inherit; font-size: 12px; }
.ck-cond-flagged { display: flex; flex-direction: column; gap: 3px; }
.ck-cond-flagged-label { font-size: 11px; color: var(--text-tertiary); margin-bottom: 2px; }
.ck-cond-flagged-row { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--text-primary); }
.ck-cond-flagged-cs { font-weight: 600; }
.ck-cond-flagged-reason { color: var(--text-tertiary); font-size: 11px; margin-right: auto; }
.ck-cond-msg { font-size: 11px; color: var(--text-tertiary); min-height: 13px; }
.ck-cond-msg.err { color: var(--red); }
/* Pin chip — per-agent in Right Now + inline in the flagged list (kill-exempt) */
.ck-pin { appearance: none; border: 1px solid var(--border-subtle); background: transparent; color: var(--text-tertiary); font: inherit; font-size: 10px; font-weight: 600; letter-spacing: .03em; padding: 2px 7px; border-radius: 10px; cursor: pointer; flex: none; }
.ck-pin:hover { border-color: var(--accent-text); color: var(--accent-text); }
.ck-pin.pinned { background: var(--accent-soft); border-color: transparent; color: var(--accent-text); }
.ck-inst-pin { margin-left: 6px; }
/* Phase 3: governed-loop schedule card (scheduled-vs-actual fire times). Self-contained
   ck-loops block — P2's control card is the separate ck-lctl. */
.ck-loops { padding: 0 10px 10px; }
.ck-loops-hdr { display: flex; align-items: center; gap: 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--text-tertiary); margin: 10px 0 5px; cursor: pointer; user-select: none; }
.ck-loops-count { color: var(--text-tertiary); text-transform: none; letter-spacing: 0; }
.ck-loops-caret { margin-left: auto; font-size: 10px; transition: transform .15s; }
.ck-loops.open .ck-loops-caret { transform: rotate(90deg); }
.ck-loops-body { display: none; }
.ck-loops.open .ck-loops-body { display: block; }
.ck-loops-row { border: 1px solid var(--border-subtle); border-radius: 6px; padding: 6px 9px; margin-bottom: 5px; background: var(--bg-raised); }
.ck-loops-row.done { opacity: .55; }
.ck-loops-head { display: flex; align-items: center; gap: 8px; }
.ck-loops-label { font-weight: 600; font-size: 12px; color: var(--text-primary); }
.ck-loops-status { font-size: 10px; padding: 1px 7px; border-radius: 999px; background: var(--bg-hover); color: var(--text-secondary); text-transform: uppercase; letter-spacing: .04em; }
.ck-loops-status.running { color: var(--green); }
.ck-loops-status.paused { color: var(--yellow); }
.ck-loops-sched { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; color: var(--text-secondary); margin-top: 4px; }
.ck-loops-int { color: var(--text-tertiary); }
.ck-loops-next.bad { color: var(--red); }
.ck-loops-drift.ok { color: var(--green); }
.ck-loops-drift.warn { color: var(--yellow); }
.ck-loops-drift.bad { color: var(--red); }

/* ===== Operator Loops panel (Phase 2) ===== */
/* Persistent collapsible operator section (mirrors the Conductor card): admin-token
   gated loop visibility + override pause/resume/terminate, outside the render-wiped views. */
.ck-lctl { flex: none; border-bottom: 1px solid var(--border-subtle); background: var(--bg-raised); }
.ck-lctl-head { display: flex; align-items: center; gap: 8px; padding: 7px 12px; cursor: pointer; user-select: none; }
.ck-lctl-head .ck-lctl-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-tertiary); flex: none; }
.ck-lctl-head .ck-lctl-dot.active { background: var(--green); }
.ck-lctl-title { font-size: 12px; font-weight: 600; letter-spacing: .02em; }
.ck-lctl-count { font-size: 11px; color: var(--text-tertiary); }
.ck-lctl-caret { margin-left: auto; color: var(--text-tertiary); font-size: 10px; transition: transform .15s; }
.ck-lctl.open .ck-lctl-caret { transform: rotate(90deg); }
.ck-lctl-body { padding: 2px 12px 11px; display: none; flex-direction: column; gap: 8px; }
.ck-lctl.open .ck-lctl-body { display: flex; }
.ck-lctl-empty { font-size: 12px; color: var(--text-tertiary); padding: 4px 0; }
.ck-lctl-msg { font-size: 11px; color: var(--text-tertiary); min-height: 13px; }
.ck-lctl-msg.err { color: var(--red); }
.ck-lctl-card { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-left: 3px solid var(--border-subtle); border-radius: var(--radius); padding: 9px 11px; }
.ck-lctl-card.warn { border-left-color: var(--yellow-text); }
.ck-lctl-card.crit { border-left-color: var(--red); }
.ck-lctl-card.terminal { opacity: 0.6; }
.ck-lctl-card-head { display: flex; align-items: center; gap: 7px; margin-bottom: 2px; }
.ck-lctl-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.ck-lctl-badge { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 5px; margin-left: auto; flex: none; }
.ck-lctl-badge.running { background: var(--green-soft); color: var(--accent-text); }
.ck-lctl-badge.paused { background: var(--yellow-soft); color: var(--yellow-text); }
.ck-lctl-badge.stopped, .ck-lctl-badge.completed { background: var(--bg-hover); color: var(--text-tertiary); }
.ck-lctl-meta { font-size: 11px; color: var(--text-tertiary); margin-bottom: 7px; display: flex; gap: 6px; flex-wrap: wrap; }
.ck-lctl-gauges { display: flex; flex-direction: column; gap: 5px; margin-bottom: 8px; }
.ck-lctl-gauge { display: flex; align-items: center; gap: 8px; font-size: 11px; }
.ck-lctl-gauge-label { color: var(--text-tertiary); flex: none; min-width: 64px; letter-spacing: .02em; }
.ck-lctl-bar { flex: 1; height: 5px; border-radius: 3px; background: var(--bg-hover); overflow: hidden; }
.ck-lctl-fill { height: 100%; border-radius: 3px; background: var(--green); }
.ck-lctl-fill.warn { background: var(--yellow); }
.ck-lctl-fill.crit { background: var(--red); }
.ck-lctl-fill.info { background: var(--accent); }
.ck-lctl-gauge-val { color: var(--text-secondary); font-variant-numeric: tabular-nums; flex: none; min-width: 84px; text-align: right; }
.ck-lctl-spark { margin-bottom: 8px; }
.ck-lctl-spark-label { font-size: 10px; color: var(--text-tertiary); letter-spacing: .03em; margin-bottom: 3px; }
.ck-lctl-spark-svg { width: 100%; height: 22px; display: block; background: var(--bg-hover); border-radius: 4px; }
.ck-lctl-spark-line { fill: none; stroke: var(--accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.ck-lctl-verdict { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.ck-lctl-verdict-rec { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 5px; text-transform: uppercase; letter-spacing: .03em; background: var(--bg-hover); color: var(--text-secondary); }
.ck-lctl-verdict-rec.accept { background: var(--green-soft); color: var(--accent-text); }
.ck-lctl-verdict-rec.retry { background: var(--yellow-soft); color: var(--yellow-text); }
.ck-lctl-verdict-rec.escalate { background: var(--red-soft); color: var(--red); }
.ck-lctl-verdict-status { font-size: 11px; color: var(--text-tertiary); }
.ck-lctl-actions { display: flex; gap: 6px; }
.ck-lctl-btn { appearance: none; border: 1px solid var(--border-subtle); background: var(--bg-surface); color: var(--text-secondary); font: inherit; font-size: 11px; padding: 3px 10px; border-radius: 6px; cursor: pointer; }
.ck-lctl-btn:hover:not(:disabled) { border-color: var(--accent-text); color: var(--accent-text); }
.ck-lctl-btn:disabled { opacity: 0.4; cursor: default; }
.ck-lctl-btn.danger:hover:not(:disabled) { border-color: var(--red); color: var(--red); }

/* ===== Operator Approvals panel (Phase 5 HITL — integration) ===== */
/* Self-contained sibling to ck-lctl: the human-in-the-loop queue for escalated loops. */
.ck-appr { flex: none; border-bottom: 1px solid var(--border-subtle); background: var(--bg-raised); }
.ck-appr-head { display: flex; align-items: center; gap: 8px; padding: 7px 12px; cursor: pointer; user-select: none; }
.ck-appr-head .ck-appr-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-tertiary); flex: none; }
.ck-appr-head .ck-appr-dot.pending { background: var(--red); }
.ck-appr-title { font-size: 12px; font-weight: 600; letter-spacing: .02em; }
.ck-appr-count { font-size: 11px; color: var(--text-tertiary); }
.ck-appr-count.pending { color: var(--red); font-weight: 600; }
.ck-appr-caret { margin-left: auto; color: var(--text-tertiary); font-size: 10px; transition: transform .15s; }
.ck-appr.open .ck-appr-caret { transform: rotate(90deg); }
.ck-appr-body { padding: 2px 12px 11px; display: none; flex-direction: column; gap: 8px; }
.ck-appr.open .ck-appr-body { display: flex; }
.ck-appr-empty { font-size: 12px; color: var(--text-tertiary); padding: 4px 0; }
.ck-appr-msg { font-size: 11px; color: var(--text-tertiary); min-height: 13px; }
.ck-appr-msg.err { color: var(--red); }
.ck-appr-card { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-left: 3px solid var(--red); border-radius: var(--radius); padding: 9px 11px; }
.ck-appr-cardhead { display: flex; align-items: center; gap: 7px; margin-bottom: 3px; }
.ck-appr-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.ck-appr-badge { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 5px; margin-left: auto; flex: none; background: var(--red-soft); color: var(--red); text-transform: uppercase; letter-spacing: .03em; }
.ck-appr-verdict { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 11px; margin-bottom: 5px; }
.ck-appr-rec { font-size: 10px; font-weight: 600; padding: 1px 6px; border-radius: 5px; text-transform: uppercase; letter-spacing: .03em; background: var(--red-soft); color: var(--red); }
.ck-appr-vstatus { color: var(--text-tertiary); }
.ck-appr-gap { color: var(--text-secondary); }
.ck-appr-reason { font-size: 12px; color: var(--text-secondary); margin-bottom: 7px; }
.ck-appr-rationale { font-size: 11px; color: var(--text-tertiary); border-left: 2px solid var(--border-subtle); padding-left: 8px; margin-bottom: 7px; }
.ck-appr-meta { font-size: 10px; color: var(--text-tertiary); margin-bottom: 7px; }
.ck-appr-actions { display: flex; gap: 6px; }
.ck-appr-btn { appearance: none; border: 1px solid var(--border-subtle); background: var(--bg-surface); color: var(--text-secondary); font: inherit; font-size: 11px; padding: 3px 10px; border-radius: 6px; cursor: pointer; }
.ck-appr-btn:disabled { opacity: 0.4; cursor: default; }
.ck-appr-btn.approve:hover:not(:disabled) { border-color: var(--accent-text); color: var(--accent-text); background: var(--accent-soft); }
.ck-appr-btn.reject:hover:not(:disabled) { border-color: var(--red); color: var(--red); }

/* Interactive terminal — in-place takeover of the radio chat/message area.
   The panel markup lives inside .message-area (dashboard.ts) so the terminal
   REPLACES the message list + composer while the sidebar (channels + On-Air
   roster) and task board stay visible. Backend ticket/WS flow is unchanged —
   only the mount + chrome moved off the old centered modal. (.message-area is
   position:relative so this absolute panel fills exactly the chat column.) */
.ck-inst-name.ck-term-open { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px; }
.ck-inst-name.ck-term-open:hover { color: var(--accent-text); }
.ck-term-overlay { position: absolute; inset: 0; z-index: 30; background: #FEFCF6; display: none; flex-direction: column; }
.ck-term-overlay.open { display: flex; }
/* No terminal-local chrome: the body fills the whole takeover. The active agent
   name + connection status surface on the MAIN app header (#term-active-label);
   exit/restore is channel-click or Esc (no in-panel Close/Release buttons). */
.ck-term-modal { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.ck-term-body { flex: 1; min-height: 0; padding: 6px; background: #FEFCF6; }
.ck-term-body .xterm { height: 100%; }
/* MOBILE: the terminal stays an in-place takeover of the chat column
   (.message-area) at ALL widths — it never goes whole-screen. The header + top
   menu / channel nav sit OUTSIDE .message-area, so they stay visible exactly like
   the normal chat view (operator can still open the channel drawer + navigate). */
`;
}

export function cockpitMarkup(): string {
  return `
<div id="cockpit">
  <div class="ck-bar">
    <div class="ck-main-toggle">
      <button class="ck-main-btn active" data-main="loop">Loop</button>
      <button class="ck-main-btn" data-main="plan">Plan</button>
    </div>
    <div class="ck-proj">
      <select id="ck-project" aria-label="Project"></select>
      <span id="ck-demo-flag" class="ck-demo-flag" style="display:none">DEMO</span>
      <div class="ck-newplan-pop">
        <button class="ck-new-plan" id="ck-new-plan" title="Create a new plan">+ New Plan</button>
        <div class="ck-newplan-form" id="ck-newplan-form">
          <input id="ck-newplan-title" type="text" placeholder="Plan title" aria-label="Plan title" maxlength="200" />
          <input id="ck-newplan-brief" type="text" placeholder="Brief (optional)" aria-label="Plan brief" maxlength="500" />
          <div class="ck-newplan-row">
            <span class="ck-newplan-msg" id="ck-newplan-msg"></span>
            <button id="ck-newplan-cancel" type="button">Cancel</button>
            <button class="ck-newplan-create" id="ck-newplan-create" type="button">Create</button>
          </div>
        </div>
      </div>
      <button class="ck-del-plan" id="ck-del-plan" type="button" title="Delete the selected plan and its tasks">Delete</button>
    </div>
    <button class="ck-launch-ref" id="ck-launch-ref" title="Spawn a headless referee on this hub (tmux)">+ Referee</button>
    <button class="ck-appr-badge" id="ck-appr-badge" style="display:none" title="Pending approvals — open the Loop page">⚠ approvals <span id="ck-appr-badge-n">0</span></button>
    <div id="ck-conn" class="ck-conn"><span class="dot"></span><span id="ck-conn-text">live</span></div>
  </div>
  <div id="ck-cond" class="ck-cond">
    <div class="ck-cond-head" id="ck-cond-head">
      <span class="ck-cond-dot" id="ck-cond-dot"></span>
      <span class="ck-cond-title">Conductor</span>
      <span class="ck-cond-state" id="ck-cond-state">—</span>
      <span class="ck-cond-caret" id="ck-cond-caret">▸</span>
    </div>
    <div class="ck-cond-body" id="ck-cond-body">
      <div class="ck-cond-row">
        <button class="ck-cond-btn" id="ck-cond-start">Start</button>
        <button class="ck-cond-btn" id="ck-cond-stop">Stop</button>
        <div class="ck-cond-seg" id="ck-cond-mode" role="group" aria-label="Conductor mode">
          <button class="ck-cond-seg-btn active" data-mode="observe">Observe</button>
          <button class="ck-cond-seg-btn" data-mode="armed" id="ck-cond-armed-btn" disabled title="Review the flagged set and pin any deliberately-idle agents before arming">Armed</button>
        </div>
      </div>
      <div class="ck-cond-row">
        <label class="ck-cond-field">idle window<input type="number" id="ck-cond-idle" min="60" step="10" aria-label="Idle window (seconds)"> s</label>
        <label class="ck-cond-field">interval<input type="number" id="ck-cond-interval" min="5" step="1" aria-label="Tick interval (seconds)"> s</label>
        <button class="ck-cond-btn" id="ck-cond-apply">Apply</button>
      </div>
      <div class="ck-cond-row">
        <label class="ck-cond-field">max agents<input type="number" id="ck-cond-fleetmax" min="1" max="20" step="1" value="20" aria-label="Max concurrent agents"></label>
        <button class="ck-cond-btn" id="ck-cond-fleetmax-btn">Set</button>
      </div>
      <div class="ck-cond-flagged" id="ck-cond-flagged"></div>
      <div class="ck-cond-msg" id="ck-cond-msg"></div>
    </div>
  </div>
  <div id="ck-view-loop">
    <div id="ck-lctl" class="ck-lctl open">
      <div class="ck-lctl-head" id="ck-lctl-head">
        <span class="ck-lctl-dot" id="ck-lctl-dot"></span>
        <span class="ck-lctl-title">Loop Control</span>
        <span class="ck-lctl-count" id="ck-lctl-count"></span>
        <span class="ck-lctl-caret" id="ck-lctl-caret">▸</span>
      </div>
      <div class="ck-lctl-body" id="ck-lctl-body">
        <div id="ck-lctl-list"></div>
        <div class="ck-lctl-msg" id="ck-lctl-msg"></div>
      </div>
    </div>
    <div id="ck-loops" class="ck-loops"></div>
    <div id="ck-appr" class="ck-appr open">
      <div class="ck-appr-head" id="ck-appr-head">
        <span class="ck-appr-dot" id="ck-appr-dot"></span>
        <span class="ck-appr-title">Approvals</span>
        <span class="ck-appr-count" id="ck-appr-count"></span>
        <span class="ck-appr-caret" id="ck-appr-caret">▸</span>
      </div>
      <div class="ck-appr-body" id="ck-appr-body">
        <div id="ck-appr-list"></div>
        <div class="ck-appr-msg" id="ck-appr-msg"></div>
      </div>
    </div>
  </div>
  <div id="ck-plan-wrap">
    <div class="ck-tabs">
      <button class="ck-tab active" data-view="ops">Right Now<span class="n" id="ck-n-ops"></span></button>
      <button class="ck-tab" data-view="board">Board<span class="n" id="ck-n-board"></span><span class="n needs" id="ck-n-needs" style="display:none"></span></button>
      <button class="ck-tab dag-tab" data-view="dag">Graph</button>
      <button class="ck-tab" data-view="feed">Feed<span class="n" id="ck-n-feed"></span></button>
    </div>
    <div class="ck-views">
      <div class="ck-view active" id="ck-view-ops"></div>
      <div class="ck-view" id="ck-view-board"></div>
      <div class="ck-view" id="ck-view-dag"><div class="ck-dag-wrap" id="ck-dag-wrap"></div></div>
      <div class="ck-view" id="ck-view-feed"></div>
    </div>
  </div>
</div>
<div class="ck-drawer-back" id="ck-drawer-back"></div>
<aside class="ck-drawer" id="ck-drawer" aria-hidden="true">
  <div class="ck-drawer-head">
    <div class="ck-drawer-title" id="ck-drawer-title"></div>
    <button class="ck-drawer-close" id="ck-drawer-close" aria-label="Close">×</button>
  </div>
  <div class="ck-drawer-body" id="ck-drawer-body"></div>
</aside>
<!-- Interactive terminal panel markup now lives INSIDE .message-area in
     dashboard.ts so it takes over the radio chat area in place (not this old
     body-level modal). openTerminal/closeTerminal still bind it by id via
     $ = getElementById, so the move is transparent to the terminal logic below. -->
`;
}

// The browser script. Exposes window.__cockpit = { onPlanUpdate, onReconnect, show, hide }.
// `token` threads the operator-control Bearer token into the cockpit's own scope so its
// admin POSTs (launch-referee, conductor config/start/stop, fleet-max, pin) are gated exactly
// like the dashboard. The PROD call-site (dashboard.ts getDashboardHTML) now passes the SCOPED
// cockpit token (A3-a), NOT the raw admin token — the hub accepts the scoped token on those
// admin routes. The default "" (no-arg test path) yields an empty Bearer → 401 fail-SAFE,
// never fail-open. Function-replacer (not a string pattern) so a "$"-bearing token is inserted
// verbatim.
export function cockpitScript(token: string = ""): string {
  return COCKPIT_SCRIPT.replace("__WT_ADMIN_TOKEN__", () => token);
}

const COCKPIT_SCRIPT = String.raw`
(function () {
  "use strict";

  // ========== operator-control admin auth (WS-C) ==========
  // Bearer token threaded in by cockpitScript(adminToken); empty on the no-arg test path
  // (→ 401 fail-safe). Same blast radius as the dashboard script in this same page.
  var ADMIN_TOKEN = "__WT_ADMIN_TOKEN__";
  var adminHeaders = { "Content-Type": "application/json", "Authorization": "Bearer " + ADMIN_TOKEN };

  // ========== verbatim copies of tested pure modules ==========
  // KEEP IDENTICAL to cockpit-lease.ts / cockpit-feed.ts / cockpit-model.ts / cockpit-dag.ts.
  var URGENT_S = 60, SOON_S = 300;
  var STALL_BEAT_MS = ${STALL_BEAT_MS};
  function serverClockOffset(serverNow, clientNow) { return serverNow - clientNow; }
  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }
  function leaseState(o) {
    var claimedAt = o.claimedAt, leaseExpiresAt = o.leaseExpiresAt, clientNow = o.clientNow, offset = o.offset;
    if (leaseExpiresAt == null) return { hasLease: false, secondsLeft: 0, urgency: "ok", label: "—", fraction: null };
    var effNow = clientNow + offset;
    var remMs = leaseExpiresAt - effNow;
    var secondsLeft = remMs <= 0 ? 0 : Math.floor(remMs / 1000);
    var urgency = remMs <= 0 ? "expired" : secondsLeft < URGENT_S ? "urgent" : secondsLeft < SOON_S ? "soon" : "ok";
    var label = urgency === "expired" ? "expired" : pad2(Math.floor(secondsLeft / 60)) + ":" + pad2(secondsLeft % 60) + " left";
    var fraction;
    if (remMs <= 0) fraction = 0;
    else if (claimedAt == null) fraction = null;
    else { var w = leaseExpiresAt - claimedAt; fraction = w > 0 ? clamp01(remMs / w) : null; }
    return { hasLease: true, secondsLeft: secondsLeft, urgency: urgency, label: label, fraction: fraction };
  }
  function stallState(o) {
    var lastSeenAt = o.lastSeenAt, leaseExpiresAt = o.leaseExpiresAt, clientNow = o.clientNow, offset = o.offset;
    var effNow = clientNow + offset;
    if (leaseExpiresAt == null || leaseExpiresAt - effNow <= 0) return { beatAgeMs: null, stalled: false, label: null };
    if (lastSeenAt == null || lastSeenAt <= 0) return { beatAgeMs: null, stalled: false, label: null };
    var beatAgeMs = Math.max(0, effNow - lastSeenAt);
    var stalled = beatAgeMs > STALL_BEAT_MS;
    if (!stalled) return { beatAgeMs: beatAgeMs, stalled: false, label: null };
    var mins = Math.floor(beatAgeMs / 60000);
    var label = mins >= 1 ? mins + "m idle" : Math.floor(beatAgeMs / 1000) + "s idle";
    return { beatAgeMs: beatAgeMs, stalled: true, label: label };
  }
  function feedKey(e) { return e.id != null ? "id:" + e.id : e.taskId + "|" + e.kind + "|" + e.ts; }
  function chronological(a, b) {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return (a.id == null ? Number.MAX_SAFE_INTEGER : a.id) - (b.id == null ? Number.MAX_SAFE_INTEGER : b.id);
  }
  function mergeFeed(existing, incoming, opts) {
    var base = Array.isArray(existing) ? existing : [];
    if (!Array.isArray(incoming)) return base;
    var seen = {}, merged = [];
    for (var i = 0; i < base.length; i++) { var it = base[i]; if (it && typeof it.key === "string" && !seen[it.key]) { seen[it.key] = 1; merged.push(it); } }
    for (var j = 0; j < incoming.length; j++) {
      var raw = incoming[j];
      if (!raw || typeof raw.taskId !== "string" || typeof raw.ts !== "number") continue;
      var k = feedKey(raw); if (seen[k]) continue; seen[k] = 1;
      var copy = {}; for (var p in raw) copy[p] = raw[p]; copy.key = k; merged.push(copy);
    }
    merged.sort(chronological);
    var lim = opts && opts.limit;
    if (typeof lim === "number" && lim >= 0 && merged.length > lim) return merged.slice(merged.length - lim);
    return merged;
  }
  var STATUS_META = {
    proposed: { label: "Proposed", group: "backlog" }, ratified: { label: "Ratified", group: "backlog" },
    ready: { label: "Ready", group: "active" }, claimed: { label: "Claimed", group: "active" },
    in_progress: { label: "In progress", group: "active" }, review: { label: "Review", group: "active" },
    blocked: { label: "Blocked", group: "active" }, done: { label: "Done", group: "terminal" },
    failed: { label: "Failed", group: "terminal" }, abandoned: { label: "Abandoned", group: "terminal" }
  };
  var IN_FLIGHT = { claimed: 1, in_progress: 1, review: 1 };
  var INSTANCE_PICK = { in_progress: 0, claimed: 1, review: 2 };
  function buildCockpitModel(board, presence) {
    if (!board || typeof board !== "object" || !board.lanes || typeof board.lanes !== "object") {
      return { project: null, lanes: emptyLanes(), instances: [], byId: {}, blockedBy: {}, blocks: {} };
    }
    var presenceBySid = {};
    if (Array.isArray(presence)) for (var i = 0; i < presence.length; i++) { var pr = presence[i]; if (pr && typeof pr.sid === "string") presenceBySid[pr.sid] = pr; }
    var blockedBy = {}, blocks = {};
    var deps = Array.isArray(board.deps) ? board.deps : [];
    for (var d = 0; d < deps.length; d++) { var dep = deps[d]; if (!dep || typeof dep.task_id !== "string" || typeof dep.blocks_on !== "string") continue; (blockedBy[dep.task_id] || (blockedBy[dep.task_id] = [])).push(dep.blocks_on); (blocks[dep.blocks_on] || (blocks[dep.blocks_on] = [])).push(dep.task_id); }
    var childSummaries = board.childSummaries && typeof board.childSummaries === "object" ? board.childSummaries : {};
    var byId = {};
    function enrich(t) {
      var p = t.owner_sid ? presenceBySid[t.owner_sid] : undefined;
      var ownerLabel = p ? p.name : (t.owner != null ? t.owner : (t.owner_sid ? t.owner_sid.slice(0, 6) : null));
      var mt = {}; for (var q in t) mt[q] = t[q];
      mt.ownerLabel = ownerLabel; mt.ownerOnline = p ? p.online : false;
      mt.ownerLastSeenAt = p && typeof p.lastSeenAt === "number" ? p.lastSeenAt : null;
      mt.blockedByCount = blockedBy[t.id] ? blockedBy[t.id].length : 0;
      mt.blocksCount = blocks[t.id] ? blocks[t.id].length : 0;
      mt.childSummary = childSummaries[t.id] || null;
      byId[t.id] = mt; return mt;
    }
    var statusKeys = Object.keys(STATUS_META);
    for (var s in board.lanes) if (!(s in STATUS_META)) statusKeys.push(s);
    var lanes = statusKeys.map(function (status) {
      var raw = Array.isArray(board.lanes[status]) ? board.lanes[status] : [];
      var tasks = raw.map(enrich).sort(function (a, b) { return a.priority !== b.priority ? a.priority - b.priority : a.created_at - b.created_at; });
      var meta = STATUS_META[status];
      return { status: status, label: meta ? meta.label : status, group: meta ? meta.group : "active", tasks: tasks, count: tasks.length };
    });
    var byInstance = {}, allInstTasks = {};
    for (var id in byId) {
      var t = byId[id];
      if (!t.owner_sid || (!IN_FLIGHT[t.status] && t.status !== "blocked")) continue;
      (allInstTasks[t.owner_sid] || (allInstTasks[t.owner_sid] = [])).push(t);
      if (!IN_FLIGHT[t.status]) continue;
      var cur = byInstance[t.owner_sid];
      if (!cur) { byInstance[t.owner_sid] = t; continue; }
      var rank = (INSTANCE_PICK[t.status] == null ? 9 : INSTANCE_PICK[t.status]) - (INSTANCE_PICK[cur.status] == null ? 9 : INSTANCE_PICK[cur.status]);
      var better = rank || ((cur.claimed_at || 0) - (t.claimed_at || 0));
      if (better < 0) byInstance[t.owner_sid] = t;
    }
    // Include blocked-only instances (no in-flight primary)
    Object.keys(allInstTasks).forEach(function(sid) {
      if (!byInstance[sid]) {
        var bl = allInstTasks[sid].filter(function(t) { return t.status === "blocked"; })[0];
        if (bl) byInstance[sid] = bl;
      }
    });
    var instances = Object.keys(byInstance).map(function (sid) {
      var task = byInstance[sid];
      var all = allInstTasks[sid] || [];
      var secondaryTasks = all.filter(function(t) { return t.id !== task.id && (t.status === "review" || t.status === "blocked"); });
      return { sid: sid, label: task.ownerLabel || sid.slice(0, 6), online: task.ownerOnline, task: task, secondaryTasks: secondaryTasks };
    }).sort(function (a, b) { return a.online === b.online ? a.label.localeCompare(b.label) : (a.online ? -1 : 1); });
    return { project: board.project || null, lanes: lanes, instances: instances, byId: byId, blockedBy: blockedBy, blocks: blocks };
  }
  function emptyLanes() { return Object.keys(STATUS_META).map(function (status) { return { status: status, label: STATUS_META[status].label, group: STATUS_META[status].group, tasks: [], count: 0 }; }); }
  function layoutDag(tasks, deps) {
    if (!Array.isArray(tasks) || tasks.length === 0) return { nodes: [], flaggedEdges: [] };
    var ids = {}, taskById = {};
    for (var i = 0; i < tasks.length; i++) { ids[tasks[i].id] = 1; taskById[tasks[i].id] = tasks[i]; }
    var blockers = {};
    if (Array.isArray(deps)) for (var d = 0; d < deps.length; d++) { var dep = deps[d]; if (!dep || !ids[dep.task_id] || !ids[dep.blocks_on]) continue; (blockers[dep.task_id] || (blockers[dep.task_id] = [])).push(dep.blocks_on); }
    var layer = {}, onStack = {}, flaggedNodes = {}, flaggedEdges = [];
    function computeLayer(id) {
      if (layer[id] !== undefined) return layer[id];
      onStack[id] = 1; var lv = 0; var bl = blockers[id] || [];
      for (var b = 0; b < bl.length; b++) { var blk = bl[b]; if (onStack[blk]) { flaggedNodes[id] = 1; flaggedEdges.push({ from: id, to: blk }); continue; } lv = Math.max(lv, 1 + computeLayer(blk)); }
      delete onStack[id]; layer[id] = lv; return lv;
    }
    for (var t = 0; t < tasks.length; t++) computeLayer(tasks[t].id);
    var byLayer = {};
    for (var u = 0; u < tasks.length; u++) { var lvl = layer[tasks[u].id] || 0; (byLayer[lvl] || (byLayer[lvl] = [])).push(tasks[u].id); }
    var order = {};
    Object.keys(byLayer).forEach(function (lvl) {
      byLayer[lvl].sort(function (x, y) { var tx = taskById[x], ty = taskById[y]; var px = tx.parent_id || "", py = ty.parent_id || ""; if (px !== py) return px < py ? -1 : 1; if (tx.priority !== ty.priority) return tx.priority - ty.priority; return x < y ? -1 : x > y ? 1 : 0; });
      byLayer[lvl].forEach(function (id, idx) { order[id] = idx; });
    });
    var nodes = tasks.map(function (t) { return { id: t.id, layer: layer[t.id] || 0, order: order[t.id] || 0, flagged: !!flaggedNodes[t.id] }; });
    return { nodes: nodes, flaggedEdges: flaggedEdges };
  }

  // ========== verbatim copy of cockpit-live.ts ==========
  // KEEP IDENTICAL to cockpit-live.ts.
  // stale is server-computed (PRESENCE_GRACE_MS threshold, matches ghost-reaper).
  // WS2 context gauge — mirrors the FROZEN consumer contract. FILL ceiling = CONTEXT_OVER (the 400k context limit / auto-compact line) so a full bar reads as "act now".
  // Color bands by ABSOLUTE tokens: green <CONTEXT_WARN (300k), amber 300k–360k, red ≥CONTEXT_RED (360k) — red fires BEFORE the 400k compact line for early warning.
  // Constant names + VALUES are kept identical to the classic board render in dashboard.ts so the two views can never disagree on a band or on "ts-stale".
  var CONTEXT_OVER = 400000, CONTEXT_RED = 360000, CONTEXT_WARN = 300000, CONTEXT_STALE_MS = 120000;
  function fmtCtx(n) { return n >= 1000 ? Math.round(n / 1000) + "k" : String(n); }
  // v2 lockstep rule (ratified with dashboard.ts renderBoard): a parked-but-alive agent's count is still accurate, so don't grey it.
  // presenceLive = online && !presence-stale. ts-stale only means "untrusted" when presence is ALSO gone.
  function ctxBand(tokens, ts, now, presenceLive) {
    if (tokens == null || ts == null) return { cls: "pending", val: "pending", pct: 0 };
    var pct = Math.min(100, Math.round(tokens / CONTEXT_OVER * 100));
    var base = tokens >= CONTEXT_RED ? "red" : tokens >= CONTEXT_WARN ? "amber" : "green";
    if (now - ts > CONTEXT_STALE_MS) {
      // gauge frozen: alive→keep true color + mark parked (count valid); dead→grey (value untrusted). Conductor stays ts-keyed regardless.
      return presenceLive
        ? { cls: base + " parked", val: fmtCtx(tokens), pct: pct }
        : { cls: "stale", val: fmtCtx(tokens), pct: pct };
    }
    return { cls: base, val: fmtCtx(tokens), pct: pct };
  }
  // Shared context-gauge renderer. compact (board chips + Right-Now rail) = bar only,
  // full count on hover, and returns null when there's no reading yet (empty/hidden
  // bar until tokens report). Non-compact (Live cards) keeps the "ctx" label + value.
  function renderCtxBar(tokens, ts, now, presenceLive, compact) {
    var cb = ctxBand(tokens, ts, now, presenceLive);
    if (compact && cb.cls === "pending") return null;
    var ctx = el("div", "ck-live-ctx " + cb.cls + (compact ? " ck-ctx-compact" : ""));
    ctx.title = (tokens != null ? tokens.toLocaleString() + " tokens" : "context pending")
      + (cb.cls.indexOf("stale") >= 0 ? " (stale — agent gone)" : cb.cls.indexOf("parked") >= 0 ? " (parked — agent quiet, count current)" : "");
    if (!compact) ctx.appendChild(el("span", "ck-live-ctx-label", "ctx"));
    if (cb.cls !== "pending") {
      var ctxBar = el("div", "ck-live-ctx-bar");
      var ctxFill = el("div", "ck-live-ctx-fill"); ctxFill.style.width = cb.pct + "%";
      ctxBar.appendChild(ctxFill); ctx.appendChild(ctxBar);
    }
    if (!compact) ctx.appendChild(el("span", "ck-live-ctx-val", cb.val));
    return ctx;
  }

  function buildLiveModel(board) {
    return board
      .filter(function(r) { return r.status !== "signed-off"; })
      .map(function(r) {
        return {
          name: r.name, node: r.node, online: r.online,
          stale: !!r.stale,
          mission: r.mission, activity: r.activity, todos: r.todos,
          subagents: r.subagents != null ? r.subagents : 0,
          updatedAt: r.updatedAt, sid: r.sid,
          // WS2 gauge: tolerate either casing on the /board entry (camel from b37c's seam, snake from registry) so this view is decoupled from the field-name choice.
          contextTokens: r.contextTokens != null ? r.contextTokens : (r.context_tokens != null ? r.context_tokens : null),
          contextTs: r.contextTs != null ? r.contextTs : (r.context_ts != null ? r.context_ts : null),
        };
      })
      .sort(function(a, b) {
        if (a.online !== b.online) return a.online ? -1 : 1;
        if (a.online && a.stale !== b.stale) return a.stale ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
  }

  // ========== verbatim copy of cockpit-loops.ts ==========
  // KEEP IDENTICAL to cockpit-loops.ts. Pure loop view-model + cap-pressure: derives
  // the iteration/token/time/completeness gauges and ONE danger level (worst of the
  // resource caps; completeness never drives danger) for the operator Loops panel.
  var LOOP_WARN_AT = 0.75, LOOP_CRIT_AT = 0.9;
  function loopFmtInt(n) { return n >= 1000 ? Math.round(n / 1000) + "k" : String(n); }
  function loopFmtDuration(ms) {
    var t = ms < 0 ? 0 : ms;
    var totalSec = Math.floor(t / 1000); var sec = totalSec % 60;
    var totalMin = Math.floor(totalSec / 60); var min = totalMin % 60;
    var hr = Math.floor(totalMin / 60);
    function p2(n) { return n < 10 ? "0" + n : "" + n; }
    return hr > 0 ? hr + ":" + p2(min) + ":" + p2(sec) : min + ":" + p2(sec);
  }
  function loopRatio(value, cap) { if (cap == null || cap <= 0) return null; return value / cap; }
  function buildLoopView(loop, now) {
    var cfg = loop.config || {}; var st = loop.state || {};
    var iterN = typeof st.iterations === "number" ? st.iterations : 0;
    var tokN = typeof st.tokens === "number" ? st.tokens : 0;
    var elapsed = now - loop.created_at;
    var iterRatio = loopRatio(iterN, cfg.max_iterations);
    var tokRatio = loopRatio(tokN, cfg.token_budget);
    var timeRatio = loopRatio(elapsed, cfg.wall_clock_timeout_ms);
    var iter = { ratio: iterRatio, shown: cfg.max_iterations != null, label: cfg.max_iterations != null ? iterN + " / " + cfg.max_iterations : String(iterN) };
    var tokens = { ratio: tokRatio, shown: cfg.token_budget != null, label: cfg.token_budget != null ? loopFmtInt(tokN) + " / " + loopFmtInt(cfg.token_budget) : loopFmtInt(tokN) };
    var time = { ratio: timeRatio, shown: cfg.wall_clock_timeout_ms != null, label: cfg.wall_clock_timeout_ms != null ? loopFmtDuration(elapsed) + " / " + loopFmtDuration(cfg.wall_clock_timeout_ms) : loopFmtDuration(elapsed) };
    var lc = typeof st.last_completeness === "number" ? st.last_completeness : null;
    var completeness = { ratio: lc, shown: lc != null, label: lc != null ? Math.round(lc * 100) + "%" + (cfg.completeness_threshold != null ? " / " + Math.round(cfg.completeness_threshold * 100) + "%" : "") : "—" };
    var worst = 0;
    var terminal = loop.status === "stopped" || loop.status === "completed";
    if (!terminal) { [iterRatio, tokRatio, timeRatio].forEach(function (r) { if (r != null && r > worst) worst = r; }); }
    var pressure = worst >= LOOP_CRIT_AT ? "crit" : worst >= LOOP_WARN_AT ? "warn" : "ok";
    var scores = Array.isArray(st.scores) ? st.scores.filter(function (n) { return typeof n === "number"; }) : [];
    var verdict = st.last_verdict && typeof st.last_verdict === "object" ? st.last_verdict : null;
    return { id: loop.id, label: loop.label, kind: loop.kind, owner: loop.owner_callsign, status: loop.status, stop_reason: loop.stop_reason != null ? loop.stop_reason : null, active: loop.status === "running" || loop.status === "paused", iter: iter, tokens: tokens, time: time, completeness: completeness, pressure: pressure, pressureRatio: worst > 1 ? 1 : worst, scores: scores, verdict: verdict };
  }
  function loopSparkPath(scores, w, h) {
    if (!Array.isArray(scores) || scores.length < 2) return "";
    var n = scores.length, d = "";
    for (var i = 0; i < n; i++) {
      var raw = scores[i]; var v = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      var x = (i / (n - 1)) * w; var y = h - v * h;
      d += (i === 0 ? "M" : " L") + Math.round(x * 100) / 100 + "," + Math.round(y * 100) / 100;
    }
    return d;
  }
  function loopGroupRank(status) { if (status === "running") return 0; if (status === "paused") return 1; return 2; }
  function buildLoopViews(loops, now) {
    if (!Array.isArray(loops)) return [];
    return loops.map(function (l) { return buildLoopView(l, now); }).sort(function (a, b) {
      var ga = loopGroupRank(a.status), gb = loopGroupRank(b.status);
      if (ga !== gb) return ga - gb;
      if (a.pressureRatio !== b.pressureRatio) return b.pressureRatio - a.pressureRatio;
      return 0;
    });
  }

  // ========== helpers ==========
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function relTime(ms, now) {
    var diff = Math.round((now - ms) / 1000);
    if (diff < 0) diff = 0;
    if (diff < 60) return diff + "s ago";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  }
  function laneDotColor(group) { return group === "terminal" ? "var(--text-tertiary)" : group === "backlog" ? "var(--accent)" : "var(--green)"; }
  function toRawEvent(e) { return { id: e.id, taskId: e.task_id, kind: e.kind, fromStatus: e.from_status, toStatus: e.to_status, actor: e.actor, ts: e.ts }; }

  // ========== state ==========
  var S = {
    projectId: "__demo__", demo: true, model: null, leaseOffset: 0, feed: [],
    openLanes: null, activeView: "ops", refetchTimer: null, drawerTaskId: null, projectsLoaded: false,
    feedFilter: "all", feedNewCount: 0, feedPrevLen: null,
    mainView: "loop",
    stalledSet: {}, // C5: task ids currently flagged stalled, for tick-driven badge toggling
    wedged: [], wedgedSet: {}, // W4.1-a: dead-blocker-wedged tasks (this project) + id→deadBlockers lookup
    conductor: null, condPollTimer: null, condPinLoaded: false, // WS-C: last /admin-conductor-status snapshot + poll handle; condPinLoaded gates Armed (C5)
    loopCtl: [], loopCtlTimer: null, // Phase 2: last /loop-admin-list view-models + poll handle
    appr: [], apprTimer: null, // Phase 5 (integration): pending HITL approvals + poll handle
    ctxBySid: {} // per-owner context gauge (sid → {tokens,ts,online,stale}) for board-chip + rail bars
  };
  var FEED_LIMIT = 200;
  function $(id) { return document.getElementById(id); }

  // ========== demo fixture (relative to client now) ==========
  function buildDemoData(now) {
    var MIN = 60000;
    function t(o) { o.project_id = "__demo__"; if (o.parent_id === undefined) o.parent_id = null; if (o.detail === undefined) o.detail = null; if (o.owner === undefined) o.owner = null; if (o.owner_sid === undefined) o.owner_sid = null; if (o.priority === undefined) o.priority = 2; o.artifacts = o.artifacts || null; if (o.claimed_at === undefined) o.claimed_at = null; if (o.done_at === undefined) o.done_at = null; if (o.lease_expires_at === undefined) o.lease_expires_at = null; o.created_at = o.created_at || (now - 90 * MIN); o.updated_at = now; return o; }
    var lanes = {
      proposed: [ t({ id: "api-design", title: "API contract design", priority: 1 }), t({ id: "design-review", title: "Design doc review", priority: 3 }) ],
      ratified: [ t({ id: "schema-plan", title: "Schema migration plan", priority: 1 }) ],
      ready: [ t({ id: "db-migrate", title: "Database migration", priority: 0 }), t({ id: "seed-data", title: "Seed data v2", priority: 2 }) ],
      claimed: [ t({ id: "auth", title: "Refactor auth flow", owner: "linux-web", owner_sid: "s-web", priority: 1, claimed_at: now - 30 * MIN, lease_expires_at: now - 25000 }) ],
      in_progress: [
        t({ id: "ratelimit", title: "Add API rate limiting", owner: "linux-255c", owner_sid: "s-255c", priority: 0, claimed_at: now - 12 * MIN, lease_expires_at: now + 40000 }),
        t({ id: "search", title: "Search indexing", owner: "linux-d4aa", owner_sid: "s-d4aa", priority: 2, claimed_at: now - 6 * MIN, lease_expires_at: now + 12 * MIN })
      ],
      review: [ t({ id: "token-refresh", title: "Token refresh handling", owner: "linux-api", owner_sid: "s-api", priority: 1, claimed_at: now - 20 * MIN }) ],
      blocked: [ t({ id: "release", title: "Release candidate cut", priority: 0 }) ],
      done: [ t({ id: "logging", title: "Structured logging", priority: 2, done_at: now - 70 * MIN }), t({ id: "metrics", title: "Metrics export", priority: 2, done_at: now - 60 * MIN }),
        t({ id: "cache-detail", title: "Response cache headers", parent_id: "ratelimit", priority: 2, done_at: now - 15 * MIN }) ],
      failed: [],
      abandoned: [ t({ id: "legacy-rewrite", title: "Legacy rewrite (rejected)", priority: 4 }) ]
    };
    // a second child of ratelimit, still in progress (drives the child rollup 2/1/1)
    lanes.in_progress.push(t({ id: "quota-detail", title: "Per-key quota buckets", parent_id: "ratelimit", owner: "linux-255c", owner_sid: "s-255c", priority: 1, claimed_at: now - 9 * MIN, lease_expires_at: now + 8 * MIN }));
    // Stamp each task's status from its lane (real /plan-board rows carry status;
    // the fixture derives it from lane membership so the model reads it correctly).
    Object.keys(lanes).forEach(function (k) { lanes[k].forEach(function (task) { task.status = k; }); });
    var deps = [
      { task_id: "ratelimit", blocks_on: "db-migrate" },
      { task_id: "release", blocks_on: "db-migrate" }, { task_id: "release", blocks_on: "seed-data" },
      { task_id: "release", blocks_on: "ratelimit" }, { task_id: "release", blocks_on: "auth" }
    ];
    var childSummaries = { ratelimit: { total: 2, terminal: 1, done: 1 } };
    var events = [
      { id: 1, task_id: "logging", ts: now - 70 * MIN, actor: "linux-255c", kind: "transition", from_status: "in_progress", to_status: "done", note: null },
      { id: 2, task_id: "metrics", ts: now - 60 * MIN, actor: "linux-api", kind: "transition", from_status: "review", to_status: "done", note: null },
      { id: 3, task_id: "ratelimit", ts: now - 12 * MIN, actor: "linux-255c", kind: "claim", from_status: "ready", to_status: "claimed", note: null },
      { id: 4, task_id: "ratelimit", ts: now - 12 * MIN, actor: "linux-255c", kind: "transition", from_status: "claimed", to_status: "in_progress", note: null },
      { id: 5, task_id: "search", ts: now - 6 * MIN, actor: "linux-d4aa", kind: "claim", from_status: "ready", to_status: "claimed", note: null },
      { id: 6, task_id: "token-refresh", ts: now - 20 * MIN, actor: "linux-api", kind: "claim", from_status: "ready", to_status: "claimed", note: null },
      { id: 7, task_id: "token-refresh", ts: now - 4 * MIN, actor: "linux-api", kind: "handoff", from_status: null, to_status: null, note: JSON.stringify({ summary: "Implemented token refresh; needs a reviewer to check the 401 retry path before sign-off.", next_step: "Verify the refresh-token rotation", blockers: [] }) },
      { id: 8, task_id: "release", ts: now - 3 * MIN, actor: "linux-d4aa", kind: "transition", from_status: "ready", to_status: "blocked", note: null },
      { id: 9, task_id: "auth", ts: now - 30 * MIN, actor: "linux-web", kind: "claim", from_status: "ready", to_status: "claimed", note: null },
      { id: 10, task_id: "auth", ts: now - 20000, actor: "system", kind: "lease_expired", from_status: null, to_status: null, note: JSON.stringify({ summary: "Lease expired — reclaim pending on next sweep.", system: true }) }
    ];
    var presence = [
      // contextTokens/contextTs seed the per-agent gauge so the demo exercises every band: green / amber / red / stale-grey.
      { sid: "s-255c", name: "linux-255c", online: true, lastSeenAt: now - 20000, contextTokens: 175000, contextTs: now - 10000 },
      // C5 demo: d4aa holds a healthy 12min lease but hasn't beat in ~6min → stalled radar.
      { sid: "s-d4aa", name: "linux-d4aa", online: true, lastSeenAt: now - 6 * MIN, contextTokens: 312000, contextTs: now - 10000 },
      { sid: "s-api", name: "linux-api", online: true, lastSeenAt: now - 15000, contextTokens: 372000, contextTs: now - 10000 },
      { sid: "s-web", name: "linux-web", online: false, lastSeenAt: now - 30 * MIN, contextTokens: 240000, contextTs: now - 5 * MIN }
    ];
    return { board: { project: { id: "__demo__", title: "Acme Platform — API Rewrite", status: "active" }, lanes: lanes, deps: deps, childSummaries: childSummaries, now: now }, events: events, presence: presence };
  }

  // ========== live fleet cards: REMOVED ==========
  // The "Live" page (per-instance fleet cards) was retired and its page slot repurposed
  // as the "Loop" page (loop control + schedule + approvals). The cards duplicated the
  // Plan "Right Now" rail. renderLoopsSchedule (below) now runs on the loop-ctl cadence
  // (see initLoopCtl), not the old live cadence. (buildLiveModel is now unused.)
  // ========== Phase 3: governed-loop schedule card (scheduled-vs-actual fire times) ==========
  // Self-contained ck-loops block. Reads the public /loops DTO (summarizeLoopSchedule) and
  // shows, per recurring loop, the scheduled NEXT fire vs the LAST actual fire and the drift
  // between them. Fully guarded: any error/empty set renders nothing, so it can never break the
  // rest of the Live view. (P2's control card is the separate ck-lctl block.)
  function fmtDur(ms) {
    if (ms == null) return "—";
    if (Math.abs(ms) < 1000) return Math.round(ms) + "ms";
    var s = Math.round(ms / 1000);
    if (Math.abs(s) < 60) return s + "s";
    var m = Math.floor(Math.abs(s) / 60), r = Math.abs(s) % 60;
    return (s < 0 ? "-" : "") + m + "m" + (r < 10 ? "0" : "") + r + "s";
  }
  function loopDriftCls(ms) {
    if (ms == null) return "";
    var a = Math.abs(ms);
    return a < 1000 ? "ok" : a < 5000 ? "warn" : "bad";
  }
  function renderLoopsSchedule() {
    var host = $("ck-loops");
    if (!host) return;
    fetch("/loops").then(function (r) { return r.ok ? r.json() : { loops: [], now: Date.now() }; })
      .catch(function () { return { loops: [], now: Date.now() }; })
      .then(function (j) {
        try {
          host.textContent = "";
          var loops = (j && Array.isArray(j.loops)) ? j.loops : [];
          var srvNow = (j && typeof j.now === "number") ? j.now : Date.now();
          var offset = srvNow - Date.now();
          if (!loops.length) return; // nothing governed → render nothing
          // recurring loops first (they carry schedule data), then the rest
          loops = loops.slice().sort(function (a, b) { return (b.recurring ? 1 : 0) - (a.recurring ? 1 : 0); });
          // Collapsible section (mirrors the Loop Control card): collapsed by default,
          // state persisted in localStorage; header shows the loop count when collapsed.
          var collapsed = true;
          try { collapsed = localStorage.getItem("ck-loops-collapsed") !== "0"; } catch (e) {}
          host.classList.toggle("open", !collapsed);
          var lhdr = el("div", "ck-loops-hdr");
          lhdr.appendChild(document.createTextNode("Governed loops"));
          lhdr.appendChild(el("span", "ck-loops-count", "(" + loops.length + ")"));
          lhdr.appendChild(el("span", "ck-loops-caret", "▸"));
          lhdr.onclick = function () {
            var willOpen = !host.classList.contains("open");
            host.classList.toggle("open", willOpen);
            try { localStorage.setItem("ck-loops-collapsed", willOpen ? "0" : "1"); } catch (e) {}
          };
          host.appendChild(lhdr);
          var lbody = el("div", "ck-loops-body");
          loops.forEach(function (lp) {
            var now = Date.now() + offset; // server-aligned clock
            var row = el("div", "ck-loops-row" + (lp.status !== "running" ? " done" : ""));
            var head = el("div", "ck-loops-head");
            head.appendChild(el("span", "ck-loops-label", lp.label || lp.id));
            head.appendChild(el("span", "ck-loops-status " + lp.status, lp.status));
            row.appendChild(head);
            if (lp.recurring) {
              var sched = el("div", "ck-loops-sched");
              sched.appendChild(el("span", "ck-loops-int", "every " + fmtDur(lp.interval_ms)));
              // scheduled next fire (or overdue)
              var nextTxt, nextCls = "";
              if (lp.next_fire_ms == null) { nextTxt = "next —"; }
              else if (lp.overdue_ms != null && lp.overdue_ms > 0) { nextTxt = "overdue " + fmtDur(lp.overdue_ms); nextCls = "bad"; }
              else { nextTxt = "next in " + fmtDur(lp.next_fire_ms - now); }
              sched.appendChild(el("span", "ck-loops-next " + nextCls, nextTxt));
              // last actual fire
              sched.appendChild(el("span", "ck-loops-last", lp.last_fire_ms == null ? "no fire yet" : "fired " + fmtDur(now - lp.last_fire_ms) + " ago"));
              // drift of the last actual fire vs its scheduled grid slot
              if (lp.last_drift_ms != null) {
                sched.appendChild(el("span", "ck-loops-drift " + loopDriftCls(lp.last_drift_ms), "drift +" + fmtDur(lp.last_drift_ms)));
              }
              row.appendChild(sched);
            } else {
              row.appendChild(el("div", "ck-loops-sched", "one-shot · " + (lp.iterations || 0) + " iters"));
            }
            lbody.appendChild(row);
          });
          host.appendChild(lbody);
        } catch (e) { /* never break the live view */ }
      });
  }

  function switchMainView(view) {
    S.mainView = view;
    document.querySelectorAll(".ck-main-btn").forEach(function(b) { b.classList.toggle("active", b.getAttribute("data-main") === view); });
    document.body.classList.toggle("ck-main-loop", view === "loop");
    if (view === "loop") {
      // Refresh all loop surfaces on entry (control + schedule + approvals).
      loadLoopCtl(); renderLoopsSchedule(); loadAppr();
    } else {
      // Lazy-init plan on first switch
      if (!S.model) { setProject(S.projectId); loadProjects(); } else { renderAll(); }
    }
  }

  // ========== data layer ==========
  // sid → context-gauge reading, for the board-chip + rail bars (same data the Live gauge uses).
  function buildCtxMap(entries) {
    var m = {};
    (entries || []).forEach(function (e) {
      if (!e || !e.sid) return;
      var tokens = e.contextTokens != null ? e.contextTokens : (e.context_tokens != null ? e.context_tokens : null);
      var ts = e.contextTs != null ? e.contextTs : (e.context_ts != null ? e.context_ts : null);
      m[e.sid] = { tokens: tokens, ts: ts, online: !!e.online, stale: !!e.stale };
    });
    return m;
  }
  function loadData(cb) {
    if (S.demo) {
      var d = buildDemoData(Date.now());
      S.leaseOffset = 0;
      S.model = buildCockpitModel(d.board, d.presence);
      S.ctxBySid = buildCtxMap(d.presence);
      S.feed = mergeFeed([], d.events.map(toRawEvent), { limit: FEED_LIMIT });
      if (cb) cb();
      return;
    }
    var pid = encodeURIComponent(S.projectId);
    Promise.all([
      fetch("/plan-board?project_id=" + pid).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetch("/plan-events?project_id=" + pid + "&limit=" + FEED_LIMIT).then(function (r) { return r.ok ? r.json() : { events: [] }; }).catch(function () { return { events: [] }; }),
      fetch("/board").then(function (r) { return r.ok ? r.json() : { board: [] }; }).catch(function () { return { board: [] }; }),
      fetch("/plan-wedged").then(function (r) { return r.ok ? r.json() : { tasks: [] }; }).catch(function () { return { tasks: [] }; })
    ]).then(function (res) {
      var board = res[0], evs = res[1], bd = res[2], wd = res[3];
      if (board && typeof board.now === "number") S.leaseOffset = serverClockOffset(board.now, Date.now());
      var presence = (bd && Array.isArray(bd.board) ? bd.board : []).filter(function (b) { return b.sid; }).map(function (b) { return { sid: b.sid, name: b.name, online: !!b.online, lastSeenAt: typeof b.lastSeenAt === "number" ? b.lastSeenAt : null }; });
      S.model = buildCockpitModel(board || { lanes: {} }, presence);
      S.ctxBySid = buildCtxMap(bd && Array.isArray(bd.board) ? bd.board : []);
      S.feed = mergeFeed([], (evs && evs.events ? evs.events : []).map(toRawEvent), { limit: FEED_LIMIT });
      // W4.1-a: /plan-wedged is global — keep only this project's wedged tasks + build an id→deadBlockers lookup for card badges.
      var wedged = (wd && Array.isArray(wd.tasks) ? wd.tasks : []).filter(function (w) { return w.projectId === S.projectId; });
      S.wedged = wedged; S.wedgedSet = {};
      wedged.forEach(function (w) { S.wedgedSet[w.taskId] = w.deadBlockers; });
      if (cb) cb();
    });
  }

  // ========== render ==========
  function clientNow() { return Date.now(); }
  function renderAll() {
    if (!S.model) return;
    if (S.openLanes === null) {
      S.openLanes = {};
      S.model.lanes.forEach(function (l) { if (l.group === "active" && l.count > 0) S.openLanes[l.status] = 1; });
      // A5: if nothing auto-opened (all active lanes empty), open the first non-empty lane of any group
      if (!Object.keys(S.openLanes).length) {
        var first = null;
        for (var li = 0; li < S.model.lanes.length; li++) { if (S.model.lanes[li].count > 0) { first = S.model.lanes[li]; break; } }
        if (first) S.openLanes[first.status] = 1;
      }
    }
    renderRail(); renderBoard(); renderFeed(); renderDagIfVisible(); updateCounts();
    // C5: seed the stall set from what we just rendered so tickLeases compares against
    // on-screen state, not a stale snapshot from before the refetch.
    S.stalledSet = {};
    var snow = clientNow();
    for (var sid in S.model.byId) {
      var stk = S.model.byId[sid];
      if (stk.status !== "claimed" && stk.status !== "in_progress") continue;
      if (stallState({ lastSeenAt: stk.ownerLastSeenAt, leaseExpiresAt: stk.lease_expires_at, clientNow: snow, offset: S.leaseOffset }).stalled) S.stalledSet[stk.id] = 1;
    }
  }
  // Roster render guard (item 3): hide an instance whose owner's presence is gone
  // — offline AND not seen within the presence-grace window — so a signed-off /
  // fixture board row can't surface in the Right-Now rail. Mirrors the server
  // presence grace (AF_PRESENCE_GRACE_SECONDS=7200). A recently-crashed real agent
  // (offline but seen < grace ago) still shows so its stalled task can be reclaimed.
  var ROSTER_PRESENCE_GRACE_MS = 2 * 60 * 60 * 1000;
  function instanceLive(inst) {
    if (!inst) return false;
    if (inst.online) return true;
    var ls = inst.task ? inst.task.ownerLastSeenAt : null;
    return typeof ls === "number" && ls > 0 && (clientNow() + S.leaseOffset - ls) <= ROSTER_PRESENCE_GRACE_MS;
  }
  function liveInstances() { return S.model.instances.filter(instanceLive); }
  function updateCounts() {
    var nLive = liveInstances().length;
    $("ck-n-ops").textContent = nLive ? "(" + nLive + ")" : "";
    var total = 0, needsCount = 0;
    S.model.lanes.forEach(function (l) {
      total += l.count;
      if (l.status === "review" || l.status === "blocked") needsCount += l.count;
    });
    needsCount += (S.wedged ? S.wedged.length : 0); // W4.1-a: wedged tasks also "need you"
    $("ck-n-board").textContent = total ? "(" + total + ")" : "";
    $("ck-n-feed").textContent = S.feed.length ? "(" + S.feed.length + ")" : "";
    var nb = $("ck-n-needs");
    if (nb) { nb.textContent = needsCount ? String(needsCount) : ""; nb.style.display = needsCount ? "" : "none"; }
  }

  function leaseRow(task) {
    var ls = leaseState({ claimedAt: task.claimed_at, leaseExpiresAt: task.lease_expires_at, clientNow: clientNow(), offset: S.leaseOffset });
    var row = el("div", "ck-lease " + ls.urgency);
    var bar = el("div", "ck-lease-bar"); var fill = el("div", "ck-lease-fill");
    fill.style.width = (ls.fraction == null ? 1 : ls.fraction) * 100 + "%";
    bar.appendChild(fill); row.appendChild(bar);
    var time = el("span", "ck-lease-time", ls.label); row.appendChild(time);
    if (ls.urgency === "expired" && (task.status === "claimed" || task.status === "in_progress")) {
      row.appendChild(el("span", "ck-reclaim", "reclaim pending"));
    }
    row.setAttribute("data-lease", task.id);
    return row;
  }

  function renderRail() {
    var v = $("ck-view-ops"); v.textContent = "";
    // A1: "Needs you" strip for review + blocked + W4.1-a wedged tasks
    var reviewCount = 0, blockedCount = 0;
    S.model.lanes.forEach(function (l) {
      if (l.status === "review") reviewCount = l.count;
      if (l.status === "blocked") blockedCount = l.count;
    });
    var wedgedCount = S.wedged ? S.wedged.length : 0;
    var needsCount = reviewCount + blockedCount + wedgedCount;
    if (needsCount > 0) {
      var strip = el("div", "ck-needs");
      strip.appendChild(el("span", "ck-needs-label", "⚑ Needs you (" + needsCount + ")"));
      var parts = [];
      if (reviewCount) parts.push(reviewCount + " in review");
      if (blockedCount) parts.push(blockedCount + " blocked");
      if (wedgedCount) parts.push(wedgedCount + " wedged");
      strip.appendChild(el("span", "ck-needs-sub", parts.join(" · ")));
      v.appendChild(strip);
    }
    var insts = liveInstances();
    if (!insts.length) { v.appendChild(emptyState("No instances working right now.", "The Right Now rail shows each agent's in-flight task and lease as work is claimed.")); return; }
    insts.forEach(function (inst) {
      var card = el("div", "ck-inst");
      var head = el("div", "ck-inst-head");
      head.appendChild(el("span", "dot" + (inst.online ? " online" : "")));
      var nameEl = el("span", "ck-inst-name", inst.label);
      // Interactive terminal: clicking a LIVE agent's name opens a read-only
      // terminal mirror of its tmux session. Demo rows aren't real fleet members.
      if (!S.demo && inst.label && inst.online) {
        nameEl.classList.add("ck-term-open");
        nameEl.title = "Open terminal (read-only)";
        nameEl.setAttribute("data-callsign", inst.label);
        (function (callsign) { nameEl.onclick = function () { openTerminal(callsign); }; })(inst.label);
      }
      head.appendChild(nameEl);
      head.appendChild(el("span", "ck-inst-status", (STATUS_META[inst.task.status] || {}).label || inst.task.status));
      // C3: per-agent kill-exempt pin (callsign-keyed), live data only — demo callsigns aren't real fleet members
      if (!S.demo && inst.label) { var pinEl = pinChip(inst.label); pinEl.classList.add("ck-inst-pin"); head.appendChild(pinEl); }
      // C5 rail radar: flag a quiet-but-not-yet-lapsed owner right on the instance head.
      var rst = (inst.task.status === "claimed" || inst.task.status === "in_progress")
        ? stallState({ lastSeenAt: inst.task.ownerLastSeenAt, leaseExpiresAt: inst.task.lease_expires_at, clientNow: clientNow(), offset: S.leaseOffset })
        : { stalled: false, label: null };
      if (rst.stalled) head.appendChild(el("span", "ck-stall", "⏸ " + rst.label));
      card.appendChild(head);
      var tl = el("div", "ck-inst-task", inst.task.title); tl.style.cursor = "pointer"; tl.onclick = function () { openDrawer(inst.task.id); }; card.appendChild(tl);
      // Per-agent context gauge: bar only, full count on hover (same gauge as the Live view).
      if (inst.task.owner_sid && S.ctxBySid && S.ctxBySid[inst.task.owner_sid]) {
        var ic = S.ctxBySid[inst.task.owner_sid];
        var icBar = renderCtxBar(ic.tokens, ic.ts, clientNow() + S.leaseOffset, ic.online && !ic.stale, true);
        if (icBar) card.appendChild(icBar);
      }
      if (inst.task.lease_expires_at != null) card.appendChild(leaseRow(inst.task));
      card.appendChild(handoffLine(inst.task.id));
      if (inst.secondaryTasks && inst.secondaryTasks.length) {
        var sec = el("div", "ck-inst-secondary");
        inst.secondaryTasks.forEach(function(st) {
          var sc = el("span", "ck-inst-sec-chip " + st.status);
          sc.textContent = "+" + ((STATUS_META[st.status] || {}).label || st.status) + ": " + (st.title.length > 30 ? st.title.slice(0, 29) + "…" : st.title);
          (function(id) { sc.onclick = function() { openDrawer(id); }; })(st.id);
          sec.appendChild(sc);
        });
        card.appendChild(sec);
      }
      v.appendChild(card);
    });
  }
  function handoffLine(taskId) {
    var wrap = el("div");
    var latest = latestHandoffFor(taskId);
    if (latest) wrap.appendChild(el("div", "ck-inst-hand", "“" + latest.summary + "”"));
    return wrap;
  }
  function latestHandoffFor(taskId) {
    var best = null;
    for (var i = 0; i < S.feed.length; i++) { var e = S.feed[i]; if (e.taskId === taskId && e.kind === "handoff") { var p = parseNote(e); if (p && p.summary && !p.system) best = p; } }
    return best;
  }
  function parseNote(e) { try { return e.note ? JSON.parse(e.note) : null; } catch (x) { return null; } }

  function renderBoard() {
    var v = $("ck-view-board"); v.textContent = "";
    var anyTask = S.model.lanes.some(function (l) { return l.count > 0; });
    if (!anyTask) { v.appendChild(emptyState("No tasks yet.", "This board populates as instances propose, claim, and complete work.")); return; }
    // A5: mobile-only top-blockers strip (shows tasks that block the most others)
    var blockerTasks = Object.values(S.model.byId).filter(function(t) { return t.blocksCount > 0 && t.status !== "done" && t.status !== "failed" && t.status !== "abandoned"; });
    blockerTasks.sort(function(a, b) { return b.blocksCount - a.blocksCount; });
    if (blockerTasks.length > 0) {
      var strip = el("div", "ck-blockers-strip");
      strip.appendChild(el("div", "ck-blockers-title", "Top blockers"));
      blockerTasks.slice(0, 3).forEach(function(t) {
        var row = el("div", "ck-blocker-row");
        row.appendChild(el("span", "ck-blocker-count", t.blocksCount + "↓"));
        row.appendChild(el("span", "ck-blocker-title", t.title));
        (function(id) { row.onclick = function() { openDrawer(id); }; })(t.id);
        strip.appendChild(row);
      });
      v.appendChild(strip);
    }
    S.model.lanes.forEach(function (lane) {
      if (lane.count === 0 && lane.group !== "active") return;
      var laneEl = el("div", "ck-lane" + (S.openLanes[lane.status] ? " open" : ""));
      var head = el("div", "ck-lane-head");
      head.appendChild(el("span", "caret", "▶"));
      var dot = el("span", "ck-lane-dot"); dot.style.background = laneDotColor(lane.group); head.appendChild(dot);
      head.appendChild(el("span", "ck-lane-label", lane.label));
      head.appendChild(el("span", "ck-lane-count", String(lane.count)));
      head.onclick = function () { if (S.openLanes[lane.status]) delete S.openLanes[lane.status]; else S.openLanes[lane.status] = 1; laneEl.classList.toggle("open"); };
      laneEl.appendChild(head);
      var body = el("div", "ck-lane-body");
      lane.tasks.forEach(function (task) { body.appendChild(chip(task)); });
      laneEl.appendChild(body);
      v.appendChild(laneEl);
    });
  }
  function chip(task) {
    var ls = leaseState({ claimedAt: task.claimed_at, leaseExpiresAt: task.lease_expires_at, clientNow: clientNow(), offset: S.leaseOffset });
    // C5: dead-agent radar — owner went quiet past the stall window while the lease is
    // still valid. Distinct from (and fires before) the A3 expired-lease reclaim chip.
    var st = (task.status === "claimed" || task.status === "in_progress")
      ? stallState({ lastSeenAt: task.ownerLastSeenAt, leaseExpiresAt: task.lease_expires_at, clientNow: clientNow(), offset: S.leaseOffset })
      : { stalled: false, label: null };
    var c = el("div", "ck-chip");
    if (task.status === "blocked") c.classList.add("blocked");
    // A3: stalled (expired, dead agent) vs urgent (live but close)
    var isStalled = ls.hasLease && ls.urgency === "expired" && (task.status === "claimed" || task.status === "in_progress");
    if (isStalled) c.classList.add("lease-stalled");
    else if (st.stalled) c.classList.add("beat-stalled");
    else if (ls.hasLease && (ls.urgency === "urgent" || ls.urgency === "expired")) c.classList.add("lease-urgent");
    else if (ls.hasLease && ls.urgency === "soon") c.classList.add("lease-soon");
    c.appendChild(el("div", "ck-chip-title", task.title));
    // Per-owner context gauge (replaces a raw token count): bar only, full count on hover.
    if (task.owner_sid && S.ctxBySid && S.ctxBySid[task.owner_sid]) {
      var oc = S.ctxBySid[task.owner_sid];
      var ocBar = renderCtxBar(oc.tokens, oc.ts, clientNow() + S.leaseOffset, oc.online && !oc.stale, true);
      if (ocBar) c.appendChild(ocBar);
    }
    var meta = el("div", "ck-chip-meta");
    if (task.ownerLabel) { var o = el("span", "ck-chip-owner"); o.appendChild(el("span", "dot" + (task.ownerOnline ? " online" : ""))); o.appendChild(el("span", null, task.ownerLabel)); meta.appendChild(o); }
    meta.appendChild(el("span", "ck-prio ck-prio-" + task.priority, "P" + task.priority));
    // C5 stall badge sits alongside the live lease ring (lease still ticking) so the
    // operator sees "quiet but not yet lapsed" — visually distinct from ck-reclaim.
    if (st.stalled) { meta.appendChild(el("span", "ck-stall", "⏸ " + st.label)); }
    if (isStalled) { meta.appendChild(el("span", "ck-reclaim", "⟳ stalled")); }
    else if (ls.hasLease) { var r = el("span", "ck-ring " + ls.urgency, ls.label); r.setAttribute("data-lease", task.id); meta.appendChild(r); }
    if (task.blockedByCount) meta.appendChild(el("span", "ck-badge", "⛔ " + task.blockedByCount));
    if (task.childSummary) meta.appendChild(el("span", "ck-badge", "▸ " + task.childSummary.done + "/" + task.childSummary.total));
    // W4.1-a: wedged = ratified but a blocker is failed/abandoned/missing → waits forever. Flag it.
    if (S.wedgedSet && S.wedgedSet[task.id]) meta.appendChild(el("span", "ck-badge ck-wedged", "⛓ wedged"));
    c.appendChild(meta);
    c.onclick = function () { openDrawer(task.id); };
    return c;
  }

  function renderFeed() {
    var v = $("ck-view-feed"); v.textContent = "";
    // Consume pending delta captured in onPlanUpdate (before async refetch)
    if (S.feedPrevLen !== null) {
      S.feedNewCount += Math.max(0, S.feed.length - S.feedPrevLen);
      S.feedPrevLen = null;
    }
    // Filter row
    var frow = el("div", "ck-feed-filters");
    [["all", "All"], ["handoffs", "Handoffs"], ["stalls", "Stalls/Blocks"]].forEach(function(f) {
      var btn = el("button", "ck-feed-fbtn" + (S.feedFilter === f[0] ? " active" : ""), f[1]);
      (function(key) { btn.onclick = function() { S.feedFilter = key; renderFeed(); }; })(f[0]);
      frow.appendChild(btn);
    });
    v.appendChild(frow);
    // Filter events
    var filtered = S.feed.filter(function(e) {
      if (S.feedFilter === "handoffs") return e.kind === "handoff";
      if (S.feedFilter === "stalls") return e.kind === "lease_expired" || (e.kind === "transition" && e.toStatus === "blocked");
      return true;
    });
    if (!filtered.length) { v.appendChild(emptyState("No activity yet.", "Claims, transitions, handoffs and reclaims stream here as the graph changes.")); return; }
    // N new pill (sticky, shows when new items arrived while scrolled)
    if (S.feedNewCount > 0) {
      var pill = el("div", "ck-feed-new-pill");
      var pbtn = el("button", null, "↑ " + S.feedNewCount + " new");
      pbtn.onclick = function() { S.feedNewCount = 0; v.scrollTop = 0; renderFeed(); };
      pill.appendChild(pbtn);
      v.appendChild(pill);
    }
    var now = clientNow();
    // newest first for the ticker reading order
    for (var i = filtered.length - 1; i >= 0; i--) {
      var e = filtered[i];
      var row = el("div", "ck-feed-row");
      if (e.kind === "transition" && e.toStatus === "blocked") row.classList.add("to-blocked");
      row.appendChild(el("span", "ck-feed-time", relTime(e.ts, now)));
      row.appendChild(el("span", "ck-feed-kind " + e.kind, feedKindLabel(e.kind)));
      var text = el("span", "ck-feed-text");
      var title = (S.model.byId[e.taskId] && S.model.byId[e.taskId].title) || e.taskId;
      var b = el("b", null, title); text.appendChild(b);
      var suffix = feedSuffix(e); if (suffix) text.appendChild(document.createTextNode(" " + suffix));
      row.appendChild(text);
      (function (id) { row.onclick = function () { openDrawer(id); }; })(e.taskId);
      row.style.cursor = "pointer";
      v.appendChild(row);
    }
  }
  function feedKindLabel(k) { return k === "lease_expired" ? "reclaim" : k === "transition" ? "moved" : k; }
  function feedSuffix(e) {
    if (e.kind === "transition") return "→ " + ((STATUS_META[e.toStatus] || {}).label || e.toStatus) + (e.actor ? " · " + e.actor : "");
    if (e.kind === "claim") return "claimed by " + (e.actor || "?");
    if (e.kind === "handoff") return "handoff · " + (e.actor || "?");
    if (e.kind === "lease_expired") return "lease expired";
    if (e.actor) return "· " + e.actor;
    return "";
  }

  // ========== DAG (desktop only) ==========
  function renderDagIfVisible() {
    if (window.innerWidth < 820) return;
    if (S.activeView !== "dag") return;
    renderDag();
  }
  function renderDag() {
    var wrap = $("ck-dag-wrap"); wrap.textContent = "";
    var tasks = []; for (var id in S.model.byId) tasks.push(S.model.byId[id]);
    if (!tasks.length) { wrap.appendChild(emptyState("No tasks to graph yet.", "The dependency graph draws once tasks and their blockers exist.")); return; }
    var deps = []; for (var tid in S.model.blockedBy) S.model.blockedBy[tid].forEach(function (on) { deps.push({ task_id: tid, blocks_on: on }); });
    var lay = layoutDag(tasks, deps);
    var COLW = 200, ROWH = 64, NODEW = 168, NODEH = 42, PADX = 24, PADY = 24;
    var maxLayer = 0, perLayer = {};
    lay.nodes.forEach(function (n) { maxLayer = Math.max(maxLayer, n.layer); perLayer[n.layer] = Math.max(perLayer[n.layer] || 0, n.order + 1); });
    var maxRows = 0; Object.keys(perLayer).forEach(function (k) { maxRows = Math.max(maxRows, perLayer[k]); });
    var W = PADX * 2 + (maxLayer + 1) * COLW, H = PADY * 2 + maxRows * ROWH;
    var pos = {};
    lay.nodes.forEach(function (n) { pos[n.id] = { x: PADX + n.layer * COLW, y: PADY + n.order * ROWH }; });
    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg"); svg.setAttribute("class", "ck-dag-svg"); svg.setAttribute("width", W); svg.setAttribute("height", H);
    var flaggedSet = {}; lay.flaggedEdges.forEach(function (e) { flaggedSet[e.from + ">" + e.to] = 1; });
    // edges: blocker(left) -> task(right)
    deps.forEach(function (d) {
      var a = pos[d.blocks_on], b = pos[d.task_id]; if (!a || !b) return;
      var x1 = a.x + NODEW, y1 = a.y + NODEH / 2, x2 = b.x, y2 = b.y + NODEH / 2;
      var path = document.createElementNS(NS, "path");
      var mx = (x1 + x2) / 2;
      path.setAttribute("d", "M" + x1 + "," + y1 + " C" + mx + "," + y1 + " " + mx + "," + y2 + " " + x2 + "," + y2);
      path.setAttribute("class", "ck-dag-edge" + (flaggedSet[d.task_id + ">" + d.blocks_on] ? " flagged" : ""));
      svg.appendChild(path);
    });
    lay.nodes.forEach(function (n) {
      var task = S.model.byId[n.id], p = pos[n.id];
      var g = document.createElementNS(NS, "g"); g.setAttribute("class", "ck-dag-node" + (n.flagged ? " flagged" : "")); g.setAttribute("transform", "translate(" + p.x + "," + p.y + ")"); g.style.cursor = "pointer";
      var rect = document.createElementNS(NS, "rect"); rect.setAttribute("width", NODEW); rect.setAttribute("height", NODEH);
      rect.setAttribute("fill", statusFill(task.status)); g.appendChild(rect);
      var txt = document.createElementNS(NS, "text"); txt.setAttribute("x", 10); txt.setAttribute("y", 17); txt.textContent = clip(task.title, 22); g.appendChild(txt);
      var sub = document.createElementNS(NS, "text"); sub.setAttribute("x", 10); sub.setAttribute("y", 32); sub.setAttribute("fill", "var(--text-tertiary)"); sub.setAttribute("font-size", "9"); sub.textContent = (STATUS_META[task.status] || {}).label || task.status; g.appendChild(sub);
      g.addEventListener("click", function () { openDrawer(n.id); });
      svg.appendChild(g);
    });
    wrap.appendChild(svg);
  }
  function statusFill(status) {
    var g = (STATUS_META[status] || {}).group;
    if (status === "blocked" || status === "failed") return "rgba(162,59,35,.12)";
    if (status === "in_progress" || status === "claimed") return "rgba(111,138,43,.14)";
    if (g === "terminal") return "rgba(124,122,112,.14)";
    return "var(--bg-surface)";
  }
  function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  // ========== drawer ==========
  function openDrawer(taskId) {
    S.drawerTaskId = taskId;
    var task = S.model.byId[taskId];
    $("ck-drawer-title").textContent = task ? task.title : taskId;
    var body = $("ck-drawer-body"); body.textContent = "";
    if (!task) { body.appendChild(el("div", "ck-empty", "Task not found in the current snapshot.")); }
    else {
      var s1 = el("div", "ck-section");
      s1.appendChild(sectionTitle("Status"));
      s1.appendChild(kv("State", (STATUS_META[task.status] || {}).label || task.status));
      if (task.ownerLabel) s1.appendChild(kv("Owner", task.ownerLabel + (task.ownerOnline ? " (online)" : " (offline)")));
      s1.appendChild(kv("Priority", "P" + task.priority));
      if (task.lease_expires_at != null) { var ls = leaseState({ claimedAt: task.claimed_at, leaseExpiresAt: task.lease_expires_at, clientNow: clientNow(), offset: S.leaseOffset }); s1.appendChild(kv("Lease", ls.urgency === "expired" ? "expired · reclaim pending" : ls.label + " left")); }
      if (task.childSummary) s1.appendChild(kv("Subtasks", task.childSummary.done + " done / " + task.childSummary.total));
      if (task.detail) s1.appendChild(kv("Detail", task.detail));
      body.appendChild(s1);

      var blockedOn = S.model.blockedBy[taskId] || [], blocksList = S.model.blocks[taskId] || [];
      if (blockedOn.length || blocksList.length) {
        var s2 = el("div", "ck-section"); s2.appendChild(sectionTitle("Dependencies"));
        if (blockedOn.length) { var bo = el("div"); bo.appendChild(el("div", "ck-hand-meta", "Blocked on")); blockedOn.forEach(function (id) { bo.appendChild(depChip(id, "⛔")); }); s2.appendChild(bo); }
        if (blocksList.length) { var bl = el("div"); bl.appendChild(el("div", "ck-hand-meta", "Blocks")); blocksList.forEach(function (id) { bl.appendChild(depChip(id, "▸")); }); s2.appendChild(bl); }
        body.appendChild(s2);
      }

      var hs = handoffsFor(taskId);
      if (hs.length) {
        var s3 = el("div", "ck-section"); s3.appendChild(sectionTitle("Handoffs"));
        hs.forEach(function (h) {
          var hw = el("div", "ck-hand" + (h.system ? " system" : ""));
          hw.appendChild(el("div", "ck-hand-meta", (h.actor || "?") + " · " + relTime(h.ts, clientNow())));
          hw.appendChild(el("div", "ck-hand-summary", h.summary));
          if (h.next_step) hw.appendChild(el("div", "ck-hand-next", "Next: " + h.next_step));
          s3.appendChild(hw);
        });
        body.appendChild(s3);
      }
    }
    $("ck-drawer").classList.add("open");
    $("ck-drawer").setAttribute("aria-hidden", "false");
    $("ck-drawer-back").classList.add("open");
    // A5: focus close button for keyboard/screen-reader users
    var closeBtn = $("ck-drawer-close"); if (closeBtn) closeBtn.focus();
  }
  function depChip(id, icon) {
    var task = S.model.byId[id];
    if (!task) { var m = el("span", "ck-dep missing", icon + " " + id + " (gone)"); return m; }
    var c = el("span", "ck-dep", icon + " " + task.title);
    c.onclick = function () { openDrawer(id); };
    return c;
  }
  function handoffsFor(taskId) {
    var out = [];
    for (var i = 0; i < S.feed.length; i++) { var e = S.feed[i]; if (e.taskId === taskId && e.kind === "handoff") { var p = parseNote(e); if (p && p.summary) out.push({ actor: e.actor, ts: e.ts, summary: p.summary, next_step: p.next_step, system: !!p.system }); } }
    return out;
  }
  function closeDrawer() { S.drawerTaskId = null; $("ck-drawer").classList.remove("open"); $("ck-drawer").setAttribute("aria-hidden", "true"); $("ck-drawer-back").classList.remove("open"); }
  function sectionTitle(t) { var h = el("h4", null, t); return h; }
  function kv(k, v) { var d = el("div", "ck-kv"); d.appendChild(el("span", null, k)); d.appendChild(el("span", null, v)); return d; }
  function emptyState(title, sub) { var d = el("div", "ck-empty"); d.appendChild(el("div", null, title)); if (sub) { var s = el("div"); s.style.marginTop = "6px"; s.style.fontSize = "12px"; s.textContent = sub; d.appendChild(s); } return d; }

  // ========== lease tick (targeted, no full re-render) ==========
  function tickLeases() {
    if (!S.model) return;
    var now = clientNow();
    var nodes = document.querySelectorAll("[data-lease]");
    nodes.forEach(function (node) {
      var task = S.model.byId[node.getAttribute("data-lease")]; if (!task) return;
      var ls = leaseState({ claimedAt: task.claimed_at, leaseExpiresAt: task.lease_expires_at, clientNow: now, offset: S.leaseOffset });
      if (node.classList.contains("ck-lease")) {
        node.className = "ck-lease " + ls.urgency;
        var fill = node.querySelector(".ck-lease-fill"); if (fill) fill.style.width = (ls.fraction == null ? 1 : ls.fraction) * 100 + "%";
        var time = node.querySelector(".ck-lease-time"); if (time) time.textContent = ls.label;
        var rec = node.querySelector(".ck-reclaim");
        var shouldReclaim = ls.urgency === "expired" && (task.status === "claimed" || task.status === "in_progress");
        if (shouldReclaim && !rec) node.appendChild(el("span", "ck-reclaim", "reclaim pending"));
        if (!shouldReclaim && rec) rec.remove();
      } else if (node.classList.contains("ck-ring")) {
        node.className = "ck-ring " + ls.urgency; node.textContent = ls.label;
      }
    });
    // C5: stall is a time-based signal that develops between SSE events. Recompute it
    // for every in-flight task each tick; when the set of stalled tasks changes, re-render
    // the rail + board so the amber badge appears/clears without waiting for an event.
    var stalledNow = {};
    for (var id in S.model.byId) {
      var t = S.model.byId[id];
      if (t.status !== "claimed" && t.status !== "in_progress") continue;
      var ss = stallState({ lastSeenAt: t.ownerLastSeenAt, leaseExpiresAt: t.lease_expires_at, clientNow: now, offset: S.leaseOffset });
      if (ss.stalled) stalledNow[id] = 1;
    }
    var changed = false, key;
    for (key in stalledNow) if (!S.stalledSet[key]) { changed = true; break; }
    if (!changed) for (key in S.stalledSet) if (!stalledNow[key]) { changed = true; break; }
    if (changed) { S.stalledSet = stalledNow; renderRail(); renderBoard(); }
  }

  // ========== live updates ==========
  function scheduleRefetch() {
    if (S.demo) return;
    if (S.refetchTimer) return;
    S.refetchTimer = setTimeout(function () { S.refetchTimer = null; loadData(renderAll); }, 350);
  }
  function onPlanUpdate(evt) {
    if (S.demo) return;
    setConn(false); setTimeout(function(){ setConn(true); }, 600);
    // A newly-created project has an id that never matches S.projectId, so the
    // projectId early-return below would skip it — and the picker is otherwise
    // populated only once on first Plan open. Refresh the picker list now (fires in
    // any view, before both early-returns) so a plan created via fleet_plan_create
    // appears in #ck-project without a page reload.
    if (evt && (evt.kind === "project_create" || evt.kind === "project_delete")) loadProjects();
    // On the Loop page there are no fleet cards to refetch; the loop surfaces self-poll
    // (initLoopCtl/initAppr timers + refresh on switch), so skip the plan refetch path.
    if (S.mainView === "loop") { return; }
    if (!evt || evt.projectId !== S.projectId) return;
    // Capture length BEFORE async refetch; renderFeed consumes it after S.feed updates
    if (S.activeView === "feed") {
      var feedView = $("ck-view-feed");
      if (feedView && feedView.scrollTop > 60) S.feedPrevLen = S.feed.length;
    }
    scheduleRefetch();
  }
  function onReconnect() { if (S.demo) return; loadData(renderAll); setConn(true); }
  function setConn(live) { var c = $("ck-conn"); if (!c) return; c.classList.toggle("stale", !live); $("ck-conn-text").textContent = S.demo ? "demo" : (live ? "live" : "syncing…"); }

  // ========== project picker ==========
  function loadProjects() {
    fetch("/plan-projects").then(function (r) { return r.ok ? r.json() : { projects: [] }; }).then(function (j) {
      var sel = $("ck-project"); sel.textContent = "";
      var demoOpt = document.createElement("option"); demoOpt.value = "__demo__"; demoOpt.textContent = "▸ DEMO — Acme Platform"; sel.appendChild(demoOpt);
      (j.projects || []).forEach(function (p) { var o = document.createElement("option"); o.value = p.id; o.textContent = p.title + " (" + p.taskCount + ")"; sel.appendChild(o); });
      sel.value = S.projectId;
    }).catch(function () {});
  }
  function setProject(pid) {
    S.projectId = pid; S.demo = (pid === "__demo__"); S.openLanes = null; closeDrawer();
    $("ck-demo-flag").style.display = S.demo ? "" : "none";
    if (_delArmTimer) { clearTimeout(_delArmTimer); _delArmTimer = null; } setDelArmed(false); // disarm delete on plan switch
    setConn(true);
    loadData(renderAll);
  }

  // ========== Delete plan (admin) — two-tap confirm so a stray tap can't nuke a real plan ==========
  var _delArmTimer = null;
  function setDelArmed(on) {
    var b = $("ck-del-plan"); if (!b) return;
    b.classList.toggle("armed", on);
    b.textContent = on ? "Confirm?" : "Delete";
  }
  function delPlanClick() {
    if (!S.projectId) return;                 // nothing selected
    var b = $("ck-del-plan"); if (!b || b.disabled) return;
    if (_delArmTimer) { clearTimeout(_delArmTimer); _delArmTimer = null; setDelArmed(false); doDeletePlan(); return; } // 2nd tap → delete
    setDelArmed(true);
    _delArmTimer = setTimeout(function () { _delArmTimer = null; setDelArmed(false); }, 4000); // auto-disarm
  }
  function doDeletePlan() {
    var id = S.projectId; var b = $("ck-del-plan"); if (!id) return;
    if (b) { b.disabled = true; b.textContent = "Deleting…"; }
    fetch("/admin-project-delete", { method: "POST", headers: adminHeaders, body: JSON.stringify({ id: id }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }).catch(function () { return { ok: r.ok, body: {} }; }); })
      .then(function (res) {
        if (b) b.disabled = false;
        if (!res.ok) { if (b) { b.textContent = "Failed"; setTimeout(function () { var x = $("ck-del-plan"); if (x) x.textContent = "Delete"; }, 2000); } return; }
        // Drop the now-gone plan; loadProjects auto-selects the first remaining one.
        S.projectId = null; S.model = null;
        if (b) b.textContent = "Delete";
        loadProjects();
      })
      .catch(function () { if (b) { b.disabled = false; b.textContent = "Delete"; } });
  }

  // ========== "+ New Plan" (admin create) ==========
  // Inline popover form (no native prompt/confirm — those block the page). POSTs to
  // the admin-bearer /admin-project-create; on success refreshes the picker and
  // selects the new plan. (The project_create SSE also refreshes the picker via
  // onPlanUpdate, so the create is visible even without the optimistic refresh here.)
  function newPlanMsg(text, isErr) {
    var m = $("ck-newplan-msg"); if (!m) return;
    m.textContent = text || "";
    m.classList.toggle("err", !!isErr);
  }
  function toggleNewPlanForm(open) {
    var f = $("ck-newplan-form"); if (!f) return;
    var show = (open == null) ? !f.classList.contains("open") : open;
    f.classList.toggle("open", show);
    if (show) {
      newPlanMsg("");
      var t = $("ck-newplan-title"); if (t) { t.value = ""; t.focus(); }
      var b = $("ck-newplan-brief"); if (b) b.value = "";
    }
  }
  function submitNewPlan() {
    var titleEl = $("ck-newplan-title"), briefEl = $("ck-newplan-brief"), btn = $("ck-newplan-create");
    var title = ((titleEl && titleEl.value) || "").trim();
    if (!title) { newPlanMsg("Title required.", true); if (titleEl) titleEl.focus(); return; }
    var brief = ((briefEl && briefEl.value) || "").trim();
    var body = { title: title, by: "operator" };
    if (brief) body.brief = brief;
    if (btn) { btn.disabled = true; btn.textContent = "Creating…"; }
    fetch("/admin-project-create", { method: "POST", headers: adminHeaders, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }).catch(function () { return { ok: r.ok, body: {} }; }); })
      .then(function (res) {
        if (!res.ok || !res.body || !res.body.project) {
          newPlanMsg((res.body && res.body.error) || "Create failed.", true);
          return;
        }
        loadProjects();              // refresh picker options
        toggleNewPlanForm(false);    // close + clear the form
        setProject(res.body.project.id); // select the new plan and load its board
      })
      .catch(function () { newPlanMsg("Create request failed.", true); })
      .then(function () { if (btn) { btn.disabled = false; btn.textContent = "Create"; } });
  }
  function initNewPlan() {
    var openB = $("ck-new-plan"); if (openB) openB.addEventListener("click", function (e) { e.stopPropagation(); toggleNewPlanForm(); });
    var cancelB = $("ck-newplan-cancel"); if (cancelB) cancelB.addEventListener("click", function () { toggleNewPlanForm(false); });
    var createB = $("ck-newplan-create"); if (createB) createB.addEventListener("click", submitNewPlan);
    ["ck-newplan-title", "ck-newplan-brief"].forEach(function (id) {
      var inp = $(id); if (!inp) return;
      inp.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); submitNewPlan(); }
        else if (e.key === "Escape") { e.preventDefault(); toggleNewPlanForm(false); }
      });
    });
  }

  // ========== view switching ==========
  function switchView(view) {
    S.activeView = view;
    if (view === "feed") { S.feedNewCount = 0; }
    var tabs = document.querySelectorAll(".ck-tab"); tabs.forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-view") === view); });
    var views = document.querySelectorAll(".ck-view"); views.forEach(function (v) { v.classList.toggle("active", v.id === "ck-view-" + view); });
    if (view === "dag") renderDagIfVisible();
    if (view === "feed") renderFeed();
  }

  // ========== operator control panel (WS-C) ==========
  function condMsg(text, isErr) {
    var m = $("ck-cond-msg"); if (!m) return;
    m.textContent = text || "";
    m.classList.toggle("err", !!isErr);
  }

  // Launch-Referee: parameterless POST (no request input reaches the spawn argv server-side).
  function launchReferee() {
    var b = $("ck-launch-ref");
    if (b) { b.disabled = true; b.textContent = "launching…"; }
    fetch("/admin-launch-referee", { method: "POST", headers: adminHeaders })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (data && data.error) alert(data.error);
        condMsg(data && data.message ? data.message : "Referee launching — watch the roster (~30–45s).", !!(data && data.error));
      })
      .catch(function () { condMsg("Referee launch request failed.", true); })
      .then(function () { setTimeout(function () { if (b) { b.disabled = false; b.textContent = "+ Referee"; } }, 4000); });
  }

  // Poll /admin-conductor-status only while the cockpit is the active mode.
  function condActive() { return document.body.classList.contains("cockpit-mode"); }
  function condControl() { return (S.conductor && S.conductor.control) || {}; }
  function pinnedList() { return condControl().pinned || []; }
  function pinSig() { return pinnedList().slice().sort().join(","); }
  function isPinned(callsign) { var p = pinnedList(); for (var i = 0; i < p.length; i++) if (p[i] === callsign) return true; return false; }

  function loadConductorStatus() {
    if (!condActive()) return;
    fetch("/admin-conductor-status", { headers: adminHeaders })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && j.ok !== false) {
          var prev = pinSig();
          S.conductor = j; S.condPinLoaded = true;
          renderConductor();
          if (S.model && pinSig() !== prev) renderRail(); // refresh per-agent pin chips only when the set changed
        } else { renderConductor(); }
      })
      .catch(function () { /* keep last-good snapshot */ });
  }

  function renderConductor() {
    var c = S.conductor, ctl = condControl();
    var running = !!(c && c.running), armed = !!ctl.armed;
    var dot = $("ck-cond-dot"); if (dot) dot.classList.toggle("running", running);
    var state = $("ck-cond-state");
    if (state) {
      state.textContent = !c ? "—" : (!running ? "stopped" : (ctl.paused ? "paused" : (armed ? "ARMED" : "observe")));
      state.classList.toggle("armed", running && armed);
    }
    var modeWrap = $("ck-cond-mode");
    if (modeWrap) {
      var btns = modeWrap.querySelectorAll(".ck-cond-seg-btn");
      for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", (btns[i].getAttribute("data-mode") === "armed") === armed);
    }
    var armedBtn = $("ck-cond-armed-btn"); // C5: Armed selectable only after the pinned/flagged set has loaded
    if (armedBtn) {
      armedBtn.disabled = !S.condPinLoaded;
      armedBtn.title = S.condPinLoaded
        ? "Arm the conductor — pinned agents stay kill-exempt"
        : "Loading the flagged/pinned set… review and pin deliberately-idle agents before arming";
    }
    setNumIfBlur("ck-cond-idle", ctl.idleWindowMs != null ? Math.round(ctl.idleWindowMs / 1000) : "");
    setNumIfBlur("ck-cond-interval", ctl.intervalMs != null ? Math.round(ctl.intervalMs / 1000) : "");
    if (c && c.fleetMax != null) setNumIfBlur("ck-cond-fleetmax", c.fleetMax);
    renderFlagged();
  }

  function setNumIfBlur(id, val) {
    var inp = $(id); if (!inp || document.activeElement === inp) return; // don't fight the operator mid-type
    inp.value = (val === "" || val == null) ? "" : String(val);
  }

  function renderFlagged() {
    var wrap = $("ck-cond-flagged"); if (!wrap) return;
    wrap.textContent = "";
    var flagged = (S.conductor && S.conductor.flagged) || [];
    wrap.appendChild(el("div", "ck-cond-flagged-label", flagged.length ? ("Would reap (" + flagged.length + ") — observe set") : "Nothing flagged for reap."));
    flagged.forEach(function (f) {
      var row = el("div", "ck-cond-flagged-row");
      row.appendChild(el("span", "ck-cond-flagged-cs", f.callsign));
      if (f.reason) row.appendChild(el("span", "ck-cond-flagged-reason", f.reason));
      row.appendChild(pinChip(f.callsign)); // INLINE pin (b37c UX): see → pin → arm in one click
      wrap.appendChild(row);
    });
  }

  // Shared pin chip — inline in the flagged list AND per-agent in Right Now.
  function pinChip(callsign) {
    var pinned = isPinned(callsign);
    var chip = el("button", "ck-pin" + (pinned ? " pinned" : ""), pinned ? "📌 pinned" : "pin");
    chip.setAttribute("type", "button");
    chip.title = pinned ? "Kill-exempt — click to unpin" : "Pin: exempt this agent from reap";
    chip.onclick = function (e) { e.stopPropagation(); togglePin(callsign); };
    return chip;
  }

  function togglePin(callsign) {
    var cur = pinnedList(), next = [], had = false;
    for (var i = 0; i < cur.length; i++) { if (cur[i] === callsign) { had = true; } else { next.push(cur[i]); } }
    if (!had) next.push(callsign);
    condConfig({ pinned: next });
  }

  // Single partial-merge config writer; optimistic local apply + authoritative re-poll.
  function condConfig(partial) {
    fetch("/admin-conductor-config", { method: "POST", headers: adminHeaders, body: JSON.stringify(partial) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }).catch(function () { return { ok: r.ok, body: {} }; }); })
      .then(function (res) {
        if (!res.ok || (res.body && res.body.error)) { condMsg((res.body && res.body.error) || "Update rejected (check ranges).", true); }
        else {
          if (res.body && res.body.control) { S.conductor = S.conductor || {}; S.conductor.control = res.body.control; }
          condMsg("Updated.", false);
          renderConductor();
          if (S.model) renderRail();
        }
        loadConductorStatus();
      })
      .catch(function () { condMsg("Config request failed.", true); });
  }

  function setArmed(armed) {
    if (armed && !S.condPinLoaded) { condMsg("Review the flagged set before arming.", true); return; }
    condConfig({ armed: !!armed });
  }

  function condStartStop(start) {
    fetch(start ? "/admin-conductor-start" : "/admin-conductor-stop", { method: "POST", headers: adminHeaders })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) { condMsg(j && j.message ? j.message : (start ? "Conductor started." : "Conductor stopped."), !!(j && j.error)); loadConductorStatus(); })
      .catch(function () { condMsg("Lifecycle request failed.", true); });
  }

  function applyTunables() {
    var idleS = parseInt($("ck-cond-idle").value, 10), intS = parseInt($("ck-cond-interval").value, 10), partial = {};
    if (!isNaN(idleS)) partial.idleWindowMs = idleS * 1000;
    if (!isNaN(intS)) partial.intervalMs = intS * 1000;
    if (!Object.keys(partial).length) { condMsg("Nothing to apply.", false); return; }
    condConfig(partial); // server enforces floors (idle≥60000, interval≥5000) and 400s on violation
  }

  function setFleetMax() {
    var v = parseInt($("ck-cond-fleetmax").value, 10);
    if (isNaN(v)) { condMsg("Enter a max (1–20).", true); return; }
    fetch("/admin-fleet-max", { method: "POST", headers: adminHeaders, body: JSON.stringify({ value: v }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }).catch(function () { return { ok: r.ok, body: {} }; }); })
      .then(function (res) { condMsg((!res.ok || (res.body && res.body.error)) ? ((res.body && res.body.error) || "Max rejected (1–20).") : ("Max agents = " + v + "."), !(res.ok && !(res.body && res.body.error))); })
      .catch(function () { condMsg("Fleet-max request failed.", true); });
  }

  function initConductor() {
    var lr = $("ck-launch-ref"); if (lr) lr.addEventListener("click", launchReferee);
    var head = $("ck-cond-head"); if (head) head.addEventListener("click", function () { $("ck-cond").classList.toggle("open"); });
    var startB = $("ck-cond-start"); if (startB) startB.addEventListener("click", function () { condStartStop(true); });
    var stopB = $("ck-cond-stop"); if (stopB) stopB.addEventListener("click", function () { condStartStop(false); });
    var modeWrap = $("ck-cond-mode");
    if (modeWrap) {
      var btns = modeWrap.querySelectorAll(".ck-cond-seg-btn");
      for (var i = 0; i < btns.length; i++) (function (btn) {
        btn.addEventListener("click", function () { if (btn.disabled) return; setArmed(btn.getAttribute("data-mode") === "armed"); });
      })(btns[i]);
    }
    var apply = $("ck-cond-apply"); if (apply) apply.addEventListener("click", applyTunables);
    var fm = $("ck-cond-fleetmax-btn"); if (fm) fm.addEventListener("click", setFleetMax);
    loadConductorStatus();
    S.condPollTimer = setInterval(loadConductorStatus, 5000);
  }

  // ========== operator loops panel (Phase 2) ==========
  // Mirrors the conductor card: a persistent collapsible operator section, admin-token
  // gated, polled every 5s while the cockpit is the active mode. Reads /loop-admin-list
  // and drives override Pause/Resume/Terminate (admin POSTs, no owner check).
  function loopCtlMsg(text, isErr) {
    var m = $("ck-lctl-msg"); if (!m) return;
    m.textContent = text || "";
    m.classList.toggle("err", !!isErr);
  }
  function loadLoopCtl() {
    if (!condActive()) return; // poll only while the cockpit is the active mode
    fetch("/loop-admin-list", { headers: adminHeaders })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !Array.isArray(j.loops)) return; // keep last-good on a transient failure
        var now = typeof j.now === "number" ? j.now : Date.now();
        S.loopCtl = buildLoopViews(j.loops, now);
        renderLoopCtl();
      })
      .catch(function () { /* keep last-good snapshot */ });
  }
  function loopCtlGaugeLevel(ratio) { return ratio == null ? "ok" : ratio >= LOOP_CRIT_AT ? "crit" : ratio >= LOOP_WARN_AT ? "warn" : "ok"; }
  function loopCtlGaugeRow(label, g, kind) {
    // kind "cap" → green/amber/red by ratio; "info" → always accent (completeness is progress, not danger)
    var row = el("div", "ck-lctl-gauge");
    row.appendChild(el("span", "ck-lctl-gauge-label", label));
    var bar = el("div", "ck-lctl-bar");
    var fill = el("div", "ck-lctl-fill " + (kind === "info" ? "info" : loopCtlGaugeLevel(g.ratio)));
    fill.style.width = (g.ratio == null ? 0 : Math.min(100, Math.round(g.ratio * 100))) + "%";
    bar.appendChild(fill); row.appendChild(bar);
    row.appendChild(el("span", "ck-lctl-gauge-val", g.label));
    return row;
  }
  function renderLoopCtl() {
    var list = $("ck-lctl-list"); if (!list) return;
    list.textContent = "";
    var loops = S.loopCtl || [];
    var active = 0;
    loops.forEach(function (l) { if (l.active) active++; });
    var cnt = $("ck-lctl-count"); if (cnt) cnt.textContent = loops.length ? "(" + active + " active / " + loops.length + ")" : "";
    var dot = $("ck-lctl-dot"); if (dot) dot.classList.toggle("active", active > 0);
    if (!loops.length) { list.appendChild(el("div", "ck-lctl-empty", "No loops registered.")); return; }
    loops.forEach(function (l) {
      var card = el("div", "ck-lctl-card " + (l.active ? l.pressure : "terminal"));
      var head = el("div", "ck-lctl-card-head");
      head.appendChild(el("span", "ck-lctl-name", l.label));
      head.appendChild(el("span", "ck-lctl-badge " + l.status, (l.status === "stopped" || l.status === "paused") && l.stop_reason ? l.stop_reason : l.status));
      card.appendChild(head);
      var meta = el("div", "ck-lctl-meta");
      meta.appendChild(el("span", null, l.kind));
      meta.appendChild(el("span", null, "· " + l.owner));
      card.appendChild(meta);
      var gauges = el("div", "ck-lctl-gauges");
      if (l.iter.shown) gauges.appendChild(loopCtlGaugeRow("iterations", l.iter, "cap"));
      if (l.tokens.shown) gauges.appendChild(loopCtlGaugeRow("tokens", l.tokens, "cap"));
      if (l.time.shown) gauges.appendChild(loopCtlGaugeRow("time", l.time, "cap"));
      if (l.completeness.shown) gauges.appendChild(loopCtlGaugeRow("complete", l.completeness, "info"));
      if (gauges.childNodes.length) card.appendChild(gauges);
      // Phase 4 completeness trajectory — folded into the card here (coord call). Reads
      // loop.state.scores OPTIONALLY: absent on basic loops + until P4 integrates ⇒ no-op.
      if (l.scores && l.scores.length >= 2) {
        var SVGNS = "http://www.w3.org/2000/svg";
        var SPK_W = 180, SPK_H = 22;
        var spark = el("div", "ck-lctl-spark");
        spark.appendChild(el("div", "ck-lctl-spark-label", "completeness trajectory"));
        var svg = document.createElementNS(SVGNS, "svg");
        svg.setAttribute("class", "ck-lctl-spark-svg");
        svg.setAttribute("viewBox", "0 0 " + SPK_W + " " + SPK_H);
        svg.setAttribute("preserveAspectRatio", "none");
        var path = document.createElementNS(SVGNS, "path");
        path.setAttribute("class", "ck-lctl-spark-line");
        path.setAttribute("d", loopSparkPath(l.scores, SPK_W, SPK_H));
        svg.appendChild(path);
        spark.appendChild(svg);
        card.appendChild(spark);
      }
      // Phase 4 verdict chip — recommendation drives the colour; absent on basic loops.
      if (l.verdict) {
        var vrow = el("div", "ck-lctl-verdict");
        vrow.appendChild(el("span", "ck-lctl-verdict-rec " + l.verdict.recommendation, l.verdict.recommendation));
        if (l.verdict.status) vrow.appendChild(el("span", "ck-lctl-verdict-status", l.verdict.status));
        card.appendChild(vrow);
      }
      if (l.active) {
        var actions = el("div", "ck-lctl-actions");
        var pr = el("button", "ck-lctl-btn", l.status === "paused" ? "Resume" : "Pause");
        pr.setAttribute("type", "button");
        (function (id, paused) { pr.onclick = function () { loopCtlAction(paused ? "/loop-admin-resume" : "/loop-admin-pause", id, pr); }; })(l.id, l.status === "paused");
        actions.appendChild(pr);
        var tm = el("button", "ck-lctl-btn danger", "Terminate");
        tm.setAttribute("type", "button");
        (function (id) { tm.onclick = function () { loopCtlAction("/loop-admin-stop", id, tm); }; })(l.id);
        actions.appendChild(tm);
        card.appendChild(actions);
      }
      list.appendChild(card);
    });
  }
  function loopCtlAction(path, id, btn) {
    if (btn) btn.disabled = true;
    var body = path === "/loop-admin-stop" ? { id: id, reason: "external_terminate" } : { id: id };
    fetch(path, { method: "POST", headers: adminHeaders, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }).catch(function () { return { ok: r.ok, body: {} }; }); })
      .then(function (res) {
        if (!res.ok || (res.body && res.body.error)) loopCtlMsg((res.body && res.body.error) || "Loop action rejected.", true);
        else loopCtlMsg("", false);
        loadLoopCtl(); // authoritative re-poll re-enables/relabels the buttons
      })
      .catch(function () { loopCtlMsg("Loop request failed.", true); if (btn) btn.disabled = false; });
  }
  function initLoopCtl() {
    var head = $("ck-lctl-head"); if (head) head.addEventListener("click", function () { $("ck-lctl").classList.toggle("open"); });
    loadLoopCtl();
    renderLoopsSchedule(); // Phase 3 schedule now shares the loop cadence (the Live view that drove it was removed)
    S.loopCtlTimer = setInterval(function () { loadLoopCtl(); renderLoopsSchedule(); }, 5000);
  }

  // ========== operator approvals panel (Phase 5 HITL — integration) ==========
  // The human-in-the-loop queue: when a loop's verifier escalates, the engine PAUSES it
  // and opens a pending approval (atomic, inside the tick txn). This admin-gated panel
  // lists pending approvals and lets the operator approve (→ resumeLoop) or reject
  // (→ stopLoop). Polled 5s while the cockpit is active (like ck-lctl/conductor) and
  // refreshed instantly on the additive loop_approval SSE. Self-contained ck-appr block.
  function apprMsg(text, isErr) {
    var m = $("ck-appr-msg"); if (!m) return;
    m.textContent = text || "";
    m.classList.toggle("err", !!isErr);
  }
  function loadAppr() {
    if (!condActive()) return; // poll only while the cockpit is the active mode
    fetch("/loop-approvals?status=pending", { headers: adminHeaders })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !Array.isArray(j.approvals)) return; // keep last-good on a transient failure
        S.appr = j.approvals;
        renderAppr();
      })
      .catch(function () { /* keep last-good snapshot */ });
  }
  function renderAppr() {
    var list = $("ck-appr-list"); if (!list) return;
    list.textContent = "";
    var items = S.appr || [];
    var cnt = $("ck-appr-count");
    if (cnt) { cnt.textContent = items.length ? "(" + items.length + ")" : ""; cnt.classList.toggle("pending", items.length > 0); }
    var dot = $("ck-appr-dot"); if (dot) dot.classList.toggle("pending", items.length > 0);
    // Pinned top-bar badge: always-visible pending count even when off the Loop page.
    var badge = $("ck-appr-badge"), badgeN = $("ck-appr-badge-n");
    if (badge && badgeN) { badgeN.textContent = String(items.length); badge.style.display = items.length ? "" : "none"; }
    if (!items.length) { list.appendChild(el("div", "ck-appr-empty", "No pending approvals.")); return; }
    var now = Date.now();
    items.forEach(function (a) {
      var card = el("div", "ck-appr-card");
      var head = el("div", "ck-appr-cardhead");
      head.appendChild(el("span", "ck-appr-name", a.loop_id || "loop"));
      head.appendChild(el("span", "ck-appr-badge", a.status || "pending"));
      card.appendChild(head);
      var v = a.verdict;
      if (v) {
        var vrow = el("div", "ck-appr-verdict");
        if (v.recommendation) vrow.appendChild(el("span", "ck-appr-rec", v.recommendation));
        if (v.status) vrow.appendChild(el("span", "ck-appr-vstatus", v.status + (typeof v.completeness === "number" ? " · " + Math.round(v.completeness * 100) + "%" : "")));
        var gaps = [];
        if (Array.isArray(v.missing) && v.missing.length) gaps.push(v.missing.length + " missing");
        if (Array.isArray(v.contradictions) && v.contradictions.length) gaps.push(v.contradictions.length + " contradiction" + (v.contradictions.length !== 1 ? "s" : ""));
        if (gaps.length) vrow.appendChild(el("span", "ck-appr-gap", gaps.join(" · ")));
        card.appendChild(vrow);
        if (v.rationale) card.appendChild(el("div", "ck-appr-rationale", v.rationale));
      }
      // reason (skip if it's just the rationale we already showed)
      if (a.reason && !(v && a.reason === v.rationale)) card.appendChild(el("div", "ck-appr-reason", a.reason));
      if (typeof a.created_at === "number") card.appendChild(el("div", "ck-appr-meta", "escalated " + relTime(a.created_at, now)));
      var actions = el("div", "ck-appr-actions");
      var ok = el("button", "ck-appr-btn approve", "Approve → resume"); ok.setAttribute("type", "button");
      (function (id) { ok.onclick = function () { apprResolve(id, "approve", ok); }; })(a.id);
      actions.appendChild(ok);
      var no = el("button", "ck-appr-btn reject", "Reject → terminate"); no.setAttribute("type", "button");
      (function (id) { no.onclick = function () { apprResolve(id, "reject", no); }; })(a.id);
      actions.appendChild(no);
      card.appendChild(actions);
      list.appendChild(card);
    });
  }
  function apprResolve(id, decision, btn) {
    if (btn) btn.disabled = true;
    fetch("/loop-approval-resolve", { method: "POST", headers: adminHeaders, body: JSON.stringify({ id: id, decision: decision, by: "operator" }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }).catch(function () { return { ok: r.ok, body: {} }; }); })
      .then(function (res) {
        if (!res.ok || (res.body && res.body.error)) apprMsg((res.body && res.body.error) || "Approval action rejected.", true);
        else apprMsg("", false);
        loadAppr();    // refresh the queue
        loadLoopCtl(); // the loop's status changed (resumed / terminated)
      })
      .catch(function () { apprMsg("Approval request failed.", true); if (btn) btn.disabled = false; });
  }
  function initAppr() {
    var head = $("ck-appr-head"); if (head) head.addEventListener("click", function () { $("ck-appr").classList.toggle("open"); });
    // Pinned badge → jump to the Loop page, expand approvals, scroll them into view (last panel).
    var badge = $("ck-appr-badge");
    if (badge) badge.addEventListener("click", function () {
      switchMainView("loop");
      var ap = $("ck-appr"); if (ap) ap.classList.add("open");
      var v = $("ck-view-loop"); if (v) v.scrollTop = v.scrollHeight;
    });
    loadAppr();
    S.apprTimer = setInterval(loadAppr, 5000);
  }

  // ========== interactive terminal ==========
  // Click a live agent's name → POST /terminal-ticket (admin/cockpit-token gated)
  // → open a WS to /terminal?ticket=… → render the tmux mirror in xterm.js
  // (vendored, no CDN). WRITABLE by default (full control): keystrokes drive the
  // live session immediately. "Release control" drops to a read-only mirror.
  // Closing tears down the WS + the term.
  var TERM = { ws: null, term: null, fit: null, callsign: null, readonly: false, status: "", onData: null, resizeHandler: null, closing: false, reconnectTimer: null, reconnectDelay: 0 };

  // No terminal-local chrome anymore — the active agent name + connection status
  // live on the MAIN app header (#term-active-label). termSetBadge just tracks
  // write/read state (gates input forwarding); termSetStatus updates the header tail.
  function setTermHeaderLabel() {
    var el = document.getElementById("term-active-label");
    if (!el) return;
    if (!TERM.callsign) { el.textContent = ""; el.classList.remove("active"); return; }
    el.textContent = "▶ " + TERM.callsign + " terminal" + (TERM.status ? " · " + TERM.status : "");
    el.classList.add("active");
  }
  function termSetBadge(readonly) { TERM.readonly = readonly; }

  function termSetStatus(msg) { TERM.status = msg || ""; setTermHeaderLabel(); }

  function openTerminal(callsign) {
    if (typeof Terminal === "undefined") { termSetStatus("xterm.js not loaded"); return; }
    // Tear down any existing session first (one panel at a time).
    closeTerminal();
    // closeTerminal() armed the intentional-close guard; clear it so drops in THIS
    // fresh session auto-reconnect, and reset the backoff ladder to 0.5s.
    TERM.closing = false;
    TERM.reconnectDelay = 0;
    TERM.callsign = callsign;
    termSetBadge(false); // writable by default (full control) — terminal stays write
    termSetStatus("connecting…"); // surfaces "▶ <callsign> terminal · connecting…" on the main header
    // The terminal now takes over the radio .message-area, so guarantee we're in
    // Radio mode before showing it — the cockpit Right-Now rail entry point can
    // fire while cockpit-mode hides the chat column. Mirror the header
    // mode-switch's own class toggles (it owns no exported setter).
    document.body.classList.remove("cockpit-mode");
    var rb = document.getElementById("mode-radio"), cb = document.getElementById("mode-cockpit");
    if (rb) rb.classList.add("active");
    if (cb) cb.classList.remove("active");
    $("ck-term-overlay").classList.add("open");
    $("ck-term-overlay").setAttribute("aria-hidden", "false");

    // Build the xterm instance.
    var term = new Terminal({ convertEol: false, cursorBlink: true, fontFamily: "IBM Plex Mono, monospace", fontSize: 13, theme: { background: "#FEFCF6", foreground: "#423F37", cursor: "#C9501A", cursorAccent: "#FEFCF6", selectionBackground: "#E2D6BF", selectionForeground: "#1A1C18", black: "#3A3A33", red: "#B23A1A", green: "#58721D", yellow: "#8D6110", blue: "#3D6577", magenta: "#8A4E63", cyan: "#2C7568", white: "#B0561B", brightBlack: "#EDE6D5", brightRed: "#C34E19", brightGreen: "#647C27", brightYellow: "#926D24", brightBlue: "#4B7A8D", brightMagenta: "#9C6277", brightCyan: "#338072", brightWhite: "#B23A1A" } });
    TERM.term = term;
    try {
      var FitCtor = (window.FitAddon && window.FitAddon.FitAddon) ? window.FitAddon.FitAddon : null;
      if (FitCtor) { TERM.fit = new FitCtor(); term.loadAddon(TERM.fit); }
    } catch (e) { TERM.fit = null; }
    term.open($("ck-term-body"));
    try { if (TERM.fit) TERM.fit.fit(); } catch (e) {}

    // Mint a single-use ticket (browser-gated by the cockpit token), then open WS.
    fetch("/terminal-ticket", { method: "POST", headers: adminHeaders, body: JSON.stringify({ callsign: callsign }) })
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (j) { throw new Error(j.error || ("HTTP " + r.status)); }); })
      .then(function (j) { termConnect(j.ticket); })
      .catch(function (e) { termSetStatus("ticket failed: " + e.message); });
  }

  function termConnect(ticket) {
    // Reconnect REUSES the same xterm (so tmux redraws the live screen in place, no
    // flash) — but the prior onData/resize listeners are still bound to it. Dispose
    // them before re-binding below, or each keystroke sends Nx and resize stacks.
    if (TERM.onData && TERM.onData.dispose) { try { TERM.onData.dispose(); } catch (e) {} TERM.onData = null; }
    if (TERM.resizeHandler) { window.removeEventListener("resize", TERM.resizeHandler); TERM.resizeHandler = null; }
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var ws = new WebSocket(proto + "//" + location.host + "/terminal?ticket=" + encodeURIComponent(ticket));
    ws.binaryType = "arraybuffer";
    TERM.ws = ws;
    ws.onopen = function () {
      TERM.reconnectDelay = 0; // healthy connect — reset the backoff ladder
      termSetStatus("connected");
      // Send our size so the mirror matches the panel.
      termSendResize();
    };
    ws.onmessage = function (ev) {
      var data = ev.data;
      if (typeof data === "string") {
        // Our control frames are JSON beginning with {"__ctl".
        if (data.charAt(0) === "{" && data.indexOf('"__ctl"') !== -1) {
          var msg = null; try { msg = JSON.parse(data); } catch (e) { msg = null; }
          if (msg && msg.__ctl) { if (msg.type === "mode") termSetBadge(!!msg.readonly); return; }
        }
        if (TERM.term) TERM.term.write(data);
      } else {
        // Binary pane output.
        if (TERM.term) TERM.term.write(new Uint8Array(data));
      }
    };
    ws.onclose = function () {
      if (TERM.closing) { termSetStatus("disconnected"); return; } // intentional teardown — stay closed
      termScheduleReconnect(); // unintentional drop (bounce / sleep / proxy idle / blip) → self-heal
    };
    ws.onerror = function () { termSetStatus("connection error"); };

    // Forward keystrokes — the SERVER drops them in read-only mode, but we also
    // guard here so read-only never even transmits input.
    TERM.onData = TERM.term.onData(function (d) {
      if (TERM.readonly) return;
      if (TERM.ws && TERM.ws.readyState === 1) TERM.ws.send(d);
    });

    // Refit + report size on window resize.
    TERM.resizeHandler = function () { try { if (TERM.fit) TERM.fit.fit(); } catch (e) {} termSendResize(); };
    window.addEventListener("resize", TERM.resizeHandler);
  }

  // Auto-reconnect: on an UNINTENTIONAL drop (hub bounce / laptop sleep / proxy idle /
  // net blip) re-mint a FRESH single-use ticket and reopen the WS, reattaching the
  // still-live tmux session — the screen comes back in ~1-2s with no page refresh.
  // Backoff 0.5→1→2→4→cap 6s, single timer, retries indefinitely (a bounce can take a
  // few seconds); the mint .catch re-arms so a still-down hub never dead-ends.
  function termScheduleReconnect() {
    if (TERM.closing || !TERM.callsign) return;
    if (TERM.reconnectTimer) { clearTimeout(TERM.reconnectTimer); TERM.reconnectTimer = null; }
    var delay = TERM.reconnectDelay ? Math.min(TERM.reconnectDelay * 2, 6000) : 500;
    TERM.reconnectDelay = delay;
    termSetStatus("reconnecting…");
    TERM.reconnectTimer = setTimeout(function () {
      TERM.reconnectTimer = null;
      if (TERM.closing || !TERM.callsign) return;
      // Pin THIS retry to its session. An A→B switch mid-fetch flips closing back to
      // false under B, so guarding the resolve on !closing alone is not enough — also
      // require the callsign to still be cs, or A's in-flight ticket hijacks B's panel
      // (resolve) / spuriously re-arms a reconnect on healthy B (reject).
      var cs = TERM.callsign;
      // FRESH single-use ticket each attempt (the ticket is one-shot).
      fetch("/terminal-ticket", { method: "POST", headers: adminHeaders, body: JSON.stringify({ callsign: cs }) })
        .then(function (r) { return r.ok ? r.json() : r.json().then(function (j) { throw new Error(j.error || ("HTTP " + r.status)); }); })
        .then(function (j) { if (!TERM.closing && TERM.callsign === cs) termConnect(j.ticket); })
        .catch(function () { if (!TERM.closing && TERM.callsign === cs) termScheduleReconnect(); }); // hub still down → re-arm, don't dead-end
    }, delay);
  }

  function termSendResize() {
    if (!TERM.ws || TERM.ws.readyState !== 1 || !TERM.term) return;
    try { TERM.ws.send(JSON.stringify({ type: "resize", cols: TERM.term.cols, rows: TERM.term.rows })); } catch (e) {}
  }

  function closeTerminal() {
    // Arm the intentional-close guard BEFORE .close()ing the ws so its onclose sees
    // TERM.closing and does NOT schedule a reconnect; cancel any pending reconnect
    // timer and reset the backoff ladder.
    TERM.closing = true;
    if (TERM.reconnectTimer) { clearTimeout(TERM.reconnectTimer); TERM.reconnectTimer = null; }
    TERM.reconnectDelay = 0;
    if (TERM.resizeHandler) { window.removeEventListener("resize", TERM.resizeHandler); TERM.resizeHandler = null; }
    if (TERM.onData && TERM.onData.dispose) { try { TERM.onData.dispose(); } catch (e) {} TERM.onData = null; }
    if (TERM.ws) { try { TERM.ws.close(); } catch (e) {} TERM.ws = null; }
    if (TERM.term) { try { TERM.term.dispose(); } catch (e) {} TERM.term = null; }
    TERM.fit = null; TERM.callsign = null; TERM.readonly = false; TERM.status = "";
    setTermHeaderLabel(); // clear the active-terminal label off the main header
    var ov = $("ck-term-overlay"); if (ov) { ov.classList.remove("open"); ov.setAttribute("aria-hidden", "true"); }
  }

  function initTerminal() {
    // No in-panel buttons anymore — exit/restore is channel-click
    // (selectChannel→closeTerminal, wired in dashboard.ts) or Esc. Keep only Esc.
    document.addEventListener("keydown", function (e) { var ov = $("ck-term-overlay"); if (e.key === "Escape" && ov && ov.classList.contains("open")) closeTerminal(); });
  }

  // ========== init ==========
  function init() {
    if (!document.getElementById("cockpit")) return;
    // E1: Live/Plan toggle
    document.querySelectorAll(".ck-main-btn").forEach(function(b) {
      b.addEventListener("click", function() { switchMainView(b.getAttribute("data-main")); });
    });
    document.querySelectorAll(".ck-tab").forEach(function (t) { t.addEventListener("click", function () { switchView(t.getAttribute("data-view")); }); });
    $("ck-drawer-close").addEventListener("click", closeDrawer);
    $("ck-drawer-back").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", function(e) { if (e.key === "Escape" && S.drawerTaskId) closeDrawer(); });
    $("ck-project").addEventListener("change", function () { setProject(this.value); });
    var delPlanB = $("ck-del-plan"); if (delPlanB) delPlanB.addEventListener("click", delPlanClick);
    initNewPlan();
    window.addEventListener("resize", function () { if (S.activeView === "dag") renderDagIfVisible(); });
    setInterval(tickLeases, 1000);
    initConductor(); // WS-C: operator control panel wiring + status poll
    initLoopCtl(); // Phase 2: operator loops panel wiring + status poll
    initAppr(); // Phase 5 (integration): HITL approvals panel wiring + status poll
    initTerminal(); // Interactive terminal panel wiring (clickable rail names)
    // E1: Default to Loop view; Plan loads lazily. Loop surfaces are driven by
    // initLoopCtl/initAppr above (control + schedule + approvals self-poll).
    document.body.classList.add("ck-main-loop");
    window.__cockpit = {
      openTerminal: openTerminal,
      closeTerminal: closeTerminal, // radio channel-select calls this to restore chat

      onPlanUpdate: onPlanUpdate,
      onReconnect: function() { if (S.mainView !== "loop") loadData(renderAll); setConn(true); loadConductorStatus(); loadLoopCtl(); renderLoopsSchedule(); loadAppr(); },
      show: function() { if (S.mainView !== "loop") loadData(renderAll); loadConductorStatus(); loadLoopCtl(); renderLoopsSchedule(); loadAppr(); },
      refresh: function() { if (S.mainView !== "loop") loadData(renderAll); loadConductorStatus(); loadLoopCtl(); renderLoopsSchedule(); loadAppr(); },
      // Phase 5 (integration): instant refresh on the loop_approval SSE (escalate opened a
      // queue item, or an approval was resolved). Also refresh ck-lctl since the loop paused/resumed.
      onLoopApproval: function() { loadAppr(); loadLoopCtl(); }
    };
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
`;
