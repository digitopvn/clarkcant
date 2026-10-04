import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { spokenActionRefusal, spokenActionWaiting } from "../src/application/action-speech.ts";

/**
 * What voice says after a widget action, in the person's language.
 *
 * The point is what each sentence claims: a call that may have run is never said as a failure, the inbox is named only
 * when the node recorded the question there, and the node's English sentence and its codes are never spoken.
 */

const workflow = {
  completed: false,
  stoppedAt: "save",
  steps: [
    { stepId: "fetch", kind: "invoke", status: "done" },
    { stepId: "save", kind: "invoke", status: "uncertain" },
    { stepId: "notify", kind: "invoke", status: "not-run" },
  ],
};

describe("what voice says after a widget action", () => {
  it("says a sent call's unknown outcome, not a failure, and the inbox only when it is recorded", () => {
    const recorded = spokenActionRefusal("Lưu", { code: "SERVICE_TIMED_OUT", detail: { outcome: "uncertain", recorded: true } }, "vi");
    expect(recorded).toContain("chưa rõ đã thực hiện hay chưa");
    expect(recorded).toContain("Hộp thư sẽ hỏi");
    expect(recorded).not.toContain("Không thực hiện được");
    expect(recorded).not.toContain("Chưa làm được");
    const unrecorded = spokenActionRefusal("Lưu", { code: "SERVICE_TIMED_OUT", detail: { outcome: "uncertain", recorded: false } }, "vi");
    expect(unrecorded).toContain("chưa rõ đã thực hiện hay chưa");
    expect(unrecorded).not.toContain("Hộp thư");
    const english = spokenActionRefusal("Save", { code: "SERVICE_TIMED_OUT", detail: { outcome: "uncertain", recorded: true } }, "en");
    expect(english).toBe("“Save” was sent, but whether it took effect is unknown. I did not run it again. Your inbox asks whether it did.");
  });

  it("says a workflow that stopped partway kept its steps, and an uncertain one names what stays done", () => {
    const uncertain = spokenActionRefusal("Đồng bộ", { code: "SERVICE_TIMED_OUT", detail: { outcome: "uncertain", recorded: true, workflow } }, "vi");
    expect(uncertain).toContain("“fetch” đã chạy và vẫn giữ nguyên");
    expect(uncertain).toContain("chưa rõ đã thực hiện hay chưa");
    const partial = spokenActionRefusal(
      "Đồng bộ",
      {
        code: "POLICY_REFUSED",
        detail: { outcome: "partial", workflow: { ...workflow, steps: workflow.steps.map((step) => (step.stepId === "save" ? { ...step, status: "refused" } : step)) } },
      },
      "vi",
    );
    expect(partial).toContain("chỉ làm được một phần");
    expect(partial).toContain("“fetch” đã chạy và vẫn giữ nguyên");
    expect(partial).not.toContain("Không có gì bị thay đổi");
  });

  it("says a press that never ran in the person's language, without a raw code", () => {
    for (const code of ["POLICY_REFUSED", "RATE_LIMITED", "LEDGER_UNAVAILABLE", "SOMETHING_NEW"]) {
      const vi = spokenActionRefusal("Lưu", { code }, "vi");
      expect(vi, code).toMatch(/^Chưa làm được “Lưu”\./u);
      expect(vi, code).toContain("Không có gì bị thay đổi.");
      expect(vi, code).not.toContain(code);
      expect(spokenActionRefusal("Save", { code }, "en"), code).not.toContain(code);
    }
    expect(spokenActionRefusal("Tra cứu", { code: "SERVICE_TIMED_OUT", detail: { outcome: "refused", readOnly: true } }, "vi")).toContain(
      "chỉ đọc nên không có gì bị thay đổi",
    );
  });

  it("is what the voice session says for a refused, started or waiting action", () => {
    // The voice bootstrap has no harness of its own; what is asserted is that it speaks through these sentences.
    const bootstrap = readFileSync(join(import.meta.dirname, "..", "src", "bootstrap", "voice-bootstrap.ts"), "utf8");
    const start = bootstrap.indexOf("export async function spokenWidgetAction(");
    expect(start).toBeGreaterThan(-1);
    const body = bootstrap.slice(start);
    expect(body).toContain("if (!result.ok) return { ok: false, say: spokenActionRefusal(");
    expect(body).toContain("preferredAppIntentLocale(");
    expect(body).not.toContain("result.message");
    // A started job is said as started, before the 202 an approval also answers with is read as one.
    const job = body.indexOf('spokenActionWaiting(action.label, "job", locale)');
    expect(job).toBeGreaterThan(-1);
    expect(job).toBeLessThan(body.indexOf('spokenActionWaiting(action.label, "approval", locale)'));
  });

  it("says a started or waiting action in the person's language", () => {
    expect(spokenActionWaiting("Lưu", "background", "vi")).toContain("ở nền");
    expect(spokenActionWaiting("Save", "approval", "en")).toBe("“Save” needs your approval first. I placed the approval card in the conversation.");
    // A job has started, nothing more: neither done nor waiting on a card.
    expect(spokenActionWaiting("Tạo ảnh", "job", "vi")).toBe("Đã bắt đầu “Tạo ảnh”. Widget hiện tiến độ, và cuộc trò chuyện sẽ báo khi xong.");
    expect(spokenActionWaiting("Generate", "job", "en")).toBe(
      "“Generate” has started. Its widget shows the progress, and the conversation says when it is done.",
    );
  });
});
