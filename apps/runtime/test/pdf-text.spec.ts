import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { extractPdfText } from "../src/pdf-text.ts";

/**
 * The text a PDF holds, without a dependency.
 *
 * A PDF is the one binary attachment format whose text can be recovered here, so the issue's requirement that a
 * file's content reaches the agent is met for it rather than deferred. These tests build the PDFs they read, which
 * is what makes them about the parser rather than about a fixture somebody else wrote: one uncompressed, one
 * compressed the way a real producer compresses, and one with no text at all - because "no text" and "cannot read"
 * are different answers and the caller has to be able to tell them apart.
 */

/** A PDF whose content stream is exactly `content`, optionally compressed. */
function pdfWith(content: string, options: { compress?: boolean } = {}): Uint8Array {
  const stream = options.compress
    ? deflateSync(Buffer.from(content, "latin1")).toString("latin1")
    : content;
  const filter = options.compress ? " /Filter /FlateDecode" : "";
  const body = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /Contents 4 0 R >> endobj",
    `4 0 obj << /Length ${stream.length}${filter} >>`,
    "stream",
    stream,
    "endstream",
    "endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF",
  ].join("\n");
  return new Uint8Array(Buffer.from(body, "latin1"));
}

describe("reading the text out of a PDF", () => {
  it("reads an uncompressed content stream", () => {
    const pdf = pdfWith("BT /F1 12 Tf (Xin chao PDF) Tj ET");
    const result = extractPdfText(pdf);
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.text).toContain("Xin chao PDF");
  });

  it("reads a FlateDecode content stream, which is how real producers write them", () => {
    const pdf = pdfWith("BT /F1 12 Tf (Noi dung nen) Tj ET", { compress: true });
    const result = extractPdfText(pdf);
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.text).toContain("Noi dung nen");
  });

  it("reads the strings of a TJ array, which is how a producer spaces out text", () => {
    const pdf = pdfWith("BT [(Mot) -250 (hai)] TJ ET");
    const result = extractPdfText(pdf);
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.text).toContain("Mot");
    expect(result.ok === true && result.text).toContain("hai");
  });

  it("decodes the escapes a PDF uses for parentheses and newlines", () => {
    const pdf = pdfWith("BT (dong mot \\(trong ngoac\\) \\n dong hai) Tj ET");
    const result = extractPdfText(pdf);
    expect(result.ok).toBe(true);
    // The escape is decoded rather than shown: a reader that kept the backslashes would be reading the syntax.
    expect(result.ok === true && result.text).toContain("(trong ngoac)");
  });

  it("says a PDF with no text has no text, rather than answering with an empty string", () => {
    const pdf = pdfWith("0 0 1 rg 10 10 m 20 20 l S");
    const result = extractPdfText(pdf);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/no text operators/i);
  });

  it("refuses a file that is not a PDF at all", () => {
    const result = extractPdfText(new Uint8Array(Buffer.from("just some text", "latin1")));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("%PDF-");
  });

  it("does not collect parentheses that are not painted as text", () => {
    // A comment holds a parenthesised string and no text operator, so it is not content.
    const pdf = pdfWith("% (khong phai noi dung)\nBT (that su la noi dung) Tj ET");
    const result = extractPdfText(pdf);
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.text).toContain("that su la noi dung");
    expect(result.ok === true && result.text).not.toContain("khong phai noi dung");
  });
});
