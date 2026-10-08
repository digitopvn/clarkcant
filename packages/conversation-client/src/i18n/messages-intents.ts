/**
 * App-intent and gateway chrome strings.
 *
 * Split out of `messages.ts` because several agents translate the catalog in parallel and each
 * needs a file of its own to edit without colliding; `messages.ts` spreads this in. Everything
 * here is a notice the app-intent executor or the gateway client shows the user, never text the
 * agent itself produced.
 */

export const MESSAGES_INTENTS_VI = {
  "intents.deletionQuestion": "Policy yêu cầu xác nhận xoá",
  "intents.delete": "Xoá hội thoại",
  "intents.cancel": "Giữ hội thoại",
  "intents.deleting": "Đang xử lý…",
  "intents.confirmFailed": "Không xác nhận được lệnh. Hội thoại đang được giữ; hãy yêu cầu lại.",
  "intents.deleteUnconfirmed": "Chưa xác định được kết quả xoá. Hãy tải lại hội thoại trước khi thử lại.",
  "intents.modelSwitchFailed": "Không chuyển được model.",
  "intents.commandLookupFailed": "Không hỏi được node về lệnh đó.",
  "intents.commandWaits": "Gửi {command} được khi Clark trả lời xong. Lệnh vẫn nằm trong ô soạn tin; bấm Dừng nếu muốn kết thúc câu trả lời ngay.",
  "intents.newConversationKept": "Đã mở cuộc trò chuyện mới. Cuộc trước vẫn được giữ; mở lại bất cứ lúc nào bằng /sessions.",
  "intents.newConversationKeptReplying":
    "Đã mở cuộc trò chuyện mới. Việc rời đi không dừng câu trả lời ở cuộc trước, cuộc đó vẫn được giữ; mở lại bất cứ lúc nào bằng /sessions.",
  "intents.leftConversationKept": "Cuộc trò chuyện bạn vừa rời đi vẫn được giữ, cùng câu trả lời của nó; mở lại bất cứ lúc nào bằng /sessions.",
} as const;

export type MessageIntentsKey = keyof typeof MESSAGES_INTENTS_VI;

export const MESSAGES_INTENTS_EN = {
  "intents.deletionQuestion": "Policy asks to confirm deletion",
  "intents.delete": "Delete conversation",
  "intents.cancel": "Keep conversation",
  "intents.deleting": "Processing…",
  "intents.confirmFailed": "The command could not be confirmed. The conversation is kept; ask again.",
  "intents.deleteUnconfirmed": "The deletion result is unknown. Reload the conversation before trying again.",
  "intents.modelSwitchFailed": "Could not switch the model.",
  "intents.commandLookupFailed": "Could not ask the node about that command.",
  "intents.commandWaits": "{command} can be sent once Clark finishes this reply. It stays in the composer; press Stop to end the reply now.",
  "intents.newConversationKept": "Started a new conversation. The previous one is kept; reopen it any time with /sessions.",
  "intents.newConversationKeptReplying":
    "Started a new conversation. Leaving did not stop the reply in the previous one, which is kept; reopen it any time with /sessions.",
  "intents.leftConversationKept": "The conversation you left is kept, along with its reply; reopen it any time with /sessions.",
} as const satisfies Record<MessageIntentsKey, string>;
