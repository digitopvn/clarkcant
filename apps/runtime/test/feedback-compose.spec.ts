import { describe, expect, it } from "vitest";

import {
  classifyPhilosophy,
  cutText,
  excerpt,
  localisePhilosophy,
  manualIssueUrl,
  neutraliseMentions,
  reportTitle,
  scrubOutbound,
} from "../src/application/feedback-compose.ts";

/**
 * The pure rules of what a product report says: how it fits the product, what its title reads, what it may carry to
 * GitHub, and how it fits in a URL. Each case here is one a person could write.
 */

const JOINER = String.fromCodePoint(0x2060);

describe("a request's fit with the product philosophy", () => {
  it.each([
    ["Widgets should show token usage per turn", "aligned"],
    ["Show the token count of each widget call", "aligned"],
    ["Let widgets read the GitHub token directly", "material-conflict"],
    ["Give extensions my API key so they can call the model", "material-conflict"],
    ["Cho tiện ích truy cập khóa API của tôi", "material-conflict"],
    ["Please remove the orb", "material-conflict"],
    ["Ẩn orb khi chụp màn hình", "material-conflict"],
    ["Tôi muốn bỏ orb đi", "material-conflict"],
    ["Show a dashboard of my tasks", "aligned-with-constraints"],
    ["Thêm thanh bên cho các phiên", "aligned-with-constraints"],
    ["Make the orb glow brighter", "aligned"],
    ["The orbit animation is slow", "aligned"],
  ])("reads %j as %s", (text, verdict) => {
    expect(classifyPhilosophy(text, undefined).verdict).toBe(verdict);
  });

  it("matches Vietnamese written in decomposed form the same as composed", () => {
    expect(classifyPhilosophy("Ẩn orb khi chụp màn hình".normalize("NFD"), undefined).verdict).toBe("material-conflict");
  });

  it("words its constraints for the card in the person's language, and keeps an unknown one as written", () => {
    const fit = classifyPhilosophy("Show a dashboard of my tasks", undefined);
    const vi = localisePhilosophy({ ...fit, constraints: [...fit.constraints, { invariant: "Something older", note: "As it was." }] }, "vi");

    expect(vi.constraints[0]?.invariant).toBe("Cuộc trò chuyện vẫn là bề mặt chính");
    expect(vi.constraints[1]).toEqual({ invariant: "Something older", note: "As it was." });
    expect(localisePhilosophy(fit, "en")).toEqual(fit);
  });
});

describe("the issue title", () => {
  it.each([
    ["Orb stops animating", "bug: orb stops animating"],
    ["API key is shown in settings", "bug: API key is shown in settings"],
    ["I can't sign in", "bug: I can't sign in"],
    ["bug: Voice cuts out", "bug: voice cuts out"],
    ["Ứng dụng treo khi mở", "bug: ứng dụng treo khi mở"],
  ])("reads %j as %j", (description, title) => {
    expect(reportTitle("bug", { description })).toBe(title);
  });
});

describe("what may leave the machine", () => {
  it("replaces the home directory whatever its case on Windows, whose paths ignore case", () => {
    const home = "C:\\Users\\Admin";

    expect(scrubOutbound("log at c:\\users\\admin\\clark\\voice.log", home, "win32")).toBe("log at ~\\clark\\voice.log");
    expect(scrubOutbound("log at C:/USERS/ADMIN/clark/voice.log", home, "win32")).toBe("log at ~/clark/voice.log");
  });

  it("keeps case where paths keep it", () => {
    // A home the shared redaction does not already recognise as a path, so only the home rule is at work.
    expect(scrubOutbound("AnnHome/notes and annhome/notes", "AnnHome", "linux")).toBe("~/notes and annhome/notes");
    expect(scrubOutbound("AnnHome/notes and annhome/notes", "AnnHome", "win32")).toBe("~/notes and ~/notes");
  });

  it("neutralises handles, and leaves e-mail addresses and code spans alone", () => {
    expect(neutraliseMentions("@octocat and (@hubot)")).toBe(`@${JOINER}octocat and (@${JOINER}hubot)`);
    expect(neutraliseMentions("ann@example.com")).toBe("ann@example.com");
    expect(neutraliseMentions("`@scope/pkg`")).toBe("`@scope/pkg`");
  });
});

describe("cutting text", () => {
  it("never ends inside a surrogate pair", () => {
    const text = "😀".repeat(10);

    expect(cutText(text, 5)).toBe("😀😀");
    expect(excerpt(`a ${"😀".repeat(200)}`, 100).endsWith("…")).toBe(true);
    expect(() => encodeURIComponent(excerpt("😀".repeat(200), 99))).not.toThrow();
  });

  it("fits a long report written in emoji into a URL GitHub accepts", () => {
    const url = manualIssueUrl("digitopvn/clarkcant", "bug: 😀", "😀".repeat(3000), ["bug"]);

    expect(url.length).toBeLessThanOrEqual(8000);
    expect(() => decodeURIComponent(url)).not.toThrow();
    expect(decodeURIComponent(url)).toContain("…");
  });

  it("encodes even a title that arrived already cut in half", () => {
    expect(() => manualIssueUrl("digitopvn/clarkcant", "bug: \uD83D", "body", ["bug"])).not.toThrow();
  });
});
