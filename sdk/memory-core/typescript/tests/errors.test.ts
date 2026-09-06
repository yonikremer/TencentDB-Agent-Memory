import { describe, it, expect } from "vitest";
import { ParamError, TDAMError } from "../src/errors.js";

describe("ParamError", () => {
  it("is a TypeError with name ParamError", () => {
    const e = new ParamError("bad param");
    expect(e).toBeInstanceOf(TypeError);
    expect(e.name).toBe("ParamError");
    expect(e.message).toBe("bad param");
  });
});

describe("TDAMError", () => {
  it("formats message and defaults requestId", () => {
    const e = new TDAMError(40001, "invalid");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("TDAMError");
    expect(e.code).toBe(40001);
    expect(e.requestId).toBe("");
    expect(e.details).toBeUndefined();
    expect(e.message).toBe("[40001] invalid (request_id=)");
  });

  it("carries requestId and details", () => {
    const e = new TDAMError(40901, "stale", "req-1", { current_version: 3 });
    expect(e.requestId).toBe("req-1");
    expect(e.details).toEqual({ current_version: 3 });
    expect(e.message).toBe("[40901] stale (request_id=req-1)");
  });
});