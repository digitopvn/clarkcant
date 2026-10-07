import { type CommandCard, type Instant, type WidgetDevSessionView } from "@clarkcant/contracts";

/**
 * The card a person chooses a folder to develop a widget from: `/develop`, and Clark's answer when it was asked to
 * develop a folder it may not watch on its own.
 *
 * Host-owned (`command-card`), built from what the node holds. Each button is a `develop-folder` action, which the page
 * carries out through the person-only `POST /widget-dev/sessions`: the card names a folder, and only the person's press
 * starts anything. A folder started that way is one the person chose, so Clark may develop in it afterwards.
 */

type Locale = "vi" | "en";
type Row = CommandCard["rows"][number];

/** A folder as a row names it: the end of a path longer than a row's label holds, which is the part that tells folders apart. */
function shown(path: string): string {
  return path.length <= 300 ? path : `…${path.slice(-299)}`;
}

/** How many of the node's sessions the card lists, newest first. */
const SESSIONS_LISTED = 8;

export function developFolderCard(input: {
  cardId: string;
  at: Instant;
  locale: Locale;
  /** The folder the card offers first: Clark's suggestion or the command's argument. */
  proposed?: string;
  sessions: readonly WidgetDevSessionView[];
}): CommandCard {
  const say = (vi: string, en: string): string => (input.locale === "vi" ? vi : en);
  const proposed = input.proposed?.trim().slice(0, 1000);
  const rows: Row[] = [];

  if (proposed !== undefined && proposed !== "") {
    rows.push({
      rowId: "proposed",
      label: shown(proposed),
      note: say("Clark sẽ theo dõi thư mục này và dựng widget của nó ở đây.", "Clark watches this folder and builds its widget here."),
      actions: [
        {
          actionId: "develop",
          label: say("Phát triển thư mục này", "Develop this folder"),
          tone: "primary",
          action: { kind: "develop-folder", root: proposed },
        },
      ],
    });
  }

  rows.push({
    rowId: "choose",
    label: say("Một thư mục khác", "Another folder"),
    note: say("Chọn thư mục chứa clarkcant.json của widget.", "Choose the folder that holds the widget's clarkcant.json."),
    actions: [
      {
        actionId: "choose",
        label: say("Chọn thư mục…", "Choose folder…"),
        tone: proposed === undefined || proposed === "" ? "primary" : "neutral",
        action: { kind: "develop-folder" },
      },
    ],
  });

  const listed = [...input.sessions]
    .filter((session) => session.root !== proposed)
    .sort((a, b) => (a.status === b.status ? (a.startedAt < b.startedAt ? 1 : -1) : a.status === "live" ? -1 : 1))
    .slice(0, SESSIONS_LISTED);
  for (const session of listed) {
    const named = session.packageId === undefined ? undefined : session.version === undefined ? session.packageId : `${session.packageId}@${session.version}`;
    rows.push({
      rowId: `session:${session.sessionId}`,
      label: shown(session.root),
      ...(named === undefined ? {} : { note: named }),
      badge:
        session.status === "live"
          ? { text: say("đang theo dõi", "watching"), tone: "active" }
          : { text: say("đã dừng", "stopped"), tone: "neutral" },
      // A live session is already watching; a stopped one is picked up again, with what it runs and was granted.
      actions:
        session.status === "live"
          ? []
          : [{ actionId: "develop", label: say("Phát triển lại", "Develop again"), action: { kind: "develop-folder", root: session.root } }],
    });
  }

  return {
    type: "command-card",
    owner: "host",
    cardId: input.cardId,
    command: "develop",
    title: say("Phát triển widget từ một thư mục", "Develop a widget from a folder"),
    detail: say(
      "Clark theo dõi thư mục bạn chọn, dựng lại widget mỗi lần bạn lưu và hiện nó ngay trong cuộc trò chuyện này. Mỗi bản dựng được cài như yêu cầu của chính bạn. Chỉ bạn chọn được thư mục; sau đó Clark cũng làm việc được trong thư mục đó.",
      "Clark watches the folder you choose, rebuilds its widget on every save and shows it right here. Each build installs as your own request. Only you can choose a folder; Clark can then work in it too.",
    ),
    rows,
    updatedAt: input.at,
  };
}
