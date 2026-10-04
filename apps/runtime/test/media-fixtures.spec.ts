import { X509Certificate } from "node:crypto";

import { describe, expect, it } from "vitest";

import { positiveDerInteger, selfSignedCertificate } from "../src/test-support/media-fixtures.ts";

/**
 * The test certificate's serial is random, so a hand-rolled DER INTEGER once failed about one run in 512 when the
 * random bytes began with a zero. These pin the serials that random bytes reach only rarely.
 */
describe("self-signed test certificate serial", () => {
  it("encodes a minimal positive DER INTEGER", () => {
    expect(positiveDerInteger(Buffer.from([0x00, 0x12, 0x34]))).toEqual(Buffer.from([0x12, 0x34]));
    expect(positiveDerInteger(Buffer.from([0x00, 0x00, 0x80, 0x01]))).toEqual(Buffer.from([0x00, 0x80, 0x01]));
    expect(positiveDerInteger(Buffer.from([0xff, 0x01]))).toEqual(Buffer.from([0x00, 0xff, 0x01]));
    expect(positiveDerInteger(Buffer.from([0x7f, 0xff]))).toEqual(Buffer.from([0x7f, 0xff]));
    expect(positiveDerInteger(Buffer.from([0x00, 0x00]))).toEqual(Buffer.from([0x01]));
    expect(positiveDerInteger(Buffer.alloc(0))).toEqual(Buffer.from([0x01]));
  });

  const cases: Array<{ name: string; bytes: number[]; serial: string }> = [
    { name: "a leading zero before a low byte", bytes: [0x00, 0x12, ...Array(14).fill(0xab)], serial: `12${"AB".repeat(14)}` },
    { name: "a leading zero before a high byte", bytes: [0x00, 0x9c, ...Array(14).fill(0x01)], serial: `9C${"01".repeat(14)}` },
    { name: "a first byte with its high bit set", bytes: [0xf0, ...Array(15).fill(0x22)], serial: `F0${"22".repeat(15)}` },
    { name: "all zeros", bytes: Array(16).fill(0), serial: "01" },
  ];

  for (const { name, bytes, serial } of cases) {
    it(`gives OpenSSL a certificate it parses for ${name}`, () => {
      const certificate = new X509Certificate(selfSignedCertificate(7, new Date(), Buffer.from(bytes)).cert);
      expect(certificate.serialNumber.toUpperCase()).toBe(serial);
      expect(certificate.subjectAltName).toContain("localhost");
    });
  }

  it("parses with a random serial", () => {
    for (let run = 0; run < 32; run += 1) {
      expect(() => new X509Certificate(selfSignedCertificate().cert)).not.toThrow();
    }
  });
});
