import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { initDB } from "../db.js";

// Captured at MODULE LOAD — i.e. AFTER vitest's setupFile (helpers/test-env-setup.ts)
// ran for this file but BEFORE any test below mutates the environment. This is the
// proof that the setupFile strips the prod-store path the builder shell exports.
const AGENT_FLEET_DB_PATH_AT_LOAD = process.env.AGENT_FLEET_DB_PATH;
const WALKIE_TALKIE_DB_PATH_AT_LOAD = process.env.WALKIE_TALKIE_DB_PATH;

// The real prod hub store. A test must NEVER open this. The guard throws BEFORE
// `new Database()`, so naming it here never actually touches it.
const PROD_DB = "/var/lib/storage/agent-fleet/agent-fleet.db";

describe("test DB isolation (regression: suite must never touch the prod store)", () => {
  let af0: string | undefined;
  let wt0: string | undefined;

  beforeEach(() => {
    af0 = process.env.AGENT_FLEET_DB_PATH;
    wt0 = process.env.WALKIE_TALKIE_DB_PATH;
  });

  afterEach(() => {
    if (af0 === undefined) delete process.env.AGENT_FLEET_DB_PATH;
    else process.env.AGENT_FLEET_DB_PATH = af0;
    if (wt0 === undefined) delete process.env.WALKIE_TALKIE_DB_PATH;
    else process.env.WALKIE_TALKIE_DB_PATH = wt0;
  });

  it("setupFile strips the inherited AGENT_FLEET_DB_PATH and forces :memory:", () => {
    // If the builder shell exported the prod path, the setupFile removed it; otherwise
    // it was already absent. Either way it must NOT be the inherited real path at load.
    expect(AGENT_FLEET_DB_PATH_AT_LOAD).toBeUndefined();
    expect(WALKIE_TALKIE_DB_PATH_AT_LOAD).toBe(":memory:");
  });

  it("hard guard THROWS if a test resolves to the prod DB file", () => {
    process.env.AGENT_FLEET_DB_PATH = PROD_DB;
    delete process.env.WALKIE_TALKIE_DB_PATH;
    expect(() => initDB()).toThrow(/TEST SAFETY GUARD/);
  });

  it("hard guard THROWS on a repo-local real file too (not just the prod path)", () => {
    delete process.env.AGENT_FLEET_DB_PATH;
    process.env.WALKIE_TALKIE_DB_PATH = path.join(process.cwd(), "agent-fleet.db");
    expect(() => initDB()).toThrow(/TEST SAFETY GUARD/);
  });

  it("guard does NOT fire for :memory: (the normal isolated case)", () => {
    delete process.env.AGENT_FLEET_DB_PATH;
    process.env.WALKIE_TALKIE_DB_PATH = ":memory:";
    expect(() => initDB()).not.toThrow();
  });

  it("guard does NOT fire for a temp-dir file (db-migration-style legitimate use)", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "af-isolation-"));
    try {
      process.env.AGENT_FLEET_DB_PATH = path.join(tmp, "scratch.db");
      delete process.env.WALKIE_TALKIE_DB_PATH;
      expect(() => initDB()).not.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
