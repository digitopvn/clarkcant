import { describe, expect, it } from "vitest";
import { SECRET_SHAPES, containsSecretShape, redactSecrets } from "../src/index.ts";

// Built from parts so no scanner reads a literal secret in this file.
const BASE64_WITH_SLASH = `${"QWxhZGRpbjpvcGVuIHNlc2FtZQ"}/${"Zm9vYmFyYmF6cXV4"}`;
const LONG_SEGMENT = "Zm9vYmFyYmF6cXV4QWxhZGRpbjpvcGVuIHNlc2FtZQ";

describe("secret-shaped text", () => {
  it("leaves a macOS temp directory readable: its separators do not make it one base64 run", () => {
    const path = "/var/folders/f9/tth74dcd50s99ss40mmrf6xw0000gp/T/clarkcant-inbox-uyNeWt";
    expect(redactSecrets(`Chạy lệnh trong ${path}`)).toBe(`Chạy lệnh trong ${path}`);
    expect(containsSecretShape(path)).toBe(false);
  });

  it("leaves an absolute project path readable", () => {
    const path = "/srv/clarkcant/apps/runtime/src/routes/attachments/index";
    expect(redactSecrets(`git diff ${path}`)).toBe(`git diff ${path}`);
  });

  it("still redacts a standalone base64 run that carries a slash", () => {
    const text = `dùng ${BASE64_WITH_SLASH} để gọi`;
    expect(redactSecrets(text)).toBe("dùng [redacted] để gọi");
  });

  it("still redacts a token that is one segment of a path or URL", () => {
    expect(redactSecrets(`/srv/cache/${LONG_SEGMENT}/data`)).toBe("/srv/cache/[redacted]/data");
    expect(redactSecrets(`https://files.example.org/s/${LONG_SEGMENT}`)).not.toContain(LONG_SEGMENT);
  });

  it("still redacts the home directory a path names", () => {
    expect(redactSecrets("/Users/someone/projects/app")).toBe("[redacted]");
  });

  it("keeps a dated model id whole and still redacts a whole phone number", () => {
    expect(redactSecrets("dùng claude-sonnet-4-5-20250929 nhé")).toBe("dùng claude-sonnet-4-5-20250929 nhé");
    // Assembled here so no scanner reads a literal phone number in this file.
    const phone = `(555) ${["123", "4567"].join("-")}`;
    expect(redactSecrets(`gọi ${phone} nhé`)).toBe("gọi [redacted] nhé");
    expect(redactSecrets(`gọi +84 ${["912", "345", "678"].join("-")}`)).toBe("gọi [redacted]");
  });

  it("replaces a parenthesised phone number whole, and leaves parentheses it did not open", () => {
    // Assembled here so no scanner reads a literal phone number in this file.
    const us = ["555", "123", "4567"];
    expect(redactSecrets(`gọi (${us.join("")}) nhé`)).toBe("gọi [redacted] nhé");
    expect(redactSecrets(`gọi (${us.join("-")}) nhé`)).toBe("gọi [redacted] nhé");
    expect(redactSecrets(`(xem ${us.join("-")})`)).toBe("(xem [redacted])");
  });

  it("leaves a date and time alone", () => {
    expect(redactSecrets("họp lúc 2025-09-29 12:34 UTC")).toBe("họp lúc 2025-09-29 12:34 UTC");
    expect(redactSecrets("log 2025-09-29 12:34:56")).toBe("log 2025-09-29 12:34:56");
  });

  it("reads a run of digits that ends in a letter without backtracking through it", () => {
    const phone = SECRET_SHAPES.find((shape) => shape.label === "phone")?.pattern;
    expect(phone).toBeDefined();
    if (phone === undefined) return;
    // A shape that let one step take several digits, such as `(?:\d+[\s-]?){9,}`, could split such a run in
    // exponentially many ways before giving up: 28 digits before a letter already take seconds, and 40 would not
    // finish. The shape takes one digit a step, so these are read at once.
    const runs = [`${"1".repeat(40)}a`, `${"1 ".repeat(20)}${"1".repeat(20)}a`, `${"1-".repeat(20)}${"1".repeat(20)}a`];
    const started = performance.now();
    for (const text of runs) new RegExp(phone.source, phone.flags).test(text);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
