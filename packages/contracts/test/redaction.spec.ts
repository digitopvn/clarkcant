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

  it("reads a hostile run of digits and separators with the phone shape in linear time", () => {
    const phone = SECRET_SHAPES.find((shape) => shape.label === "phone")?.pattern;
    expect(phone).toBeDefined();
    if (phone === undefined) return;
    // Sized so that trying the shape again from every digit of a run would take minutes, not milliseconds.
    const hostile = [
      { text: `a-${"1-".repeat(100_000)}x`, matches: false },
      { text: "1-".repeat(100_000), matches: true },
      { text: `${"(1)".repeat(100_000)}a`, matches: true },
      { text: `${"+(".repeat(100_000)}1`, matches: false },
      { text: `${"1".repeat(200_000)}a`, matches: false },
      { text: `${"12345678a ".repeat(50_000)}`, matches: false },
    ];
    const started = performance.now();
    for (const { text, matches } of hostile) {
      expect(new RegExp(phone.source, phone.flags).test(text), text.slice(0, 12)).toBe(matches);
    }
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
