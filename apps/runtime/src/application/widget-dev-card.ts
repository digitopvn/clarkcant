import { type CommandCard, type Instant, type WidgetDevSessionView } from "@clarkcant/contracts";

/**
 * The card a person chooses a folder to develop a widget from: `/develop`, Clark's answer when it was asked to develop
 * a folder it may not watch on its own, and `/develop forget`.
 *
 * Host-owned (`command-card`), built from what the node holds. A `develop-folder` button is carried out by the page
 * through the person-only `POST /widget-dev/sessions`: the card names a folder, and only the person's press starts
 * anything. A folder started that way is one the person chose, so Clark may develop in it, and in every folder inside
 * it, afterwards; the card lists those folders, each with a `develop-folder-forget` button that takes the choice back.
 */

type Locale = "vi" | "en";
type Row = CommandCard["rows"][number];

/** A folder as a row names it: the end of a path longer than a row's label holds, which is the part that tells folders apart. */
function shown(path: string, room = 300): string {
  return path.length <= room ? path : `…${path.slice(-(room - 1))}`;
}

/** How many of the node's sessions the card lists, newest first. */
const SESSIONS_LISTED = 8;
/** How many chosen folders the card lists. */
const CHOSEN_LISTED = 16;

/** The folder the card offers first: the words it was given, and the folder they resolve to on the node now. */
export interface ProposedFolder {
  /** As Clark or the command gave it. */
  given: string;
  /** Its canonical path now; absent when it does not resolve to a folder (the press then says why). */
  folder?: string;
  /** A whole drive or the home folder: a session may run there, but the choice is not kept. */
  broad?: "drive" | "home";
  /**
   * Why there is nothing to press: the path is not absolute, names a network share or device, or is not found now. The
   * row then says so instead of offering a button that could only fail, or promising access to whatever appears there later.
   */
  problem?: "relative" | "remote" | "missing";
}

export function developFolderCard(input: {
  cardId: string;
  at: Instant;
  locale: Locale;
  proposed?: ProposedFolder;
  /** The folders the person chose; one not `found` at its path now grants nothing until it is there again. */
  chosen: readonly { root: string; found: boolean }[];
  sessions: readonly WidgetDevSessionView[];
  /** `chosen`: only the folders Clark may develop in, for `/develop forget`. */
  only?: "chosen";
}): CommandCard {
  const say = (vi: string, en: string): string => (input.locale === "vi" ? vi : en);
  const rows: Row[] = [];
  const chosenRows: Row[] = input.chosen.slice(0, CHOSEN_LISTED).map(({ root, found }, index) => ({
    rowId: `chosen:${String(index)}`,
    label: shown(root),
    note: found
      ? say("Clark được phát triển trong thư mục này và mọi thư mục bên trong nó.", "Clark may develop in this folder and every folder inside it.")
      : say(
          "Hiện không tìm thấy thư mục này ở đường dẫn đó (đã bị chuyển, xoá, hoặc thay bằng một liên kết hay một thư mục khác), nên nó không cho Clark quyền gì; nếu chính thư mục này trở lại đúng chỗ này, quyền sẽ có lại, còn một thư mục khác được tạo ở đó thì không. Thu hồi để bỏ hẳn.",
          "This folder is not found at this path now (moved, removed, or replaced by a link or by another folder), so it gives Clark nothing; if this same folder comes back here, so does the access, but another folder made here does not get it. Forget it to drop it for good.",
        ),
    badge: found ? { text: say("bạn đã chọn", "you chose"), tone: "success" } : { text: say("không tìm thấy", "not found now"), tone: "warning" },
    actions: [{ actionId: "forget", label: say("Thu hồi", "Forget"), action: { kind: "develop-folder-forget", root } }],
  }));

  if (input.only === "chosen") {
    return {
      type: "command-card",
      owner: "host",
      cardId: input.cardId,
      command: "develop",
      title: say("Thư mục Clark được phát triển", "Folders Clark may develop in"),
      detail: say(
        "Những thư mục bạn đã chọn, kể cả mọi thư mục bên trong. Thu hồi một thư mục thì Clark không tự bắt đầu phiên ở đó nữa, trừ khi nó nằm trong một thư mục khác Clark vẫn được dùng; phiên đang chạy và widget của nó vẫn giữ nguyên. Không gian widget riêng của Clark không nằm trong danh sách này.",
        "The folders you chose, each including every folder inside it. Forget one and Clark no longer starts sessions there on its own, unless it lies inside another folder Clark may still use; a running session and its widget stay as they are. Clark's own widget workspace is not listed here.",
      ),
      rows: chosenRows,
      empty: say("Chưa có thư mục nào bạn đã chọn cho Clark.", "You have not chosen any folder for Clark."),
      updatedAt: input.at,
    };
  }

  const proposed = input.proposed;
  if (proposed?.problem !== undefined) {
    rows.push({
      rowId: "proposed",
      label: shown(proposed.given),
      note:
        proposed.problem === "remote"
          ? say("Đây là thư mục chia sẻ qua mạng hoặc đường dẫn thiết bị, nên không phát triển từ đó được. Hãy chọn một thư mục trên ổ đĩa của máy này.", "This is a network share or device path, which is not developed from. Choose a folder on this machine's own drives.")
          : proposed.problem === "relative"
            ? say("Đây không phải đường dẫn đầy đủ. Hãy chọn thư mục bên dưới, hoặc gõ đường dẫn đầy đủ của nó.", "This is not a full path. Choose the folder below, or type its full path.")
            : say("Hiện không tìm thấy thư mục này trên node. Hãy kiểm tra đường dẫn, hoặc chọn thư mục bên dưới.", "This folder is not found on the node now. Check the path, or choose the folder below."),
      actions: [],
    });
  } else if (proposed !== undefined) {
    const target = proposed.folder ?? proposed.given;
    const differs = proposed.folder !== undefined && proposed.folder !== proposed.given;
    const resolvedNote = differs ? say(`Đường dẫn được đưa ra là ${shown(proposed.given, 200)}; nó trỏ tới thư mục này. `, `The path given was ${shown(proposed.given, 200)}; it leads to this folder. `) : "";
    const keptNote =
      proposed.broad === "drive"
        ? say("Đây là cả một ổ đĩa: Clark chỉ theo dõi nó trong phiên này và không giữ quyền phát triển ở đó.", "This is a whole drive: Clark watches it for this session only and keeps no access to it.")
        : proposed.broad === "home"
          ? say("Đây là thư mục home của bạn: Clark chỉ theo dõi nó trong phiên này và không giữ quyền phát triển ở đó.", "This is your home folder: Clark watches it for this session only and keeps no access to it.")
          : say("Sau đó Clark cũng được phát triển trong thư mục này và mọi thư mục bên trong nó, cho tới khi bạn thu hồi.", "Afterwards Clark may also develop in this folder and every folder inside it, until you forget it.");
    rows.push({
      rowId: "proposed",
      label: shown(target),
      note: `${resolvedNote}${keptNote}`,
      actions: [
        {
          actionId: "develop",
          label: say("Phát triển thư mục này", "Develop this folder"),
          tone: "primary",
          action: { kind: "develop-folder", root: target },
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
        tone: proposed?.folder === undefined ? "primary" : "neutral",
        action: { kind: "develop-folder" },
      },
    ],
  });

  rows.push(...chosenRows);

  const offered = proposed?.folder ?? proposed?.given;
  const listed = [...input.sessions]
    .filter((session) => session.root !== offered)
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
      "Clark theo dõi thư mục bạn chọn, dựng lại widget mỗi lần bạn lưu và hiện nó ngay trong cuộc trò chuyện này. Mỗi bản dựng được cài như yêu cầu của chính bạn. Chỉ bạn chọn được thư mục; sau đó Clark cũng làm việc được trong thư mục đó và mọi thư mục bên trong, cho tới khi bạn thu hồi.",
      "Clark watches the folder you choose, rebuilds its widget on every save and shows it right here. Each build installs as your own request. Only you can choose a folder; Clark can then work in it, and in every folder inside it, until you forget it.",
    ),
    rows,
    updatedAt: input.at,
  };
}
