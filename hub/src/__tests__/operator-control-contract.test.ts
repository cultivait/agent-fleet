import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { writeControlMerged } from "../operator-control.js";

// DRIFT GUARD (b37c-mandated): conductor-control.json now has TWO writers/readers —
// B's atomic writer (writeControlMerged, here) and A's engine reader (resolveControl in
// scripts/fleet/conductor-control.mjs). This test writes via B and reads via A to prove
// the on-disk shape round-trips field-for-field, so the two impls can't silently diverge.
//
// A's reader is an ESM .mjs OUTSIDE hub/src; importing it statically would pull it into
// tsc's rootDir and break the build (cf. registry-retire-isolation.test.ts). So we import
// it at RUNTIME via a computed specifier (tsc treats a non-literal import() as `any`), and
// the suite SELF-ACTIVATES only when the file is present — i.e. in the integration worktree
// where A's branch is merged. On B's isolated pre-merge branch it SKIPS (logged below).

const controlMjs = resolve(dirname(fileURLToPath(import.meta.url)), "../../../scripts/fleet/conductor-control.mjs");
const A_PRESENT = existsSync(controlMjs);
if (!A_PRESENT) {
  // Visible in test output so the pending contract isn't mistaken for "covered".
  console.warn(`[contract] SKIP: ${controlMjs} absent (pre-integration B branch) — runs at the integration gate.`);
}

(A_PRESENT ? describe : describe.skip)("WS-A↔WS-B control-file contract (writer ↔ reader round-trip)", () => {
  // biome-ignore lint/suspicious/noExplicitAny: runtime-imported untyped .mjs (kept out of tsc rootDir)
  let A: any;
  let dir: string;

  beforeAll(async () => {
    A = await import(/* @vite-ignore */ pathToFileURL(controlMjs).href);
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ocp-contract-"));
  });
  afterEach(() => {
    delete process.env.WT_CONDUCTOR_CONTROL_FILE;
    rmSync(dir, { recursive: true, force: true });
  });

  it("every field B writes round-trips through A's resolveControl", () => {
    process.env.WT_CONDUCTOR_CONTROL_FILE = join(dir, "conductor-control.json");
    writeControlMerged(
      { armed: true, paused: true, idleWindowMs: 90_000, intervalMs: 8_000, pinned: ["linux-fleet", "linux-6425"] },
      "2026-06-17T12:00:00.000Z",
    );
    const diskObj = JSON.parse(readFileSync(process.env.WT_CONDUCTOR_CONTROL_FILE, "utf8"));
    const view = A.resolveControl(diskObj, A.envFallbacks({}));

    expect(view.version).toBe(A.CONTROL_VERSION);
    expect(view.armed).toBe(true);
    expect(view.paused).toBe(true);
    expect(view.idleWindowMs).toBe(90_000);
    expect(view.intervalMs).toBe(8_000);
    expect(view.pinned).toEqual(["linux-fleet", "linux-6425"]);
    expect(view.updatedAt).toBe("2026-06-17T12:00:00.000Z");
    expect(view.updatedBy).toBe("operator");
  });

  it("null/unset numeric fields resolve to A's defaults without drift", () => {
    process.env.WT_CONDUCTOR_CONTROL_FILE = join(dir, "c2.json");
    writeControlMerged({ armed: false }, "2026-06-17T12:01:00.000Z");
    const diskObj = JSON.parse(readFileSync(process.env.WT_CONDUCTOR_CONTROL_FILE, "utf8"));

    // B serialized explicit nulls for unset numerics + [] for pinned (the shape A expects).
    expect(diskObj.idleWindowMs).toBeNull();
    expect(diskObj.intervalMs).toBeNull();
    expect(diskObj.pinned).toEqual([]);

    const view = A.resolveControl(diskObj, A.envFallbacks({}));
    expect(view.armed).toBe(false);
    expect(view.idleWindowMs).toBe(A.CONTROL_DEFAULTS.idleWindowMs);
    expect(view.intervalMs).toBe(A.CONTROL_DEFAULTS.intervalMs);
    expect(view.pinned).toEqual([]);
  });

  it("a freshly written file is parseable JSON (atomic write left no torn content)", () => {
    process.env.WT_CONDUCTOR_CONTROL_FILE = join(dir, "c3.json");
    const written = writeControlMerged({ pinned: ["a"] }, "2026-06-17T12:02:00.000Z");
    const diskObj = JSON.parse(readFileSync(process.env.WT_CONDUCTOR_CONTROL_FILE, "utf8"));
    expect(diskObj).toEqual(written); // returned object === persisted object
  });
});
