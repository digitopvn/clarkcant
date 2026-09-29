import { describe, expect, it } from "vitest";

import {
  COMPOSER_REFERENCES_MAX,
  composerReferencesSchema,
  messageBlockSchema,
  messageBlocksAsText,
  projectRelativePathSchema,
  referenceToken,
} from "../src/index.ts";

const skill = { kind: "skill", skillId: "review", source: "personal", revision: "a".repeat(64), label: "review" };
const file = { kind: "file", projectId: "proj_1", path: "src/app.ts", label: "clarkcant/src/app.ts" };

describe("the references a message carries", () => {
  it("accepts every kind in the versioned envelope", () => {
    const items = [
      skill,
      { kind: "project", projectId: "proj_1", label: "clarkcant" },
      file,
      { kind: "folder", projectId: "proj_1", path: "docs", label: "clarkcant/docs" },
      { kind: "mcp-server", serviceKey: "pkg:tools", label: "pkg:tools" },
      { kind: "conversation", conversationId: "conv_1", label: "Kế hoạch" },
      { kind: "background-work", workId: "work_1", label: "Dọn log" },
      { kind: "notice", noticeId: "ntc_1", label: "Build lỗi" },
    ];
    expect(composerReferencesSchema.safeParse({ version: 1, items }).success).toBe(true);
  });

  it("refuses another version rather than reading it as far as it can", () => {
    expect(composerReferencesSchema.safeParse({ version: 2, items: [skill] }).success).toBe(false);
  });

  it("refuses a kind it does not know and a field a kind does not have", () => {
    expect(composerReferencesSchema.safeParse({ version: 1, items: [{ kind: "url", url: "x", label: "x" }] }).success).toBe(
      false,
    );
    expect(composerReferencesSchema.safeParse({ version: 1, items: [{ ...file, absolutePath: "/etc" }] }).success).toBe(false);
  });

  it("bounds a message to a fixed number of references and a label to 120 characters", () => {
    const many = Array.from({ length: COMPOSER_REFERENCES_MAX + 1 }, (_, index) => ({ ...skill, skillId: `s${index}` }));
    expect(composerReferencesSchema.safeParse({ version: 1, items: many }).success).toBe(false);
    expect(composerReferencesSchema.safeParse({ version: 1, items: [{ ...skill, label: "x".repeat(121) }] }).success).toBe(
      false,
    );
  });
});

describe("a path inside a project", () => {
  it.each(["src/app.ts", "a", "docs/guide/intro.md", "..hidden-but-named"])("accepts %s", (path) => {
    expect(projectRelativePathSchema.safeParse(path).success).toBe(true);
  });

  it.each(["/etc/passwd", "C:/Windows", "c:relative", "src\\app.ts", "../outside", "src/../../x", "src//app", "./src", "src/"])(
    "refuses %s",
    (path) => {
      expect(projectRelativePathSchema.safeParse(path).success).toBe(false);
    },
  );
});

describe("the stored block", () => {
  it("is a message block and reads as its token in plain text", () => {
    const block = messageBlockSchema.parse({ type: "reference", reference: skill, note: "đã kiểm" });
    expect(messageBlocksAsText([block])).toBe("[reference /review]");
    expect(referenceToken(file as never)).toBe("@clarkcant/src/app.ts");
  });
});
