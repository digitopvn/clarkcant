import { describe, expect, it } from "vitest";

import {
  acquisitionPlanSchema,
  acquisitionReachSchema,
  consentDoesNotCover,
  reachConsentFor,
  reachConsentSchema,
  reachExpansionPlanSchema,
  reachWidening,
  type AcquisitionPlan,
  type AcquisitionReach,
  type ReachConsent,
  type ReachExpansionPlan,
} from "../src/index.ts";

const at = "2026-10-06T08:00:00.000Z";
const forms = "/home/an/Documents/Forms";

const reach: AcquisitionReach = acquisitionReachSchema.parse({
  filesystem: [{ nodeId: "node_laptop", path: forms, access: "write", purpose: "Fills the forms you keep here." }],
  networkOrigins: [{ origin: "https://api.pdf.example", purpose: "Reads form fields." }],
  dataRecipients: [
    { recipient: { kind: "origin", origin: "https://api.pdf.example" }, dataClasses: ["internal"], purpose: "Receives the form to read it." },
  ],
  credentials: [{ name: "PDF_EXAMPLE_KEY", purpose: "Signs requests in." }],
  grants: [],
});

const recommended: AcquisitionPlan = acquisitionPlanSchema.parse({
  candidateId: "cand_pdf",
  summary: "Install PDF tools and fill the form.",
  acquisition: { kind: "package", source: { kind: "npm", name: "@example/pdf-tools", version: "1.2.0" } },
  location: { nodeId: "node_laptop" },
  provides: ["pdf.fill@1"],
  actions: [
    { kind: "install", summary: "Install PDF tools 1.2.0" },
    { kind: "connect", summary: "Connect your PDF Example key" },
  ],
  reach,
  trustLane: "service",
});

const alternative: AcquisitionPlan = acquisitionPlanSchema.parse({
  candidateId: "cand_local",
  summary: "Use the PDF reader already on this computer, without filling fields.",
  provides: ["pdf.read@1"],
  actions: [{ kind: "enable", summary: "Enable the local PDF reader" }],
  reach: {
    filesystem: [{ nodeId: "node_laptop", path: forms, access: "read", purpose: "Reads the form." }],
    networkOrigins: [],
    dataRecipients: [],
    credentials: [],
    grants: [],
  },
  trustLane: "declarative",
});

const plan: ReachExpansionPlan = reachExpansionPlanSchema.parse({
  version: 1,
  planId: "rxp_1",
  goal: "Fill in the visa form",
  taskId: "task_1",
  recommended,
  alternatives: [alternative],
  consentOptions: ["once", "task", "standing"],
  createdAt: at,
});

const laterPlan = "rxp_2" as ReachExpansionPlan["planId"];

describe("a reach-expansion plan", () => {
  it("offers each candidate once", () => {
    expect(reachExpansionPlanSchema.safeParse({ ...plan, alternatives: [recommended] }).success).toBe(false);
  });

  it("needs the task when it offers consent for the task", () => {
    const { taskId: _left, ...withoutTask } = plan;
    expect(reachExpansionPlanSchema.safeParse(withoutTask).success).toBe(false);
    expect(reachExpansionPlanSchema.safeParse({ ...withoutTask, consentOptions: ["once"] }).success).toBe(true);
  });

  it("needs at least one step and at least one provided capability for every option", () => {
    expect(reachExpansionPlanSchema.safeParse({ ...plan, recommended: { ...recommended, actions: [] } }).success).toBe(false);
    expect(reachExpansionPlanSchema.safeParse({ ...plan, recommended: { ...recommended, provides: [] } }).success).toBe(false);
  });

  it("names the verifiable source of anything it installs", () => {
    const { acquisition: _left, ...sourceless } = recommended;
    const result = acquisitionPlanSchema.safeParse(sourceless);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["acquisition"]);
    expect(acquisitionPlanSchema.safeParse({ ...sourceless, actions: [{ kind: "connect", summary: "Connect" }] }).success).toBe(true);
  });

  it("names credentials and never carries their values", () => {
    const withValue = { ...plan, recommended: { ...recommended, reach: { ...reach, credentials: [{ name: "K", value: "secret", purpose: "x" }] } } };
    expect(reachExpansionPlanSchema.safeParse(withValue).success).toBe(false);
  });

  it("names folders by node and absolute normalized path", () => {
    const folder = (entry: Record<string, unknown>) =>
      acquisitionReachSchema.safeParse({ ...reach, filesystem: [{ access: "read", purpose: "p", ...entry }] }).success;
    expect(folder({ nodeId: "node_laptop", path: forms })).toBe(true);
    expect(folder({ nodeId: "node_laptop", path: "C:\\Users\\an\\Forms" })).toBe(true);
    expect(folder({ path: forms })).toBe(false);
    expect(folder({ nodeId: "node_laptop", path: "~/Documents/Forms" })).toBe(false);
    expect(folder({ nodeId: "node_laptop", path: "../../etc" })).toBe(false);
    expect(folder({ nodeId: "node_laptop", path: "/home/an/../../etc" })).toBe(false);
  });

  it("names recipients as an origin, a target in a connection, or a principal, never free text", () => {
    const recipient = (value: unknown) =>
      acquisitionReachSchema.safeParse({ ...reach, dataRecipients: [{ recipient: value, dataClasses: ["internal"], purpose: "p" }] }).success;
    expect(recipient({ kind: "origin", origin: "https://api.pdf.example" })).toBe(true);
    expect(recipient({ kind: "connection", connectionId: "conn_tg", target: "Family" })).toBe(true);
    expect(recipient({ kind: "principal", principalId: "prin_mai" })).toBe(true);
    expect(recipient("PDF Example")).toBe(false);
    expect(recipient({ kind: "origin", origin: "http://api.pdf.example" })).toBe(false);
  });
});

describe("consent", () => {
  it("is given only for an option and a scope the plan offered", () => {
    expect(reachConsentFor(plan, { candidateId: "cand_other", scope: "once", decidedAt: plan.createdAt })).toMatch(/not an option/);
    const once = reachExpansionPlanSchema.parse({ ...plan, consentOptions: ["once"] });
    expect(reachConsentFor(once, { candidateId: "cand_pdf", scope: "standing", decidedAt: plan.createdAt })).toMatch(/does not offer/);
  });

  function consent(scope: ReachConsent["scope"]): ReachConsent {
    const result = reachConsentFor(plan, { candidateId: "cand_pdf", scope, decidedAt: plan.createdAt });
    if (typeof result === "string") throw new Error(result);
    return result;
  }

  it("records the step kinds, capabilities and location it was given for, and parses", () => {
    const given = consent("task");
    expect(given.steps).toEqual(["install", "connect"]);
    expect(given.provides).toEqual(["pdf.fill@1"]);
    expect(given.location).toEqual({ nodeId: "node_laptop" });
    expect(reachConsentSchema.safeParse(given).success).toBe(true);
  });

  it("refuses a task-scoped consent that does not name its task", () => {
    const { taskId: _left, ...taskless } = consent("task");
    expect(reachConsentSchema.safeParse(taskless).success).toBe(false);
  });

  it("covers the same option asking for the same reach, or less", () => {
    const standing = consent("standing");
    expect(consentDoesNotCover(standing, { planId: plan.planId, taskId: plan.taskId, option: recommended })).toBeUndefined();
    const narrower = {
      ...recommended,
      actions: [recommended.actions[1]!],
      reach: { ...reach, networkOrigins: [], filesystem: [{ ...reach.filesystem[0]!, path: `${forms}/Visa`, access: "read" as const }] },
    };
    expect(consentDoesNotCover(standing, { planId: laterPlan, option: narrower })).toBeUndefined();
  });

  it("does not cover a request that reaches further, and says what is new", () => {
    const wider = {
      ...recommended,
      reach: { ...reach, networkOrigins: [...reach.networkOrigins, { origin: "https://upload.pdf.example", purpose: "p" }] },
    };
    expect(consentDoesNotCover(consent("standing"), { planId: plan.planId, option: wider })).toBe(
      "it now also asks to reach https://upload.pdf.example",
    );
  });

  it("does not cover a new kind of step", () => {
    const granting = { ...recommended, actions: [...recommended.actions, { kind: "grant" as const, summary: "Let the VPS use it" }] };
    expect(consentDoesNotCover(consent("standing"), { planId: plan.planId, option: granting })).toBe("it now also needs to grant");
  });

  it("does not cover a capability beyond those consented to", () => {
    const more = { ...recommended, provides: [...recommended.provides, "pdf.sign@1" as AcquisitionPlan["provides"][number]] };
    expect(consentDoesNotCover(consent("standing"), { planId: plan.planId, option: more })).toBe("it now also provides pdf.sign@1");
  });

  it("does not cover another acquisition form, another place or a more trusted lane", () => {
    const standing = consent("standing");
    const otherVersion = { ...recommended, acquisition: { kind: "package" as const, source: { kind: "npm" as const, name: "@example/pdf-tools", version: "1.3.0" } } };
    expect(consentDoesNotCover(standing, { planId: plan.planId, option: otherVersion })).toMatch(/acquired/);
    const elsewhere = { ...recommended, location: { nodeId: "node_vps" as NonNullable<AcquisitionPlan["location"]>["nodeId"] } };
    expect(consentDoesNotCover(standing, { planId: plan.planId, option: elsewhere })).toMatch(/somewhere other/);
    expect(consentDoesNotCover(standing, { planId: plan.planId, option: { ...recommended, trustLane: "trusted-native" } })).toMatch(/trusted-native/);
  });

  it("binds standing consent to what is acquired, not the id discovery gave it", () => {
    const rediscovered = { ...recommended, candidateId: "cand_pdf_again" as AcquisitionPlan["candidateId"] };
    expect(consentDoesNotCover(consent("standing"), { planId: laterPlan, option: rediscovered })).toBeUndefined();
    expect(consentDoesNotCover(consent("task"), { planId: laterPlan, taskId: plan.taskId, option: rediscovered })).toMatch(/another option/);
  });

  it("keeps a standing consent for something with only a place bound to its candidate", () => {
    const placed = reachExpansionPlanSchema.parse({
      ...plan,
      alternatives: [{ ...alternative, location: { nodeId: "node_laptop" } }],
    });
    const given = reachConsentFor(placed, { candidateId: "cand_local", scope: "standing", decidedAt: plan.createdAt });
    if (typeof given === "string") throw new Error(given);
    const neighbour = { ...placed.alternatives[0]!, candidateId: "cand_other" as AcquisitionPlan["candidateId"] };
    expect(consentDoesNotCover(given, { planId: laterPlan, option: neighbour })).toMatch(/another option/);
    expect(consentDoesNotCover(given, { planId: laterPlan, option: placed.alternatives[0]! })).toBeUndefined();
  });

  it("keeps a standing consent for something with no source or place bound to its candidate", () => {
    const local = reachConsentFor(plan, { candidateId: "cand_local", scope: "standing", decidedAt: plan.createdAt });
    if (typeof local === "string") throw new Error(local);
    const renamed = { ...alternative, candidateId: "cand_other" as AcquisitionPlan["candidateId"] };
    expect(consentDoesNotCover(local, { planId: laterPlan, option: renamed })).toMatch(/another option/);
    expect(consentDoesNotCover(local, { planId: laterPlan, option: alternative })).toBeUndefined();
  });

  it("keeps once to its question and task to its task", () => {
    expect(consentDoesNotCover(consent("once"), { planId: laterPlan, taskId: plan.taskId, option: recommended })).toMatch(/one question/);
    expect(consentDoesNotCover(consent("task"), { planId: laterPlan, taskId: plan.taskId, option: recommended })).toBeUndefined();
    expect(
      consentDoesNotCover(consent("task"), { planId: laterPlan, taskId: "task_2" as ReachExpansionPlan["taskId"], option: recommended }),
    ).toMatch(/another task/);
  });
});

describe("reach widening", () => {
  const onlyFolders = (filesystem: unknown[]): AcquisitionReach =>
    acquisitionReachSchema.parse({ filesystem, networkOrigins: [], dataRecipients: [], credentials: [], grants: [] });
  const folder = (path: string, access: "read" | "write", nodeId = "node_laptop") => ({ nodeId, path, access, purpose: "p" });

  it("lets write access to a folder cover reading it, and not the other way round", () => {
    const write = onlyFolders([folder(forms, "write")]);
    const read = onlyFolders([folder(forms, "read")]);
    expect(reachWidening(write, read)).toEqual([]);
    expect(reachWidening(read, write)).toEqual([`write ${forms} on node_laptop`]);
  });

  it("lets a folder cover the folders inside it on the same node, segment by segment", () => {
    const given = onlyFolders([folder(forms, "read")]);
    expect(reachWidening(given, onlyFolders([folder(`${forms}/Visa`, "read")]))).toEqual([]);
    expect(reachWidening(given, onlyFolders([folder(`${forms}Old`, "read")]))).toEqual([`read ${forms}Old on node_laptop`]);
    expect(reachWidening(given, onlyFolders([folder("/home/an/Documents", "read")]))).toEqual(["read /home/an/Documents on node_laptop"]);
    expect(reachWidening(given, onlyFolders([folder(forms, "read", "node_vps")]))).toEqual([`read ${forms} on node_vps`]);
  });

  it("ignores a reworded purpose, which changes what is said and not what is reached", () => {
    const reworded = { ...reach, networkOrigins: [{ origin: "https://api.pdf.example", purpose: "Another sentence." }] };
    expect(reachWidening(reach, reworded)).toEqual([]);
  });

  it("compares data recipients per recipient and data class, and grants per capability", () => {
    const more: AcquisitionReach = acquisitionReachSchema.parse({
      ...reach,
      dataRecipients: [
        { recipient: { kind: "origin", origin: "https://api.pdf.example" }, dataClasses: ["internal", "confidential"], purpose: "p" },
        { recipient: { kind: "connection", connectionId: "conn_tg", target: "Family" }, dataClasses: ["internal"], purpose: "p" },
      ],
      grants: [{ to: { kind: "node", nodeId: "node_vps" }, capabilityRefs: ["pdf.fill@1"], purpose: "p" }],
    });
    expect(reachWidening(reach, more)).toEqual([
      "let node_vps use pdf.fill@1",
      "send internal data to Family on conn_tg",
      "send confidential data to https://api.pdf.example",
    ]);
  });
});
