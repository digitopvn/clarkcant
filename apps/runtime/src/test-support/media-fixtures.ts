import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Fixtures for the media content policy's tests: an audio file that really plays, and a TLS certificate for a local
 * https origin.
 *
 * The certificate is made here, at run time, and never committed: a private key in the repository is a secret whether
 * or not it protects anything, and the secret scan refuses one. It is self-signed for `127.0.0.1` and `localhost`, and a
 * test trusts it explicitly (an `https.request` `ca`, or `NODE_EXTRA_CA_CERTS` for a node process); nothing installs it
 * anywhere else.
 */

/** A PCM WAV of a tone: mono, 16-bit, at the given rate. */
export function toneWav(input: { seconds: number; sampleRate?: number; frequency?: number }): Uint8Array {
  const sampleRate = input.sampleRate ?? 8_000;
  const frequency = input.frequency ?? 440;
  const samples = Math.round(input.seconds * sampleRate);
  const bytes = new Uint8Array(44 + samples * 2);
  const data = new DataView(bytes.buffer);
  const write = (at: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) bytes[at + index] = text.charCodeAt(index);
  };
  write(0, "RIFF");
  data.setUint32(4, 36 + samples * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, sampleRate, true);
  data.setUint32(28, sampleRate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  write(36, "data");
  data.setUint32(40, samples * 2, true);
  for (let index = 0; index < samples; index += 1) {
    data.setInt16(44 + index * 2, Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 8_000), true);
  }
  return bytes;
}

/* DER, by hand: the handful of ASN.1 shapes an X.509 certificate needs. */

function length(size: number): Buffer {
  if (size < 0x80) return Buffer.from([size]);
  const bytes: number[] = [];
  for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...content: Buffer[]): Buffer => tlv(0x30, ...content);
const oid = (bytes: number[]): Buffer => tlv(0x06, Buffer.from(bytes));
const utcTime = (date: Date): Buffer => {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const text = `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, "ascii"));
};

const ECDSA_WITH_SHA256 = sequence(oid([0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]));
const COMMON_NAME = [0x55, 0x04, 0x03];
const SUBJECT_ALT_NAME = [0x55, 0x1d, 0x11];
const BASIC_CONSTRAINTS = [0x55, 0x1d, 0x13];

function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

export interface LocalTlsIdentity {
  cert: string;
  key: string;
  notAfter: Date;
}

/**
 * The content octets of a minimal, positive DER INTEGER holding `bytes` read as an unsigned big-endian number.
 *
 * DER forbids a leading zero octet unless the next octet has its high bit set, and X.509 serials must be positive, so
 * leading zeros are dropped, a single zero is put back only before a high bit, and a value of zero becomes one.
 */
export function positiveDerInteger(bytes: Uint8Array): Buffer {
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start += 1;
  const magnitude = start === bytes.length ? Buffer.from([1]) : Buffer.from(bytes.subarray(start));
  return (magnitude[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), magnitude]) : magnitude;
}

/**
 * A self-signed P-256 certificate for `127.0.0.1` and `localhost`, valid from an hour ago for `days` days.
 *
 * `serialBytes` is random by default; a caller passes its own only to pin the serial.
 */
export function selfSignedCertificate(days = 7, now = new Date(), serialBytes: Uint8Array = randomBytes(16)): LocalTlsIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const serial = positiveDerInteger(serialBytes);
  const name = sequence(tlv(0x31, sequence(oid(COMMON_NAME), tlv(0x0c, Buffer.from("ClarkCant local media fixture", "utf8")))));
  const notBefore = new Date(now.getTime() - 3_600_000);
  const notAfter = new Date(now.getTime() + days * 86_400_000);
  const altNames = sequence(tlv(0x87, Buffer.from([127, 0, 0, 1])), tlv(0x82, Buffer.from("localhost", "ascii")));
  const extensions = tlv(
    0xa3,
    sequence(
      sequence(oid(SUBJECT_ALT_NAME), tlv(0x04, altNames)),
      sequence(oid(BASIC_CONSTRAINTS), tlv(0x01, Buffer.from([0xff])), tlv(0x04, sequence(tlv(0x01, Buffer.from([0xff]))))),
    ),
  );
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ECDSA_WITH_SHA256,
    name,
    sequence(utcTime(notBefore), utcTime(notAfter)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", tbs, privateKey);
  const certificate = sequence(tbs, ECDSA_WITH_SHA256, tlv(0x03, Buffer.from([0]), signature));
  return {
    cert: pem("CERTIFICATE", certificate),
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    notAfter,
  };
}

/**
 * The certificate and key for the e2e media origin, made in `dir` when absent or within a day of expiring.
 *
 * Called by the Playwright configuration as it loads, before any server starts, because the runtime node reads
 * `NODE_EXTRA_CA_CERTS` once, when it starts. The browser journey serves its origin with the same files.
 */
export function ensureLocalTls(dir: string, now = new Date()): { certPath: string; keyPath: string } {
  const certPath = join(dir, "media-origin.crt");
  const keyPath = join(dir, "media-origin.key");
  const expiryPath = join(dir, "media-origin.expires");
  const expires = existsSync(expiryPath) ? Date.parse(readFileSync(expiryPath, "utf8")) : Number.NaN;
  if (!existsSync(certPath) || !existsSync(keyPath) || !Number.isFinite(expires) || expires - now.getTime() < 86_400_000) {
    mkdirSync(dir, { recursive: true });
    const identity = selfSignedCertificate(7, now);
    writeFileSync(keyPath, identity.key, { mode: 0o600 });
    writeFileSync(certPath, identity.cert);
    writeFileSync(expiryPath, identity.notAfter.toISOString());
  }
  return { certPath, keyPath };
}
