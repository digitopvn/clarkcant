import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Report only object IDs and categories, never matching credential values or source lines.
/** @type {Array<[string, RegExp]>} */
const patterns = [
  ["GitHub token", /gh[pousr]_[A-Za-z0-9]{20,}/],
  ["API key", /sk-[A-Za-z0-9]{20,}/],
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["npm token", /npm_[A-Za-z0-9]{30,}/],
];

/** Carry incomplete prefixes across pipe boundaries; callers report categories only. */
export function scanCredentialChunk(chunk, previous = "") {
  const text = previous + chunk;
  const categories = patterns.filter(([, pattern]) => pattern.test(text)).map(([category]) => category);
  const pem = text.lastIndexOf("-----BEGIN ");
  const tail = pem >= 0 && /^[A-Z ]*-{0,4}$/.test(text.slice(pem + 11))
    ? text.slice(pem)
    : text.slice(-128);
  return { categories, tail };
}

/** Scan each reachable file version once, including deleted files, docs and merge commits. */
export async function scanSecretHistory(cwd = process.cwd()) {
  const git = (args) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
  }).trim();
  if (git(["rev-parse", "--is-shallow-repository"]) !== "false") {
    throw new Error("full history required; fetch with depth 0 before scanning");
  }
  const objects = git(["rev-list", "--objects", "--all", "--no-object-names"]);
  if (!objects) throw new Error("no reachable history to scan");
  const ids = objects.split("\n");
  if (ids.some((id) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(id))) {
    throw new Error("invalid Git object list");
  }
  const child = spawn("git", ["cat-file", "--batch"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let processError;
  child.on("error", (error) => { processError = error; });
  child.stdin.on("error", (error) => { processError = error; });
  // Drain stderr without relaying potentially sensitive Git diagnostics.
  child.stderr.resume();
  const closed = new Promise((done) => child.on("close", (code) => done(code)));
  child.stdin.end(`${objects}\n`);
  const stream = child.stdout[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0);
  async function refill() {
    const next = await stream.next();
    if (next.done) throw new Error("incomplete Git object stream");
    buffer = buffer.length ? Buffer.concat([buffer, next.value]) : next.value;
  }
  const findings = [];
  let blobs = 0;
  try {
    for (const id of ids) {
      while (!buffer.includes(10)) await refill();
      const newline = buffer.indexOf(10);
      const header = buffer.subarray(0, newline).toString("ascii").split(" ");
      buffer = buffer.subarray(newline + 1);
      const size = Number(header[2]);
      if (header[0] !== id || header.length !== 3 || !Number.isSafeInteger(size) || size < 0) {
        throw new Error("invalid Git object response");
      }
      const isBlob = header[1] === "blob";
      if (isBlob) blobs += 1;
      // Carry token prefixes across pipe chunks instead of retaining full file contents.
      let tail = "";
      const categories = new Set();
      let remaining = size;
      while (remaining > 0) {
        if (!buffer.length) await refill();
        const length = Math.min(remaining, buffer.length);
        if (isBlob) {
          const scanned = scanCredentialChunk(buffer.subarray(0, length).toString("latin1"), tail);
          for (const category of scanned.categories) categories.add(category);
          tail = scanned.tail;
        }
        remaining -= length;
        buffer = buffer.subarray(length);
      }
      if (!buffer.length) await refill();
      if (buffer[0] !== 10) throw new Error("invalid Git object delimiter");
      buffer = buffer.subarray(1);
      if (categories.size) findings.push({ object: id, categories: [...categories] });
    }
    if (buffer.length || !(await stream.next()).done) throw new Error("unexpected Git object output");
    if (await closed !== 0 || processError) throw new Error("Git object scan failed");
    return { blobs, findings };
  } finally {
    if (child.exitCode === null) child.kill();
    await closed;
  }
}

async function main() {
  try {
    const result = await scanSecretHistory();
    for (const finding of result.findings) {
      console.error(`Credential pattern in blob ${finding.object}: ${finding.categories.join(", ")}`);
    }
    console.log(`Scanned ${result.blobs} reachable file versions; ${result.findings.length} flagged objects.`);
    process.exitCode = result.findings.length ? 1 : 0;
  } catch {
    console.error("Secret history scan failed: require complete Git history and a readable object database.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
