/**
 * Settings → AI & Routing → Provider sign-in: signing in to and out of the providers pi answers with.
 *
 * The same capability `/login` and `/logout` answer with in the conversation; the progress of a sign-in itself is
 * worded by the shared `commandCard.signIn.*` strings, so the card and the settings row say the same thing.
 */

export const MESSAGES_PROVIDERS_VI = {
  "settings.providers.heading": "Đăng nhập nhà cung cấp",
  "settings.providers.intro":
    "Các nhà cung cấp AI mà pi có thể dùng để trả lời. Đăng nhập bằng tài khoản hoặc API key; những gì bạn nhập đi thẳng tới pi và không bao giờ hiện lại. Gõ /login trong cuộc trò chuyện cũng làm được việc này.",
  "settings.providers.unavailable": "Node này không có pi để đăng nhập, nên ở đây không có nhà cung cấp nào để đăng nhập.",
  "settings.providers.readFailed": "Không đọc được danh sách nhà cung cấp từ pi. Không có gì thay đổi.",
  "settings.providers.retry": "Thử lại",
  "settings.providers.empty": "pi không có nhà cung cấp nào để đăng nhập.",
  "settings.providers.badge.signedIn": "Đã đăng nhập",
  "settings.providers.badge.signedOut": "Chưa đăng nhập",
  "settings.providers.source.stored": "Đăng nhập ở đây: pi đã lưu thông tin đăng nhập này.",
  "settings.providers.source.environment":
    "Khoá lấy từ biến môi trường của node (.env hoặc shell). Không đăng xuất được ở đây; hãy gỡ khoá ở đó.",
  "settings.providers.source.runtime": "Khoá được trao lúc node khởi động. Không đăng xuất được ở đây.",
  "settings.providers.source.models_json": "Khoá nằm trong models.json của pi. Không đăng xuất được ở đây; hãy gỡ khoá ở đó.",
  "settings.providers.source.fallback": "Khoá do pi tự tìm thấy. Không đăng xuất được ở đây.",
  "settings.providers.source.unknown": "Đã đăng nhập, nhưng pi không cho biết thông tin đăng nhập đến từ đâu, nên không đăng xuất được ở đây.",
  "settings.providers.method.account": "Đăng nhập tài khoản",
  "settings.providers.method.oauth": "Đăng nhập",
  "settings.providers.method.oauthAgain": "Đăng nhập lại",
  "settings.providers.method.apiKey": "Dùng API key",
  "settings.providers.method.apiKeyReplace": "Thay API key",
  "settings.providers.signOut": "Đăng xuất",
  "settings.providers.startFailed": "Không bắt đầu đăng nhập được: {reason}",
  "settings.providers.signOutFailed": "Đăng xuất không thành công; thông tin đăng nhập vẫn còn. {reason}",
  "settings.providers.signOutNothing": "Nhà cung cấp này đã không còn đăng nhập. Không có gì thay đổi.",
  "settings.providers.answerFailed": "pi không nhận được câu trả lời: {reason}",
} as const;

export type ProvidersMessageKey = keyof typeof MESSAGES_PROVIDERS_VI;

export const MESSAGES_PROVIDERS_EN = {
  "settings.providers.heading": "Provider sign-in",
  "settings.providers.intro":
    "The AI providers pi can answer with. Sign in with an account or an API key; what you type goes straight to pi and is never shown again. Typing /login in the conversation does the same.",
  "settings.providers.unavailable": "This node has no pi runtime to sign in through, so there are no providers to sign in to here.",
  "settings.providers.readFailed": "Couldn't read the providers from pi. Nothing changed.",
  "settings.providers.retry": "Try again",
  "settings.providers.empty": "pi has no providers to sign in to.",
  "settings.providers.badge.signedIn": "Signed in",
  "settings.providers.badge.signedOut": "Not signed in",
  "settings.providers.source.stored": "Signed in here: pi stored this credential.",
  "settings.providers.source.environment":
    "Key from the node's environment (.env or the shell). It can't be signed out here; remove the key there.",
  "settings.providers.source.runtime": "Key handed over when the node started. It can't be signed out here.",
  "settings.providers.source.models_json": "Key in pi's models.json. It can't be signed out here; remove the key there.",
  "settings.providers.source.fallback": "A key pi finds on its own. It can't be signed out here.",
  "settings.providers.source.unknown": "Signed in, but pi didn't say where the credential comes from, so it can't be signed out here.",
  "settings.providers.method.account": "Sign in with account",
  "settings.providers.method.oauth": "Sign in",
  "settings.providers.method.oauthAgain": "Sign in again",
  "settings.providers.method.apiKey": "Use an API key",
  "settings.providers.method.apiKeyReplace": "Replace API key",
  "settings.providers.signOut": "Sign out",
  "settings.providers.startFailed": "Sign-in couldn't start: {reason}",
  "settings.providers.signOutFailed": "Sign-out didn't complete; the credential is still there. {reason}",
  "settings.providers.signOutNothing": "This provider was already signed out. Nothing changed.",
  "settings.providers.answerFailed": "pi didn't take the answer: {reason}",
} as const satisfies Record<ProvidersMessageKey, string>;
