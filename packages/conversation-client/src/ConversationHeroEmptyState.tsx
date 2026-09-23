import type { CSSProperties, ReactElement, RefObject } from "react";

import type { Suggestion } from "@clarkcant/contracts";
import type { HeroPhase } from "./use-hero-orb-layout.ts";

/**
 * The four things the empty state offers.
 *
 * Four, and every one of them actually runs. The first three reach a scripted recipe over the
 * sample dataset, so they work with no provider configured; the fourth is an ordinary message and
 * needs a model to answer it. Nothing here is a label that looks like a feature — a chip that sends
 * a message nobody can handle teaches the user that the app is broken rather than that a model is
 * missing, and the fourth chip says which of those is true.
 */
export const SUGGESTIONS = [
  // `demo: true` is what makes these chips the only way a scripted sample runs: the label says the data is sample
  // data, and the flag is what the node reads to decide whether a scripted reply is allowed at all.
  { label: "Làm gì đó", text: "cho tui xem biểu đồ", detail: "chạy trên dữ liệu mẫu", demo: true },
  { label: "Sửa một lỗi", text: "tạo note nhanh cho tui", detail: "chạy trên dữ liệu mẫu", demo: true },
  { label: "Xem dự án của tui", text: "cho tui xem bảng dữ liệu", detail: "chạy trên dữ liệu mẫu", demo: true },
  { label: "Chỉ trò chuyện", text: "chào bạn, bạn làm được gì?", detail: "cần model", demo: false },
] as const;

export interface ConversationHeroEmptyStateProps {
  heroPhase: HeroPhase;
  heroOrb: RefObject<HTMLDivElement | null>;
  needsModel: boolean | undefined;
  onOpenSettings: () => void;
  dynamicSuggestions: readonly Suggestion[];
  onSend: (text: string, options?: { demo?: boolean }) => void;
}

/**
 * The start screen: an orb anchor, the setup card when there is no model, and the suggestion
 * chips — the node's own dynamic set when it has one, the four written ones otherwise.
 *
 * Stays mounted while it leaves, out of the flow, so its chips can go one at a time: unmounting it
 * with the message that replaced it would take all four with it in the same frame, which is a
 * disappearance rather than an exit.
 */
export function ConversationHeroEmptyState({
  heroPhase,
  heroOrb,
  needsModel,
  onOpenSettings,
  dynamicSuggestions,
  onSend,
}: ConversationHeroEmptyStateProps): ReactElement | null {
  if (heroPhase === "gone") return null;
  return (
    <div className="cc-empty" data-leaving={heroPhase === "leaving" ? "true" : "false"}>
      {/*
        Where the orb goes while the start screen is up. The orb itself is drawn in the layer
        behind the composer, and this is the space it is measured against — which is why it is
        reserved rather than drawn: the same element has to be able to be in two places, and
        only one of them can be a layout child.
      */}
      <div className="cc-hero-orb" ref={heroOrb} aria-hidden="true" />
      {needsModel === true ? (
        <div className="cc-card cc-setup-card" data-needs-model="true" role="status">
          <div className="cc-setting-text">
            <span className="cc-setting-label">Node này chưa có model</span>
            <span className="cc-setting-desc">
              Nó vẫn trả lời được bằng recipe và capability đã cài. Muốn hỏi tự do thì cần chọn provider và
              model trước — mở Cài đặt, tab AI &amp; Routing.
            </span>
          </div>
          {/* The control that leads there, rather than a sentence that only describes the gap. */}
          <button type="button" className="cc-chip" data-open-model-settings="true" onClick={onOpenSettings}>
            Mở Cài đặt
          </button>
        </div>
      ) : null}
      <h1>Bạn đang nghĩ gì?</h1>
      <p>Nói việc bạn muốn làm, hoặc bắt đầu từ một gợi ý dưới đây.</p>
      {/*
        Two rows, not one row with two shapes in it. What the node offers is what the person was
        actually doing, and it is only shown when there is some; the four written chips are the floor,
        and saying so in the markup is what lets a test tell an empty node from a broken one.
      */}
      {dynamicSuggestions.length > 0 ? (
        <div className="cc-chip-row" data-suggestion-count={dynamicSuggestions.length}>
          {dynamicSuggestions.map((suggestion, index) => (
            <button
              key={suggestion.suggestionId}
              type="button"
              className="cc-chip"
              data-suggestion={suggestion.text}
              data-suggestion-source={suggestion.source}
              data-suggestion-source-label={suggestion.sourceLabel}
              style={{ "--cc-chip-index": index } as CSSProperties}
              aria-label={`${suggestion.label} — ${suggestion.sourceLabel}`}
              onClick={() => onSend(suggestion.text)}
            >
              <span className="cc-chip-label">{suggestion.label}</span>
              <span className="cc-chip-detail">{suggestion.sourceLabel}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="cc-chip-row" data-suggestion-count={SUGGESTIONS.length} data-suggestion-static="true">
          {SUGGESTIONS.map((suggestion, index) => (
            <button
              key={suggestion.text}
              type="button"
              className="cc-chip"
              data-suggestion={suggestion.text}
              data-suggestion-detail={suggestion.detail}
              style={{ "--cc-chip-index": index } as CSSProperties}
              // The detail is in the accessible name as well as visible text, because a person
              // using a screen reader has the same question about which chips need a model.
              aria-label={`${suggestion.label} — ${suggestion.detail}`}
              onClick={() => onSend(suggestion.text, { demo: suggestion.demo === true })}
            >
              <span className="cc-chip-label">{suggestion.label}</span>
              <span className="cc-chip-detail">{suggestion.detail}</span>
            </button>
          ))}
        </div>
      )}
      <p className="cc-freshness">Gợi ý đánh dấu “cần model” sẽ báo lỗi nếu node này chưa cấu hình model.</p>
    </div>
  );
}
