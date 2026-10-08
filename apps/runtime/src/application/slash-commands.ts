import {
  type AppIntentDecision,
  type ChangelogCard,
  type CommandCard,
  type FeedbackCard,
  type FeedbackKind,
  type Instant,
  type MessageBlock,
  type Principal,
  type SlashCommand,
  type TypedSlashCommand,
  THINKING_LEVELS,
} from "@clarkcant/contracts";
import { readThinkingLevel, writeRegisteredPreference } from "@clarkcant/core";
import { appendAuditEvent, getConversation, listConversations } from "@clarkcant/storage";

import { preferredAppIntentLocale } from "../app-intents.ts";
import { conversationLabel } from "../composer-suggestions.ts";
import { startBackgroundWork } from "../routes/conversations.ts";
import { type NodeServices } from "../services.ts";
import { nodeWork } from "../work-supervisor.ts";
import { CHANGELOG_FALLBACK_URL, changelogCard, readChangelog } from "./changelog.ts";
import { composeFeedback, feedbackComposeCard } from "./product-feedback.ts";

/**
 * The host's answers to the composer's slash commands.
 *
 * Each command is answered in the conversation, as an agent message: a sentence, and where there is something to look
 * at or choose, a host-owned card (`command-card`) whose buttons carry out the choice through the same capability the
 * rest of the app uses. Nothing here opens a screen of its own, and no model is asked: a command is the person telling
 * the app something, which the app can answer at once and exactly.
 */

type Locale = "vi" | "en";
type SlashServices = Pick<NodeServices, "runtime" | "conductor" | "search" | "turnControl" | "providerAuth" | "currentModel" | "feedbackGithub" | "widgetDev">;

export interface SlashCommandAnswer {
  text: string;
  card?: CommandCard | FeedbackCard | ChangelogCard;
  /** Host-owned blocks after the card, such as the approval card a report waits on when the policy asks first. */
  extraBlocks?: MessageBlock[];
  /** Present when the page has something to do as well, such as `/new` leaving for a fresh conversation. */
  appIntent?: AppIntentDecision;
}

const NOTES: Record<SlashCommand, Record<Locale, string>> = {
  new: { vi: "Mở cuộc trò chuyện mới, giữ lại cuộc này", en: "Start a new conversation and keep this one" },
  sessions: { vi: "Việc đang chạy ngầm và các cuộc trò chuyện trước", en: "Background work and earlier conversations" },
  login: { vi: "Đăng nhập vào một AI provider", en: "Sign in to an AI provider" },
  logout: { vi: "Đăng xuất khỏi một AI provider", en: "Sign out of an AI provider" },
  thinking: { vi: "Đặt mức suy nghĩ cho lượt sau", en: "Set how hard the next turn thinks" },
  background: { vi: "Chạy một yêu cầu ở chế độ nền", en: "Run a request in the background" },
  changelog: { vi: "Phiên bản này của Clark có gì mới", en: "What this version of Clark changed" },
  report: { vi: "Báo lỗi hoặc đề xuất tính năng cho ClarkCant", en: "Report a bug or request a feature for ClarkCant" },
  develop: { vi: "Phát triển widget từ một thư mục bạn chọn", en: "Develop a widget from a folder you choose" },
};

/** What the composer's picker says beside a command, in the person's language. */
export function slashCommandNote(command: SlashCommand, locale: Locale): string {
  return NOTES[command][locale];
}

export function slashCommandBlocks(answer: SlashCommandAnswer): MessageBlock[] {
  return [
    { type: "text", format: "plain", content: answer.text, streaming: false },
    ...(answer.card === undefined ? [] : [answer.card as MessageBlock]),
    ...(answer.extraBlocks ?? []),
  ];
}

export async function answerSlashCommand(
  services: SlashServices,
  principal: Principal,
  input: { conversationId: string; typed: TypedSlashCommand; at: () => Instant },
): Promise<SlashCommandAnswer> {
  const deps = { db: services.runtime.db, now: input.at };
  const principalId = services.runtime.identity.ownerPrincipalId;
  const locale = preferredAppIntentLocale(deps, principalId);
  const say = (vi: string, en: string): string => (locale === "vi" ? vi : en);
  const card = (command: SlashCommand, fields: Omit<CommandCard, "type" | "owner" | "cardId" | "command" | "updatedAt">): CommandCard => ({
    type: "command-card",
    owner: "host",
    cardId: services.conductor.newId("card"),
    command,
    updatedAt: input.at(),
    ...fields,
  });
  const { command, argument } = input.typed;

  switch (command) {
    case "new": {
      const readBack = say(
        "Đã mở cuộc trò chuyện mới. Cuộc này vẫn được giữ; mở lại bất cứ lúc nào bằng /sessions.",
        "Started a new conversation. This one is kept; reopen it any time with /sessions.",
      );
      return { text: readBack, appIntent: { kind: "intent", intent: { kind: "nav.home" }, requiresConfirmation: false, readBack } };
    }

    case "sessions":
      return sessionsAnswer(services, input.conversationId, say, card);

    case "thinking": {
      const current = readThinkingLevel(deps, principalId);
      if (argument === "") {
        const levels = [null, ...THINKING_LEVELS] as const;
        return {
          text: say(
            `Mức suy nghĩ hiện tại: ${current ?? "tự động (model dùng mức mặc định của nó)"}. Chọn mức cho các lượt sau.`,
            `Thinking level now: ${current ?? "auto (the model uses its own default)"}. Choose one for the turns that follow.`,
          ),
          card: card("thinking", {
            title: say("Mức suy nghĩ", "Thinking level"),
            detail: say(
              "Mức cao hơn nghĩ kỹ hơn nhưng chậm và tốn hơn. Model không hỗ trợ một mức sẽ dùng mức gần nhất nó có.",
              "Higher levels think harder but are slower and cost more. A model without a level uses the nearest one it has.",
            ),
            rows: levels.map((level) => ({
              rowId: level ?? "default",
              // Auto is no level at all: nothing is sent, and the model thinks at its own default.
              label: level ?? say("Tự động (mặc định của model)", "Auto (model default)"),
              ...((level ?? undefined) === current ? { current: true } : {}),
              actions:
                (level ?? undefined) === current
                  ? []
                  : [{ actionId: "choose", label: say("Chọn", "Choose"), action: { kind: "set-thinking" as const, level } }],
            })),
          }),
        };
      }
      const wanted = argument.toLowerCase();
      const level = ["auto", "default", "tự động", "tu dong", "mặc định", "mac dinh"].includes(wanted)
        ? null
        : (THINKING_LEVELS as readonly string[]).includes(wanted)
          ? (wanted as (typeof THINKING_LEVELS)[number])
          : undefined;
      if (level === undefined) {
        return {
          text: say(
            `Không có mức suy nghĩ “${argument}”. Các mức: ${THINKING_LEVELS.join(", ")}, hoặc auto để model tự dùng mức mặc định. Gõ /thinking để chọn từ danh sách.`,
            `There is no thinking level "${argument}". Levels: ${THINKING_LEVELS.join(", ")}, or auto for the model's own default. Type /thinking to choose from a list.`,
          ),
        };
      }
      const written = writeRegisteredPreference(deps, { principalId, key: "ai.thinkingLevel", value: level });
      if (!written.ok) return { text: say(`Không đổi được mức suy nghĩ: ${written.message}`, `Could not change the thinking level: ${written.message}`) };
      return {
        text:
          level === null
            ? say(
                "Đã đặt mức suy nghĩ về tự động: từ lượt sau, model dùng mức mặc định của nó.",
                "Thinking is back to auto: from the next turn, the model uses its own default.",
              )
            : say(`Đã đặt mức suy nghĩ ${level}, từ lượt sau.`, `Thinking level set to ${level} from the next turn.`),
      };
    }

    case "background": {
      if (argument === "") {
        return {
          text: say(
            "Gõ yêu cầu sau lệnh, ví dụ: /background tóm tắt các thay đổi tuần này. Việc chạy ở chế độ nền, kết quả báo lại ở đây.",
            "Type the request after the command, for example: /background summarise this week's changes. It runs in the background and reports back here.",
          ),
        };
      }
      const started = startBackgroundWork(services, principal, input.at, input.conversationId, argument);
      if ("refusal" in started) return { text: started.refusal };
      appendAuditEvent(services.runtime.db, {
        auditId: services.conductor.newId("audit"),
        principalId,
        nodeId: services.runtime.identity.nodeId,
        kind: "interaction",
        summary: "started a background request from /background",
        outcome: "done",
        ref: started.sessionId,
        at: input.at(),
      });
      return {
        text:
          started.state === "queued"
            ? say(
                `Đã xếp việc nền vào hàng chờ${started.position === undefined ? "" : ` (thứ ${started.position})`}; nó sẽ chạy khi có chỗ và báo kết quả ở đây. Xem bằng /sessions.`,
                `Queued the background request${started.position === undefined ? "" : ` (position ${started.position})`}; it runs when a slot frees and reports back here. See it with /sessions.`,
              )
            : say(
                "Đã bắt đầu việc nền; kết quả sẽ báo ở đây. Bạn cứ tiếp tục trò chuyện. Xem bằng /sessions.",
                "Started the background request; the result will be reported here. Carry on with the conversation. See it with /sessions.",
              ),
      };
    }

    case "login":
    case "logout":
      return providersAnswer(services, command, say, card);

    case "changelog":
      return changelogAnswer(services, argument, say, input.at);
    case "report":
      return reportAnswer(services, input.conversationId, argument, input.at, say);
    case "develop":
      return developAnswer(services, argument, locale, say);
  }
}

/**
 * `/develop`, `/develop <folder>` and `/develop forget`: the card the person chooses a folder to develop a widget from, or
 * takes a choice back on. Nothing starts here;
 * a press on the card starts the session through the person-only route, as the person.
 */
function developAnswer(services: SlashServices, argument: string, locale: Locale, say: Say): SlashCommandAnswer {
  if (services.widgetDev === undefined) {
    return {
      text: say(
        "Node này không chạy phiên phát triển widget, nên chưa phát triển được widget từ một thư mục ở đây.",
        "This node is not running widget dev sessions, so a widget cannot be developed from a folder here.",
      ),
    };
  }
  // `/develop forget`: the folders Clark may develop in because the person chose them, each with a way to take that back.
  // A folder is always an absolute path, so the word never names one.
  if (argument.toLowerCase() === "forget") {
    const chosen = services.widgetDev.marked().length;
    return {
      text:
        chosen === 0
          ? say("Bạn chưa chọn thư mục nào cho Clark, nên không có gì để thu hồi.", "You have not chosen any folder for Clark, so there is nothing to forget.")
          : say(
              "Đây là những thư mục Clark được phát triển vì bạn đã chọn chúng. Bấm “Thu hồi” ở thư mục nào thì Clark không tự bắt đầu phiên ở đó nữa, trừ khi nó nằm trong một thư mục khác Clark vẫn được dùng.",
              "These are the folders Clark may develop in because you chose them. Press \"Forget\" on one and Clark no longer starts sessions there on its own, unless it lies inside another folder Clark may still use.",
            ),
      card: services.widgetDev.folderCard({ locale, only: "chosen" }),
    };
  }
  return {
    text:
      argument === ""
        ? say(
            "Chọn thư mục chứa widget. Clark sẽ theo dõi nó, dựng lại mỗi lần bạn lưu và hiện widget ngay tại đây.",
            "Choose the folder that holds the widget. Clark watches it, rebuilds on every save and shows the widget right here.",
          )
        : say(
            "Bấm “Phát triển thư mục này” để Clark bắt đầu theo dõi thư mục đó, hoặc chọn một thư mục khác.",
            "Press \"Develop this folder\" to have Clark start watching it, or choose another folder.",
          ),
    card: services.widgetDev.folderCard({ ...(argument === "" ? {} : { proposed: argument }), locale }),
  };
}

/** `/changelog` and `/changelog 1.4`: the release notes embedded with this build, as the host-owned card. */
function changelogAnswer(services: SlashServices, argument: string, say: Say, at: () => Instant): SlashCommandAnswer {
  const answer = readChangelog({ since: argument });
  if (!answer.ok) {
    const typed = argument.slice(0, 60);
    return answer.code === "invalid-version"
      ? {
          text: say(
            `"${typed}" không phải số phiên bản. Thử /changelog 1.4, hoặc /changelog để xem tất cả.`,
            `"${typed}" is not a version. Try /changelog 1.4, or /changelog for everything.`,
          ),
        }
      : { text: changelogUnavailableText(answer, say) };
  }
  const { view } = answer;
  const coverage =
    view.notesCover === undefined
      ? ""
      : say(
          ` Ghi chú này dừng ở commit ${view.notesCover.commit.slice(0, 7)} (${view.notesCover.date}); bản checkout này có thể có thay đổi mới hơn chưa được liệt kê.`,
          ` These notes go up to commit ${view.notesCover.commit.slice(0, 7)} (${view.notesCover.date}); this checkout may include later changes that are not listed.`,
        );
  const installed =
    view.installed.channel === "source"
      ? say(`Bạn đang chạy Clark ${view.installed.version} từ mã nguồn.`, `You are running Clark ${view.installed.version} from source.`) + coverage
      : say(
          `Bạn đang dùng Clark ${view.installed.version}, kênh ${view.installed.channel}.`,
          `You are on Clark ${view.installed.version}, ${view.installed.channel} channel.`,
        );
  const what =
    view.since === undefined
      ? say("Đây là ghi chú phát hành đi kèm bản này.", "Here are the release notes that came with this build.")
      : view.releases.length === 0
        ? say(`Bản này không ghi nhận phiên bản nào sau ${view.since}.`, `This build records no release after ${view.since}.`)
        : say(`Đây là những gì thay đổi sau ${view.since}.`, `Here is what changed after ${view.since}.`);
  return { text: `${installed} ${what}`, card: changelogCard(view, { cardId: services.conductor.newId("card"), at: at() }) };
}

/** The kind a `/report` argument starts with, and the words after it. */
export function reportArgument(argument: string): { kind?: FeedbackKind; text: string } {
  const match = /^(bug|lỗi|loi|feature|feat|tính năng|tinh nang)(?=\s|$)\s*/iu.exec(argument.trim());
  if (match === null) return { text: argument.trim() };
  const word = (match[1] ?? "").toLowerCase();
  const kind: FeedbackKind = word === "bug" || word === "lỗi" || word === "loi" ? "bug" : "feature";
  return { kind, text: argument.trim().slice(match[0].length).trim() };
}

/**
 * `/report`: alone, or with only a kind, the Feedback Composer; with a kind and words, the report prepared through the
 * same service as every other way of reporting and shown as it would be filed. Nothing is sent: the person's Create
 * issue on that card files it. Words without a kind open the composer with them, so the person picks Bug or Feature
 * rather than Clark guessing.
 */
async function reportAnswer(
  services: SlashServices,
  conversationId: string,
  argument: string,
  at: () => Instant,
  say: Say,
): Promise<SlashCommandAnswer> {
  const { kind, text } = reportArgument(argument);
  if (kind === undefined || text === "") {
    return {
      text: say(
        "Kể Clark nghe lỗi bạn gặp hoặc tính năng bạn muốn. Bạn xem trước đúng những gì sẽ được chia sẻ trước khi tạo issue.",
        "Tell Clark about the bug you hit or the feature you want. You see exactly what will be shared before the issue is created.",
      ),
      card: feedbackComposeCard(services, {
        ...(kind === undefined ? {} : { kind }),
        ...(text === "" ? {} : { description: text }),
        source: "slash",
        at,
      }),
    };
  }
  const composed = await composeFeedback(services, {
    request: { kind, description: text.slice(0, 4000), source: "slash", includeDiagnostics: true },
    conversationId,
    at,
  });
  if (!composed.ok) return { text: composed.text };
  const [draft, ...rest] = composed.blocks;
  return { text: composed.text, card: draft as FeedbackCard, extraBlocks: rest };
}

type Say = (vi: string, en: string) => string;

/**
 * Why `/changelog` has no notes to show, what is untouched and how to recover. A missing file comes back with setup; a
 * file that is present but unreadable or off its contract is part of the checkout, so updating the checkout replaces it.
 */
export function changelogUnavailableText(answer: { message: string; missing: boolean }, say: Say): string {
  const preserved = say(
    "Không có gì bị thay đổi: hội thoại và cài đặt vẫn nguyên, Clark vẫn chạy bình thường.",
    "Nothing was changed: your conversation and settings are as they were, and Clark keeps working.",
  );
  const recover = answer.missing
    ? say(
        `Chạy lại bước cài đặt sẽ khôi phục tệp ghi chú; trong lúc đó, lịch sử thay đổi có tại ${CHANGELOG_FALLBACK_URL}.`,
        `Running setup again restores the notes file; until then, the change history is at ${CHANGELOG_FALLBACK_URL}.`,
      )
    : say(
        `Tệp ghi chú có ở đó nhưng không đọc được; cập nhật bản checkout (git pull) sẽ thay nó. Trong lúc đó, lịch sử thay đổi có tại ${CHANGELOG_FALLBACK_URL}.`,
        `The notes file is there but unreadable; updating the checkout (git pull) replaces it. Until then, the change history is at ${CHANGELOG_FALLBACK_URL}.`,
      );
  return `${say("Không đọc được ghi chú phát hành đi kèm bản này", "Could not read the release notes that came with this build")}: ${answer.message}. ${preserved} ${recover}`;
}
type CardOf = (command: SlashCommand, fields: Omit<CommandCard, "type" | "owner" | "cardId" | "command" | "updatedAt">) => CommandCard;
type Row = CommandCard["rows"][number];

const WORK_BADGE: Record<string, { vi: string; en: string; tone: NonNullable<Row["badge"]>["tone"] }> = {
  running: { vi: "đang chạy", en: "running", tone: "active" },
  queued: { vi: "đang chờ", en: "queued", tone: "neutral" },
  done: { vi: "đã xong", en: "done", tone: "success" },
  failed: { vi: "không xong", en: "failed", tone: "danger" },
  stopped: { vi: "đã dừng", en: "stopped", tone: "warning" },
  interrupted: { vi: "bị ngắt", en: "interrupted", tone: "warning" },
};

function sessionsAnswer(services: SlashServices, currentId: string, say: Say, card: CardOf): SlashCommandAnswer {
  const { db } = services.runtime;
  const untitled = say("(chưa có tiêu đề)", "(untitled)");
  const labelOf = (conversationId: string): string | undefined => {
    const conversation = getConversation(db, conversationId);
    if (conversation === undefined) return undefined;
    return conversationLabel(db, conversationId, conversation.title) || untitled;
  };
  const open = (conversationId: string): Row["actions"] =>
    conversationId === currentId
      ? []
      : [{ actionId: "open", label: say("Mở", "Open"), tone: "primary", action: { kind: "open-conversation", conversationId } }];

  const work: Row[] = nodeWork()
    .list({ includeFinished: true })
    .filter((view) => view.kind === "background")
    .slice(0, 12)
    .map((view) => {
      const badge = WORK_BADGE[view.state];
      const where = view.conversationId === undefined ? undefined : view.conversationId === currentId ? say("cuộc này", "this conversation") : labelOf(view.conversationId);
      return {
        rowId: `work:${view.workId}`,
        label: view.title || untitled,
        note: [say("Việc nền", "Background"), where, shortTime(view.startedAt)].filter((part) => part !== undefined).join(" · "),
        ...(badge === undefined ? {} : { badge: { text: say(badge.vi, badge.en), tone: badge.tone } }),
        actions: view.conversationId === undefined || where === undefined ? [] : open(view.conversationId),
      };
    });

  const answering = new Set(services.turnControl?.running() ?? []);
  const conversations: Row[] = listConversations(db, 16)
    .filter((conversationId) => conversationId !== currentId)
    .slice(0, 15)
    .flatMap((conversationId) => {
      const conversation = getConversation(db, conversationId);
      if (conversation === undefined) return [];
      return [
        {
          rowId: `conversation:${conversationId}`,
          label: conversationLabel(db, conversationId, conversation.title) || untitled,
          note: shortTime(conversation.updatedAt),
          ...(answering.has(conversationId) ? { badge: { text: say("đang trả lời", "answering"), tone: "active" as const } } : {}),
          actions: open(conversationId),
        },
      ];
    });

  const running = work.filter((row) => row.badge?.tone === "active").length + conversations.filter((row) => row.badge !== undefined).length;
  return {
    text:
      work.length + conversations.length === 0
        ? say("Chưa có việc nền hay cuộc trò chuyện nào khác.", "There is no background work or other conversation yet.")
        : say(
            `${running} việc đang chạy, ${conversations.length} cuộc trò chuyện trước. Bấm Mở để xem lại.`,
            `${running} running, ${conversations.length} earlier conversations. Press Open to look back at one.`,
          ),
    card: card("sessions", {
      title: say("Phiên làm việc", "Sessions"),
      rows: [...work, ...conversations],
      empty: say("Chưa có gì để mở lại.", "Nothing to reopen yet."),
    }),
  };
}

async function providersAnswer(services: SlashServices, command: "login" | "logout", say: Say, card: CardOf): Promise<SlashCommandAnswer> {
  const port = services.providerAuth;
  if (port === undefined) {
    return {
      text: say(
        "Node này không có pi để đăng nhập provider, nên không có gì để đăng nhập hay đăng xuất ở đây.",
        "This node has no pi runtime to sign in through, so there is nothing to sign in to or out of here.",
      ),
    };
  }
  let providers;
  try {
    providers = await port.providerAuth();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    return { text: say(`Không đọc được danh sách provider từ pi: ${reason}`, `pi could not list its providers: ${reason}`) };
  }
  const sourceNote = (source: string | undefined): string | undefined => {
    switch (source) {
      case "stored":
        return say("Đã lưu bởi pi", "Stored by pi");
      case "environment":
        return say("Khoá lấy từ môi trường (.env hoặc shell)", "Key from the environment (.env or the shell)");
      case "runtime":
        return say("Khoá được trao lúc khởi động", "Key handed over at startup");
      case "models_json":
        return say("Khoá trong models.json của pi", "Key in pi's models.json");
      default:
        return undefined;
    }
  };

  if (command === "login") {
    const rows: Row[] = providers.slice(0, 60).map((provider) => {
      const actions: Row["actions"] = [];
      if (provider.oauth !== undefined) {
        actions.push({
          actionId: "oauth",
          label: provider.oauth.subscription ? say("Đăng nhập tài khoản", "Sign in with account") : say("Đăng nhập", "Sign in"),
          tone: "primary",
          action: { kind: "provider-sign-in", providerId: provider.providerId, method: "oauth" },
        });
      }
      if (provider.apiKey) {
        actions.push({
          actionId: "api_key",
          label: say("Dùng API key", "Use an API key"),
          tone: provider.oauth === undefined ? "primary" : "neutral",
          action: { kind: "provider-sign-in", providerId: provider.providerId, method: "api_key" },
        });
      }
      const note = provider.configured ? sourceNote(provider.source) : provider.oauth?.label;
      return {
        rowId: provider.providerId,
        label: provider.name,
        ...(note === undefined ? {} : { note }),
        badge: provider.configured
          ? { text: say("đã đăng nhập", "signed in"), tone: "success" as const }
          : { text: say("chưa đăng nhập", "signed out"), tone: "neutral" as const },
        actions,
      };
    });
    const signedIn = providers.filter((provider) => provider.configured).length;
    return {
      text: say(
        `${signedIn} provider đang đăng nhập. Chọn provider để đăng nhập; trang đăng nhập hoặc ô nhập khoá hiện ngay trong thẻ.`,
        `${signedIn} providers signed in. Choose one to sign in to; its sign-in page or key field opens right in the card.`,
      ),
      card: card("login", {
        title: say("Đăng nhập AI provider", "Sign in to an AI provider"),
        detail: say(
          "Khoá và mã bạn nhập đi thẳng tới pi và không bao giờ hiện lại trong cuộc trò chuyện.",
          "Keys and codes you enter go straight to pi and never appear in the conversation.",
        ),
        rows,
        empty: say("pi không có provider nào để đăng nhập.", "pi has no providers to sign in to."),
      }),
    };
  }

  const rows: Row[] = providers
    .filter((provider) => provider.configured)
    .map((provider) => {
      const removable = provider.source === "stored";
      const note = removable
        ? sourceNote(provider.source)
        : provider.source === "environment"
          ? say("Khoá lấy từ môi trường; gỡ nó trong .env hoặc shell", "Key from the environment; remove it in .env or the shell")
          : say("Không do pi lưu, nên không gỡ được ở đây", "Not stored by pi, so it cannot be removed here");
      return {
        rowId: provider.providerId,
        label: provider.name,
        ...(note === undefined ? {} : { note }),
        badge: { text: say("đã đăng nhập", "signed in"), tone: "success" as const },
        actions: removable
          ? [{ actionId: "sign-out", label: say("Đăng xuất", "Sign out"), tone: "danger" as const, action: { kind: "provider-sign-out" as const, providerId: provider.providerId } }]
          : [],
      };
    });
  return {
    text:
      rows.length === 0
        ? say("Chưa đăng nhập provider nào. Gõ /login để đăng nhập.", "No provider is signed in. Type /login to sign in.")
        : say(`${rows.length} provider đang đăng nhập. Chọn provider để đăng xuất.`, `${rows.length} providers signed in. Choose one to sign out of.`),
    card: card("logout", {
      title: say("Đăng xuất AI provider", "Sign out of an AI provider"),
      rows,
      empty: say("Chưa đăng nhập provider nào.", "No provider is signed in."),
    }),
  };
}

/** `2026-10-05 14:03` from an instant: enough to tell conversations apart, without a locale's clock. */
function shortTime(instant: string): string {
  return instant.slice(0, 16).replace("T", " ");
}
