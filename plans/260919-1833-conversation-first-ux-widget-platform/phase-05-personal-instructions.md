---
title: "Phase 5 — Personal system instructions & model routing (~8h)"
status: done
---

# Phase 5 — Personal system instructions & model routing (~8h)

### Mục tiêu

Cho user thêm personal instructions mà không phá product/tool/security system prompt.

### Files

- update: `packages/pi-adapter/src/types.ts`
- update: `packages/pi-adapter/src/real.ts`
- update: `apps/runtime/src/model-turn.ts`
- update preference reader in runtime services
- Settings AI & Routing tests

### Precedence

```text
Clark/product invariants
  → security/tool/action instructions
  → user personal instructions
  → recap/context
  → current user message
```

### Pi seam

Không prepend personal text vào user prompt và không dùng `systemPromptOverride` để thay nguyên prompt.

Pi SDK hiện có `DefaultResourceLoader.extensionFactories`, và `before_agent_start` exposes mutable structured `systemPromptOptions`; docs upstream khuyến nghị sửa `sections` / `promptGuidelines` thay vì force-replace prompt. Implement một **trusted inline control extension** trong `packages/pi-adapter`:

1. `RealPiAdapterOptions` nhận callback `personalInstructions?: () => string | undefined`.
2. ResourceLoader đăng ký named inline extension `clark-personal-instructions`.
3. Mỗi `before_agent_start` đọc callback mới nhất.
4. Thêm/xoá section riêng `clark_personal_instructions` trong structured prompt options.
5. Không log nội dung, không đưa vào extension list metadata ngoài tên control extension.
6. Fake Pi seam test assert tool snippets/context sections vẫn còn và section personal có precedence đúng.

Cách này cho phép thay đổi có hiệu lực ở **turn kế tiếp** trên SDK hiện tại mà không restart session, đồng thời giữ prompt/tool assembly của Pi. Nếu pinned SDK type thực tế khác latest docs, compatibility test phải fail và phase dừng để adapt exact typed API; không fallback sang string-prefix user prompt.

Personal instructions là app preference, không sửa `SYSTEM.md` / `APPEND_SYSTEM.md` trong agent dir.

### Semantics

- max chars + normalized whitespace;
- Enabled toggle;
- Reset;
- Preview “Clark will also receive…”;
- applies from next turn once preference write is acknowledged;
- model switch/favorites continue to use existing catalogue.

### Tests

FakePiAdapter/session fixture captures system instructions at creation; assert product instruction remains and personal text follows it.

---
