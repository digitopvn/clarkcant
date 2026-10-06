import { describe, expect, it } from "vitest";

import {
  DEFAULT_ALLOWED_DATA_CLASSES,
  ENFORCED_DATA_CLASSES,
  MODEL_DATA_CLASS_UNAVAILABLE,
  allowedDataClassesFor,
  checkSendBoundary,
  contractError,
  dataClassOfText,
  dataClassesOfText,
  estimateTokens,
  intersectDataClasses,
  maxDataClass,
  outboundDataClasses,
  redactSecrets,
  retryabilityOf,
  userModelProfileSchema,
} from "../src/index.ts";

/**
 * Data classes decide what context a model may be sent.
 *
 * What has to hold: the class of a text comes from its shapes alone, so the same text is always the same class; a
 * credential is `secret` and personal data `confidential`, while the everyday material of a coding conversation stays
 * `internal`; and a profile's list and trust class only ever narrow each other.
 */

/*
 * Credential fixtures are assembled from parts, so a secret scanner reading this file sees no credential: none of them
 * is real.
 */
const SK = ["sk", "live", "4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c"].join("-");
const PEM = ["-----BEGIN RSA PRIVATE", "KEY-----\nMIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MaqkW\n-----END RSA PRIVATE", "KEY-----"].join(" ");
const AWS_ID = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const GITHUB_PAT = ["github", "pat", "11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123"].join("_");
const GOOGLE_KEY = ["AIza", "SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY"].join("");
const DB_URL = ["postgres://clark", "s3cretPass@db.example.internal:5432/app"].join(":");

describe("the class of a text", () => {
  it("is secret for a credential shape", () => {
    expect(dataClassOfText(`dùng khóa ${SK}`)).toBe("secret");
    expect(dataClassOfText("Authorization: Bearer abcdefghijklmnop")).toBe("secret");
  });

  it("is confidential for an address, a phone number or a home folder", () => {
    expect(dataClassOfText("gửi cho duy@example.com")).toBe("confidential");
    expect(dataClassOfText("file ở C:\\Users\\duy\\notes.txt")).toBe("confidential");
  });

  it("is confidential for a phone number however it is written", () => {
    // Assembled here so no scanner reads a literal phone number in this file.
    const phones = [
      `+84 ${["912", "345", "678"].join("-")}`,
      `(555) ${["123", "4567"].join("-")}`,
      ["555", "123", "4567"].join("-"),
      ["0912", "345", "678"].join(" "),
      `call ${["555", "123", "4567"].join("-")} tomorrow`,
      `số ${["0912", "345", "678"].join("")}.`,
    ];
    for (const text of phones) expect(dataClassOfText(text), text).toBe("confidential");
  });

  it("is internal for a dated model id, which only looks like a run of digits", () => {
    const ids = [
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-1-20250805",
      "claude-haiku-4-5-20251001",
      "claude-3-5-sonnet-20241022",
      "gpt-4o-2024-08-06",
      "o3-2025-04-16",
      "jev-1.13.0",
    ];
    for (const id of ids) {
      expect(dataClassOfText(`switched the model to ${id}`), id).toBe("internal");
      expect(redactSecrets(`model ${id} answered`), id).toBe(`model ${id} answered`);
    }
  });

  it("is internal for everything else, including identifiers and digests", () => {
    expect(dataClassOfText("Dự án dùng SQLite.")).toBe("internal");
    expect(dataClassOfText("the key_value_store module and npm-registry-url")).toBe("internal");
    expect(dataClassOfText("commit 7048018c0ffee0ddba11deadbeef00112233445566")).toBe("internal");
  });

  it("is secret for a private key, an AWS key, GitHub and Google tokens, and a password in a URL", () => {
    expect(dataClassOfText(`khóa:\n${PEM}`)).toBe("secret");
    // A key whose footer was cut off is still a key.
    expect(dataClassOfText(PEM.slice(0, 80))).toBe("secret");
    expect(dataClassOfText(`aws_access_key_id = ${AWS_ID}`)).toBe("secret");
    expect(dataClassOfText(`AWS_SECRET_ACCESS_KEY=${"wJalrXUtnFEMI/K7MDENG/bPxRfiCY".concat("EXAMPLEKEY")}`)).toBe("secret");
    expect(dataClassOfText(`token: ${GITHUB_PAT}`)).toBe("secret");
    expect(dataClassOfText(`key=${GOOGLE_KEY}`)).toBe("secret");
    expect(dataClassOfText(`DATABASE_URL=${DB_URL}`)).toBe("secret");
  });

  it("is not secret for an obvious placeholder in a credential's place", () => {
    const placeholders = [
      'API_KEY="your_api_key"',
      'DB_PASSWORD="example"',
      'password: "changeme"',
      "Authorization: Bearer YOURTOKENHERE",
      "client_secret = 'xxxxxxxxxxxx'",
      'password: "********"',
      "api_key=INSERT_KEY",
      "token: <your-token>",
      `${["postgres://clark", "password@db"].join(":")}`,
    ];
    for (const text of placeholders) expect(dataClassOfText(text), text).toBe("internal");
  });

  it("is still secret for a real-shaped value in the same places", () => {
    const values = [
      // Assembled, so a scanner reading this file does not take a test value for a real key.
      `API_KEY="${["a8f3k29d", "k3l0qpz7"].join("")}"`,
      'DB_PASSWORD="example2024!"',
      'password: "hunter22x"',
      // No digit, but not a stand-in either.
      'password: "correcthorsebattery"',
      `Authorization: Bearer ${["abcdefgh", "ijklmnop"].join("")}`,
      `Authorization: Bearer ${["your9token", "8value7x"].join("")}`,
      `client_secret = '${["xxxxxxxx", "1xxxx"].join("")}'`,
      `${["postgres://clark", "s3cretPass@db"].join(":")}`,
    ];
    for (const text of values) expect(dataClassOfText(text), text).toBe("secret");
  });

  it("is secret for an HTTP Basic header whose user name or password is written with accents", () => {
    const basic = (pair: string): string => `Authorization: Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(pair)))}`;
    expect(dataClassOfText(basic(["admin", "mậtkhẩu123"].join(":")))).toBe("secret");
    expect(dataClassOfText(basic(["jürgen", "pässwort1"].join(":")))).toBe("secret");
    // Bytes that are not text are no user name and password.
    expect(dataClassOfText(`Authorization: Basic ${btoa(String.fromCharCode(0xff, 0xfe, 0x3a, 0x00, 0x01, 0x80))}`)).toBe("internal");
  });

  it("is secret for an HTTP Basic header and a SendGrid key", () => {
    // "aladdin:opensesame"
    expect(dataClassOfText(`Authorization: Basic ${["YWxhZGRpbjpv", "cGVuc2VzYW1l"].join("")}`)).toBe("secret");
    expect(dataClassOfText(`curl -H "authorization: basic ${["dXNlcjpzM2Ny", "ZXQ="].join("")}"`)).toBe("secret");
    const sendgrid = ["SG", "aB3dE5gH7jK9mN1pQ3sT5v", "x7Z9b1D3f5H7j9L1n3P5r7T9v1X3z5B7d9F1h3J5l7N"].join(".");
    expect(dataClassOfText(`SENDGRID=${sendgrid}`)).toBe("secret");
    expect(redactSecrets(`key ${sendgrid} end`)).toBe("key [redacted] end");
    // "Basic" as a word, a header with no credential in it, or a SendGrid-like name of the wrong length is not.
    expect(dataClassOfText("Basic information about the project")).toBe("internal");
    expect(dataClassOfText("Authorization: Basic realm")).toBe("internal");
    expect(dataClassOfText(`Authorization: Basic ${["bm90IGEgcGFp", "cg=="].join("")}`)).toBe("internal");
    expect(dataClassOfText("SG.short.value")).toBe("internal");
  });

  it("is secret for a Basic header whose either side is a real value", () => {
    const basic = (decoded: string): string => `Authorization: Basic ${btoa(decoded)}`;
    // A key sent as the user with an empty password, and a one-letter password.
    expect(dataClassOfText(basic(["k3yAsUser", "Name9x:"].join("")))).toBe("secret");
    expect(dataClassOfText(basic(["someone", "X"].join(":")))).toBe("secret");
    // Both sides placeholders, or nothing at all, is no credential.
    expect(dataClassOfText(basic(["example", "changeme"].join(":")))).toBe("internal");
    expect(dataClassOfText(basic(["", "xxxxxxxx"].join(":")))).toBe("internal");
  });

  it("takes a mask for a placeholder only when it is at least four characters long", () => {
    expect(dataClassOfText('password: "****"')).toBe("internal");
    expect(dataClassOfText(`Authorization: Basic ${btoa("  :xxxx")}`)).toBe("internal");
    expect(dataClassOfText(`Authorization: Basic ${btoa("  :xxx")}`)).toBe("secret");
  });

  it("does not take a value that only starts by addressing the reader for a placeholder", () => {
    expect(dataClassOfText('password = "YourMomsMaidenNameIsSecret"')).toBe("secret");
    expect(dataClassOfText('password = "insert_your_password_here"')).toBe("internal");
    expect(dataClassOfText('API_KEY="replace-api-key"')).toBe("internal");
  });

  it("does not read a URL's placeholder password and host as an email address", () => {
    expect(dataClassOfText(["postgres://app", "password@db.example.com/app"].join(":"))).toBe("internal");
    // An address elsewhere in the same text still is one.
    expect(dataClassOfText(`${["postgres://app", "password@db.example.com/app"].join(":")} owner duy@example.com`)).toBe(
      "confidential",
    );
  });

  it("is not secret for ordinary code", () => {
    const code = [
      "export async function api_v2_handler_migration_0012(db: Database): Promise<void> {",
      "  const token_refresh_worker_2 = createWorker({ queue: \"token_refresh\" });",
      "  const secret_store_v3 = await openStore(key_value_store);",
      "  interface Login { password: string; api_key: string | undefined }",
      "  const config = { api_key: process.env.API_KEY, password: options.password };",
      "  await fetch(\"https://registry.npmjs.org/@clarkcant/contracts\");",
      "  const npm_install_script_v2 = \"pnpm install --frozen-lockfile\";",
      "}",
    ].join("\n");
    expect(dataClassOfText(code)).toBe("internal");
    expect(dataClassOfText("sk_button_component_v2 và pk_index_users_2024")).toBe("internal");
  });

  it("is not secret for validation schemas, templated connection strings or a key header on its own", () => {
    const schema = [
      "const signUp = z.object({",
      "  email: z.string().email(),",
      "  password: z.string().min(8).max(128),",
      "  apiKey: z.string().min(32),",
      "});",
      "const change = yup.object({ newPassword: yup.string().required(), confirmPassword: yup.string().oneOf([ref('newPassword')]) });",
      "const config = { password: options.password; };",
      "const url = `postgres://${user}:${password}@${host}:5432/app`;",
      'const cache = "redis://default:${REDIS_PASSWORD}@cache:6379";',
      'const template = "amqp://guest:<password>@queue";',
      `const HEADER = "${["-----BEGIN PRIVATE", "KEY-----"].join(" ")}";`,
    ].join("\n");
    expect(dataClassOfText(schema)).toBe("internal");
    // A real value in the same places still is one.
    expect(dataClassOfText("password: hunter22x")).toBe("secret");
    expect(dataClassOfText(`url = "${["postgres://clark", "s3cretPass@db"].join(":")}"`)).toBe("secret");
  });

  it("redacts a key without running past it, and leaves code and a header on its own as they are", () => {
    const header = ["-----BEGIN PRIVATE", "KEY-----"].join(" ");
    const mention = `const HEADER = "${header}"; const next = parse(HEADER);`;
    expect(redactSecrets(mention)).toBe(mention);
    const clipped = `${PEM.slice(0, 80)}" và phần sau vẫn còn`;
    const redacted = redactSecrets(clipped);
    expect(redacted).not.toContain("MIIEowIBAAKCAQEA");
    expect(redacted).toContain("và phần sau vẫn còn");
    expect(redactSecrets("password: z.string().min(8)")).toBe("password: z.string().min(8)");
  });

  it("is the same for the same text, every time", () => {
    const text = `duy@example.com và ${SK}`;
    expect(new Set(Array.from({ length: 5 }, () => dataClassOfText(text)))).toEqual(new Set(["secret"]));
  });
});

describe("the class of JSON carried as text", () => {
  const PASSWORD_NAME = ["pass", "word"].join("");
  const API_KEY_NAME = ["api", "key"].join("_");
  const VALUE = ["hunter", "22x"].join("");

  it("is secret for a quoted credential inside a JSON string, at every level of escaping", () => {
    const note = `db ${PASSWORD_NAME}="${VALUE}"`;
    const once = JSON.stringify({ note });
    const twice = JSON.stringify({ result: once });
    const thrice = JSON.stringify([twice]);
    // The escaped quotes hide the shape from the text as written.
    expect(once).toContain('\\"');
    for (const text of [once, twice, thrice]) expect(dataClassOfText(text), text).toBe("secret");
  });

  it("is secret for a token an escape beside it hides from the text as written", () => {
    // Written as JSON, the line break becomes `\n`, and `ngithub_pat_…` is not a token's start.
    const text = JSON.stringify({ note: `token:\n${GITHUB_PAT}` });
    expect(text).toContain("\\ngithub");
    expect(dataClassOfText(text)).toBe("secret");
  });

  it("is secret for a credential field of a JSON object, nested or carried as a string", () => {
    const config = { service: "billing", auth: { [API_KEY_NAME]: VALUE, region: "ap-southeast-1" } };
    expect(dataClassOfText(JSON.stringify(config))).toBe("secret");
    expect(dataClassOfText(JSON.stringify(config, null, 2))).toBe("secret");
    expect(dataClassOfText(`Kết quả: ${JSON.stringify({ body: JSON.stringify(config) })}`)).toBe("secret");
    expect(dataClassOfText(JSON.stringify({ text: JSON.stringify({ auth: { accessToken: "x", access_token: VALUE } }) }))).toBe(
      "secret",
    );
  });

  it("is secret for a credential written across a name field and a value field", () => {
    const fields = [{ name: "user", value: "duy" }, { value: VALUE, name: PASSWORD_NAME }];
    expect(dataClassOfText(JSON.stringify({ fields }))).toBe("secret");
    expect(dataClassOfText(JSON.stringify({ body: JSON.stringify({ fields }) }))).toBe("secret");
    expect(dataClassOfText(JSON.stringify([{ key: API_KEY_NAME, value: VALUE }]))).toBe("secret");
  });

  it("reads every field that could name the value, not only the first", () => {
    expect(dataClassOfText(JSON.stringify({ id: "f1", name: PASSWORD_NAME, value: VALUE }))).toBe("secret");
    expect(dataClassOfText(JSON.stringify({ key: "db", name: PASSWORD_NAME, value: VALUE }))).toBe("secret");
    expect(dataClassOfText(JSON.stringify({ field: "login", id: API_KEY_NAME, value: VALUE }))).toBe("secret");
  });

  it("reads field names in any case, and a parameter path as a name", () => {
    // AWS SSM parameters and AWS tags write `Name`, `Key` and `Value`.
    const parameter = { Name: `/prod/db/${PASSWORD_NAME}`, Type: "SecureString", Value: VALUE };
    expect(dataClassOfText(JSON.stringify({ Parameters: [parameter] }))).toBe("secret");
    expect(dataClassOfText(JSON.stringify({ Tags: [{ Key: API_KEY_NAME, Value: VALUE }] }))).toBe("secret");
    expect(dataClassOfText(JSON.stringify({ body: JSON.stringify({ NAME: PASSWORD_NAME, VALUE }) }))).toBe("secret");
    // The same shapes naming anything else stay ordinary data.
    const ordinary = {
      Parameters: [{ Name: "/prod/db/host", Type: "String", Value: "db-01.internal.example" }],
      Tags: [{ Key: "Environment", Value: "production-2026" }, { Key: "Owner", Value: "platform-team-7" }],
    };
    expect(dataClassOfText(JSON.stringify(ordinary))).toBe("internal");
  });

  it("never makes one shape out of two neighbouring assignments", () => {
    const fields = [
      { name: "header", value: "Authorization" },
      { name: "scheme", value: ": Basic" },
      { name: "note", value: PASSWORD_NAME },
      { name: "sep", value: "=" },
      { name: "phone", value: "0901" },
      { name: "rest", value: "234567" },
    ];
    expect(dataClassOfText(JSON.stringify({ fields }))).toBe("internal");
  });

  it("does not take a whole masked display for a credential", () => {
    const masked = ["••••••••", "••••1234", "1234••••", "****abcd", `${["sk", "live"].join("-")}-…a1b2`, `${"sk"}-…abcd`];
    for (const value of masked) {
      expect(dataClassOfText(`${PASSWORD_NAME} = "${value}"`), value).toBe("internal");
      expect(dataClassOfText(JSON.stringify({ name: API_KEY_NAME, value })), value).toBe("internal");
    }
  });

  it("still takes a value that only holds a mask character for a credential", () => {
    const values = [
      `${VALUE}…`,
      ["Tr0ub4dor", "horse"].join("•"),
      ["pa", "rd-and-more"].join("••••"),
      `${["sk", "live"].join("_")}_…0c…`,
      ["ab", "cdefgh12"].join("…"),
    ];
    for (const value of values) expect(dataClassOfText(`${PASSWORD_NAME} = "${value}"`), value).toBe("secret");
    // A lone elision is no masked display either: as a URL's password, the one place a value that short is read, it is
    // still a value.
    expect(dataClassOfText(["postgres://app", "…@db.example.com/x"].join(":"))).toBe("secret");
  });

  it("keeps a credential secret beside an ellipsis or a bullet in prose and in a URL", () => {
    expect(dataClassOfText(`the db ${PASSWORD_NAME}=${VALUE}… and then it failed`)).toBe("secret");
    expect(dataClassOfText(`${PASSWORD_NAME}="${VALUE}•horse"`)).toBe("secret");
    expect(dataClassOfText(`${["postgres://app", VALUE].join(":")}…@db.example.com/x`)).toBe("secret");
  });

  it("finds a personal shape behind escaping as well", () => {
    expect(dataClassesOfText(JSON.stringify({ body: JSON.stringify({ owner: "duy@example.com" }) }))).toEqual([
      "internal",
      "confidential",
    ]);
  });

  it("is not secret for ordinary JSON, placeholders, schemas or a field that names something else", () => {
    const texts = [
      JSON.stringify({ city: "Huế", celsius: 31, note: 'he said "the password is long enough" and left' }),
      JSON.stringify({ body: JSON.stringify({ [PASSWORD_NAME]: "changeme", [API_KEY_NAME]: "your_api_key" }) }),
      JSON.stringify({ body: JSON.stringify({ [PASSWORD_NAME]: "${DB_PASSWORD}" }) }),
      JSON.stringify({ properties: { [PASSWORD_NAME]: { type: "string", minLength: 8 } } }),
      JSON.stringify({ fields: [{ name: PASSWORD_NAME, type: "password", label: "Mật khẩu" }] }),
      JSON.stringify({ fields: [{ name: PASSWORD_NAME, value: "" }, { name: PASSWORD_NAME, value: "example" }] }),
      JSON.stringify({ fields: [{ name: "reset password", value: "Submitted" }, { name: "city", value: "Huế-2026-x" }] }),
      JSON.stringify({ path: "C:\\Program Files\\node", commit: "4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4f9a8b7c" }),
      "a backslash \\ on its own, and \\u0041 written out",
    ];
    for (const text of texts) expect(dataClassOfText(text), text).toBe("internal");
  });

  it("stays linear on a large result", () => {
    // Sized so that one quadratic step over its rows, escapes or unclosed braces would take minutes, not milliseconds.
    const rows = Array.from({ length: 4_000 }, (_, index) => ({ name: `row_${String(index)}`, value: `v${String(index)}` }));
    const large = JSON.stringify({ body: JSON.stringify({ rows, note: "\\".repeat(10_000) + "{".repeat(10_000) }) });
    expect(large.length).toBeGreaterThan(200_000);
    const started = performance.now();
    expect(dataClassOfText(large)).toBe("internal");
    expect(dataClassOfText(`${large}${JSON.stringify({ name: PASSWORD_NAME, value: VALUE })}`)).toBe("secret");
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe("what a model profile may receive", () => {
  it("is everything but secret for a profile that says nothing", () => {
    expect(allowedDataClassesFor({})).toEqual(["public", "internal", "confidential"]);
    expect(DEFAULT_ALLOWED_DATA_CLASSES).not.toContain("secret");
  });

  it("follows the trust class, and a list never widens it", () => {
    expect(allowedDataClassesFor({ trustClass: "local" })).toContain("secret");
    expect(allowedDataClassesFor({ trustClass: "untrusted" })).toEqual(["public"]);
    expect(allowedDataClassesFor({ trustClass: "untrusted", allowedDataClasses: ["public", "secret"] })).toEqual(["public"]);
    expect(allowedDataClassesFor({ allowedDataClasses: ["internal", "public"] })).toEqual(["public", "internal"]);
  });

  it("is what every list permits when several profiles name one model", () => {
    expect(intersectDataClasses([["public", "internal", "confidential"], ["public", "internal"]])).toEqual(["public", "internal"]);
    expect(intersectDataClasses([])).toEqual(DEFAULT_ALLOWED_DATA_CLASSES);
  });

  it("is stored on a profile only as a known class and a bounded list", () => {
    const base = { modelProfileId: "p", alias: "a", provider: "x", modelId: "m", enabled: true, roles: ["background"], priority: 1 };
    expect(userModelProfileSchema.safeParse({ ...base, allowedDataClasses: ["public"], trustClass: "local" }).success).toBe(true);
    expect(userModelProfileSchema.safeParse({ ...base, allowedDataClasses: ["top-secret"] }).success).toBe(false);
    expect(userModelProfileSchema.safeParse({ ...base, trustClass: "friendly" }).success).toBe(false);
  });
});

describe("helpers", () => {
  it("takes the most sensitive class, and public for none", () => {
    expect(maxDataClass(["internal", "secret", "public"])).toBe("secret");
    expect(maxDataClass([])).toBe("public");
  });

  it("estimates four characters a token", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("the send boundary", () => {
  it("takes the class of every part separately, skipping empty ones, with known classes added", () => {
    expect(outboundDataClasses({ texts: ["xin chào", undefined, "  ", "gửi cho duy@example.com"] })).toEqual([
      "internal",
      "confidential",
    ]);
    expect(outboundDataClasses({ texts: [], classes: ["public"] })).toEqual(["public"]);
    expect(outboundDataClasses({})).toEqual([]);
  });

  it("finds every class one text carries, not only its most sensitive", () => {
    const both = "password: hunter22x, gửi cho duy@example.com";
    expect(dataClassesOfText(both)).toEqual(["internal", "confidential", "secret"]);
    expect(dataClassOfText(both)).toBe("secret");
    expect(dataClassesOfText("xin chào")).toEqual(["internal"]);
    expect(outboundDataClasses({ texts: [both] })).toEqual(["internal", "confidential", "secret"]);
  });

  it("lets a request go when every class it carries is allowed, and names the class that stops it when not", () => {
    expect(checkSendBoundary({ allowed: DEFAULT_ALLOWED_DATA_CLASSES, texts: ["gửi cho duy@example.com"] })).toEqual({
      ok: true,
      dataClass: "confidential",
    });
    expect(checkSendBoundary({ allowed: DEFAULT_ALLOWED_DATA_CLASSES, texts: ["xin chào", "password: hunter22x"] })).toEqual({
      ok: false,
      code: MODEL_DATA_CLASS_UNAVAILABLE,
      dataClass: "secret",
      allowed: DEFAULT_ALLOWED_DATA_CLASSES,
    });
    // Nothing to send is nothing to stop.
    expect(checkSendBoundary({ allowed: ["public"], texts: ["", undefined] }).ok).toBe(true);
  });

  it("checks each class present against an explicit list, not only the most sensitive", () => {
    // A list that names secret but not confidential does not admit a request carrying confidential data.
    const check = checkSendBoundary({ allowed: ["public", "internal", "secret"], texts: ["duy@example.com", "password: hunter22x"] });
    expect(check).toMatchObject({ ok: false, dataClass: "confidential" });
    expect(checkSendBoundary({ allowed: ["public"], classes: ["confidential"] })).toMatchObject({ ok: false, dataClass: "confidential" });
  });

  it("never refuses a send for public or internal data, which only steer routing and narrowing", () => {
    expect(ENFORCED_DATA_CLASSES).toEqual(["confidential", "secret"]);
    expect(checkSendBoundary({ allowed: ["public"], texts: ["hi"] })).toEqual({ ok: true, dataClass: "internal" });
    expect(checkSendBoundary({ allowed: [], classes: ["public", "internal"] }).ok).toBe(true);
    expect(checkSendBoundary({ allowed: ["public"], texts: ["hi", "duy@example.com"] })).toMatchObject({ ok: false, dataClass: "confidential" });
  });

  it("is a policy refusal a person can act on", () => {
    expect(retryabilityOf(MODEL_DATA_CLASS_UNAVAILABLE)).toBe("after-user-action");
    expect(contractError(MODEL_DATA_CLASS_UNAVAILABLE, "policy", "not sent")).toMatchObject({
      code: MODEL_DATA_CLASS_UNAVAILABLE,
      retryability: "after-user-action",
    });
  });
});
