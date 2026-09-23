/**
 * The UI string catalog: one key per translated chrome string, both languages declared together.
 *
 * `MESSAGES_VI` is the source of truth for the key set — Vietnamese is the product's default
 * language — and `MESSAGES_EN` is checked against it with `satisfies Record<MessageKey, string>`.
 * Dropping an `en` key, or misspelling one, is a `tsc` error rather than a runtime fallback: a
 * missing translation would otherwise render as a blank label, which is worse than a build failure
 * nobody can miss.
 *
 * Only default, visible chrome belongs here — composer, timeline chrome, settings, error copy,
 * voice controls, marketplace headings. Agent output is never translated: it is the model's own
 * words, in whatever language the conversation is in, and this catalog has no opinion about it.
 */

import type { LocaleChoice } from "./locale.ts";
import { MESSAGES_INTENTS_EN, MESSAGES_INTENTS_VI } from "./messages-intents.ts";
import { MESSAGES_SETTINGS_VI, MESSAGES_SETTINGS_EN } from "./messages-settings.ts";
import { MESSAGES_SHELL_EN, MESSAGES_SHELL_VI } from "./messages-shell.ts";
import { MESSAGES_TIMELINE_EN, MESSAGES_TIMELINE_VI } from "./messages-timeline.ts";

export const MESSAGES_VI = {
  ...MESSAGES_INTENTS_VI,
  ...MESSAGES_SETTINGS_VI,
  ...MESSAGES_SHELL_VI,
  ...MESSAGES_TIMELINE_VI,
  "settings.title": "Cài đặt",
  "settings.description": "Vài tuỳ chọn. Mọi thứ khác nằm trong hội thoại.",
  "settings.done": "Xong",
  "settings.tabs.group": "Nhóm cài đặt",
  "settings.tab.experience": "Trải nghiệm",
  "settings.tab.ai": "AI & Định tuyến",
  "settings.tab.control": "Kiểm soát",
  "settings.tab.extensions": "Tiện ích",
  "settings.tab.devices": "Thiết bị & Giọng nói",
  "settings.tab.memory": "Bộ nhớ",
  "settings.tab.developer": "Nhà phát triển",
  "settings.language.heading": "Ngôn ngữ",
  "settings.language.description": "Ngôn ngữ giao diện. Áp dụng ngay, và giữ nguyên sau khi tải lại.",
  "settings.language.vi": "Tiếng Việt",
  "settings.language.en": "English",
  "control.instructions": "Chỉ dẫn",
  "composer.attach": "Đính kèm",
  "composer.input": "Nhập tin nhắn",
  "composer.placeholder": "Nhắn gì cũng được…",
  "composer.voice": "Nói bằng giọng nói",
  "composer.send": "Gửi",
  "marketplace.heading": "Thư viện Widget",
  "voice.unmute": "Bật micro",
  "voice.mute": "Tắt micro",
  "voice.expand": "Mở rộng",
  "voice.collapse": "Thu gọn",
  "voice.end": "Kết thúc",
  "composer.placeholder.1": "có cập nhật gì mới không?",
  "composer.placeholder.2": "cần làm gì hôm nay?",
  "composer.placeholder.3": "phân tích các commit gần nhất",
} as const;

export type MessageKey = keyof typeof MESSAGES_VI;

export const MESSAGES_EN = {
  ...MESSAGES_INTENTS_EN,
  ...MESSAGES_SETTINGS_EN,
  ...MESSAGES_SHELL_EN,
  ...MESSAGES_TIMELINE_EN,
  "settings.title": "Settings",
  "settings.description": "A few preferences. Everything else lives in the conversation.",
  "settings.done": "Done",
  "settings.tabs.group": "Settings group",
  "settings.tab.experience": "Experience",
  "settings.tab.ai": "AI & Routing",
  "settings.tab.control": "Control",
  "settings.tab.extensions": "Extensions",
  "settings.tab.devices": "Devices & Voice",
  "settings.tab.memory": "Memory",
  "settings.tab.developer": "Developer",
  "settings.language.heading": "Language",
  "settings.language.description": "The interface language. Applies immediately, and stays after reload.",
  "settings.language.vi": "Tiếng Việt",
  "settings.language.en": "English",
  "control.instructions": "Instructions",
  "composer.attach": "Attach",
  "composer.input": "Message input",
  "composer.placeholder": "Message anything…",
  "composer.voice": "Speak by voice",
  "composer.send": "Send",
  "marketplace.heading": "Widget Library",
  "voice.unmute": "Turn mic on",
  "voice.mute": "Turn mic off",
  "voice.expand": "Expand",
  "voice.collapse": "Collapse",
  "voice.end": "End",
  "composer.placeholder.1": "any updates?",
  "composer.placeholder.2": "what needs doing today?",
  "composer.placeholder.3": "analyze the latest commits",
} as const satisfies Record<MessageKey, string>;

export const CATALOGS: Record<LocaleChoice, Record<MessageKey, string>> = {
  vi: MESSAGES_VI,
  en: MESSAGES_EN,
};
