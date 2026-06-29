import { describe, expect, it } from "vitest";
import { cockpitScript } from "../cockpit-ui.js";

// The +Referee button POSTs /admin-launch-referee. handleLaunchReferee ALWAYS replies HTTP 200 and
// carries success in the BODY {ok}. FIX C resolved the "launching…" hang by polling the roster after
// a 200, but it only branched on r.ok (transport) — so an immediate server-side failure (ok:false @
// 200, e.g. "spawn produced no pid") degraded into the ~45s "not seated" path instead of instant
// feedback. This follow-up branches on data.ok === false for instant "✗ launch failed".
describe("cockpit — +Referee instant body-level failure (data.ok === false)", () => {
  it("the embedded browser JS still parses (no syntax break from the edit)", () => {
    expect(() => new Function(cockpitScript())).not.toThrow();
  });

  it("branches on data.ok === false and surfaces an instant launch-failed state", () => {
    const script = cockpitScript();
    expect(script).toContain("data.ok === false");
    expect(script).toContain("✗ launch failed");
    // the failure message comes from the response BODY (message), the server's failure field
    expect(script).toContain("data.message || data.error");
  });

  it("does NOT regress the transport-reject path or the accepted→roster-poll path", () => {
    const script = cockpitScript();
    expect(script).toContain("✗ launch rejected"); // 4xx/5xx transport failure (r.ok === false)
    expect(script).toContain("pollRefereeSeated"); // ok:true still watches the roster
  });

  it("gives instant feedback on body-failure — it does NOT fall through to the roster poll", () => {
    // Assert ordering in source: the data.ok === false guard (with its early return) precedes the
    // pollRefereeSeated call in the accepted branch, so a body-failure never starts the ~45s poll.
    const script = cockpitScript();
    const guard = script.indexOf("data.ok === false");
    const poll = script.indexOf("pollRefereeSeated(b)", guard);
    expect(guard).toBeGreaterThan(-1);
    expect(poll).toBeGreaterThan(guard);
  });
});
