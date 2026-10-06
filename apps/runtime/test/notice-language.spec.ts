import { describe, expect, it } from "vitest";

import { effectCategorySchema, peerMessageKindSchema, type Instant, type PeerEnvelope } from "@clarkcant/contracts";

import { unknownEffectNotice } from "../src/effect-notices.ts";
import { hostText } from "../src/host-text.ts";
import { noticeText } from "../src/notice-text.ts";
import { packageUpdateNotice, workerSettledNotice } from "../src/notices.ts";
import { peerNoticeTurnedDownNotice } from "../src/peer-notices.ts";
import { peerOfflineNotice } from "../src/peer-outage.ts";
import { peerLostNotice, peerStuckNotice } from "../src/peer-skip.ts";
import { browserTaskApprovalText } from "../src/task-browser.ts";

/**
 * The inbox notices and approval wording this node writes for its owner follow the owner's interface language.
 *
 * Each notice is worded when it is recorded, so the language is an input here; the wiring that reads the owner's
 * `experience.language` at that moment is `ownerLocale`. Vietnamese stays the words for a caller that names none,
 * and those words are the ones the node wrote before, unchanged.
 */

const AT = "2026-10-05T04:00:00.000Z" as Instant;

/** Any letter only Vietnamese writes. */
const VIETNAMESE_LETTER = /[ăâđêôơưạảãàáậầấẩẫặằắẳẵẹẻẽèéệềếểễịỉĩìíọỏõòóộồốổỗợờớởỡụủũùúựừứửữỵỷỹỳýĐ]/iu;

function wording(notice: { title: string; body?: string | undefined } | undefined): string {
  return notice === undefined ? "" : `${notice.title}\n${notice.body ?? ""}`;
}

const worker = (language?: "vi" | "en") =>
  workerSettledNotice({
    taskId: "task_1",
    conversationId: "conv_1",
    outcome: "uncertain",
    message: "done",
    at: AT,
    ...(language === undefined ? {} : { language }),
  });

const update = (language?: "vi" | "en") =>
  packageUpdateNotice({
    packageId: "pkg.weather",
    currentVersion: "1.0.0",
    newVersion: "1.1.0",
    sourceKind: "npm",
    lane: "trusted-native",
    at: AT,
    ...(language === undefined ? {} : { language }),
  });

const outage = (situation: "unreachable" | "refused" | "erroring" | "given-up", language?: "vi" | "en") =>
  peerOfflineNotice({
    peerNodeId: "node_peer",
    label: "laptop",
    situation,
    since: AT,
    atLeast: true,
    status: 503,
    lastAcknowledgedAt: null,
    step: 1,
    at: AT,
    ...(language === undefined ? {} : { language }),
  });

const envelope: PeerEnvelope = {
  protocol: "agent.nodelink",
  version: 1,
  messageId: "msg_1",
  correlationId: "msg_1",
  senderNodeId: "node_self",
  recipientNodeId: "node_peer",
  kind: "notice",
  sentAt: AT,
  payload: {},
} as never;

const turnedDown = (code: string | undefined, language?: "vi" | "en") =>
  peerNoticeTurnedDownNotice({
    peerNodeId: "node_peer",
    label: "laptop",
    envelope,
    reason: "not today",
    ...(code === undefined ? {} : { code }),
    at: AT,
    ...(language === undefined ? {} : { language }),
  });

const unknown = (browser: boolean, language?: "vi" | "en") =>
  unknownEffectNotice({
    effects: [
      {
        taskId: "task_1",
        intent: browser ? "Submit the order — page" : "git push origin main",
        reconciliationEvidence: null,
        ...(browser ? { capabilityRef: "browser.task" } : {}),
      },
      { taskId: "task_1", intent: "git push origin dev", reconciliationEvidence: null },
    ] as never,
    task: { conversationId: "conv_1", goal: "ship it" },
    at: AT,
    ...(language === undefined ? {} : { language }),
  });

describe("an inbox notice is worded in its owner's language", () => {
  it("writes every notice with no Vietnamese in it when the owner's interface is English", () => {
    const notices = [
      worker("en"),
      update("en"),
      ...(["unreachable", "refused", "erroring", "given-up"] as const).map((situation) => outage(situation, "en")),
      ...["PEER_NOT_ALLOWED", "RATE_LIMITED", "NOTICE_UNREADABLE", "NOTICES_OFF", undefined].map((code) => turnedDown(code, "en")),
      unknown(false, "en"),
      unknown(true, "en"),
    ];
    for (const notice of notices) {
      expect(notice).toBeDefined();
      expect(wording(notice)).not.toMatch(VIETNAMESE_LETTER);
    }
    expect(worker("en").title).toBe("Background work has an unknown outcome");
    expect(update("en").body).toBe("1.0.0 → 1.1.0 · source npm · native Pi extension — runs in the same process");
    expect(outage("refused", "en").body).toContain("(code 503)");
    expect(turnedDown("RATE_LIMITED", "en").body).toMatch(/more than \d+ notices in one minute/u);
    // A reason this node does not know is still quoted as the peer's own words.
    expect(turnedDown(undefined, "en").body).toContain("“not today”");
  });

  it("keeps the Vietnamese words the node wrote before when no language is named", () => {
    expect(worker().title).toBe("Việc chạy nền chưa rõ kết quả");
    expect(update().title).toBe("Có bản cập nhật: pkg.weather");
    expect(update().body).toBe("1.0.0 → 1.1.0 · nguồn npm · extension Pi gốc — chạy cùng tiến trình");
    expect(outage("unreachable").title).toBe("Không gửi được tới thiết bị khác");
    expect(outage("unreachable").body).toMatch(/^Không gửi được tới thiết bị laptop ít nhất từ lúc .+ ngày .+: thiết bị đó không trả lời\./u);
    expect(turnedDown("RATE_LIMITED").body).toMatch(/quá \d+ thông báo trong một phút/u);
    expect(unknown(false)?.title).toBe("Chưa rõ một thao tác đã có hiệu lực hay chưa");
    expect(unknown(false)?.body).toContain("cho việc “ship it”");
  });

  it("names the same words whether the language is Vietnamese or not named at all", () => {
    expect(wording(worker("vi"))).toBe(wording(worker()));
    expect(wording(outage("given-up", "vi"))).toBe(wording(outage("given-up")));
    expect(wording(turnedDown("NOTICES_OFF", "vi"))).toBe(wording(turnedDown("NOTICES_OFF")));
    expect(wording(unknown(true, "vi"))).toBe(wording(unknown(true)));
  });
});

/** Every kind of message a skip can give up on. */
const PEER_SKIP_KINDS = peerMessageKindSchema.options.filter((kind) => kind !== "skip");

const lostAll = PEER_SKIP_KINDS.map((kind, index) => ({
  sequence: index + 1,
  messageId: `msg_${String(index)}`,
  kind,
  ...(kind === "result" ? { taskId: "task_9" } : {}),
}));

const lost = (side: "out" | "in", count: number, language?: "vi" | "en") =>
  peerLostNotice({
    side,
    peerNodeId: "node_peer",
    label: "laptop",
    through: 40,
    lost: lostAll.slice(0, count) as never,
    settled: ["task_9"],
    at: AT,
    ...(language === undefined ? {} : { language }),
  });

const stuck = (language?: "vi" | "en") =>
  peerStuckNotice({ peerNodeId: "node_peer", label: "laptop", lastAcknowledgedAt: null, at: AT, ...(language === undefined ? {} : { language }) });

describe("the notices about lost messages, a stuck pairing, expiry, GitHub watching and package jobs", () => {
  it("are written with no Vietnamese in them when the owner's interface is English", () => {
    const en = noticeText("en");
    const samples = [
      ...[1, 3, lostAll.length].flatMap((count) => [lost("out", count, "en"), lost("in", count, "en")].map(wording)),
      wording(stuck("en")),
      ...Object.values(en.expired),
      ...Object.values(en.packageJob),
      en.githubPolling.title("acme/widgets"),
      en.githubPolling.keepsFailing("acme/widgets", 3, "timeout"),
      en.githubPolling.tokenRefused("github_token", "acme/widgets", 401),
      en.githubPolling.refused("acme/widgets", 404),
    ];
    for (const sample of samples) expect(sample).not.toMatch(VIETNAMESE_LETTER);
    expect(lost("out", 1, "en").title).toBe("A message to another device was given up on");
    expect(lost("in", 3, "en").title).toBe("3 messages from another device were lost");
    // Every kind of message has its own English words, so a lost one is named rather than left as a code.
    for (const kind of PEER_SKIP_KINDS) expect(en.peerSkip.kindWords[kind], kind).not.toMatch(VIETNAMESE_LETTER);
  });

  it("keep the Vietnamese words the node wrote before when no language is named", () => {
    expect(lost("out", 1).title).toBe("Một tin gửi tới thiết bị khác đã bị bỏ");
    expect(lost("in", 3).title).toBe("3 tin từ thiết bị khác đã bị mất");
    expect(lost("out", 1).body).toMatch(/^Máy này đã bỏ một tin gửi tới thiết bị laptop vì gửi mãi không được\. /u);
    expect(stuck().title).toBe("Ghép cặp với thiết bị khác đang bị kẹt");
    const vi = noticeText();
    expect(vi.expired).toEqual({
      install: "Yêu cầu cài đặt đã hết hạn, chưa có gì được cài",
      approval: "Yêu cầu duyệt đã hết hạn, không có gì được chạy",
      question: "Câu hỏi đã hết hạn, không có ai trả lời",
    });
    expect(vi.githubPolling.title("acme/widgets")).toBe("Chưa theo dõi được acme/widgets");
    expect(wording(lost("in", 2, "vi"))).toBe(wording(lost("in", 2)));
  });
});

describe("what an approval card says a task needs", () => {
  it("words the effect, the parked reason and a browser request in English", () => {
    const en = hostText("en").approvals;
    for (const category of effectCategorySchema.options) expect(en.categoryEffect(category)).not.toMatch(VIETNAMESE_LETTER);
    expect(en.needsApproval("an action to send")).not.toMatch(VIETNAMESE_LETTER);
    expect(browserTaskApprovalText(["https://example.com"], "buy it", "en")).toBe("use the browser on example.com for “buy it”");
    expect(en.capabilityRan("failed", "pkg.cap")).toBe("Could not call pkg.cap");
  });

  it("keeps the Vietnamese words when no language is named", () => {
    const vi = hostText().approvals;
    expect(vi.needsApproval("x")).toMatch(/^Cần được duyệt trước khi thực hiện: x\. /u);
    expect(browserTaskApprovalText(["https://example.com"], "buy it")).toBe("dùng trình duyệt trên example.com cho việc “buy it”");
    expect(vi.capabilityRan("done", "pkg.cap")).toBe("Đã gọi pkg.cap");
    expect(vi.commandCard("/w")).toBe("Chạy một lệnh trong /w");
  });
});
