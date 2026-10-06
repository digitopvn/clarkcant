import { describe, expect, it } from "vitest";

import {
  consentDoesNotCover,
  reachConsentFor,
  reachExpansionPlanSchema,
  reachWidening,
  type AcquisitionPlan,
  type AcquisitionReach,
  type ReachConsent,
  type ReachExpansionPlan,
} from "../src/index.ts";

const at = "2026-10-06T08:00:00.000Z";

const reach: AcquisitionReach = {
  filesystem: [{ path: "~/Documents/Forms", access: "write", purpose: "Fills the forms you keep here." }],
  networkOrigins: [{ origin: "https://api.pdf.example", purpose: "Reads form fields." }],
  dataRecipients: [{ recipient: "PDF Example", dataClasses: ["internal"], purpose: "Receives the form to read it." }],
  credentials: [{ name: "PDF_EXAMPLE_KEY", purpose: "Signs requests in." }],
  grants: [],
};

const recommended: AcquisitionPlan = {
  candidateId: "cand_pdf" as AcquisitionPlan["candidateId"],
  summary: "Install PDF tools and fill the form.",
  acquisition: { kind: "package", source: { kind: "npm", name: "@example/pdf-tools", version: "1.2.0" } },
  actions: [
    { kind: "install", summary: "Install PDF tools 1.2.0" },
    { kind: "connect", summary: "Connect your PDF Example key" },
  ],
  reach,
  trustLane: "service",
};

const alternative: AcquisitionPlan = {
  candidateId: "cand_local" as AcquisitionPlan["candidateId"],
  summary: "Use the PDF reader already on this computer, without filling fields.",
  actions: [{ kind: "enable", summary: "Enable the local PDF reader" }],
  reach: { filesystem: [{ path: "~/Documents/Forms", access: "read", purpose: "Reads the form." }], networkOrigins: [], dataRecipients: [], credentials: [], grants: [] },
  trustLane: "declarative",
};

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

describe("a reach-expansion plan", () => {
  it("offers each candidate once", () => {
    expect(reachExpansionPlanSchema.safeParse({ ...plan, alternatives: [recommended] }).success).toBe(false);
  });

  it("needs the task when it offers consent for the task", () => {
    const { taskId: _left, ...withoutTask } = plan;
    expect(reachExpansionPlanSchema.safeParse(withoutTask).success).toBe(false);
    expect(reachExpansionPlanSchema.safeParse({ ...withoutTask, consentOptions: ["once"] }).success).toBe(true);
  });

  it("needs at least one step for every option", () => {
    expect(reachExpansionPlanSchema.safeParse({ ...plan, recommended: { ...recommended, actions: [] } }).success).toBe(false);
  });

  it("names credentials and never carries their values", () => {
    const withValue = { ...plan, recommended: { ...recommended, reach: { ...reach, credentials: [{ name: "K", value: "secret", purpose: "x" }] } } };
    expect(reachExpansionPlanSchema.safeParse(withValue).success).toBe(false);
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

  it("covers the same option asking for the same reach, or less", () => {
    const standing = consent("standing");
    expect(consentDoesNotCover(standing, { planId: plan.planId, taskId: plan.taskId, option: recommended })).toBeUndefined();
    const narrower = { ...recommended, reach: { ...reach, networkOrigins: [], filesystem: [{ path: "~/Documents/Forms", access: "read" as const, purpose: "p" }] } };
    expect(consentDoesNotCover(standing, { planId: "rxp_2" as ReachExpansionPlan["planId"], option: narrower })).toBeUndefined();
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

  it("does not cover another acquisition form or a more trusted lane", () => {
    const standing = consent("standing");
    const otherVersion = { ...recommended, acquisition: { kind: "package" as const, source: { kind: "npm" as const, name: "@example/pdf-tools", version: "1.3.0" } } };
    expect(consentDoesNotCover(standing, { planId: plan.planId, option: otherVersion })).toMatch(/acquired/);
    expect(consentDoesNotCover(standing, { planId: plan.planId, option: { ...recommended, trustLane: "trusted-native" } })).toMatch(/trusted-native/);
  });

  it("keeps once to its question and task to its task", () => {
    const later = "rxp_2" as ReachExpansionPlan["planId"];
    expect(consentDoesNotCover(consent("once"), { planId: later, taskId: plan.taskId, option: recommended })).toMatch(/one question/);
    expect(consentDoesNotCover(consent("task"), { planId: later, taskId: plan.taskId, option: recommended })).toBeUndefined();
    expect(
      consentDoesNotCover(consent("task"), { planId: later, taskId: "task_2" as ReachExpansionPlan["taskId"], option: recommended }),
    ).toMatch(/another task/);
  });
});

describe("reach widening", () => {
  it("lets write access to a folder cover reading it, and not the other way round", () => {
    const write = { ...reach, networkOrigins: [], dataRecipients: [], credentials: [] };
    const read = { ...write, filesystem: [{ path: "~/Documents/Forms", access: "read" as const, purpose: "p" }] };
    expect(reachWidening(write, read)).toEqual([]);
    expect(reachWidening(read, write)).toEqual(["write ~/Documents/Forms"]);
  });

  it("ignores a reworded purpose, which changes what is said and not what is reached", () => {
    const reworded = { ...reach, networkOrigins: [{ origin: "https://api.pdf.example", purpose: "Another sentence." }] };
    expect(reachWidening(reach, reworded)).toEqual([]);
  });

  it("compares data recipients per data class and grants per capability", () => {
    const more: AcquisitionReach = {
      ...reach,
      dataRecipients: [{ recipient: "PDF Example", dataClasses: ["internal", "confidential"], purpose: "p" }],
      grants: [{ to: { kind: "node", nodeId: "node_vps" as never }, capabilityRefs: ["pdf.fill@1"], purpose: "p" }],
    };
    expect(reachWidening(reach, more)).toEqual(["let node_vps use pdf.fill@1", "send confidential data to PDF Example"]);
  });
});
