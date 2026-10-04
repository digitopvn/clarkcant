import { describe, expect, it } from "vitest";

import { providerErrorReason } from "../src/provider-error.ts";

describe("providerErrorReason", () => {
  it("lifts the sentence out of a status and JSON body, keeping the status", () => {
    const raw =
      '400 {"type":"error","error":{"type":"invalid_request_error","message":"Version 2.1.280 or newer is required."},"request_id":"req_1"}';
    expect(providerErrorReason(raw)).toBe("Version 2.1.280 or newer is required. (HTTP 400)");
  });

  it("reads a top-level message and a string error", () => {
    expect(providerErrorReason('402: {"message":"Insufficient Balance","code":"x"}')).toBe("Insufficient Balance (HTTP 402)");
    expect(providerErrorReason('{"error":"model not found"}')).toBe("model not found");
  });

  it("passes anything else on unchanged rather than guessing", () => {
    expect(providerErrorReason("connect ECONNREFUSED")).toBe("connect ECONNREFUSED");
    expect(providerErrorReason('500 {"not":"what we expect"}')).toBe('500 {"not":"what we expect"}');
    expect(providerErrorReason("500 {broken")).toBe("500 {broken");
    expect(providerErrorReason("")).toBe("no reason given");
    expect(providerErrorReason(undefined)).toBe("no reason given");
  });
});
