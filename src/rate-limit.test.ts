import { beforeEach, describe, expect, it } from "vitest";
import { RATE_LIMIT, clientAddress, isRateLimited, resetRateLimits } from "./rate-limit";

const from = (ip: string) => new Headers({ "cf-connecting-ip": ip });

describe("isRateLimited", () => {
  beforeEach(resetRateLimits);

  it("allows the quota, then refuses", () => {
    const h = from("1.2.3.4");
    for (let i = 0; i < RATE_LIMIT; i++) expect(isRateLimited(h)).toBe(false);
    expect(isRateLimited(h)).toBe(true);
  });

  it("counts each address separately", () => {
    const a = from("1.2.3.4");
    for (let i = 0; i < RATE_LIMIT; i++) isRateLimited(a);
    expect(isRateLimited(a)).toBe(true);
    expect(isRateLimited(from("5.6.7.8"))).toBe(false);
  });

  it("forgets requests older than the window", () => {
    const h = from("1.2.3.4");
    const t0 = Date.now();
    for (let i = 0; i < RATE_LIMIT; i++) isRateLimited(h, t0);
    expect(isRateLimited(h, t0)).toBe(true);
    expect(isRateLimited(h, t0 + 61 * 60 * 1000)).toBe(false);
  });

  it("falls back to x-forwarded-for, then to a constant", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" }))).toBe("9.9.9.9");
    expect(clientAddress(new Headers())).toBe("unknown");
  });
});
