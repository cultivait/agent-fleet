import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dbListChannels, initDB } from "../db.js";

// Agent Fleet rename (Lane B / B3): the default db filename moved walkie-talkie.db →
// agent-fleet.db, the path env moved WALKIE_TALKIE_DB_PATH → AGENT_FLEET_DB_PATH (with
// one-version back-compat), and initDB() carries an existing legacy db over on first
// boot by COPYING it (never moving) when resolving the DEFAULT location. These tests
// pin all four behaviours.
describe("Agent Fleet db path migration (copy-on-boot)", () => {
  let tmp: string;
  let cwd0: string;
  let af0: string | undefined;
  let wt0: string | undefined;

  beforeEach(() => {
    cwd0 = process.cwd();
    af0 = process.env.AGENT_FLEET_DB_PATH;
    wt0 = process.env.WALKIE_TALKIE_DB_PATH;
    delete process.env.AGENT_FLEET_DB_PATH;
    delete process.env.WALKIE_TALKIE_DB_PATH;
    tmp = mkdtempSync(path.join(tmpdir(), "af-dbmig-"));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(cwd0);
    rmSync(tmp, { recursive: true, force: true });
    if (af0 === undefined) delete process.env.AGENT_FLEET_DB_PATH;
    else process.env.AGENT_FLEET_DB_PATH = af0;
    if (wt0 === undefined) delete process.env.WALKIE_TALKIE_DB_PATH;
    else process.env.WALKIE_TALKIE_DB_PATH = wt0;
  });

  it("copies a legacy walkie-talkie.db → agent-fleet.db on first boot, carrying data over", () => {
    // Seed a legacy db with a recognizable channel.
    const legacy = new Database(path.join(tmp, "walkie-talkie.db"));
    legacy.exec(
      "CREATE TABLE channels (name TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );
    legacy.prepare("INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?)").run("#carryover", "seed", 1);
    legacy.close();

    initDB();

    // New db created; legacy preserved (copy, not move) as a rollback safety net.
    expect(existsSync(path.join(tmp, "agent-fleet.db"))).toBe(true);
    expect(existsSync(path.join(tmp, "walkie-talkie.db"))).toBe(true);

    // Seeded data carried over into the new db, plus the usual #all seed.
    const names = dbListChannels().map((c) => c.name);
    expect(names).toContain("#carryover");
    expect(names).toContain("#all");
  });

  it("creates a fresh agent-fleet.db when no legacy db exists (no migration)", () => {
    initDB();
    expect(existsSync(path.join(tmp, "agent-fleet.db"))).toBe(true);
    expect(existsSync(path.join(tmp, "walkie-talkie.db"))).toBe(false);
  });

  it("honors an explicit AGENT_FLEET_DB_PATH override and skips the legacy migration", () => {
    // Legacy default is present, but an explicit override must win and NOT trigger a copy.
    const legacy = new Database(path.join(tmp, "walkie-talkie.db"));
    legacy.exec(
      "CREATE TABLE channels (name TEXT PRIMARY KEY, created_by TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );
    legacy.close();

    const explicit = path.join(tmp, "explicit.db");
    process.env.AGENT_FLEET_DB_PATH = explicit;
    initDB();

    expect(existsSync(explicit)).toBe(true);
    expect(existsSync(path.join(tmp, "agent-fleet.db"))).toBe(false);
  });

  it("still resolves the legacy WALKIE_TALKIE_DB_PATH env (one-version back-compat)", () => {
    const legacyExplicit = path.join(tmp, "legacy-explicit.db");
    process.env.WALKIE_TALKIE_DB_PATH = legacyExplicit;
    initDB();
    expect(existsSync(legacyExplicit)).toBe(true);
  });
});
