import { describe, expect, it } from "vitest";
import { containsSecretShape, dataClassOfText, dataClassesOfText, redactSecrets } from "../src/index.ts";

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

  it("still redacts an address and a password in a URL", () => {
    expect(redactSecrets("gửi cho duy.nguyen+work@mail.example.com nhé")).toBe("gửi cho [redacted] nhé");
    const url = ["postgres://app:", "s3cretpass", "@db.example.com/main"].join("");
    expect(redactSecrets(url)).not.toContain("s3cretpass");
    expect(dataClassOfText(url)).toBe("secret");
  });

  it("still redacts an address whose local part is longer than the standard allows", () => {
    // Short dotted words, so no other shape reads part of it first.
    const local = Array.from({ length: 16 }, (_unused, index) => `muc${String(index)}`).join(".");
    expect(local.length).toBeGreaterThan(64);
    expect(redactSecrets(`gửi ${local}@mail.example.com`)).toBe("gửi [redacted]");
    expect(dataClassOfText(`${local}@mail.example.com`)).toBe("confidential");
  });

  it("recognises an HTTP Basic header written as a key and its value", () => {
    const encoded = btoa(["admin", "hunter22x"].join(":"));
    for (const written of [
      JSON.stringify({ Authorization: `Basic ${encoded}` }),
      JSON.stringify({ headers: { authorization: `Basic ${encoded}` } }, null, 2),
      `headers: { authorization: 'Basic ${encoded}' }`,
      `headers["Authorization"] = "Basic ${encoded}";`,
      `headers['authorization'] = 'Basic ${encoded}'`,
      "const header = { Authorization: `Basic " + encoded + "` };",
      "fetch(url, { headers: { `Authorization`: `Basic " + encoded + "` } })",
    ]) {
      expect(dataClassOfText(written)).toBe("secret");
      expect(redactSecrets(written)).not.toContain(encoded);
    }
    // The word on its own, with nothing encoded after it, is still not one.
    expect(dataClassOfText(JSON.stringify({ authorization: "Basic realm" }))).toBe("internal");
  });
});

describe("the cost of reading hostile text", () => {
  /*
   * Each of these once made a shape scan its run to the end from every boundary inside it, so the cost grew with the
   * square of the length: at 64 KB, sixteen times what it was at 16 KB, which is tens of seconds. The bounded patterns
   * grow with the length alone and take a few hundred milliseconds at 64 KB, even on a loaded machine, so the bound sits
   * far from both behaviours.
   */
  const SIZE = 64 * 1024;
  // A key header repeated with no body, assembled here so no scanner reads a key block in this file.
  const KEY_HEADER = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
  const HOSTILE_UNITS = ["sk-", "key-", "a-", "a.", "a+", "a%", "1-", "+1", "SG.", "api-", KEY_HEADER];

  it.each(HOSTILE_UNITS)(
    "redacts and classifies 64 KB of %j well inside the bound",
    (unit) => {
      const text = unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
      const started = performance.now();
      redactSecrets(text);
      dataClassesOfText(text);
      expect(performance.now() - started).toBeLessThan(5000);
    },
    // Long enough that a regression fails on the assertion, with its time, rather than on the runner's timeout.
    60_000,
  );
});
