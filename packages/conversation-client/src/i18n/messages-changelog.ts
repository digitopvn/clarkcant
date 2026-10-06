/**
 * The changelog: the card `/changelog` and Clark's `show_changelog` answer with, and the Settings section that shows
 * the same view. The labels are translated; the entries are not — they are the canonical commit descriptions the
 * release recorded, and rewording them here would be inventing them.
 *
 * Split from `messages.ts` for the same reason as the other `messages-*` files: parallel edits do not collide. Spread
 * into `MESSAGES_VI` / `MESSAGES_EN` there. Key prefixes are `changelog.` and `settings.changelog.`.
 */

export const MESSAGES_CHANGELOG_VI = {
  "changelog.title": "Có gì mới trong Clark",
  "changelog.installed.release": "Đang dùng Clark {version}, kênh {channel}",
  "changelog.installed.source": "Đang chạy Clark {version} từ mã nguồn",
  "changelog.channel.stable": "ổn định",
  "changelog.channel.beta": "beta",
  "changelog.since": "Những thay đổi sau {version}",
  "changelog.empty": "Bản này chưa ghi nhận phiên bản nào.",
  "changelog.emptySince": "Bản này không ghi nhận phiên bản nào sau {version}.",
  "changelog.release.after": "sau {version}",
  "changelog.baseline": "Lịch sử mã nguồn trước bản phát hành đầu tiên",
  "changelog.group.breaking": "Thay đổi không tương thích",
  "changelog.group.feature": "Tính năng",
  "changelog.group.fix": "Sửa lỗi",
  "changelog.group.other": "Thay đổi khác",
  "changelog.noEntries": "Không có thay đổi nào được ghi lại cho phiên bản này.",
  "changelog.omitted": "Còn {count} thay đổi nữa không liệt kê ở đây.",
  "changelog.source": "Ghi chú phát hành đầy đủ",
  "settings.changelog.heading": "Phiên bản & có gì mới",
  "settings.changelog.intro": "Ghi chú phát hành đi kèm bản này, đọc được cả khi không có mạng. Hỏi Clark “có gì mới?” hoặc gõ /changelog để xem trong hội thoại.",
  "settings.changelog.loading": "Đang đọc ghi chú phát hành…",
  "settings.changelog.failed": "Không đọc được ghi chú phát hành: {reason}",
} as const;

export const MESSAGES_CHANGELOG_EN = {
  "changelog.title": "What's new in Clark",
  "changelog.installed.release": "Clark {version}, {channel} channel",
  "changelog.installed.source": "Clark {version}, run from source",
  "changelog.channel.stable": "stable",
  "changelog.channel.beta": "beta",
  "changelog.since": "Changes after {version}",
  "changelog.empty": "This build records no release yet.",
  "changelog.emptySince": "This build records no release after {version}.",
  "changelog.release.after": "after {version}",
  "changelog.baseline": "Source history before the first published release",
  "changelog.group.breaking": "Breaking changes",
  "changelog.group.feature": "Features",
  "changelog.group.fix": "Fixes",
  "changelog.group.other": "Other changes",
  "changelog.noEntries": "No change is recorded for this version.",
  "changelog.omitted": "{count} more changes are not listed here.",
  "changelog.source": "Full release notes",
  "settings.changelog.heading": "Version & what's new",
  "settings.changelog.intro": "The release notes that came with this build, readable offline. Ask Clark \"what's new?\" or type /changelog to see them in the conversation.",
  "settings.changelog.loading": "Reading the release notes…",
  "settings.changelog.failed": "Could not read the release notes: {reason}",
} as const satisfies Record<keyof typeof MESSAGES_CHANGELOG_VI, string>;
