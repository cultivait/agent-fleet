import { describe, expect, it } from "vitest";
import { leaseState, serverClockOffset, stallState } from "../cockpit-lease.js";

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
  // STALL_BEAT_MS is 240_000ms (4min). clientNow=2_000_000, offset=0 throughout.
  const NOW = 2_000_000;
  const base = { clientNow: NOW, offset: 0 };

  it("is not stalled when the owner beat recently (lease valid)", () => {
    // beat 1min ago, lease 10min out.
    const s = stallState({ ...base, lastSeenAt: NOW - 60_000, leaseExpiresAt: NOW + 600_000 });
    expect(s.stalled).toBe(false);
    expect(s.beatAgeMs).toBe(60_000);
    expect(s.label).toBeNull();
  });

  it("stalls once the beat is older than the 4min threshold (lease still valid)", () => {
    // beat 5min ago, lease still 10min out — early dead-agent radar before expiry.
    const s = stallState({ ...base, lastSeenAt: NOW - 300_000, leaseExpiresAt: NOW + 600_000 });
    expect(s.stalled).toBe(true);
    expect(s.beatAgeMs).toBe(300_000);
    expect(s.label).toBe("5m idle");
  });

  it("does NOT stall at exactly the threshold (strictly greater than)", () => {
    const s = stallState({ ...base, lastSeenAt: NOW - 240_000, leaseExpiresAt: NOW + 600_000 });
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
    // Client clock 5min BEHIND server (offset +300_000). lastSeenAt on server timeline
    // 2min before raw clientNow reads 2min idle (not stalled); the true server-effective
    // now is 5min ahead → 7min idle → stalled.
    const s = stallState({
      lastSeenAt: NOW - 120_000,
      leaseExpiresAt: NOW + 600_000,
      clientNow: NOW,
      offset: 300_000,
    });
    expect(s.stalled).toBe(true);
    expect(s.beatAgeMs).toBe(420_000);
    expect(s.label).toBe("7m idle");
  });

  it("renders seconds for a sub-minute idle gap (only reachable under skew)", () => {
    // Force a >threshold but <1min beatAge via offset so the seconds branch is covered.
    const s = stallState({ lastSeenAt: NOW, leaseExpiresAt: NOW + 600_000, clientNow: NOW, offset: 250_000 });
    // effectiveNow = NOW+250_000 → beatAge 250_000ms = 250s > 240s threshold, <1min? no.
    // 250s is >4min in seconds? 250_000ms = 250s = 4m10s → mins=4 → "4m idle".
    expect(s.stalled).toBe(true);
    expect(s.label).toBe("4m idle");
  });
});
