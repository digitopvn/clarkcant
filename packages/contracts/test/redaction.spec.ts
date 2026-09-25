import { describe, expect, it } from "vitest";
import { containsSecretShape, redactSecrets } from "../src/index.ts";

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
});
