import { describe, expect, it } from "vitest";
import { resolveOwnerSid } from "../session.js";

describe("resolveOwnerSid", () => {
  it("returns the explicit owner_sid when the caller supplies one", () => {
    expect(resolveOwnerSid("explicit-sid", "env-sid")).toBe("explicit-sid");
  });

  it("falls back to the environment session id when no explicit sid is given", () => {
    expect(resolveOwnerSid(undefined, "env-sid")).toBe("env-sid");
  });

  it("treats an empty/whitespace explicit sid as absent and uses the env sid", () => {
    expect(resolveOwnerSid("", "env-sid")).toBe("env-sid");
    expect(resolveOwnerSid("   ", "env-sid")).toBe("env-sid");
  });

  it("trims a supplied explicit sid", () => {
    expect(resolveOwnerSid("  spaced-sid  ", "env-sid")).toBe("spaced-sid");
  });

  it("returns undefined when neither an explicit nor an env sid is available", () => {
    expect(resolveOwnerSid(undefined, undefined)).toBeUndefined();
    expect(resolveOwnerSid(null, "")).toBeUndefined();
    expect(resolveOwnerSid("", "   ")).toBeUndefined();
  });
});
