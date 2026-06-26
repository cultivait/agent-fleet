import { cockpitMarkup, cockpitScript, cockpitStyles } from "./cockpit-ui.js";
import { STALL_BEAT_MS } from "./constants.js";

// `cockpitToken` is the SCOPED cockpit token (A3-a), minted per request on an
// authenticated GET /. It is embedded in BOTH browser scripts (the dashboard
// script below + the threaded cockpitScript) in place of the raw admin token —
// the raw admin token must never reach the browser. The hub accepts this scoped
// token on the admin routes the cockpit calls. The parameter is still a plain
// string threaded verbatim, so the existing injection tests are unaffected.
//
// `operatorName` is the configured persistent operator identity. It is injected
// into the client script (window.__AF_OPERATOR__) so the dashboard can tag the
// operator's messages without hardcoding a name. Defaults to the same env-driven
// value server.ts resolves (AF_OPERATOR_NAME ?? WT_OPERATOR_NAME ?? "Operator").
export function getDashboardHTML(
  cockpitToken: string,
  operatorName: string = (process.env.AF_OPERATOR_NAME ?? process.env.WT_OPERATOR_NAME ?? "Operator").trim() || "Operator",
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, interactive-widget=resizes-content">
<title>Agent Fleet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter+Tight:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  /* ===== Quiet-modern theme =====
     Paper & ink. Moss is the resting "all-good" accent; burnt orange (--action)
     is the ONLY loud note, spent solely where a human is genuinely needed.
     Whitespace is the texture — hairline rules + paper/white tonal steps, no
     drop shadows. Earthen status ramp: moss / ochre / brick. No serif, no italics. */
  :root {
    --bg-base: #F1ECE2;        /* paper — page ground (load-bearing) */
    --bg-raised: #F6F1E7;      /* warm off-white — sidebar / board / header panels */
    --bg-surface: #FFFFFF;     /* white card — message rows, fleet cards */
    --bg-hover: #EAE3D5;       /* warm hover / pressed well */
    --border: #D6CEBC;         /* rule — hairline divider/border */
    --border-subtle: #E2DACB;  /* ruleSoft — faint / mobile separators */
    --text-primary: #1A1C18;   /* ink */
    --text-secondary: #4A4B45; /* inkSoft */
    --text-tertiary: #67665C;  /* inkMuted — metadata, mono labels (a11y-darkened for AA) */
    --accent: #6F8A2B;         /* moss — ambient interactive identity */
    --accent-soft: rgba(111,138,43,0.12);
    --accent-border: rgba(111,138,43,0.30);
    --accent-text: #4E6320;    /* darker moss for TEXT only (links/active labels/done chip) — AA on cream */
    --green: #6F8A2B;          /* moss — online / healthy / done */
    --green-soft: rgba(111,138,43,0.12);
    --green-border: rgba(111,138,43,0.24);
    --red: #A23B23;            /* brick — error / offline / blocked / stall */
    --red-soft: rgba(162,59,35,0.10);
    --red-border: rgba(162,59,35,0.24);
    --yellow: #B5832E;         /* ochre — warning / soon / idle */
    --yellow-soft: rgba(181,131,46,0.14);
    --yellow-border: rgba(181,131,46,0.28);
    --yellow-text: #6E5310;    /* darker ochre for TEXT only (warn/idle chip text) — AA on cream */
    --action: #C9501A;         /* burnt orange — RESERVED for true action/attention only */
    --action-soft: rgba(201,80,26,0.10);
    --radius: 6px;
    --font: 'Inter Tight', -apple-system, sans-serif;
    --mono: 'IBM Plex Mono', ui-monospace, monospace;
    --font-display: 'Inter Tight', -apple-system, sans-serif;  /* display via weight/size/tracking, not a serif */
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--font);
    background: var(--bg-base);
    color: var(--text-primary);
    height: 100vh;       /* fallback for browsers without dvh */
    height: 100dvh;      /* dynamic viewport height: keeps the input bar in view on mobile Chrome (100vh counts the area behind the URL bar) */
    display: flex;
    flex-direction: column;
    -webkit-font-smoothing: antialiased;
  }

  /* Header */
  header {
    height: 52px;
    padding: 0 20px;
    background: var(--bg-raised);
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    gap: 14px;
    flex-shrink: 0;
    backdrop-filter: blur(12px);
    position: relative;
    z-index: 50;
  }

  /* Active-terminal label on the main header: shows "▶ <callsign> terminal · <status>"
     while a terminal takeover is open, cleared on close (set by openTerminal/closeTerminal
     in cockpit-ui.ts). The terminal panel has no header of its own. */
  .term-active-label {
    display: none;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--accent-text);
    background: var(--accent-soft);
    padding: 4px 11px;
    border-radius: 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 44vw;
  }
  .term-active-label.active { display: inline-flex; }
  /* Mobile drawer toggles (hidden on desktop) */
  .mobile-toggle {
    display: none;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
    border-radius: 8px;
    cursor: pointer;
    flex-shrink: 0;
    transition: all 0.15s ease;
  }
  .mobile-toggle:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
    border-color: var(--border);
  }
  .mobile-toggle:active { transform: scale(0.95); }
  .mobile-toggle svg {
    width: 17px;
    height: 17px;
    stroke: currentColor;
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .drawer-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(26,28,24,0.32);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s ease;
    z-index: 40;
  }
  .header-sep {
    width: 1px;
    height: 18px;
    background: var(--border);
  }
  #status {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 500;
    padding: 3px 10px;
    border-radius: 100px;
    background: var(--green-soft);
    color: var(--accent-text);
    border: 1px solid var(--green-border);
    transition: all 0.25s ease;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  #status::before {
    content: "";
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 6px var(--green);
  }
  #status.disconnected {
    background: var(--red-soft);
    color: var(--red);
    border-color: var(--red-border);
  }
  #status.disconnected::before {
    background: var(--red);
    box-shadow: 0 0 6px var(--red);
  }
  .header-spacer { flex: 1; }
  .clear-btn, .filter-btn {
    font-family: var(--mono);
    font-size: 11px;
    font-weight: 500;
    padding: 4px 12px;
    background: transparent;
    color: var(--text-tertiary);
    border: 1px solid var(--border);
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .clear-btn:hover, .filter-btn:hover {
    color: var(--text-secondary);
    border-color: var(--border);
    background: var(--bg-hover);
  }
  .clear-btn:active, .filter-btn:active {
    transform: scale(0.97);
  }
  .filter-btn.active {
    background: var(--accent-soft);
    color: var(--accent-text);
    border-color: var(--accent-border);
  }
  body.filter-operator .msg:not(.operator):not(.system) {
    opacity: 0.3;
  }

  /* Main */
  .container {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  /* Sidebar */
  #sidebar {
    width: 220px;
    background: var(--bg-raised);
    border-right: 1px solid var(--border);
    padding: 16px 12px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
  }
  .sidebar-label {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--text-tertiary);
    padding: 0 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .sidebar-label .add-btn {
    font-family: var(--mono);
    font-size: 11px;
    background: transparent;
    color: var(--text-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 0 6px;
    cursor: pointer;
    transition: all 0.15s ease;
    line-height: 18px;
  }
  .sidebar-label .add-btn:hover {
    color: var(--accent-text);
    border-color: var(--accent-border);
    background: var(--accent-soft);
  }

  /* Channel list */
  #channel-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  #channel-list li {
    padding: 6px 8px;
    font-family: var(--mono);
    font-size: 13px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s ease;
    color: var(--text-secondary);
  }
  #channel-list li:hover {
    background: var(--bg-hover);
  }
  #channel-list li.active {
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .channel-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .channel-unread {
    font-family: var(--mono);
    font-size: 10px;
    background: var(--action);
    color: var(--bg-base);
    padding: 1px 6px;
    border-radius: 100px;
    flex-shrink: 0;
    font-weight: 600;
  }
  #channel-list li.active .channel-unread {
    display: none;
  }
  .channel-del {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-tertiary);
    font-family: var(--mono);
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s ease;
    opacity: 0;
    flex-shrink: 0;
    margin-left: 4px;
  }
  #channel-list li:hover .channel-del {
    opacity: 1;
  }
  .channel-del:hover {
    border-color: var(--red-border);
    color: var(--red);
    background: var(--red-soft);
  }

  /* User list */
  #user-list {
    list-style: none;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  #user-list li {
    padding: 7px 8px;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-radius: 8px;
    transition: background 0.15s ease;
  }
  #user-list li:hover {
    background: var(--bg-hover);
  }
  .user-info {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .user-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 0 3px var(--green-soft);
    flex-shrink: 0;
  }
  .user-dot.offline {
    background: var(--text-tertiary);
    box-shadow: none;
  }
  .user-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
  }
  .kick-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-tertiary);
    font-family: var(--mono);
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
    opacity: 0;
    flex-shrink: 0;
  }
  #user-list li:hover .kick-btn {
    opacity: 1;
  }
  .kick-btn:hover {
    border-color: var(--red-border);
    color: var(--red);
    background: var(--red-soft);
  }
  #stop-all {
    width: 100%;
    padding: 8px;
    background: var(--red-soft);
    color: var(--red);
    border: 1px solid var(--red-border);
    border-radius: 8px;
    font-family: var(--font);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  #stop-all:hover {
    background: rgba(162,59,35,0.16);
    border-color: rgba(162,59,35,0.34);
  }
  #stop-all:active {
    transform: scale(0.98);
  }
  #launch-referee {
    width: 100%;
    margin-top: 6px;
    padding: 8px;
    background: var(--green-soft);
    color: var(--accent-text);
    border: 1px solid var(--green-border);
    border-radius: 8px;
    font-family: var(--font);
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  #launch-referee:hover { border-color: var(--accent-text); }
  #launch-referee:active { transform: scale(0.98); }
  #launch-referee:disabled { opacity: 0.55; cursor: default; }

  /* Agent list */
  #agent-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  #agent-list li {
    padding: 7px 8px;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    border-radius: 8px;
    transition: background 0.15s ease;
  }
  #agent-list li:hover {
    background: var(--bg-hover);
  }
  .agent-info {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .agent-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .agent-dot.online {
    background: var(--green);
    box-shadow: 0 0 0 3px var(--green-soft);
  }
  .agent-dot.offline {
    background: var(--text-tertiary);
    box-shadow: none;
  }
  .agent-name {
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
  }
  .agent-actions {
    display: flex;
    gap: 4px;
    flex-shrink: 0;
  }
  .agent-actions button {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-tertiary);
    font-family: var(--mono);
    font-size: 10px;
    padding: 2px 8px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
    opacity: 0;
  }
  #agent-list li:hover .agent-actions button {
    opacity: 1;
  }
  .agent-launch-btn:hover {
    border-color: var(--green-border) !important;
    color: var(--accent-text) !important;
    background: var(--green-soft) !important;
  }
  .agent-edit-btn:hover {
    border-color: var(--accent-border) !important;
    color: var(--accent-text) !important;
    background: var(--accent-soft) !important;
  }
  .agent-del-btn:hover {
    border-color: var(--red-border) !important;
    color: var(--red) !important;
    background: var(--red-soft) !important;
  }

  /* Agent dialog */
  .dialog-overlay {
    position: fixed;
    inset: 0;
    background: rgba(26,28,24,0.38);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }
  .dialog {
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 24px;
    width: 420px;
    max-width: 90vw;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .dialog h2 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0;
  }
  .dialog label {
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .dialog input, .dialog textarea {
    font-family: var(--mono);
    font-size: 13px;
    padding: 8px 10px;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 8px;
    outline: none;
    transition: border-color 0.15s ease;
  }
  .dialog input:focus, .dialog textarea:focus {
    border-color: var(--accent-text);
  }
  .dialog input::placeholder, .dialog textarea::placeholder {
    color: var(--text-tertiary);
  }
  .dialog textarea {
    resize: vertical;
    min-height: 60px;
  }
  .dialog .checkbox-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-secondary);
  }
  .dialog .checkbox-row input[type="checkbox"] {
    width: 16px;
    height: 16px;
    accent-color: var(--accent-text);
  }
  .dialog .dialog-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .dialog .dialog-buttons button {
    font-family: var(--font);
    font-size: 13px;
    font-weight: 500;
    padding: 8px 16px;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .dialog .btn-cancel {
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border);
  }
  .dialog .btn-cancel:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .dialog .btn-save {
    background: var(--text-primary);
    color: var(--bg-base);
    border: 1px solid var(--text-primary);
  }
  .dialog .btn-save:hover {
    opacity: 0.9;
  }

  /* Messages */
  #messages {
    flex: 1;
    min-height: 0; /* bound the scroll region within .message-area (don't rely on overflow→auto min-height inference) */
    overflow-y: auto;
    padding: 16px 24px;
    display: flex;
    flex-direction: column;
    gap: 3px;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  #messages::-webkit-scrollbar { width: 5px; }
  #messages::-webkit-scrollbar-track { background: transparent; }
  #messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 8px; }

  .msg {
    padding: 10px 14px;
    border-radius: var(--radius);
    font-size: 16px;
    line-height: 1.6;
    max-width: 100%;
    animation: slideIn 0.25s cubic-bezier(0.16,1,0.3,1);
    border: 1px solid transparent;
  }
  .msg .time {
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-tertiary);
    margin-right: 8px;
  }
  .msg .channel-tag {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--yellow-text);
    background: var(--yellow-soft);
    padding: 1px 6px;
    border-radius: 4px;
    margin-right: 6px;
  }
  .msg .from {
    font-weight: 600;
    color: var(--accent-text);
  }
  .msg .to {
    font-family: var(--mono);
    font-size: 14px;
    color: var(--text-tertiary);
    margin-left: 2px;
  }
  .msg .content {
    margin-top: 4px;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--text-primary);
  }
  .msg.message {
    background: var(--bg-surface);
    border-color: var(--border-subtle);
  }
  .msg.message:hover {
    border-color: var(--border);
  }
  .msg.operator {
    background: var(--accent-soft);
    border-color: var(--accent-border);
    border-left: 3px solid var(--accent);
  }
  .msg.operator:hover {
    border-color: var(--accent-border);
    border-left-color: var(--accent-text);
  }
  /* REFEREE / principal-non-operator messages: faded terracotta (Tint B), mirrors operator's moss */
  .msg.referee {
    background: rgba(181,88,47,0.09);
    border-color: rgba(181,88,47,0.24);
    border-left: 3px solid #B5582F;
  }
  .msg.referee:hover {
    border-color: rgba(181,88,47,0.45);
    border-left-color: #9A4A28;
  }
  .msg.referee .from { color: #9A4A28; }
  .msg.system {
    background: transparent;
    font-size: 15px;
    color: var(--text-tertiary);
    max-width: 100%;
    padding: 6px 14px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .msg.system::before {
    content: "";
    flex: 0 0 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--green);
  }
  .msg.system.leave::before {
    background: var(--red);
  }
  .msg.system.channel-event::before {
    background: var(--yellow);
  }
  .msg.system strong {
    color: var(--text-secondary);
    font-weight: 500;
  }
  .empty {
    color: var(--text-tertiary);
    text-align: center;
    margin-top: 36vh;
    font-size: 13px;
  }

  /* Message area wrapper */
  .message-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0; /* let #messages own the scroll region (flex item default min-height:auto would grow the column to fit all messages, so the page/container scrolls and selectChannel's scrollBottom() no-ops) */
    position: relative; /* anchor the in-place terminal takeover (.ck-term-overlay) */
  }

  /* On-Air roster: a LIVE callsign is a click target that opens its read-only
     terminal in place of the chat. Offline rows stay plain (no session to mirror). */
  .user-name.term-open { cursor: pointer; text-decoration: underline dotted; text-underline-offset: 2px; }
  .user-name.term-open:hover { color: var(--accent-text); }

  /* Input bar */
  .input-bar {
    padding: 12px 16px;
    background: var(--bg-raised);
    border-top: 1px solid var(--border);
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex-shrink: 0;
  }
  .input-bar-wrapper {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 8px;
    flex: 1;
    min-width: 0;
  }
  .input-tag {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 500;
    padding: 6px 10px;
    border-radius: 6px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 1px;
    user-select: none;
  }
  .input-tag.channel {
    background: var(--yellow-soft);
    color: var(--yellow-text);
    border: 1px solid var(--yellow-border);
  }
  .input-tag.recipient {
    background: var(--accent-soft);
    color: var(--accent-text);
    border: 1px solid var(--accent-border);
    cursor: default;
  }
  .input-tag .tag-remove {
    font-size: 14px;
    line-height: 1;
    cursor: pointer;
    opacity: 0.6;
    transition: opacity 0.15s ease;
  }
  .input-tag .tag-remove:hover {
    opacity: 1;
  }
  .mention-popup {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 6px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: 8px;
    min-width: 180px;
    max-height: 200px;
    overflow-y: auto;
    box-shadow: 0 6px 20px rgba(26,28,24,0.10);
    z-index: 100;
    display: none;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  .mention-popup.visible {
    display: block;
    animation: slideIn 0.15s cubic-bezier(0.16,1,0.3,1);
  }
  .mention-item {
    padding: 8px 12px;
    font-family: var(--mono);
    font-size: 13px;
    color: var(--text-secondary);
    cursor: pointer;
    transition: background 0.1s ease;
  }
  .mention-item:hover, .mention-item.active {
    background: var(--accent-soft);
    color: var(--accent-text);
  }
  .mention-item:first-child { border-radius: 7px 7px 0 0; }
  .mention-item:last-child { border-radius: 0 0 7px 7px; }
  .mention-item:only-child { border-radius: 7px; }
  .input-bar textarea {
    flex: 1;
    font-family: var(--font);
    font-size: 13px;
    padding: 8px 12px;
    background: var(--bg-surface);
    color: var(--text-primary);
    border: 1px solid var(--border);
    border-radius: 8px;
    outline: none;
    resize: none;
    overflow-y: hidden;
    line-height: 1.5;
    min-height: 36px;
    max-height: 120px;
    field-sizing: content;
  }
  .input-bar textarea::placeholder {
    color: var(--text-tertiary);
  }
  .input-bar textarea:focus {
    border-color: var(--accent-text);
  }
  .send-btn {
    font-family: var(--font);
    font-size: 12px;
    font-weight: 600;
    padding: 8px 16px;
    background: var(--text-primary);
    color: var(--bg-base);
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.15s ease;
    flex-shrink: 0;
  }
  .send-btn:hover {
    opacity: 0.85;
  }
  .send-btn:active {
    transform: scale(0.97);
  }
  .send-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .msg.hidden-by-filter {
    display: none;
  }

  .typing-indicator {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--accent-text);
    margin-left: 6px;
    animation: typingBlink 1.2s ease-in-out infinite;
  }
  #typing-bar {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--accent-text);
    padding: 0 24px;
    height: 0;
    overflow: hidden;
    transition: height 0.2s ease, padding 0.2s ease;
  }
  #typing-bar.active {
    height: 28px;
    padding: 6px 24px;
  }
  #image-preview {
    display: none;
    align-items: center;
    padding: 8px 16px;
    gap: 10px;
    border-top: 1px solid var(--border);
    background: var(--bg-raised);
  }
  #image-preview.active {
    display: flex;
  }
  #image-preview img {
    max-width: 120px;
    max-height: 80px;
    border-radius: 6px;
    border: 1px solid var(--border);
  }
  #image-preview .remove-img {
    font-family: var(--mono);
    font-size: 11px;
    background: transparent;
    color: var(--text-tertiary);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 2px 8px;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  #image-preview .remove-img:hover {
    border-color: var(--red-border);
    color: var(--red);
    background: var(--red-soft);
  }
  .msg-image img {
    max-width: 300px;
    max-height: 200px;
    border-radius: 6px;
    margin-top: 6px;
    border: 1px solid var(--border);
    cursor: pointer;
  }
  .msg-image img:hover {
    border-color: var(--border);
  }
  @keyframes typingBlink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  /* Task board */
  #task-board {
    width: 280px;
    background: var(--bg-raised);
    border-left: 1px solid var(--border);
    padding: 16px 12px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: var(--border) transparent;
  }
  #task-board::-webkit-scrollbar { width: 5px; }
  #task-board::-webkit-scrollbar-track { background: transparent; }
  #task-board::-webkit-scrollbar-thumb { background: var(--border); border-radius: 8px; }
  #board-cards {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .board-empty {
    color: var(--text-tertiary);
    font-size: 12px;
    text-align: center;
    padding: 24px 8px;
  }
  .board-card {
    background: var(--bg-surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    transition: border-color 0.15s ease;
    animation: slideIn 0.25s cubic-bezier(0.16,1,0.3,1);
  }
  .board-card:hover {
    border-color: var(--border);
  }
  .board-remove-btn {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--text-tertiary);
    font-family: var(--mono);
    font-size: 10px;
    line-height: 1;
    padding: 2px 5px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.15s ease;
    opacity: 0;
    flex-shrink: 0;
  }
  .board-card:hover .board-remove-btn {
    opacity: 1;
  }
  .board-remove-btn:hover {
    border-color: var(--red-border);
    color: var(--red);
    background: var(--red-soft);
  }
  .board-card-head {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
  }
  .board-agent-name {
    font-weight: 600;
    font-size: 13px;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .board-node {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-secondary);
    background: var(--bg-hover);
    border: 1px solid var(--border);
    padding: 1px 6px;
    border-radius: 4px;
    flex-shrink: 0;
  }
  .board-subagents {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
    padding: 1px 7px;
    border-radius: 100px;
    background: var(--accent-soft);
    color: var(--accent-text);
    border: 1px solid var(--accent-border);
    flex-shrink: 0;
    white-space: nowrap;
    animation: typingBlink 1.6s ease-in-out infinite;
  }
  .board-context {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 4px;
    flex-shrink: 0;
    white-space: nowrap;
    border: 1px solid var(--border);
  }
  .board-context.ok {
    background: var(--green-soft);
    color: var(--accent-text);
    border-color: var(--green-border);
  }
  .board-context.warn {
    background: var(--yellow-soft);
    color: var(--yellow-text);
    border-color: var(--yellow-border);
  }
  .board-context.over {
    background: var(--red-soft);
    color: var(--red);
    border-color: var(--red-border);
  }
  .board-context.stale,
  .board-context.pending {
    background: var(--bg-hover);
    color: var(--text-tertiary);
    border-color: var(--border);
    font-weight: 500;
  }
  .board-context.parked {
    border-style: dashed;
    opacity: 0.92;
  }
  .board-status {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 500;
    padding: 1px 8px;
    border-radius: 100px;
    margin-left: auto;
    flex-shrink: 0;
  }
  .board-status.active {
    background: var(--green-soft);
    color: var(--accent-text);
    border: 1px solid var(--green-border);
  }
  .board-status.idle {
    background: var(--yellow-soft);
    color: var(--yellow-text);
    border: 1px solid var(--yellow-border);
  }
  .board-status.signed-off {
    background: var(--bg-hover);
    color: var(--text-tertiary);
    border: 1px solid var(--border);
  }
  .board-mission {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
    word-break: break-word;
  }
  .board-activity {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-secondary);
    word-break: break-word;
  }
  .board-plantasks {
    display: flex;
    flex-direction: column;
    gap: 3px;
    margin: 2px 0;
  }
  .board-plantask {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    min-width: 0;
  }
  .board-plantask-badge {
    font-family: var(--mono);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 5px;
    border-radius: 3px;
    white-space: nowrap;
    background: var(--bg-hover);
    color: var(--text-secondary);
  }
  .board-plantask-badge.in_progress { background: var(--green-soft); color: var(--accent-text); }
  .board-plantask-badge.review { background: var(--yellow-soft); color: var(--yellow-text); }
  .board-plantask-badge.blocked { background: var(--red-soft); color: var(--red); }
  .board-plantask-title {
    flex: 1;
    min-width: 0;
    color: var(--text-primary);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .board-plantask-lease {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-secondary);
    white-space: nowrap;
  }
  .board-plantask-lease.soon { color: var(--yellow-text); }
  .board-plantask-lease.urgent { color: var(--red); }
  .board-plantask-lease.expired { color: var(--red); font-weight: 600; }
  .board-plantask-lease.parked { color: var(--text-tertiary); }
  /* C5 stall radar: amber pause badge (owner quiet, lease still valid) — distinct
     from the red expired lease label. */
  .board-plantask-stall {
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 600;
    color: var(--yellow-text);
    white-space: nowrap;
  }
  .board-plantask.stalled { border-left: 2px solid var(--yellow); padding-left: 5px; }
  .board-todos {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .board-todos li {
    font-size: 12px;
    color: var(--text-secondary);
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .board-todos .todo-marker {
    font-family: var(--mono);
    flex-shrink: 0;
    color: var(--text-tertiary);
  }
  .board-todos .todo-text {
    word-break: break-word;
  }
  .board-todos li.completed .todo-text {
    color: var(--text-tertiary);
    text-decoration: line-through;
  }
  .board-todos li.completed .todo-marker {
    color: var(--accent-text);
  }
  .board-todos li.in-progress .todo-text {
    color: var(--text-primary);
  }
  .board-todos li.in-progress .todo-marker {
    color: var(--accent-text);
    animation: typingBlink 1.2s ease-in-out infinite;
  }
  .board-completed {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text-tertiary);
    display: flex;
    gap: 5px;
    align-items: baseline;
  }
  .board-completed .done-check { color: var(--accent-text); }
  /* Board auto-digest: the per-agent logbook headline + expandable last-5.
     This is the "detailed book" — where detail lives so it stays out of chat. */
  .board-log {
    border-top: 1px dashed var(--border);
    padding-top: 6px;
    margin-top: 2px;
  }
  .board-log-head {
    display: flex;
    align-items: baseline;
    gap: 6px;
    cursor: pointer;
    min-width: 0;
    border-radius: 4px;
    margin: -2px -4px;
    padding: 2px 4px;
    transition: background 0.12s ease;
  }
  .board-log-head:hover { background: var(--bg-hover); }
  .board-log-kind {
    flex-shrink: 0;
    font-family: var(--mono);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--bg-hover);
    color: var(--text-secondary);
  }
  .board-log-kind.decision { background: var(--green-soft); color: var(--accent-text); }
  .board-log-kind.blocker { background: var(--red-soft); color: var(--red); }
  .board-log-kind.done { background: var(--yellow-soft); color: var(--yellow-text); }
  .board-log-note {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .board-log-toggle {
    flex-shrink: 0;
    font-size: 9px;
    color: var(--text-tertiary);
  }
  .board-log-tail {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 5px;
    margin: 6px 0 2px;
    padding-left: 2px;
  }
  .board-log-line {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  .board-log-line .board-log-note {
    white-space: normal;
    word-break: break-word;
    color: var(--text-primary);
  }
  .board-log-age {
    flex-shrink: 0;
    font-family: var(--mono);
    font-size: 9px;
    color: var(--text-tertiary);
  }
  .board-age {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text-tertiary);
  }

  @keyframes slideIn {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* ---------- Mobile / responsive ---------- */
  @media (max-width: 820px) {
    .mobile-toggle { display: inline-flex; }

    header { padding: 0 12px; gap: 10px; }
    .header-sep { display: none; }

    /* Sidebar + task board become off-canvas drawers */
    #sidebar, #task-board {
      position: fixed;
      top: 52px;
      bottom: 0;
      z-index: 45;
      transition: transform 0.25s cubic-bezier(0.16,1,0.3,1);
      box-shadow: 0 0 40px rgba(26,28,24,0.14);
    }
    #sidebar {
      left: 0;
      width: 280px;
      max-width: 85vw;
      transform: translateX(-100%);
    }
    #task-board {
      right: 0;
      width: 300px;
      max-width: 88vw;
      transform: translateX(100%);
    }
    body.sidebar-open #sidebar { transform: translateX(0); }
    body.board-open #task-board { transform: translateX(0); }
    body.sidebar-open .drawer-backdrop,
    body.board-open .drawer-backdrop {
      opacity: 1;
      pointer-events: auto;
    }

    .message-area { width: 100%; flex: 1; }

    #messages { padding: 14px 14px; }
    #typing-bar { padding: 0 14px; }
    #typing-bar.active { padding: 6px 14px; }

    /* Roomier tap targets + 16px input prevents iOS zoom-on-focus */
    .input-bar { padding: 10px 12px; gap: 6px; }
    .input-tag { padding: 6px 8px; font-size: 11px; }
    .input-bar textarea { font-size: 16px; }
    .send-btn { padding: 9px 14px; }
  }

  @media (max-width: 540px) {
    /* Tight phone widths: drop the wordmark, collapse status to its dot,
       keep the operator filter/clear controls. */
    header h1 { display: none; }
    #status {
      font-size: 0;
      gap: 0;
      padding: 7px;
    }
    .filter-btn, .clear-btn { padding: 4px 9px; }
    .msg { font-size: 15px; padding: 9px 12px; }
    .msg.system { font-size: 14px; }
    #messages { padding: 12px 10px; }

    /* Composer relayout: on phones the channel (#all) + recipient (@all) chips
       and the Send button share the textarea's flex row, all flex-shrink:0; the
       field-sizing:content textarea is then the only thing that yields and
       collapses to ~1ch. Re-lay the bar as a grid so the two chips sit on a
       full top row and the textarea spans the whole second row (Send stays
       beside it). Same DOM nodes — selectChannel()/setRecipient() keep them in
       sync and the recipient ✕ stays clickable. Desktop (>540px) is untouched. */
    .input-bar {
      display: grid;
      grid-template-columns: auto auto 1fr auto;
      grid-template-areas:
        "ctag rtag .     ."
        "field field field send";
      align-items: end;
      column-gap: 8px;
      row-gap: 8px;
    }
    #channel-tag       { grid-area: ctag; }
    #recipient-tag     { grid-area: rtag; }
    .input-bar-wrapper { grid-area: field; }
    .send-btn          { grid-area: send; }
  }
  @media (min-width: 1440px) {
    /* Large desktop / fullscreen: the chatroom has width to spare, so widen the
       roster (left) and task-board (right) side columns to stop callsigns,
       agent names, mission text, context badges and todo titles from
       truncating. Below 1440px the default 220px/280px layout is unchanged, and
       the <=820px mobile drawers re-declare their own widths so they are
       unaffected. .message-area (flex:1) absorbs the smaller remainder. */
    #sidebar { width: 300px; }
    #task-board { width: 400px; }
  }
  ${cockpitStyles()}
</style>
<!-- Vendored xterm.js (served from the hub, NO CDN) for the interactive terminal panel. -->
<link rel="stylesheet" href="/vendor/xterm.css">
<script src="/vendor/xterm.js"></script>
<script src="/vendor/addon-fit.js"></script>
</head>
<body>
  <header>
    <button class="mobile-toggle" id="menu-toggle" aria-label="Toggle channels and agents">
      <svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M3 12h18"/><path d="M3 18h18"/></svg>
    </button>
    <div class="mode-switch">
      <button id="mode-radio" class="mode-btn active">Radio</button>
      <button id="mode-cockpit" class="mode-btn">Cockpit</button>
    </div>
    <div class="header-sep"></div>
    <span id="status">connected</span>
    <span id="term-active-label" class="term-active-label"></span>
    <div class="header-spacer"></div>
    <button class="mobile-toggle" id="board-toggle" aria-label="Toggle task board">
      <svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
    </button>
  </header>
  <div class="drawer-backdrop" id="drawer-backdrop"></div>
  <div class="container">
    <div id="sidebar">
      <span class="sidebar-label">Channels <button class="add-btn" id="add-channel-btn">+ New</button></span>
      <ul id="channel-list"></ul>
      <span class="sidebar-label">On Air</span>
      <ul id="user-list"></ul>
      <span class="sidebar-label">Agents <button class="add-btn" id="add-agent-btn">+ New</button></span>
      <ul id="agent-list"></ul>
      <button id="stop-all">Kick all agents</button>
      <button id="launch-referee" title="Spawn a headless referee on this hub (tmux)">+ Launch Referee</button>
    </div>
    <div class="message-area">
      <div id="messages">
        <div class="empty">Waiting for transmissions...</div>
      </div>
      <div id="typing-bar"></div>
      <div id="image-preview"></div>
      <div class="input-bar">
        <span class="input-tag channel" id="channel-tag">#all</span>
        <span class="input-tag recipient" id="recipient-tag">@all</span>
        <div class="input-bar-wrapper">
          <div class="mention-popup" id="mention-popup"></div>
          <textarea id="send-input" placeholder="Message (@ to mention)" rows="1"></textarea>
        </div>
        <button class="send-btn" id="send-btn">Send</button>
      </div>
      <!-- Interactive terminal takeover: absolutely fills .message-area (chat
           column), leaving the sidebar (channels + On-Air roster) and task board
           in place. Bound by id from cockpit-ui.ts (openTerminal/closeTerminal). -->
      <!-- No terminal-local chrome: the body fills the takeover. Active agent name +
           status show on the MAIN header (#term-active-label); exit = channel-click or Esc. -->
      <div class="ck-term-overlay" id="ck-term-overlay" aria-hidden="true">
        <div class="ck-term-modal" role="region" aria-label="Agent terminal">
          <div class="ck-term-body" id="ck-term-body"></div>
        </div>
      </div>
    </div>
    <div id="task-board">
      <span class="sidebar-label">Task Board</span>
      <div id="board-cards">
        <div class="board-empty">No agents reporting yet</div>
      </div>
    </div>
  </div>
  <div class="dialog-overlay" id="agent-dialog" style="display:none">
    <div class="dialog">
      <h2 id="agent-dialog-title">New Agent</h2>
      <input type="hidden" id="agent-dialog-id">
      <label>Name <span style="font-weight:400;color:var(--text-tertiary)">(a-z, 0-9, hyphen, underscore)</span>
        <input type="text" id="agent-dialog-name" placeholder="alice" pattern="[a-zA-Z0-9_-]+">
        <span id="agent-dialog-name-error" style="color:var(--red);font-size:11px;display:none"></span>
      </label>
      <label>Working Directory
        <input type="text" id="agent-dialog-workdir" placeholder="/path/to/project">
      </label>
      <div class="checkbox-row">
        <input type="checkbox" id="agent-dialog-autostart">
        <label for="agent-dialog-autostart" style="flex-direction:row;gap:0">Auto-start on Hub launch</label>
      </div>
      <div class="dialog-buttons">
        <button class="btn-cancel" id="agent-dialog-cancel">Cancel</button>
        <button class="btn-save" id="agent-dialog-save">Save</button>
      </div>
    </div>
  </div>
  <script>
    // A3-a: this is the SCOPED cockpit token (minted per authenticated GET /),
    // NOT the raw admin token. The hub accepts it on the admin routes the
    // dashboard/cockpit call. Named ADMIN_TOKEN only for call-site continuity.
    const ADMIN_TOKEN = "${cockpitToken}";
    // The configured persistent operator identity, injected server-side. The
    // dashboard tags messages from this name as the operator (instead of a
    // hardcoded handle). Source: AF_OPERATOR_NAME ?? WT_OPERATOR_NAME ?? "Operator".
    const OPERATOR_NAME = ${JSON.stringify(operatorName)};
    window.__AF_OPERATOR__ = OPERATOR_NAME;
    const adminHeaders = { "Content-Type": "application/json", "Authorization": "Bearer " + ADMIN_TOKEN };
    const messagesEl = document.getElementById("messages");
    const userListEl = document.getElementById("user-list");
    const channelListEl = document.getElementById("channel-list");
    const statusEl = document.getElementById("status");
    const users = new Map(); // name -> online (boolean)
    const channels = new Map(); // name -> { memberCount, createdBy, members }
    const typingUsers = new Map(); // name -> { timeoutId, channel }
    const pendingReply = new Map(); // name -> timeoutId (30s no-TYPING → grey)
    const agentConfigs = new Map(); // id -> { name, workDir, command, autoStart, status, pid, exitCode }
    const agentListEl = document.getElementById("agent-list");

    let selectedChannel = "#all";
    const unreadCounts = {}; // channel -> count

    function formatTime(ts) {
      return new Date(ts).toLocaleTimeString();
    }

    function clearEmpty() {
      const empty = messagesEl.querySelector(".empty");
      if (empty) empty.remove();
    }

    function scrollBottom() {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function kick(name) {
      fetch("/kick", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ name }),
      });
    }

    const typingBarEl = document.getElementById("typing-bar");
    function renderTypingBar() {
      const names = [...typingUsers.entries()].filter(([, v]) => v.channel === selectedChannel).map(([k]) => k);
      if (names.length === 0) {
        typingBarEl.className = "";
        typingBarEl.textContent = "";
      } else {
        typingBarEl.className = "active";
        typingBarEl.textContent = names.join(", ") + (names.length === 1 ? " is thinking..." : " are thinking...");
      }
    }

    function renderUsers() {
      userListEl.innerHTML = "";
      // ON AIR is scoped to the active channel: a specific channel shows only its
      // members; #all shows everyone (it is the global channel). The client already
      // carries per-channel members in the channels Map (from GET /channels), the
      // same source the @mention autocomplete filters on. When the channel's info
      // isn't loaded yet (chInfo undefined) we fall back to showing all rather than
      // flashing an empty roster; an existing-but-empty channel correctly shows none.
      const chInfo = channels.get(selectedChannel);
      const memberSet = (selectedChannel !== "#all" && chInfo) ? new Set(chInfo.members) : null;
      for (const [u, online] of users) {
        if (memberSet && !memberSet.has(u)) continue;
        const li = document.createElement("li");
        const info = document.createElement("span");
        info.className = "user-info";
        const dotCls = online ? "user-dot" : "user-dot offline";
        const tu = typingUsers.get(u);
        const typingHtml = tu && tu.channel === selectedChannel ? '<span class="typing-indicator">typing...</span>' : '';
        info.innerHTML = '<span class="' + dotCls + '"></span><span class="user-name">' + u + '</span>' + typingHtml;
        // Live callsign → open its read-only terminal in place of the chat.
        // openTerminal lives in the cockpit IIFE (window.__cockpit); it flips to
        // Radio mode and reveals the takeover panel anchored in .message-area.
        if (online) {
          const nameSpan = info.querySelector(".user-name");
          if (nameSpan) {
            nameSpan.classList.add("term-open");
            nameSpan.title = "Open terminal (read-only)";
            nameSpan.onclick = () => {
              if (window.__cockpit && window.__cockpit.openTerminal) window.__cockpit.openTerminal(u);
            };
          }
        }
        const btn = document.createElement("button");
        btn.className = "kick-btn";
        btn.textContent = "kick";
        btn.onclick = () => kick(u);
        li.appendChild(info);
        li.appendChild(btn);
        userListEl.appendChild(li);
      }
      // Reset recipient if the current target left
      if (recipientTarget !== "@all") {
        const targetName = recipientTarget.slice(1);
        if (!users.has(targetName)) setRecipient("@all");
      }
    }

    function renderAgents() {
      agentListEl.innerHTML = "";
      for (const [id, agent] of agentConfigs) {
        const li = document.createElement("li");
        const info = document.createElement("span");
        info.className = "agent-info";
        const isOnline = users.has(agent.name) && users.get(agent.name);
        info.innerHTML = '<span class="agent-dot ' + (isOnline ? 'online' : 'offline') + '"></span><span class="agent-name">' + agent.name + '</span>';
        const actions = document.createElement("span");
        actions.className = "agent-actions";
        const launchBtn = document.createElement("button");
        launchBtn.className = "agent-launch-btn";
        launchBtn.textContent = "launch";
        launchBtn.onclick = (e) => { e.stopPropagation(); agentLaunch(id); };
        actions.appendChild(launchBtn);
        if (!isOnline) {
          const editBtn = document.createElement("button");
          editBtn.className = "agent-edit-btn";
          editBtn.textContent = "edit";
          editBtn.onclick = (e) => { e.stopPropagation(); openAgentDialog(id, agent); };
          actions.appendChild(editBtn);
          const delBtn = document.createElement("button");
          delBtn.className = "agent-del-btn";
          delBtn.textContent = "x";
          delBtn.onclick = (e) => { e.stopPropagation(); if (confirm("Delete agent config '" + agent.name + "'?")) agentDelete(id); };
          actions.appendChild(delBtn);
        }
        li.appendChild(info);
        li.appendChild(actions);
        agentListEl.appendChild(li);
      }
    }

    function agentLaunch(id) {
      fetch("/admin-agent-start", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ id }),
      }).then(r => r.json()).then(data => {
        if (data.error) alert(data.error);
      }).catch(() => {});
    }

    function agentDelete(id) {
      fetch("/admin-agent-config-delete", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ id }),
      }).then(r => r.json()).then(data => {
        if (data.error) alert(data.error);
      }).catch(() => {});
    }

    function refreshAgentConfigs() {
      fetch("/admin-agent-configs", { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } })
        .then(r => r.json())
        .then(data => {
          agentConfigs.clear();
          for (const c of data.configs) {
            agentConfigs.set(c.id, { name: c.name, workDir: c.workDir, autoStart: c.autoStart });
          }
          renderAgents();
        }).catch(() => {});
    }

    function refreshChannels() {
      fetch("/channels").then(r => r.json()).then(data => {
        channels.clear();
        for (const ch of data.channels) {
          channels.set(ch.name, { memberCount: ch.memberCount, createdBy: ch.createdBy, members: ch.members || [] });
        }
        renderChannels();
        // Channel membership just changed (join/leave/create) — re-render the
        // channel-scoped ON AIR roster so it reflects the active channel's members.
        renderUsers();
      }).catch(() => {});
    }

    function renderChannels() {
      channelListEl.innerHTML = "";
      for (const [name, info] of channels) {
        const li = document.createElement("li");
        const unread = unreadCounts[name] || 0;
        const unreadBadge = unread > 0 ? '<span class="channel-unread">' + unread + '</span>' : '';
        if (name === "#all") {
          li.innerHTML = '<span class="channel-name">' + name + '</span>' + unreadBadge;
        } else {
          li.innerHTML = '<span class="channel-name">' + name + '</span>' + unreadBadge + '<button class="channel-del">x</button>';
          li.querySelector(".channel-del").onclick = (e) => {
            e.stopPropagation();
            if (confirm("Delete " + name + "?")) deleteChannel(name);
          };
        }
        if (selectedChannel === name) li.className = "active";
        li.onclick = () => selectChannel(name);
        channelListEl.appendChild(li);
      }
    }

    function markChannelRead(channel) {
      fetch("/admin-mark-read", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ channel }),
      }).catch(() => {});
      delete unreadCounts[channel];
      renderChannels();
    }

    function selectChannel(name) {
      // Picking a channel exits any open terminal takeover and restores that
      // channel's chat. closeTerminal is a no-op when no terminal is open.
      if (window.__cockpit && window.__cockpit.closeTerminal) window.__cockpit.closeTerminal();
      selectedChannel = name;
      channelTagEl.textContent = name || "#all";
      // Reset recipient if not a member of the new channel
      if (recipientTarget !== "@all" && name !== "#all") {
        const chInfo = channels.get(name);
        const members = chInfo ? chInfo.members : [];
        if (members.length > 0 && !members.includes(recipientTarget.slice(1))) {
          setRecipient("@all");
        }
      }
      markChannelRead(name);
      // First open of this channel: backfill any history older than the initial
      // recent window (no-op for #all, already fully loaded at startup).
      if (name && name !== "#all") lazyLoadChannelHistory(name);
      applyChannelFilter();
      // Switching channels should reveal the newest messages, not strand the
      // viewport at the prior channel's scroll position.
      scrollBottom();
      renderTypingBar();
      renderUsers();
      // On mobile, picking a channel closes the sidebar drawer
      if (window.innerWidth <= 820) document.body.classList.remove("sidebar-open");
    }

    function applyChannelFilter() {
      const msgs = messagesEl.querySelectorAll(".msg");
      for (const msg of msgs) {
        if (!selectedChannel) {
          msg.classList.remove("hidden-by-filter");
        } else {
          const ch = msg.dataset.channel;
          if (!ch) {
            msg.classList.remove("hidden-by-filter");
          } else if (ch === selectedChannel) {
            msg.classList.remove("hidden-by-filter");
          } else {
            msg.classList.add("hidden-by-filter");
          }
        }
      }
    }

    function addMessage(html, cls, channel, id, ts) {
      clearEmpty();
      const div = document.createElement("div");
      div.className = "msg " + cls;
      if (channel) div.dataset.channel = channel;
      // Tag real messages with id + timestamp so lazy-loaded channel history can
      // dedup by id and splice older rows into the right chronological position.
      if (id != null) div.dataset.msgId = String(id);
      if (ts != null) div.dataset.ts = String(ts);
      div.innerHTML = html;
      if (selectedChannel && channel && channel !== selectedChannel) {
        div.classList.add("hidden-by-filter");
      }
      messagesEl.appendChild(div);
      scrollBottom();
    }

    // --- Lazy-load older channel history on first open of a channel ---
    // The initial load only renders a recent window across ALL channels, so a
    // chatty channel can have messages OLDER than that window. On first open we
    // fetch that channel's recent history and splice the missing (older) rows
    // into the right chronological spot in the one mixed-channel #messages list.
    const loadedChannels = new Set(); // channels whose history we've lazy-loaded

    // VERBATIM copy of mergeChannelHistory from src/dashboard-merge.ts — the
    // browser can't import the module, so keep these two IDENTICAL (that copy is
    // unit-tested in src/__tests__/dashboard-merge.test.ts).
    function mergeChannelHistory(existing, fetched) {
      // Fail-open on anything that isn't a usable array of fetched messages.
      if (!Array.isArray(fetched) || fetched.length === 0) return [];
      const existingList = Array.isArray(existing) ? existing : [];

      const seen = new Set();
      for (const m of existingList) {
        if (m && typeof m.id === "string") seen.add(m.id);
      }

      const newMessages = fetched.filter(
        (m) =>
          m &&
          typeof m.id === "string" &&
          typeof m.timestamp === "number" &&
          !seen.has(m.id),
      );
      if (newMessages.length === 0) return [];
      newMessages.sort((a, b) => a.timestamp - b.timestamp);

      const insertions = [];
      for (const msg of newMessages) {
        let anchorId = null;
        for (const ex of existingList) {
          if (ex && typeof ex.id === "string" && ex.timestamp > msg.timestamp) {
            anchorId = ex.id;
            break;
          }
        }
        insertions.push({ message: msg, insertBeforeId: anchorId });
      }
      return insertions;
    }

    function buildMessageRow(msg) {
      const cls = msg.from === OPERATOR_NAME ? "message operator" : (String(msg.from || "").trim().toUpperCase().startsWith("REFEREE") ? "message referee" : "message");
      const channel = msg.channel || "#all";
      const channelTag = '<span class="channel-tag">' + channel + '</span>';
      const div = document.createElement("div");
      div.className = "msg " + cls;
      div.dataset.channel = channel;
      div.dataset.msgId = String(msg.id);
      div.dataset.ts = String(msg.timestamp);
      div.innerHTML =
        '<span class="time">' + formatTime(msg.timestamp) + '</span>' +
        channelTag +
        '<span class="from">' + msg.from + '</span> ' +
        '<span class="to">&rarr; ' + msg.to + '</span>' +
        '<div class="content">' + msg.content.replace(/</g, "&lt;") + '</div>' +
        renderImageTag(msg.image);
      if (selectedChannel && channel !== selectedChannel) {
        div.classList.add("hidden-by-filter");
      }
      return div;
    }

    function lazyLoadChannelHistory(channel) {
      if (!channel || loadedChannels.has(channel)) return;
      // Mark loaded immediately so a fast re-select can't double-fetch; on a
      // hard failure we un-mark so a later open can retry.
      loadedChannels.add(channel);
      fetch("/admin-channel-history?channel=" + encodeURIComponent(channel) + "&limit=200", {
        headers: { "Authorization": "Bearer " + ADMIN_TOKEN },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const fetched = data && Array.isArray(data.messages) ? data.messages : null;
          if (!fetched || fetched.length === 0) return; // fail-open
          // Snapshot the already-rendered ids + timestamps (in render order).
          const existing = [];
          for (const el of messagesEl.querySelectorAll(".msg[data-msg-id]")) {
            existing.push({ id: el.dataset.msgId, timestamp: Number(el.dataset.ts) });
          }
          const insertions = mergeChannelHistory(existing, fetched);
          if (insertions.length === 0) return;
          // Was the viewport pinned to the newest message before we splice in
          // older history? selectChannel just scrolled us there on first open.
          const wasAtBottom =
            messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
          clearEmpty();
          for (const ins of insertions) {
            const row = buildMessageRow(ins.message);
            if (ins.insertBeforeId == null) {
              messagesEl.appendChild(row);
            } else {
              const anchor = messagesEl.querySelector(
                '.msg[data-msg-id="' + (window.CSS && CSS.escape ? CSS.escape(ins.insertBeforeId) : ins.insertBeforeId) + '"]',
              );
              if (anchor) messagesEl.insertBefore(row, anchor);
              else messagesEl.appendChild(row);
            }
          }
          // Older rows splice in ABOVE the newest; re-pin to the bottom, but
          // only if we were already there and are still on this channel — never
          // yank a user who scrolled up to read history mid-fetch.
          if (selectedChannel === channel && wasAtBottom) scrollBottom();
        })
        .catch(() => {
          // Network/parse error: fail-open (view untouched) and allow a retry.
          loadedChannels.delete(channel);
        });
    }

    document.getElementById("stop-all").onclick = () => {
      fetch("/kick-all", { method: "POST", headers: adminHeaders });
    };

    const launchRefereeBtn = document.getElementById("launch-referee");
    if (launchRefereeBtn) {
      launchRefereeBtn.onclick = () => {
        launchRefereeBtn.disabled = true;
        const orig = launchRefereeBtn.textContent;
        launchRefereeBtn.textContent = "Referee launching…";
        fetch("/admin-launch-referee", { method: "POST", headers: adminHeaders })
          .then(r => r.json().catch(() => ({})))
          .then(data => { if (data && data.error) alert(data.error); })
          .catch(() => {})
          .then(() => { setTimeout(() => { launchRefereeBtn.disabled = false; launchRefereeBtn.textContent = orig; }, 4000); });
      };
    }

    // Send from dashboard
    const sendInputEl = document.getElementById("send-input");
    const sendBtnEl = document.getElementById("send-btn");
    const channelTagEl = document.getElementById("channel-tag");
    const recipientTagEl = document.getElementById("recipient-tag");
    const mentionPopupEl = document.getElementById("mention-popup");
    let recipientTarget = "@all";
    const MAX_IMAGE_SIZE = 1024; // max長辺 px
    let pendingImage = null; // { data, mimeType }

    function resizeImage(file, maxSize, callback) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result;
        const img = new Image();
        img.onload = () => {
          const w = img.width;
          const h = img.height;
          if (w <= maxSize && h <= maxSize) {
            callback(dataUrl.split(",")[1]);
            return;
          }
          const scale = maxSize / Math.max(w, h);
          const nw = Math.round(w * scale);
          const nh = Math.round(h * scale);
          const canvas = document.createElement("canvas");
          canvas.width = nw;
          canvas.height = nh;
          canvas.getContext("2d").drawImage(img, 0, 0, nw, nh);
          const resized = canvas.toDataURL("image/png");
          callback(resized.split(",")[1]);
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    }
    const imagePreviewEl = document.getElementById("image-preview");

    function renderImagePreview() {
      if (pendingImage) {
        imagePreviewEl.innerHTML = '<img src="data:' + pendingImage.mimeType + ';base64,' + pendingImage.data + '">'
          + '<button class="remove-img">Remove</button>';
        imagePreviewEl.classList.add("active");
        imagePreviewEl.querySelector(".remove-img").onclick = () => {
          pendingImage = null;
          renderImagePreview();
        };
      } else {
        imagePreviewEl.innerHTML = "";
        imagePreviewEl.classList.remove("active");
      }
    }

    sendInputEl.addEventListener("paste", (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) return;
          resizeImage(blob, MAX_IMAGE_SIZE, (base64) => {
            pendingImage = { data: base64, mimeType: "image/png" };
            renderImagePreview();
          });
          return;
        }
      }
    });

    let mentionActive = false;
    let mentionIndex = 0;
    let mentionFiltered = [];

    function setRecipient(value) {
      recipientTarget = value;
      recipientTagEl.innerHTML = value === "@all"
        ? "@all"
        : value + ' <span class="tag-remove">&times;</span>';
    }

    recipientTagEl.addEventListener("click", (e) => {
      if (e.target.classList.contains("tag-remove")) {
        setRecipient("@all");
      }
    });

    let popupMode = ""; // "mention" or "channel"

    function getPopupQuery() {
      const val = sendInputEl.value;
      const pos = sendInputEl.selectionStart;
      const before = val.slice(0, pos);
      const mentionMatch = before.match(/@([\\w-]*)$/);
      if (mentionMatch) return { mode: "mention", query: mentionMatch[1] };
      const channelMatch = before.match(/#([\\w-]*)$/);
      if (channelMatch) return { mode: "channel", query: channelMatch[1] };
      return null;
    }

    function getMentionCandidates() {
      const chInfo = channels.get(selectedChannel);
      const memberList = chInfo ? chInfo.members : [];
      const candidates = [];
      for (const [u] of users) {
        if (selectedChannel !== "#all" && memberList.length > 0 && !memberList.includes(u)) continue;
        candidates.push(u);
      }
      return candidates;
    }

    function getChannelCandidates() {
      return [...channels.keys()];
    }

    function showPopup() {
      const result = getPopupQuery();
      if (!result) { hidePopup(); return; }
      const candidates = result.mode === "mention" ? getMentionCandidates() : getChannelCandidates();
      mentionFiltered = candidates.filter(c => c.toLowerCase().startsWith((result.mode === "channel" ? "#" : "") + result.query.toLowerCase()));
      if (result.mode === "channel") mentionFiltered = mentionFiltered.map(c => c.replace(/^#/, ""));
      if (mentionFiltered.length === 0) { hidePopup(); return; }
      mentionIndex = 0;
      mentionActive = true;
      popupMode = result.mode;
      renderPopup();
    }

    function renderPopup() {
      const prefix = popupMode === "channel" ? "#" : "@";
      mentionPopupEl.innerHTML = "";
      mentionFiltered.forEach((name, i) => {
        const div = document.createElement("div");
        div.className = "mention-item" + (i === mentionIndex ? " active" : "");
        div.textContent = prefix + name;
        div.addEventListener("mouseenter", () => {
          mentionIndex = i;
          mentionPopupEl.querySelectorAll(".mention-item").forEach((el, j) => {
            el.classList.toggle("active", j === i);
          });
        });
        div.addEventListener("mousedown", (e) => { e.preventDefault(); selectPopupItem(name); });
        mentionPopupEl.appendChild(div);
      });
      mentionPopupEl.classList.add("visible");
    }

    function hidePopup() {
      mentionActive = false;
      mentionFiltered = [];
      popupMode = "";
      mentionPopupEl.classList.remove("visible");
    }

    function selectPopupItem(name) {
      const val = sendInputEl.value;
      const pos = sendInputEl.selectionStart;
      const before = val.slice(0, pos);
      const after = val.slice(pos);
      if (popupMode === "channel") {
        const replaced = before.replace(/#[\\w-]*$/, "#" + name + " ");
        sendInputEl.value = replaced + after;
        sendInputEl.selectionStart = sendInputEl.selectionEnd = replaced.length;
      } else {
        const replaced = before.replace(/@[\\w-]*$/, "");
        sendInputEl.value = replaced + after;
        sendInputEl.selectionStart = sendInputEl.selectionEnd = replaced.length;
        setRecipient("@" + name);
      }
      hidePopup();
      sendInputEl.focus();
    }

    function expectReply(name) {
      const prev = pendingReply.get(name);
      if (prev) clearTimeout(prev);
      pendingReply.set(name, setTimeout(() => {
        pendingReply.delete(name);
        if (users.has(name)) { users.set(name, false); renderUsers(); }
      }, 30000));
    }

    function clearPendingReply(name) {
      const timer = pendingReply.get(name);
      if (timer) { clearTimeout(timer); pendingReply.delete(name); }
    }

    function renderImageTag(image) {
      if (!image) return "";
      return '<div class="msg-image"><img src="data:' + image.mimeType + ';base64,' + image.data + '" onclick="window.open(this.src)"></div>';
    }

    function sendMessage() {
      const content = sendInputEl.value.trim();
      if (!content && !pendingImage) return;
      const channel = selectedChannel;
      const target = recipientTarget;
      const payload = { to: target, content, channel };
      if (pendingImage) payload.image = pendingImage;
      fetch("/admin-send", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify(payload),
      }).then(() => {
        sendInputEl.value = "";
        sendInputEl.style.height = "auto";
        pendingImage = null;
        renderImagePreview();
        sendInputEl.focus();
        // Start 30s reply expectation timer. @all only reaches the active channel's
        // members (the hub pings just those), so scope the reply-expectation to them
        // too — #all stays hub-wide since everyone is a member.
        const targetName = target.startsWith("@") ? target.slice(1) : target;
        if (targetName === "all") {
          const chInfo = channels.get(channel);
          const memberSet = (channel !== "#all" && chInfo) ? new Set(chInfo.members) : null;
          for (const [u] of users) { if (u !== OPERATOR_NAME && (!memberSet || memberSet.has(u))) expectReply(u); }
        } else {
          expectReply(targetName);
        }
      });
    }

    sendBtnEl.onclick = sendMessage;

    sendInputEl.addEventListener("keydown", (e) => {
      if (mentionActive && !e.isComposing) {
        if (e.key === "ArrowDown") { e.preventDefault(); mentionIndex = (mentionIndex + 1) % mentionFiltered.length; renderPopup(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); mentionIndex = (mentionIndex - 1 + mentionFiltered.length) % mentionFiltered.length; renderPopup(); return; }
        if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); selectPopupItem(mentionFiltered[mentionIndex]); return; }
        if (e.key === "Escape") { e.preventDefault(); hidePopup(); return; }
      }
      if (e.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey) { e.preventDefault(); sendMessage(); }
    });

    sendInputEl.addEventListener("input", () => {
      sendInputEl.style.height = "auto";
      sendInputEl.style.height = Math.min(sendInputEl.scrollHeight, 120) + "px";
      sendInputEl.style.overflowY = sendInputEl.scrollHeight > 120 ? "auto" : "hidden";
      showPopup();
    });

    sendInputEl.addEventListener("blur", () => {
      setTimeout(() => hidePopup(), 150);
    });

    // Mobile drawers (sidebar + task board slide in below ~820px)
    const menuToggle = document.getElementById("menu-toggle");
    const boardToggle = document.getElementById("board-toggle");
    const drawerBackdrop = document.getElementById("drawer-backdrop");
    function closeDrawers() {
      document.body.classList.remove("sidebar-open", "board-open");
    }
    function toggleDrawer(cls) {
      const open = document.body.classList.contains(cls);
      closeDrawers();
      if (!open) document.body.classList.add(cls);
    }
    if (menuToggle) menuToggle.onclick = () => toggleDrawer("sidebar-open");
    if (boardToggle) boardToggle.onclick = () => toggleDrawer("board-open");
    if (drawerBackdrop) drawerBackdrop.onclick = closeDrawers;
    window.addEventListener("resize", () => {
      if (window.innerWidth > 820) closeDrawers();
    });

    const AGENT_NAME_RE = /^[a-zA-Z0-9_-]+$/;
    const agentDialogEl = document.getElementById("agent-dialog");
    const agentDialogTitle = document.getElementById("agent-dialog-title");
    const agentDialogId = document.getElementById("agent-dialog-id");
    const agentDialogName = document.getElementById("agent-dialog-name");
    const agentDialogNameError = document.getElementById("agent-dialog-name-error");
    const agentDialogWorkdir = document.getElementById("agent-dialog-workdir");
    const agentDialogAutostart = document.getElementById("agent-dialog-autostart");

    function updateCommandPreview() {
      const name = agentDialogName.value.trim();
      if (name && AGENT_NAME_RE.test(name)) {
        agentDialogNameError.style.display = "none";
      } else if (name) {
        agentDialogNameError.textContent = "Use only a-z, 0-9, hyphen, underscore";
        agentDialogNameError.style.display = "block";
      } else {
        agentDialogNameError.style.display = "none";
      }
    }

    agentDialogName.addEventListener("input", updateCommandPreview);

    function openAgentDialog(id, agent) {
      const isEdit = !!id;
      agentDialogTitle.textContent = isEdit ? "Edit Agent" : "New Agent";
      agentDialogId.value = id || "";
      agentDialogName.value = agent ? agent.name : "";
      agentDialogWorkdir.value = agent ? agent.workDir : "";
      agentDialogAutostart.checked = agent ? agent.autoStart : false;
      updateCommandPreview();
      agentDialogEl.style.display = "flex";
      agentDialogName.focus();
    }

    function closeAgentDialog() {
      agentDialogEl.style.display = "none";
    }

    document.getElementById("agent-dialog-cancel").onclick = closeAgentDialog;
    agentDialogEl.onclick = (e) => { if (e.target === agentDialogEl) closeAgentDialog(); };

    document.getElementById("agent-dialog-save").onclick = () => {
      const id = agentDialogId.value;
      const name = agentDialogName.value.trim();
      const workDir = agentDialogWorkdir.value.trim();
      const autoStart = agentDialogAutostart.checked;
      if (!name || !AGENT_NAME_RE.test(name)) { agentDialogName.focus(); updateCommandPreview(); return; }
      if (!workDir) { agentDialogWorkdir.focus(); return; }
      if (id) {
        fetch("/admin-agent-config-update", {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ id, name, workDir, autoStart }),
        }).then(r => r.json()).then(data => {
          if (data.error) alert(data.error);
          else closeAgentDialog();
        }).catch(() => {});
      } else {
        fetch("/admin-agent-config-create", {
          method: "POST",
          headers: adminHeaders,
          body: JSON.stringify({ name, workDir }),
        }).then(r => r.json()).then(data => {
          if (data.error) alert(data.error);
          else closeAgentDialog();
        }).catch(() => {});
      }
    };

    document.getElementById("add-agent-btn").onclick = () => openAgentDialog(null, null);

    document.getElementById("add-channel-btn").onclick = () => {
      const name = prompt("Channel name (without #):");
      if (!name || !name.trim()) return;
      fetch("/admin-channel-create", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ name: name.trim() }),
      }).then(r => r.json()).then(data => {
        if (data.error) alert(data.error);
      }).catch(() => {});
    };

    function deleteChannel(name) {
      fetch("/admin-channel-delete", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ name }),
      }).then(r => r.json()).then(data => {
        if (data.error) alert(data.error);
      }).catch(() => {});
    }

    // Task board
    const boardCardsEl = document.getElementById("board-cards");
    const boardEntries = new Map(); // name -> { name, node, status, mission, activity, todos, subagents, sid, updatedAt, online, lastSeenAt, stale, contextTokens, contextTs, recentLog, logTail?, logOpen? }

    // 3B: plan tasks each session currently holds, keyed by owner_sid (= board sid).
    // Joined onto cards in renderBoard; refreshed on plan_update + SSE reconnect.
    const inflightBySid = new Map(); // owner_sid -> [{ id, title, status, lease_expires_at }]
    let inflightOffset = 0; // serverNow - clientNow, captured from /plan-inflight
    let inflightTimer = null;
    function loadInflight() {
      return fetch("/plan-inflight").then(r => r.json()).then(data => {
        inflightOffset = (data.now || Date.now()) - Date.now();
        inflightBySid.clear();
        for (const t of (data.tasks || [])) {
          if (!t.owner_sid) continue;
          if (!inflightBySid.has(t.owner_sid)) inflightBySid.set(t.owner_sid, []);
          inflightBySid.get(t.owner_sid).push(t);
        }
        renderBoard();
      }).catch(() => {});
    }
    function scheduleInflight() {
      if (inflightTimer) return;
      inflightTimer = setTimeout(() => { inflightTimer = null; loadInflight(); }, 800);
    }
    function planLeaseLabel(leaseExpiresAt) {
      if (!leaseExpiresAt) return null;
      const secs = Math.round((leaseExpiresAt - (Date.now() + inflightOffset)) / 1000);
      if (secs <= 0) return { text: "expired", urg: "expired" };
      const m = Math.floor(secs / 60), s = secs % 60;
      return { text: m > 0 ? m + "m" : s + "s", urg: secs <= 60 ? "urgent" : (secs <= 300 ? "soon" : "ok") };
    }
    // C5 stall radar (client-side, mirrors STALL_BEAT_MS / stallState in cockpit-lease.ts).
    // Recomputed each renderBoard (incl. the 30s tick) off last_seen_at + the server-clock
    // offset, so a stall that develops between SSE events still surfaces. Only fires while
    // the lease is still valid — the expired case is the red lease label, not this.
    // Canonical value injected from hub/src/constants.ts (STALL_BEAT_MS) at build time.
    const STALL_BEAT_MS = ${STALL_BEAT_MS};
    function planStallLabel(lastSeenAt, leaseExpiresAt) {
      const effNow = Date.now() + inflightOffset;
      if (!leaseExpiresAt || leaseExpiresAt - effNow <= 0) return null;
      if (!lastSeenAt || lastSeenAt <= 0) return null;
      const ageMs = Math.max(0, effNow - lastSeenAt);
      if (ageMs <= STALL_BEAT_MS) return null;
      const m = Math.floor(ageMs / 60000);
      return m >= 1 ? m + "m idle" : Math.floor(ageMs / 1000) + "s idle";
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function formatAge(ts) {
      const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
      if (s < 60) return s + "s ago";
      const m = Math.floor(s / 60);
      if (m < 60) return m + "m ago";
      const h = Math.floor(m / 60);
      if (h < 24) return h + "h ago";
      return Math.floor(h / 24) + "d ago";
    }

    // WS2 context-gauge render thresholds (mirror the FROZEN consumer contract):
    // OVER = the 400k absolute compaction trigger / context limit (the cockpit gauge's
    // 100% fill ceiling); RED = 360k red band (fires BEFORE the compact line for early
    // warning); WARN = 300k yellow band. STALE_MS = how long without a fresh context_ts
    // before the reading is greyed (frozen). Color is by ABSOLUTE tokens, never %; grey
    // is by ts-liveness, never value. Kept identical to cockpit-ui.ts.
    const CONTEXT_OVER = 400000;
    const CONTEXT_RED = 360000;
    const CONTEXT_WARN = 300000;
    const CONTEXT_STALE_MS = 120000;

    // Roster render guard (item 3): an agent that is offline AND hasn't been seen
    // within this window is dropped from the visible roster, so a signed-off /
    // stale / fixture board row can't render regardless of what's in the DB.
    // Mirrors the server presence-grace default (AF_PRESENCE_GRACE_SECONDS=7200);
    // a recently-crashed real agent (offline but seen < grace ago) still shows.
    // Purging the underlying rows is separate DB hygiene.
    const ROSTER_PRESENCE_GRACE_MS = 2 * 60 * 60 * 1000;

    function renderBoard() {
      if (boardEntries.size === 0) {
        boardCardsEl.innerHTML = '<div class="board-empty">No agents reporting yet</div>';
        return;
      }
      const effNow = Date.now() + inflightOffset;
      const entries = [...boardEntries.values()].filter((e) => {
        if (e.online) return true;
        const seen = Math.max(
          typeof e.lastSeenAt === "number" ? e.lastSeenAt : 0,
          typeof e.updatedAt === "number" ? e.updatedAt : 0
        );
        return seen > 0 && (effNow - seen) <= ROSTER_PRESENCE_GRACE_MS;
      }).sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return (b.updatedAt || 0) - (a.updatedAt || 0);
      });
      if (entries.length === 0) {
        boardCardsEl.innerHTML = '<div class="board-empty">No agents reporting yet</div>';
        return;
      }
      let html = "";
      for (const entry of entries) {
        const dotCls = entry.online ? "user-dot" : "user-dot offline";
        const nodeBadge = entry.node
          ? '<span class="board-node">' + escapeHtml(entry.node) + '</span>'
          : '';
        const statusCls = entry.status === "active" ? "active" : (entry.status === "idle" ? "idle" : "signed-off");
        const subCount = entry.subagents || 0;
        const subBadge = subCount > 0
          ? '<span class="board-subagents" title="' + subCount + ' subagent' + (subCount === 1 ? '' : 's') + ' running">&#9889; ' + subCount + '</span>'
          : '';
        // WS2 context-gauge badge. Color by ABSOLUTE tokens (mirrors the 400k
        // compaction trigger). When context_ts goes stale (frozen reading): if the
        // agent is still present (online & not ghost-stale) it's parked-but-alive —
        // its count is still accurate, so KEEP the color and mark it 'parked'
        // (subtle dashed border); only an ABSENT agent's stale reading is greyed as
        // untrusted. null tokens = pending (no badge). Mirrors the cockpit view 1:1.
        let ctxBadge = '';
        if (entry.contextTokens != null) {
          const tk = entry.contextTokens;
          const tsStale = !entry.contextTs || (Date.now() - entry.contextTs) > CONTEXT_STALE_MS;
          const presenceLive = !!entry.online && !entry.stale;
          let ctxCls = tk >= CONTEXT_RED ? 'over' : (tk >= CONTEXT_WARN ? 'warn' : 'ok');
          let parked = false;
          if (tsStale) {
            if (presenceLive) parked = true;   // alive but quiet — reading still current
            else ctxCls = 'stale';             // absent + frozen — reading untrusted
          }
          const tkLabel = tk >= 1000000 ? (tk / 1000000).toFixed(2) + 'M' : Math.round(tk / 1000) + 'k';
          const tsTxt = entry.contextTs ? formatAge(entry.contextTs) : 'never';
          const note = ctxCls === 'stale'
            ? ' (stale — agent gone, reading may be frozen)'
            : (parked ? ' (parked — agent quiet, count still current)' : '');
          // Status bar (mirrors the cockpit Live gauge): fill toward CONTEXT_OVER (400k),
          // color green→amber→red by absolute tokens. Reuses the page-wide .ck-live-ctx styles.
          const ctxClsBar = ctxCls === 'over' ? 'red' : ctxCls === 'warn' ? 'amber' : ctxCls === 'stale' ? 'stale' : 'green';
          const ctxPct = Math.min(100, Math.round(tk / CONTEXT_OVER * 100));
          ctxBadge = '<div class="ck-live-ctx ' + ctxClsBar + (parked ? ' parked' : '')
            + '" title="context ' + tk.toLocaleString() + ' / ' + CONTEXT_OVER.toLocaleString() + ' tokens · gauge updated ' + tsTxt + note + '">'
            + '<span class="ck-live-ctx-label">ctx</span>'
            + '<div class="ck-live-ctx-bar"><div class="ck-live-ctx-fill" style="width:' + ctxPct + '%"></div></div>'
            + '<span class="ck-live-ctx-val">' + tkLabel + '</span>'
            + '</div>';
        }
        let todosHtml = "";
        if (entry.todos && entry.todos.length > 0) {
          // Hide completed todos to reduce clutter; tally them in a counter instead.
          const activeTodos = entry.todos.filter(t => t.status !== "completed");
          const completedCount = entry.todos.length - activeTodos.length;
          if (activeTodos.length > 0) {
            todosHtml = '<ul class="board-todos">';
            for (const t of activeTodos) {
              let cls = "pending";
              let marker = "&#9675;"; // open circle
              if (t.status === "in_progress") { cls = "in-progress"; marker = "&#10148;"; }
              todosHtml += '<li class="' + cls + '"><span class="todo-marker">' + marker + '</span><span class="todo-text">' + escapeHtml(t.content) + '</span></li>';
            }
            todosHtml += '</ul>';
          }
          if (completedCount > 0) {
            todosHtml += '<div class="board-completed"><span class="done-check">&#10003;</span> Completed: ' + completedCount + '</div>';
          }
        }
        // 3B: the shared-graph plan task(s) this session has claimed (by owner_sid),
        // distinct from the local TodoWrite todos above. Lease-governed states show a
        // countdown; parked review/blocked show "parked".
        let planHtml = "";
        const planTasks = entry.sid ? (inflightBySid.get(entry.sid) || []) : [];
        if (planTasks.length > 0) {
          planHtml = '<div class="board-plantasks">';
          for (const pt of planTasks) {
            const governed = pt.status === "claimed" || pt.status === "in_progress";
            let leaseHtml = '<span class="board-plantask-lease parked">parked</span>';
            if (governed) {
              const ll = planLeaseLabel(pt.lease_expires_at);
              leaseHtml = ll ? '<span class="board-plantask-lease ' + ll.urg + '">&#9201; ' + escapeHtml(ll.text) + '</span>' : '';
            }
            // C5 stall radar: owner went quiet past the threshold while the lease is
            // still valid. Recomputed client-side off last_seen_at so it stays live on
            // the 30s tick. Amber pause badge — distinct from the red expired lease label.
            const idle = governed ? planStallLabel(pt.last_seen_at, pt.lease_expires_at) : null;
            const stallHtml = idle
              ? '<span class="board-plantask-stall" title="No heartbeat from this session in ' + escapeHtml(idle) + ' — likely stalled (lease still valid)">&#9208; ' + escapeHtml(idle) + '</span>'
              : '';
            planHtml += '<div class="board-plantask' + (idle ? ' stalled' : '') + '">'
              + '<span class="board-plantask-badge ' + escapeHtml(pt.status) + '">' + escapeHtml(pt.status.replace("_", " ")) + '</span>'
              + '<span class="board-plantask-title" title="' + escapeHtml(pt.title) + '">' + escapeHtml(pt.title) + '</span>'
              + stallHtml
              + leaseHtml
              + '</div>';
          }
          planHtml += '</div>';
        }
        // Board auto-digest: the agent's latest logbook line as a headline,
        // click-to-expand to its last 5. This is the "detailed book" — detail
        // lives here (read), not in chat (which wakes). Empty until first emit.
        let logHtml = "";
        if (entry.recentLog && entry.recentLog.note) {
          const lg = entry.recentLog;
          const kindCls = (lg.kind === "decision" || lg.kind === "blocker" || lg.kind === "done") ? lg.kind : "finding";
          const open = !!entry.logOpen;
          let tailHtml = "";
          if (open && Array.isArray(entry.logTail) && entry.logTail.length > 0) {
            tailHtml = '<ul class="board-log-tail">';
            for (const e of entry.logTail) {
              const kc = (e.kind === "decision" || e.kind === "blocker" || e.kind === "done") ? e.kind : "finding";
              tailHtml += '<li class="board-log-line"><span class="board-log-kind ' + kc + '">' + escapeHtml(e.kind) + '</span><span class="board-log-note">' + escapeHtml(e.note) + '</span><span class="board-log-age">' + formatAge(e.ts) + '</span></li>';
            }
            tailHtml += '</ul>';
          }
          logHtml = '<div class="board-log' + (open ? ' open' : '') + '">'
            + '<div class="board-log-head" data-name="' + escapeHtml(entry.name) + '" title="Show recent log">'
            + '<span class="board-log-kind ' + kindCls + '">' + escapeHtml(lg.kind) + '</span>'
            + '<span class="board-log-note">' + escapeHtml(lg.note) + '</span>'
            + '<span class="board-log-toggle">' + (open ? '&#9652;' : '&#9662;') + '</span>'
            + '</div>'
            + tailHtml
            + '</div>';
        }
        html += '<div class="board-card">'
          + '<div class="board-card-head">'
          + '<span class="' + dotCls + '"></span>'
          + '<span class="board-agent-name">' + escapeHtml(entry.name) + '</span>'
          + nodeBadge
          + subBadge
          + '<span class="board-status ' + statusCls + '">' + escapeHtml(entry.status) + '</span>'
          + '<button class="board-remove-btn" data-name="' + escapeHtml(entry.name) + '" title="Remove from board">&#10005;</button>'
          + '</div>'
          + ctxBadge
          + (entry.mission ? '<div class="board-mission">' + escapeHtml(entry.mission) + '</div>' : '')
          + (entry.activity ? '<div class="board-activity">' + escapeHtml(entry.activity) + '</div>' : '')
          + planHtml
          + todosHtml
          + logHtml
          + '<div class="board-age">updated ' + formatAge(entry.updatedAt || 0) + '</div>'
          + '</div>';
      }
      boardCardsEl.innerHTML = html;
      for (const btn of boardCardsEl.querySelectorAll(".board-remove-btn")) {
        btn.onclick = () => boardDelete(btn.dataset.name);
      }
      // Board auto-digest: click a log headline to expand/collapse its last-5.
      // The tail is fetched lazily on first open (then kept live by agent_log SSE).
      for (const head of boardCardsEl.querySelectorAll(".board-log-head")) {
        head.onclick = () => toggleBoardLog(head.dataset.name);
      }
    }

    // Board auto-digest: toggle a card's expandable log tail. First open fetches
    // /agent-log-tail (public read, no wake); thereafter agent_log SSE keeps it
    // current. Re-renders via renderBoard so the open state + arrow stay in sync.
    function toggleBoardLog(name) {
      const entry = boardEntries.get(name);
      if (!entry) return;
      const willOpen = !entry.logOpen;
      entry.logOpen = willOpen;
      if (willOpen && !Array.isArray(entry.logTail)) {
        fetch("/agent-log-tail?name=" + encodeURIComponent(name) + "&limit=5")
          .then(r => r.json())
          .then(data => { entry.logTail = (data && data.log) || []; renderBoard(); })
          .catch(() => { entry.logTail = []; renderBoard(); });
      }
      renderBoard();
    }

    function boardDelete(name) {
      fetch("/admin-board-delete", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ name }),
      }).then(r => r.json()).then(data => {
        if (data.error) { alert(data.error); return; }
        // Server broadcasts board_delete via SSE; remove locally as a fallback
        if (boardEntries.delete(name)) renderBoard();
      }).catch(() => {});
    }

    function setBoardOnline(name, online) {
      const entry = boardEntries.get(name);
      if (entry && entry.online !== online) {
        entry.online = online;
        renderBoard();
      }
    }

    // Authoritative load of the agent roster. REPLACE semantics: any name the
    // fresh /board payload no longer reports (e.g. a junk/fixture row purged
    // during a hub bounce) is dropped from the local Map so it can't linger as
    // stale junk after a reconnect. Called on init AND on SSE reconnect.
    function loadBoard() {
      return fetch("/board").then(r => r.json()).then(data => {
        const fresh = new Set();
        for (const b of (data.board || [])) {
          fresh.add(b.name);
          boardEntries.set(b.name, {
            name: b.name,
            node: b.node,
            status: b.status,
            mission: b.mission,
            activity: b.activity,
            todos: b.todos,
            subagents: b.subagents || 0,
            sid: b.sid,
            updatedAt: b.updatedAt,
            online: !!b.online,
            lastSeenAt: typeof b.lastSeenAt === "number" ? b.lastSeenAt : null,
            stale: !!b.stale,
            contextTokens: b.contextTokens != null ? b.contextTokens : null,
            contextTs: b.contextTs != null ? b.contextTs : null,
            // Board auto-digest: freshest logbook line ({ts,kind,note}) or null.
            // The expandable last-5 tail is fetched lazily on card-click.
            recentLog: b.recentLog || null,
          });
        }
        for (const name of [...boardEntries.keys()]) if (!fresh.has(name)) boardEntries.delete(name);
        renderBoard();
      }).catch(() => {});
    }
    loadBoard();

    loadInflight(); // 3B: initial claimed-plan-task lines for the cards

    // Refresh relative ages periodically
    setInterval(renderBoard, 30000);

    // Fetch initial data
    // Authoritative load/replace of the On-Air roster — drop any name the server
    // no longer reports (mirrors loadBoard). Called on init + SSE reconnect.
    function loadUsers() {
      return fetch("/users").then(r => r.json()).then(data => {
        const fresh = new Set();
        for (const u of data.users) { fresh.add(u.name); users.set(u.name, u.online); }
        for (const name of [...users.keys()]) if (!fresh.has(name)) users.delete(name);
        renderUsers();
      }).catch(() => {});
    }
    loadUsers();

    fetch("/channels").then(r => r.json()).then(data => {
      for (const ch of data.channels) {
        channels.set(ch.name, { memberCount: ch.memberCount, createdBy: ch.createdBy, members: ch.members || [] });
      }
      renderChannels();
    }).catch(() => {});

    // Load agent configs
    refreshAgentConfigs();

    // Load unread counts
    fetch("/admin-unread-counts", { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } })
      .then(r => r.json())
      .then(data => {
        if (data.counts) {
          for (const [ch, cnt] of Object.entries(data.counts)) {
            unreadCounts[ch] = cnt;
          }
          renderChannels();
        }
      }).catch(() => {});

    // Load message history from DB
    fetch("/admin-channel-history", { headers: { "Authorization": "Bearer " + ADMIN_TOKEN } })
      .then(r => r.json())
      .then(data => {
        if (data.messages && data.messages.length > 0) {
          clearEmpty();
          for (const msg of data.messages) {
            const cls = msg.from === OPERATOR_NAME ? "message operator" : (String(msg.from || "").trim().toUpperCase().startsWith("REFEREE") ? "message referee" : "message");
            const channelTag = '<span class="channel-tag">' + (msg.channel || "#all") + '</span>';
            addMessage(
              '<span class="time">' + formatTime(msg.timestamp) + '</span>' +
              channelTag +
              '<span class="from">' + msg.from + '</span> ' +
              '<span class="to">&rarr; ' + msg.to + '</span>' +
              '<div class="content">' + msg.content.replace(/</g, "&lt;") + '</div>' +
              renderImageTag(msg.image),
              cls,
              msg.channel || "#all",
              msg.id,
              msg.timestamp
            );
          }
        }
        // The startup history fetch already pulled the recent window across all
        // channels, so #all needs no per-channel lazy backfill.
        loadedChannels.add("#all");
        // Mark #all as read after loading history
        markChannelRead("#all");
      }).catch(() => {});

    const es = new EventSource("/events");

    es.onmessage = (e) => {
      const ev = JSON.parse(e.data);

      if (ev.type === "status") {
        if (users.has(ev.name)) {
          users.set(ev.name, ev.online);
          renderUsers();
          renderAgents();
        }
        setBoardOnline(ev.name, !!ev.online);
      } else if (ev.type === "join") {
        users.set(ev.name, true);
        renderUsers();
        renderAgents();
        refreshChannels();
        setBoardOnline(ev.name, true);
        addMessage(
          '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
          '<strong>' + ev.name + '</strong> joined the channel',
          "system",
          null
        );
      } else if (ev.type === "leave") {
        users.delete(ev.name);
        renderUsers();
        renderAgents();
        refreshChannels();
        setBoardOnline(ev.name, false);
        addMessage(
          '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
          '<strong>' + ev.name + '</strong> left the channel',
          "system leave",
          null
        );
      } else if (ev.type === "message") {
        // Clear typing and pending-reply state when user sends a real message
        clearPendingReply(ev.from);
        if (users.has(ev.from)) users.set(ev.from, true);
        const existingTimer = typingUsers.get(ev.from);
        if (existingTimer) { clearTimeout(existingTimer.timeoutId); typingUsers.delete(ev.from); renderUsers(); renderTypingBar(); }
        const cls = ev.from === OPERATOR_NAME ? "message operator" : (String(ev.from || "").trim().toUpperCase().startsWith("REFEREE") ? "message referee" : "message");
        const channelTag = '<span class="channel-tag">' + (ev.channel || "#all") + '</span>';
        addMessage(
          '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
          channelTag +
          '<span class="from">' + ev.from + '</span> ' +
          '<span class="to">&rarr; ' + ev.to + '</span>' +
          '<div class="content">' + ev.content.replace(/</g, "&lt;") + '</div>' +
          renderImageTag(ev.image),
          cls,
          ev.channel || "#all",
          ev.id,
          ev.timestamp
        );
        // Unread tracking
        const msgChannel = ev.channel || "#all";
        if (msgChannel === selectedChannel) {
          markChannelRead(msgChannel);
        } else {
          unreadCounts[msgChannel] = (unreadCounts[msgChannel] || 0) + 1;
          renderChannels();
        }
      } else if (ev.type === "channel_create") {
        refreshChannels();
        addMessage(
          '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
          'Channel <strong>' + ev.name + '</strong> created',
          "system channel-event",
          null
        );
      } else if (ev.type === "channel_join") {
        refreshChannels();
        addMessage(
          '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
          '<strong>' + ev.userName + '</strong> joined <strong>' + ev.channel + '</strong>',
          "system channel-event",
          ev.channel
        );
      } else if (ev.type === "channel_leave") {
        refreshChannels();
        addMessage(
          '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
          '<strong>' + ev.userName + '</strong> left <strong>' + ev.channel + '</strong>',
          "system channel-event leave",
          ev.channel
        );
      } else if (ev.type === "read_update") {
        if (ev.userName === OPERATOR_NAME) {
          delete unreadCounts[ev.channel];
          renderChannels();
        }
      } else if (ev.type === "channel_delete") {
        if (selectedChannel === ev.name) selectedChannel = "#all";
        delete unreadCounts[ev.name];
        refreshChannels();
        addMessage(
          '<span class="time">' + formatTime(ev.timestamp) + '</span>' +
          'Channel <strong>' + ev.name + '</strong> deleted',
          "system channel-event leave",
          null
        );
      } else if (ev.type === "agent_config_create" || ev.type === "agent_config_update") {
        refreshAgentConfigs();
      } else if (ev.type === "agent_config_delete") {
        agentConfigs.delete(ev.id);
        renderAgents();
      } else if (ev.type === "board_update") {
        const prev = boardEntries.get(ev.name);
        boardEntries.set(ev.name, {
          name: ev.name,
          node: ev.node,
          status: ev.status,
          mission: ev.mission,
          activity: ev.activity,
          todos: ev.todos,
          subagents: ev.subagents || 0,
          sid: ev.sid !== undefined ? ev.sid : (prev ? prev.sid : null),
          updatedAt: ev.timestamp,
          // A board_update is itself a liveness beat — stamp lastSeenAt so the
          // roster render guard keeps a just-active agent visible between polls.
          lastSeenAt: ev.timestamp,
          // board_update carries no online flag: keep what we knew, or
          // assume online for a brand-new entry (an update implies liveness)
          online: prev ? prev.online : true,
          // board_update carries no presence ghost flag or context gauge; preserve
          // the last /board values (the 30s poll refreshes them).
          stale: prev ? prev.stale : false,
          contextTokens: prev ? prev.contextTokens : null,
          contextTs: prev ? prev.contextTs : null,
          // board_update carries no log; preserve the last known headline.
          recentLog: prev ? prev.recentLog : null,
        });
        renderBoard();
      } else if (ev.type === "agent_log") {
        // Board auto-digest: fold the new entry into the emitting card. Update
        // the latest-log headline live; if that card's tail is currently
        // expanded, prepend to it (cap 5) so an open log grows in real time.
        const prev = boardEntries.get(ev.name);
        if (prev) {
          prev.recentLog = ev.entry;
          if (Array.isArray(prev.logTail)) {
            prev.logTail = [ev.entry, ...prev.logTail].slice(0, 5);
          }
          renderBoard();
        }
      } else if (ev.type === "board_delete") {
        if (boardEntries.delete(ev.name)) renderBoard();
      } else if (ev.type === "typing") {
        clearPendingReply(ev.name);
        if (users.has(ev.name)) users.set(ev.name, true);
        const prev = typingUsers.get(ev.name);
        if (prev) clearTimeout(prev.timeoutId);
        typingUsers.set(ev.name, { timeoutId: setTimeout(() => { typingUsers.delete(ev.name); renderUsers(); renderTypingBar(); }, 60000), channel: ev.channel || "#all" });
        renderUsers();
        renderTypingBar();
      } else if (ev.type === "plan_update") {
        // Meta-harness cockpit: a task-graph mutation. Hand to the cockpit, which
        // debounces a coalesced /plan-board + /plan-events refetch (its own module).
        if (window.__cockpit) window.__cockpit.onPlanUpdate(ev);
        // 3B: also refresh the board cards' claimed-plan-task lines (debounced).
        scheduleInflight();
      } else if (ev.type === "loop_approval") {
        // Loop Phase 5 (HITL): a loop's approval-queue item opened (escalate) or was
        // resolved. Live-refresh the cockpit's Approvals panel (+ Loop Control, since the
        // loop paused/resumed/terminated). The 5s poll is the fallback; this is instant.
        if (window.__cockpit && window.__cockpit.onLoopApproval) window.__cockpit.onLoopApproval(ev);
      }
    };

    es.onopen = () => {
      statusEl.textContent = "connected";
      statusEl.className = "";
      // Cockpit resync: a dropped SSE (e.g. a backgrounded phone tab) may have
      // missed plan_updates — refetch the full board on reconnect.
      if (window.__cockpit) window.__cockpit.onReconnect();
      // Radio roster resync: authoritatively REPLACE the agent board + On-Air
      // roster from the server so any row purged during the bounce drops out
      // instead of lingering as stale junk until a manual reload.
      loadBoard();
      loadUsers();
      loadInflight(); // 3B: resync claimed-task lines after a dropped SSE
    };

    es.onerror = () => {
      statusEl.textContent = "disconnected";
      statusEl.className = "disconnected";
    };

    // ===== Meta-harness cockpit (own IIFE; exposes window.__cockpit) =====
    // Thread the SCOPED cockpit token (A3-a) so the cockpit's operator-control POSTs are
    // Bearer-gated (same token already embedded above for the dashboard script — same page,
    // same blast radius). NOT the raw admin token: that never reaches the browser.
    ${cockpitScript(cockpitToken)}

    // Mode switch: Radio (default 3-panel) ↔ Cockpit (task-graph).
    (function () {
      const radioBtn = document.getElementById("mode-radio");
      const cockpitBtn = document.getElementById("mode-cockpit");
      function setMode(cockpit) {
        document.body.classList.toggle("cockpit-mode", cockpit);
        if (radioBtn) radioBtn.classList.toggle("active", !cockpit);
        if (cockpitBtn) cockpitBtn.classList.toggle("active", cockpit);
        if (cockpit && window.__cockpit) window.__cockpit.refresh();
      }
      if (radioBtn) radioBtn.addEventListener("click", () => setMode(false));
      if (cockpitBtn) cockpitBtn.addEventListener("click", () => setMode(true));
    })();
  </script>
  ${cockpitMarkup()}
</body>
</html>`;
}
