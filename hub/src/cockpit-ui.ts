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

/* E1: Live/Plan main toggle */
.ck-main-toggle { display: flex; gap: 2px; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 8px; padding: 2px; flex: none; }
.ck-main-btn { appearance: none; border: none; background: transparent; color: var(--text-secondary); font: inherit; font-size: 12px; padding: 4px 11px; border-radius: 6px; cursor: pointer; }
.ck-main-btn.active { background: var(--accent-soft); color: var(--accent-text); }

/* E1: Live fleet view container */
#ck-view-live { display: none; flex: 1; overflow-y: auto; padding: 12px; flex-direction: column; }
body.ck-main-live #ck-view-live { display: flex; }
body.ck-main-live #ck-plan-wrap { display: none; }
body.ck-main-live .ck-proj { display: none; }
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
`;
}

export function cockpitMarkup(): string {
  return `
<div id="cockpit">
  <div class="ck-bar">
    <div class="ck-main-toggle">
      <button class="ck-main-btn active" data-main="live">Live</button>
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
    </div>
    <button class="ck-launch-ref" id="ck-launch-ref" title="Spawn a headless referee on this hub (tmux)">+ Referee</button>
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
  <div id="ck-view-live"></div>
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
`;
}

// The browser script. Exposes window.__cockpit = { onPlanUpdate, onReconnect, show, hide }.
// adminToken threads the operator-control Bearer token into the cockpit's own scope so its
// admin POSTs (launch-referee, conductor config/start/stop, fleet-max, pin) are gated exactly
// like the dashboard. The PROD call-site (dashboard.ts getDashboardHTML) passes the real token;
// the default "" (no-arg test path) yields an empty Bearer → 401 fail-SAFE, never fail-open.
// Function-replacer (not a string pattern) so a "$"-bearing token is inserted verbatim.
export function cockpitScript(adminToken: string = ""): string {
  return COCKPIT_SCRIPT.replace("__WT_ADMIN_TOKEN__", function () { return adminToken; });
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
  // WS2 context gauge — mirrors the FROZEN consumer contract. Bar max = the over (auto-compact) trigger so a full bar reads as "act now".
  // Constant names + VALUES are kept identical to the classic board render in dashboard.ts so the two views can never disagree on a band or on "ts-stale".
  var CONTEXT_OVER = 400000, CONTEXT_WARN = 320000, CONTEXT_STALE_MS = 120000;
  function fmtCtx(n) { return n >= 1000 ? Math.round(n / 1000) + "k" : String(n); }
  // v2 lockstep rule (ratified with dashboard.ts renderBoard): a parked-but-alive agent's count is still accurate, so don't grey it.
  // presenceLive = online && !presence-stale. ts-stale only means "untrusted" when presence is ALSO gone.
  function ctxBand(tokens, ts, now, presenceLive) {
    if (tokens == null || ts == null) return { cls: "pending", val: "pending", pct: 0 };
    var pct = Math.min(100, Math.round(tokens / CONTEXT_OVER * 100));
    var base = tokens >= CONTEXT_OVER ? "red" : tokens >= CONTEXT_WARN ? "amber" : "green";
    if (now - ts > CONTEXT_STALE_MS) {
      // gauge frozen: alive→keep true color + mark parked (count valid); dead→grey (value untrusted). Conductor stays ts-keyed regardless.
      return presenceLive
        ? { cls: base + " parked", val: fmtCtx(tokens), pct: pct }
        : { cls: "stale", val: fmtCtx(tokens), pct: pct };
    }
    return { cls: base, val: fmtCtx(tokens), pct: pct };
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
    mainView: "live", liveEntries: [], liveOffset: 0, liveRefetchTimer: null,
    stalledSet: {}, // C5: task ids currently flagged stalled, for tick-driven badge toggling
    wedged: [], wedgedSet: {}, // W4.1-a: dead-blocker-wedged tasks (this project) + id→deadBlockers lookup
    conductor: null, condPollTimer: null, condPinLoaded: false // WS-C: last /admin-conductor-status snapshot + poll handle; condPinLoaded gates Armed (C5)
  };
  var FEED_LIMIT = 200;
  function $(id) { return document.getElementById(id); }

  // ========== demo fixture (relative to client now) ==========
  function buildDemoData(now) {
    var MIN = 60000;
    function t(o) { o.project_id = "__demo__"; if (o.parent_id === undefined) o.parent_id = null; if (o.detail === undefined) o.detail = null; if (o.owner === undefined) o.owner = null; if (o.owner_sid === undefined) o.owner_sid = null; if (o.priority === undefined) o.priority = 2; o.artifacts = o.artifacts || null; if (o.claimed_at === undefined) o.claimed_at = null; if (o.done_at === undefined) o.done_at = null; if (o.lease_expires_at === undefined) o.lease_expires_at = null; o.created_at = o.created_at || (now - 90 * MIN); o.updated_at = now; return o; }
    var lanes = {
      proposed: [ t({ id: "site-synth", title: "Site survey synthesis", priority: 1 }), t({ id: "mood", title: "Client mood-board review", priority: 3 }) ],
      ratified: [ t({ id: "permit-mtx", title: "Permit scope matrix", priority: 1 }) ],
      ready: [ t({ id: "grading", title: "Grading & drainage plan", priority: 0 }), t({ id: "plants", title: "Plant schedule v2", priority: 2 }) ],
      claimed: [ t({ id: "irrig", title: "Irrigation zoning", owner: "linux-pie", owner_sid: "s-pie", priority: 1, claimed_at: now - 30 * MIN, lease_expires_at: now - 25000 }) ],
      in_progress: [
        t({ id: "hardscape", title: "Hardscape layout", owner: "linux-255c", owner_sid: "s-255c", priority: 0, claimed_at: now - 12 * MIN, lease_expires_at: now + 40000 }),
        t({ id: "lighting", title: "Landscape lighting plan", owner: "linux-d4aa", owner_sid: "s-d4aa", priority: 2, claimed_at: now - 6 * MIN, lease_expires_at: now + 12 * MIN })
      ],
      review: [ t({ id: "drainage-calc", title: "Drainage volume calc", owner: "linux-fieldbook", owner_sid: "s-fb", priority: 1, claimed_at: now - 20 * MIN }) ],
      blocked: [ t({ id: "cost-est", title: "Final cost estimate", priority: 0 }) ],
      done: [ t({ id: "topo", title: "Topo import", priority: 2, done_at: now - 70 * MIN }), t({ id: "trees", title: "Tree inventory", priority: 2, done_at: now - 60 * MIN }),
        t({ id: "patio", title: "Patio detail", parent_id: "hardscape", priority: 2, done_at: now - 15 * MIN }) ],
      failed: [],
      abandoned: [ t({ id: "concept-a", title: "Concept A (rejected)", priority: 4 }) ]
    };
    // a second child of hardscape, still in progress (drives the child rollup 2/1/1)
    lanes.in_progress.push(t({ id: "retwall", title: "Retaining wall detail", parent_id: "hardscape", owner: "linux-255c", owner_sid: "s-255c", priority: 1, claimed_at: now - 9 * MIN, lease_expires_at: now + 8 * MIN }));
    // Stamp each task's status from its lane (real /plan-board rows carry status;
    // the fixture derives it from lane membership so the model reads it correctly).
    Object.keys(lanes).forEach(function (k) { lanes[k].forEach(function (task) { task.status = k; }); });
    var deps = [
      { task_id: "hardscape", blocks_on: "grading" },
      { task_id: "cost-est", blocks_on: "grading" }, { task_id: "cost-est", blocks_on: "plants" },
      { task_id: "cost-est", blocks_on: "hardscape" }, { task_id: "cost-est", blocks_on: "irrig" }
    ];
    var childSummaries = { hardscape: { total: 2, terminal: 1, done: 1 } };
    var events = [
      { id: 1, task_id: "topo", ts: now - 70 * MIN, actor: "linux-255c", kind: "transition", from_status: "in_progress", to_status: "done", note: null },
      { id: 2, task_id: "trees", ts: now - 60 * MIN, actor: "linux-fieldbook", kind: "transition", from_status: "review", to_status: "done", note: null },
      { id: 3, task_id: "hardscape", ts: now - 12 * MIN, actor: "linux-255c", kind: "claim", from_status: "ready", to_status: "claimed", note: null },
      { id: 4, task_id: "hardscape", ts: now - 12 * MIN, actor: "linux-255c", kind: "transition", from_status: "claimed", to_status: "in_progress", note: null },
      { id: 5, task_id: "lighting", ts: now - 6 * MIN, actor: "linux-d4aa", kind: "claim", from_status: "ready", to_status: "claimed", note: null },
      { id: 6, task_id: "drainage-calc", ts: now - 20 * MIN, actor: "linux-fieldbook", kind: "claim", from_status: "ready", to_status: "claimed", note: null },
      { id: 7, task_id: "drainage-calc", ts: now - 4 * MIN, actor: "linux-fieldbook", kind: "handoff", from_status: null, to_status: null, note: JSON.stringify({ summary: "Calc'd peak runoff for 25-yr storm; needs a second reviewer to sanity-check the C-values before sign-off.", next_step: "Verify runoff coefficients against the soil report", blockers: [] }) },
      { id: 8, task_id: "cost-est", ts: now - 3 * MIN, actor: "linux-d4aa", kind: "transition", from_status: "ready", to_status: "blocked", note: null },
      { id: 9, task_id: "irrig", ts: now - 30 * MIN, actor: "linux-pie", kind: "claim", from_status: "ready", to_status: "claimed", note: null },
      { id: 10, task_id: "irrig", ts: now - 20000, actor: "system", kind: "lease_expired", from_status: null, to_status: null, note: JSON.stringify({ summary: "Lease expired — reclaim pending on next sweep.", system: true }) }
    ];
    var presence = [
      { sid: "s-255c", name: "linux-255c", online: true, lastSeenAt: now - 20000 },
      // C5 demo: d4aa holds a healthy 12min lease but hasn't beat in ~6min → stalled radar.
      { sid: "s-d4aa", name: "linux-d4aa", online: true, lastSeenAt: now - 6 * MIN },
      { sid: "s-fb", name: "linux-fieldbook", online: true, lastSeenAt: now - 15000 },
      { sid: "s-pie", name: "linux-pie", online: false, lastSeenAt: now - 30 * MIN }
    ];
    return { board: { project: { id: "__demo__", title: "Garden of Bloom — Riverside Estate", status: "active" }, lanes: lanes, deps: deps, childSummaries: childSummaries, now: now }, events: events, presence: presence };
  }

  // ========== live fleet data + render ==========
  function loadLiveData(cb) {
    fetch("/board").then(function(r) { return r.ok ? r.json() : { board: [], now: Date.now() }; }).catch(function() { return { board: [], now: Date.now() }; }).then(function(j) {
      var now = typeof j.now === "number" ? j.now : Date.now();
      S.liveOffset = serverClockOffset(now, Date.now());
      S.liveEntries = buildLiveModel(Array.isArray(j.board) ? j.board : []);
      if (cb) cb();
    });
  }
  function scheduleLiveRefetch() {
    if (S.liveRefetchTimer) return;
    S.liveRefetchTimer = setTimeout(function() { S.liveRefetchTimer = null; loadLiveData(renderLive); }, 350);
  }
  function renderLive() {
    var v = $("ck-view-live"); if (!v) return; v.textContent = "";
    if (!S.liveEntries.length) { v.appendChild(emptyState("No instances online.", "The Live view shows each Claude instance's mission, activity, and todos as they run.")); return; }
    var now = Date.now() + S.liveOffset; // server-aligned clock for context_ts liveness
    S.liveEntries.forEach(function(e) {
      var dot = e.stale ? "stale" : (e.online ? "online" : "");
      var badge = e.stale ? "ghost" : (e.online ? "live" : "offline");
      var cardCls = "ck-live-card" + (e.stale ? " stale" : "") + (!e.online ? " offline" : "");
      var card = el("div", cardCls);
      // Header
      var head = el("div", "ck-live-head");
      head.appendChild(el("span", "dot" + (dot ? " " + dot : "")));
      head.appendChild(el("span", "ck-live-name", e.name));
      if (e.node) head.appendChild(el("span", "ck-live-node", e.node));
      head.appendChild(el("span", "ck-live-badge " + badge, badge));
      card.appendChild(head);
      // WS2 context gauge — poll-on-nudge source is the /board join; null fields => pending pill, no false zero.
      var presenceLive = e.online && !e.stale; // v2: parked-but-alive keeps its color; only !presenceLive ts-stale greys.
      var cb = ctxBand(e.contextTokens, e.contextTs, now, presenceLive);
      var ctx = el("div", "ck-live-ctx " + cb.cls);
      ctx.appendChild(el("span", "ck-live-ctx-label", "ctx"));
      if (cb.cls !== "pending") {
        var ctxBar = el("div", "ck-live-ctx-bar");
        var ctxFill = el("div", "ck-live-ctx-fill"); ctxFill.style.width = cb.pct + "%";
        ctxBar.appendChild(ctxFill); ctx.appendChild(ctxBar);
      }
      ctx.appendChild(el("span", "ck-live-ctx-val", cb.val));
      card.appendChild(ctx);
      // Mission
      if (e.mission) card.appendChild(el("div", "ck-live-mission", e.mission));
      // Activity (▸ now)
      if (e.activity) {
        var act = el("div", "ck-live-activity");
        act.appendChild(el("span", "ck-live-act-icon", "▸"));
        act.appendChild(document.createTextNode(e.activity));
        card.appendChild(act);
      }
      // Todo checklist
      if (e.todos && e.todos.length) {
        var todoWrap = el("div", "ck-live-todos");
        e.todos.forEach(function(t) {
          var cls = "ck-live-todo" + (t.status === "completed" ? " done" : t.status === "in_progress" ? " inprog" : "");
          var row = el("div", cls);
          var icon = t.status === "completed" ? "☑" : t.status === "in_progress" ? "◈" : "☐";
          row.appendChild(el("span", "ck-live-todo-icon", icon));
          row.appendChild(el("span", "ck-live-todo-text", t.content));
          todoWrap.appendChild(row);
        });
        card.appendChild(todoWrap);
      }
      // Subagent count
      if (e.subagents > 0) card.appendChild(el("div", "ck-live-sub", e.subagents + " subagent" + (e.subagents !== 1 ? "s" : "")));
      v.appendChild(card);
    });
  }
  function switchMainView(view) {
    S.mainView = view;
    document.querySelectorAll(".ck-main-btn").forEach(function(b) { b.classList.toggle("active", b.getAttribute("data-main") === view); });
    document.body.classList.toggle("ck-main-live", view === "live");
    if (view === "live") {
      loadLiveData(renderLive);
    } else {
      // Lazy-init plan on first switch
      if (!S.model) { setProject(S.projectId); loadProjects(); } else { renderAll(); }
    }
  }

  // ========== data layer ==========
  function loadData(cb) {
    if (S.demo) {
      var d = buildDemoData(Date.now());
      S.leaseOffset = 0;
      S.model = buildCockpitModel(d.board, d.presence);
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
  function updateCounts() {
    $("ck-n-ops").textContent = S.model.instances.length ? "(" + S.model.instances.length + ")" : "";
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
    if (!S.model.instances.length) { v.appendChild(emptyState("No instances working right now.", "The Right Now rail shows each agent's in-flight task and lease as work is claimed.")); return; }
    S.model.instances.forEach(function (inst) {
      var card = el("div", "ck-inst");
      var head = el("div", "ck-inst-head");
      head.appendChild(el("span", "dot" + (inst.online ? " online" : "")));
      head.appendChild(el("span", "ck-inst-name", inst.label));
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
    if (evt && evt.kind === "project_create") loadProjects();
    // Always refresh live data (board updates arrive via same SSE path)
    if (S.mainView === "live") { scheduleLiveRefetch(); return; }
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
      var demoOpt = document.createElement("option"); demoOpt.value = "__demo__"; demoOpt.textContent = "▸ DEMO — Garden of Bloom"; sel.appendChild(demoOpt);
      (j.projects || []).forEach(function (p) { var o = document.createElement("option"); o.value = p.id; o.textContent = p.title + " (" + p.taskCount + ")"; sel.appendChild(o); });
      sel.value = S.projectId;
    }).catch(function () {});
  }
  function setProject(pid) {
    S.projectId = pid; S.demo = (pid === "__demo__"); S.openLanes = null; closeDrawer();
    $("ck-demo-flag").style.display = S.demo ? "" : "none";
    setConn(true);
    loadData(renderAll);
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
    initNewPlan();
    window.addEventListener("resize", function () { if (S.activeView === "dag") renderDagIfVisible(); });
    setInterval(tickLeases, 1000);
    initConductor(); // WS-C: operator control panel wiring + status poll
    // E1: Default to Live view; Plan loads lazily
    document.body.classList.add("ck-main-live");
    loadLiveData(renderLive);
    window.__cockpit = {
      onPlanUpdate: onPlanUpdate,
      onReconnect: function() { if (S.mainView === "live") { loadLiveData(renderLive); } else { loadData(renderAll); } setConn(true); loadConductorStatus(); },
      show: function() { if (S.mainView === "live") loadLiveData(renderLive); else loadData(renderAll); loadConductorStatus(); },
      refresh: function() { if (S.mainView === "live") loadLiveData(renderLive); else loadData(renderAll); loadConductorStatus(); }
    };
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
`;
