# Proposed clarkcant-web text for #326 (activity timeline)

Not applied: the task says not to edit `digitopvn/clarkcant-web`. What follows is the proposed change for whoever lands it.

## Where it goes

`clarkcant-web` is a static site. The capability list a person reads is the `<ul>` of `<li>` bullets in `index.html`
(around lines 297-300, next to "Cards that show where something stands…" and "Code, changes and files Clark shows
you…", added by #33 and #36). The Vietnamese pages under `vi/docs/` are the API, CLI, MCP and WebSocket references,
which this change does not touch: `canvas.timeline@1` adds no route, CLI command, MCP tool or WebSocket message. The
`timeline.select` binding goes through the existing `POST /conversations/{id}/widgets/{instanceId}/actions` route
with a new view operation, and `show_view` gains a definition id, not a new tool.

Suggested commit: `docs(landing): say Clark can show what happened as a timeline`, body `Addresses digitopvn/clarkcant#326.`

## English bullet (index.html), after the "Code, changes and files" bullet

```html
<li>A timeline of what happened, in Clark's own words: entries grouped by day in the timezone the timeline was made in, each with its time or "All day", a tone told by a symbol and a word as well as a colour, and who did it. Pick an entry with a tap or the keyboard and your machine keeps the choice, so the timeline opens the same way next time and Clark knows which entry you mean. It shows only what Clark stated and never claims to be live, and your machine refuses one with a time that has no timezone offset, an entry named twice, or text with a hidden character that would make it read differently from how it looks</li>
```

## Vietnamese wording (for a Vietnamese landing, if one is added)

```html
<li>Dòng thời gian của những gì đã xảy ra, bằng lời của chính Clark: các mục được nhóm theo ngày theo múi giờ của dòng thời gian, mỗi mục có giờ hoặc "Cả ngày", sắc thái được nói bằng một ký hiệu và một chữ chứ không chỉ bằng màu, và người thực hiện. Chọn một mục bằng cách chạm hoặc bằng bàn phím, máy của bạn giữ lựa chọn đó, nên lần sau dòng thời gian mở ra như cũ và Clark biết bạn đang nói đến mục nào. Nó chỉ hiện điều Clark đã nêu và không bao giờ nói mình đang cập nhật trực tiếp, còn máy của bạn từ chối một dòng thời gian có thời điểm thiếu độ lệch múi giờ, một mục bị đặt tên hai lần, hoặc chữ có ký tự ẩn khiến nó đọc khác với vẻ ngoài</li>
```

## Claims checked against the implementation

- Grouping by the timeline's timezone, written by the node when the props name none: `apps/runtime/src/view-catalog.ts`
  (`timelineView`, `timelineTimeZone`), `apps/runtime/test/activity-timeline.spec.ts`.
- Tone as symbol and word: `ActivityTimeline` in `packages/conversation-client/src/renderers.tsx`
  (`TONE_MARK`, `widgets.status.tone.*`).
- Selection kept by the node and read by voice and `inspect_ui`: `timeline.select` in
  `packages/core/src/widget-service.ts`, `apps/runtime/src/widget-semantic.ts`; E2E reload test in
  `apps/web/e2e/activity-timeline.spec.ts`.
- Never live: the timeline has no data source and shows the "As Clark stated at" provenance line.
- Refusals: `timelineProblems` in `packages/contracts/src/activity-timeline.ts`; E2E placement refusal test.
