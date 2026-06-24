import { describe, expect, it } from "vitest";
import { leaseState, serverClockOffset, stallState } from "../cockpit-lease.js";
import { STALL_BEAT_MS } from "../constants.js";

describe("serverClockOffset", () => {
  it("is the signed gap between server and client clocks (server ahead → positive)", () => {
    expect(serverClockOffset(10_000, 7_000)).toBe(3_000);
  });
  it("is negative when the client clock is ahead of the server", () => {
    expect(serverClockOffset(7_000, 10_000)).toBe(-3_000);
  });
  it("is zero when the clocks agree", () => {
    expect(serverClockOffset(5_000, 5_000)).toBe(0);
  });
});

describe("leaseState", () => {
  const base = { claimedAt: 1_000_000, offset: 0 };

  it("reports no lease when lease_expires_at is null", () => {
    const s = leaseState({ ...base, leaseExpiresAt: null, clientNow: 1_000_000 });
    expect(s.hasLease).toBe(false);
    expect(s.urgency).toBe("ok");
    expect(s.secondsLeft).toBe(0);
    expect(s.label).toBe("—");
    expect(s.fraction).toBeNull();
  });

  it("counts down in mm:ss and is 'ok' when comfortably in the future", () => {
    // 600s left.
    const s = leaseState({ ...base, leaseExpiresAt: 1_600_000, clientNow: 1_000_000 });
    expect(s.hasLease).toBe(true);
    expect(s.secondsLeft).toBe(600);
    expect(s.urgency).toBe("ok");
    expect(s.label).toBe("10:00 left");
  });

  it("is 'soon' under 5 minutes left", () => {
    const s = leaseState({ ...base, leaseExpiresAt: 1_200_000, clientNow: 1_000_000 }); // 200s
    expect(s.urgency).toBe("soon");
    expect(s.label).toBe("03:20 left");
  });

  it("is 'urgent' under 60 seconds left", () => {
    const s = leaseState({ ...base, leaseExpiresAt: 1_045_000, clientNow: 1_000_000 }); // 45s
    expect(s.urgency).toBe("urgent");
    expect(s.label).toBe("00:45 left");
  });

  it("is 'expired' (clamped to 0) once past the lease, with fraction 0", () => {
    const s = leaseState({ ...base, leaseExpiresAt: 999_000, clientNow: 1_000_000 }); // -1s
    expect(s.urgency).toBe("expired");
    expect(s.secondsLeft).toBe(0);
    expect(s.label).toBe("expired");
    expect(s.fraction).toBe(0);
  });

  it("computes the bar fraction as remaining/window of the claim→expiry span", () => {
    // window 1_000_000..1_400_000 (400s), now at 1_100_000 → 300s left → 0.75.
    const s = leaseState({ claimedAt: 1_000_000, offset: 0, leaseExpiresAt: 1_400_000, clientNow: 1_100_000 });
    expect(s.fraction).toBeCloseTo(0.75, 5);
  });

  it("applies the server-clock offset rather than the raw client clock", () => {
    // Client clock is 5s BEHIND server (offset +5000). lease_expires_at is on the
    // server timeline. Raw client now (1_000_000) would read 50s left; the true
    // server-effective now (1_005_000) reads 45s → 'urgent'.
    const s = leaseState({ ...base, leaseExpiresAt: 1_050_000, clientNow: 1_000_000, offset: 5_000 });
    expect(s.secondsLeft).toBe(45);
    expect(s.urgency).toBe("urgent");
  });

  it("clamps the fraction to 1 under clock skew (now before claim)", () => {
    const s = leaseState({ claimedAt: 1_000_000, offset: 0, leaseExpiresAt: 1_400_000, clientNow: 900_000 });
    expect(s.fraction).toBe(1);
  });

  it("has a null fraction when claimedAt is unknown but still counts down", () => {
    const s = leaseState({ claimedAt: null, offset: 0, leaseExpiresAt: 1_600_000, clientNow: 1_000_000 });
    expect(s.fraction).toBeNull();
    expect(s.secondsLeft).toBe(600);
    expect(s.hasLease).toBe(true);
  });
});

describe("stallState", () => {
  // Threshold-agnostic: timings are derived from the canonical STALL_BEAT_MS (constants.ts;
  // this deployment defaults it to 1h, env-tunable) so these stay correct if the default
  // changes. NOW sits well above STALL_BEAT_MS so that NOW - beatAge stays positive (a
  // non-positive lastSeenAt reads as "never-seen owner"). offset=0 unless a test overrides.
  const NOW = 1_000_000_000;
  const base = { clientNow: NOW, offset: 0 };
  // Label the formatter would emit for a given idle age (mirrors stallState's own logic).
  const idleLabel = (ms: number) =>
    Math.floor(ms / 60_000) >= 1 ? `${Math.floor(ms / 60_000)}m idle` : `${Math.floor(ms / 1000)}s idle`;

  it("is not stalled when the owner beat recently (lease valid)", () => {
    // beat 1min ago, lease 10min out.
    const s = stallState({ ...base, lastSeenAt: NOW - 60_000, leaseExpiresAt: NOW + 600_000 });
    expect(s.stalled).toBe(false);
    expect(s.beatAgeMs).toBe(60_000);
    expect(s.label).toBeNull();
  });

  it("stalls once the beat is older than the threshold (lease still valid)", () => {
    // beat just past the stall threshold, lease still 10min out — early dead-agent
    // radar before expiry. beatAge is one minute over STALL_BEAT_MS.
    const beatAge = STALL_BEAT_MS + 60_000;
    const s = stallState({ ...base, lastSeenAt: NOW - beatAge, leaseExpiresAt: NOW + 600_000 });
    expect(s.stalled).toBe(true);
    expect(s.beatAgeMs).toBe(beatAge);
    expect(s.label).toBe(idleLabel(beatAge));
  });

  it("does NOT stall at exactly the threshold (strictly greater than)", () => {
    const s = stallState({ ...base, lastSeenAt: NOW - STALL_BEAT_MS, leaseExpiresAt: NOW + 600_000 });
    expect(s.beatAgeMs).toBe(STALL_BEAT_MS);
    expect(s.stalled).toBe(false);
  });

  it("never stalls once the lease has expired (A3 reclaim chip owns that case)", () => {
    // beat ages ago AND lease already expired → not stalled (avoid double-flagging).
    const s = stallState({ ...base, lastSeenAt: NOW - 600_000, leaseExpiresAt: NOW - 1_000 });
    expect(s.stalled).toBe(false);
    expect(s.beatAgeMs).toBeNull();
  });

  it("does not stall when there is no lease at all", () => {
    const s = stallState({ ...base, lastSeenAt: NOW - 600_000, leaseExpiresAt: null });
    expect(s.stalled).toBe(false);
    expect(s.beatAgeMs).toBeNull();
  });

  it("does not false-alarm on an unknown/never-seen owner (lastSeenAt 0 or null)", () => {
    expect(stallState({ ...base, lastSeenAt: 0, leaseExpiresAt: NOW + 600_000 }).stalled).toBe(false);
    expect(stallState({ ...base, lastSeenAt: null, leaseExpiresAt: NOW + 600_000 }).stalled).toBe(false);
  });

  it("applies the server-clock offset rather than the raw client clock", () => {
    // Client clock is a full threshold BEHIND the server (offset = STALL_BEAT_MS). By the
    // raw client clock the owner beat only `rawIdle` (2min) ago → under threshold, not
    // stalled; the true server-effective now is `offset` ahead, pushing beatAge over the
    // threshold → stalled. Proves the offset is applied, independent of the threshold value.
    const offset = STALL_BEAT_MS;
    const rawIdle = 120_000; // 2min by the raw client clock — under any realistic threshold
    const s = stallState({
      lastSeenAt: NOW - rawIdle,
      leaseExpiresAt: NOW + offset + 600_000, // lease still valid on the server timeline
      clientNow: NOW,
      offset,
    });
    const beatAge = rawIdle + offset;
    expect(s.stalled).toBe(true);
    expect(s.beatAgeMs).toBe(beatAge);
    expect(s.label).toBe(idleLabel(beatAge));
  });

  it("renders a minutes idle label at the threshold boundary", () => {
    // The "Ns idle" (seconds) branch of the formatter is only reachable when STALL_BEAT_MS
    // itself is sub-minute; with the realistic (>=1min) threshold a just-over-threshold gap
    // always renders minutes. Cover the minutes branch right above the boundary.
    const beatAge = STALL_BEAT_MS + 10_000;
    const s = stallState({ ...base, lastSeenAt: NOW - beatAge, leaseExpiresAt: NOW + 600_000 });
    expect(s.stalled).toBe(true);
    expect(s.label).toBe(idleLabel(beatAge));
    expect(s.label).toMatch(/^\d+m idle$/);
  });
});
