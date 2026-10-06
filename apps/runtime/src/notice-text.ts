import type { AppIntentLocale, PeerSkipLost, RiskLane } from "@clarkcant/contracts";

import type { PeerNoticeRefusalCode } from "./peer-notices.ts";

/**
 * The words of the inbox notices this node writes for its owner, in the owner's interface language.
 *
 * The same rule as `host-text.ts`, kept apart because an inbox notice is a stored title and body rather than a line
 * in a conversation: it is worded when it is recorded, from the owner's `experience.language` read then, and
 * Vietnamese is the default for a caller that names no language. A notice another node sends is that node's words and
 * is never worded here, and neither is anything this node sends to a peer: that peer's owner's language is not known.
 */

/** How delivery to a paired node is failing (`peer-outage.ts`). */
export type PeerOutageSituation = "unreachable" | "refused" | "erroring" | "given-up";

export interface NoticeText {
  /** The title a notice is stored with when the one it was given is empty once cleaned. */
  untitled: string;
  /** The title of the notice a dispatched task leaves when it settles. */
  workerOutcome: Record<"succeeded" | "failed" | "cancelled" | "uncertain", string>;
  packageUpdate: {
    title: (packageId: string) => string;
    /** A risk lane's wording; a native Pi extension is never worded like an isolated widget. */
    lane: Record<RiskLane, string>;
    body: (current: string, next: string, source: string, lane: string) => string;
  };
  peerOutage: {
    title: Record<PeerOutageSituation, string>;
    /** `time` is already worded by `readableTime`; `atLeast` when this node was not watching before it. */
    since: (time: string, atLeast: boolean) => string;
    /** A moment as a person reads it: hour and minute, the day, and the zone. */
    readableTime: (time: string, day: string, zone: string) => string;
    /** The `Intl` locale the hour and the day are formatted in. */
    dateLocale: string;
    body: (situation: PeerOutageSituation, name: string, since: string, status: number | undefined) => string;
  };
  peerTurnedDown: {
    title: string;
    /** The notice that did not arrive: its title, or nothing when it cannot be read back. */
    what: (title: string | undefined) => string;
    /** Why, and what to do next, by the code the peer gave. `perMinute` is how many notices a peer takes a minute. */
    reasons: Record<PeerNoticeRefusalCode, { why: (perMinute: number) => string; next: string }>;
    /** A reason this node does not know, quoted as the peer's own words. */
    otherWhy: (reason: string) => string;
    otherNext: string;
    body: (name: string, what: string, why: string, next: string) => string;
  };
  unknownEffect: {
    title: string;
    forTask: (goal: string) => string;
    stopped: string;
    browserNoAnswer: string;
    noAnswer: string;
    others: (count: number) => string;
    uncertain: string;
    nextBrowser: string;
    nextCommand: string;
    /** What starts the body of a browser press, which is worded as a phrase rather than quoted. */
    actionPrefix: string;
  };
  /** What expired with nobody answering (`expiry-notices.ts`). The body is the request's own description or prompt. */
  expired: { install: string; approval: string; question: string };
  /** A package job's result (`bootstrap/work-bootstrap.ts`); the body is the job's own note. */
  packageJob: Record<"completed" | "cancelled" | "other", string>;
  /**
   * How a package job ended (`job-host.ts`): the note in its conversation, which is also its notice's body, so the two
   * read in one language. `names` are the results already quoted; `more` is how many were left unnamed.
   */
  packageJobEnded: {
    completed: (ref: string) => string;
    produced: (ref: string, names: string, more: number, count: number) => string;
    notSent: (ref: string) => string;
    stopped: (ref: string) => string;
    failed: (ref: string) => string;
    interrupted: (ref: string) => string;
  };
  /** A watched GitHub repository this node cannot read (`github-polling.ts`). */
  githubPolling: {
    title: (repository: string) => string;
    keepsFailing: (repository: string, failures: number, reason: string) => string;
    tokenRefused: (secretName: string, repository: string, status: number) => string;
    refused: (repository: string, status: number) => string;
  };
  /** Messages between paired nodes that were given up on, and a pairing stuck on one (`peer-skip.ts`). */
  peerSkip: {
    /** Each kind of message, in words the owner reads. */
    kindWords: Record<PeerSkipLost["kind"], string>;
    /** The task a lost message was about, after its kind. */
    forTask: (taskId: string) => string;
    howMany: (count: number) => string;
    andMore: (rest: number) => string;
    settledOut: string;
    resultUncertainThere: string;
    settledIn: string;
    notResent: string;
    nothingToSettle: string;
    /** What starts an `out` notice; the list of what was given up on follows it. */
    guidanceOut: (name: string, count: number, consequences: string) => string;
    /** What starts an `in` notice; the list of what was lost follows it. */
    guidanceIn: (name: string, count: number, consequences: string) => string;
    titleOut: (count: number) => string;
    titleIn: (count: number) => string;
    stuckTitle: string;
    stuckBody: (name: string) => string;
  };
}

const VI: NoticeText = {
  untitled: "(không có tiêu đề)",
  workerOutcome: {
    succeeded: "Việc chạy nền đã xong",
    failed: "Việc chạy nền không xong",
    cancelled: "Việc chạy nền đã được hủy",
    uncertain: "Việc chạy nền chưa rõ kết quả",
  },
  packageUpdate: {
    title: (packageId) => `Có bản cập nhật: ${packageId}`,
    lane: {
      declarative: "chỉ dữ liệu",
      "isolated-ui": "widget cách ly",
      service: "service riêng tiến trình",
      "trusted-native": "extension Pi gốc — chạy cùng tiến trình",
    },
    body: (current, next, source, lane) => `${current} → ${next} · nguồn ${source} · ${lane}`,
  },
  peerOutage: {
    title: {
      unreachable: "Không gửi được tới thiết bị khác",
      refused: "Thiết bị khác từ chối nhận",
      erroring: "Thiết bị khác báo lỗi khi nhận",
      "given-up": "Đã ngừng gửi tới thiết bị khác",
    },
    since: (time, atLeast) => `${atLeast ? "ít nhất từ lúc" : "từ lúc"} ${time}`,
    readableTime: (time, day, zone) => `${time} ngày ${day} (${zone})`,
    dateLocale: "vi-VN",
    body: (situation, name, since, status) => {
      const code = status === undefined ? "" : ` (mã ${String(status)})`;
      switch (situation) {
        case "unreachable":
          return (
            `Không gửi được tới thiết bị ${name} ${since}: thiết bị đó không trả lời. ` +
            "Những gì cần gửi vẫn nằm trong hàng đợi trên máy này và còn được thử lại tự động một thời gian; thông báo này tự đóng khi gửi được. " +
            "Nếu thiết bị đó đã tắt hẳn hoặc đổi địa chỉ, hãy bật nó lên hoặc ghép cặp lại."
          );
        case "refused":
          return (
            `Thiết bị ${name} vẫn trả lời nhưng từ chối những gì máy này gửi ${since}${code}. ` +
            "Máy này còn thử lại một thời gian rồi sẽ dừng; thông báo này tự đóng nếu thiết bị đó nhận. " +
            "Hãy kiểm tra việc ghép cặp trên thiết bị đó, hoặc cập nhật ClarkCant trên cả hai máy."
          );
        case "erroring":
          return (
            `Thiết bị ${name} vẫn trả lời nhưng báo lỗi khi nhận những gì máy này gửi ${since}${code}: nó đang chạy, nhưng ClarkCant trên đó chưa xử lý được. ` +
            "Những gì cần gửi vẫn nằm trong hàng đợi trên máy này và còn được thử lại tự động một thời gian; thông báo này tự đóng khi gửi được. " +
            "Nếu lỗi kéo dài, hãy mở ClarkCant trên thiết bị đó để xem lỗi, rồi khởi động lại hoặc cập nhật nó."
          );
        case "given-up":
          return (
            `Máy này đã ngừng gửi tới thiết bị ${name}: những gì cần gửi ${since} không gửi được sau nhiều lần thử và đã bị bỏ, sẽ không được gửi lại. ` +
            "Việc đã giao cho thiết bị đó được chốt trong hội thoại của từng việc (thất bại hoặc chưa rõ). " +
            "Khi thiết bị đó hoạt động lại, hãy gửi lại những gì còn cần; thông báo này tự đóng khi thiết bị đó nhận được tin mới từ máy này."
          );
      }
    },
  },
  peerTurnedDown: {
    title: "Thiết bị khác không nhận thông báo",
    what: (title) => (title === undefined ? "một thông báo" : `thông báo “${title}”`),
    reasons: {
      PEER_NOT_ALLOWED: {
        why: () => "chủ của thiết bị đó chưa cho phép làm việc với Clark này",
        next: "Nếu muốn thiết bị đó nhận thông báo từ máy này, chủ của nó cần cho phép làm việc với Clark này (ví dụ bằng allow_peer_tasks), rồi gửi lại.",
      },
      RATE_LIMITED: {
        why: (perMinute) => `máy này đã gửi tới đó quá ${String(perMinute)} thông báo trong một phút`,
        next: "Hãy đợi một phút rồi gửi lại những gì còn cần.",
      },
      NOTICE_UNREADABLE: {
        why: () => "thiết bị đó không đọc được thông báo này",
        next: "Hãy cập nhật ClarkCant trên cả hai máy rồi gửi lại.",
      },
      NOTICES_OFF: {
        why: () => "ClarkCant trên thiết bị đó không ghi thông báo từ thiết bị khác",
        next: "Hãy cập nhật ClarkCant trên thiết bị đó nếu muốn nó nhận thông báo.",
      },
    },
    otherWhy: (reason) => `thiết bị đó trả lời: “${reason}”`,
    otherNext: "Nếu cần, hãy hỏi chủ của thiết bị đó về lý do trên rồi gửi lại.",
    body: (name, what, why, next) =>
      `Thiết bị ${name} đã nhận nhưng không ghi ${what} mà máy này gửi: ${why}. Không có gì được ghi ở đó, và máy này sẽ không gửi lại. ${next}`,
  },
  unknownEffect: {
    title: "Chưa rõ một thao tác đã có hiệu lực hay chưa",
    forTask: (goal) => ` cho việc “${goal}”`,
    stopped: "đã bị dừng theo yêu cầu trong lúc đang chạy",
    browserNoAnswer: "đã được gửi đi nhưng trang không trả lời",
    noAnswer: "đã được gửi đi nhưng không báo lại kết quả",
    others: (count) => ` (và ${String(count)} thao tác khác cũng vậy)`,
    uncertain: "nên chưa rõ nó đã có hiệu lực hay chưa",
    nextBrowser:
      "Việc được giữ ở trạng thái chưa rõ kết quả và trình duyệt không gửi thêm gì, vì gửi lại có thể làm nó hai lần. " +
      "Hãy kiểm tra trên trang đó (ví dụ email xác nhận) rồi ghi nhận kết quả, trước khi làm lại.",
    nextCommand:
      "Việc được giữ ở trạng thái chưa rõ kết quả; mọi lệnh ra bên ngoài mà nó nhận ra đều bị từ chối, vì chạy lại có thể làm nó hai lần. " +
      "Hãy kiểm tra ở nơi nhận (ví dụ remote Git) rồi ghi nhận kết quả, trước khi chạy lại.",
    actionPrefix: "Thao tác ",
  },
  expired: {
    install: "Yêu cầu cài đặt đã hết hạn, chưa có gì được cài",
    approval: "Yêu cầu duyệt đã hết hạn, không có gì được chạy",
    question: "Câu hỏi đã hết hạn, không có ai trả lời",
  },
  packageJob: {
    completed: "Một job của package đã xong",
    cancelled: "Một job của package đã bị dừng",
    other: "Một job của package không xong",
  },
  packageJobEnded: {
    completed: (ref) => `Job của package cho ${ref} đã xong. Widget của nó hiện kết quả.`,
    produced: (ref, names, more, count) =>
      `Job của package cho ${ref} đã xong và tạo ra ${names}${more > 0 ? ` và ${String(more)} tệp khác` : ""}. ` +
      `Mở widget của nó để dùng ${count === 1 ? "tệp này" : "các tệp này"}.`,
    notSent: (ref) =>
      `Job của package cho ${ref} đã kết thúc trước khi yêu cầu được gửi. Chưa có gì chạy; có thể bắt đầu lại từ widget của nó.`,
    stopped: (ref) =>
      `Job của package cho ${ref} đã bị dừng. Service có thể đã hoàn tất tác động trước khi nhận lệnh dừng; ` +
      "hãy kiểm tra kết quả trước khi chạy lại.",
    failed: (ref) =>
      `Job của package cho ${ref} không thành công. Service có thể đã làm một phần việc; hãy kiểm tra kết quả trước khi chạy lại.`,
    interrupted: (ref) =>
      `Job của package cho ${ref} bị gián đoạn khi node khởi động lại. Service của nó có thể đã hoàn tất tác động; ` +
      "hãy xem lại trước khi thử lại.",
  },
  githubPolling: {
    title: (repository) => `Chưa theo dõi được ${repository}`,
    keepsFailing: (repository, failures, reason) =>
      `Chưa đọc được sự kiện GitHub của ${repository} sau ${String(failures)} lần thử (${reason}). Node vẫn thử lại, thưa dần, và các việc tự động về repository này chờ đến khi đọc được.`,
    tokenRefused: (secretName, repository, status) =>
      `GitHub từ chối token “${secretName}” khi node đọc sự kiện của ${repository} (${String(status)}): token có thể đã hết hạn hoặc không có quyền đọc repository này. Hãy nói với Clark để lưu lại token; node thử lại ngay khi có token mới.`,
    refused: (repository, status) =>
      `GitHub không cho node này đọc sự kiện của ${repository} (${String(status)}). Nếu đây là repository riêng tư, hãy nói với Clark để lưu token GitHub cho việc theo dõi repository này; node thử lại ngay khi có token.`,
  },
  peerSkip: {
    kindWords: {
      handshake: "lời chào kết nối",
      "invite.claim": "yêu cầu nhận lời mời ghép cặp",
      "pair.confirm": "quyền làm việc được cấp",
      revoke: "yêu cầu rút quyền làm việc",
      delegate: "việc được giao",
      accepted: "xác nhận đã nhận việc",
      status: "cập nhật trạng thái của việc",
      "input.request": "câu hỏi cần trả lời",
      "input.response": "câu trả lời",
      "approval.request": "yêu cầu duyệt",
      "approval.response": "quyết định duyệt",
      "cancel.request": "yêu cầu dừng việc",
      result: "kết quả của việc được giao",
      "artifact.offer": "tệp được gửi",
      "artifact.accept": "trả lời về tệp được gửi",
      heartbeat: "tín hiệu giữ kết nối",
      signal: "tín hiệu",
      notice: "thông báo",
    },
    forTask: (taskId) => ` (việc ${taskId})`,
    howMany: (count) => (count === 1 ? "một tin" : `${String(count)} tin`),
    andMore: (rest) => `và ${String(rest)} tin khác`,
    settledOut: "Việc giao đi hoặc lệnh dừng bị mất đã được chốt trong hội thoại của việc đó.",
    resultUncertainThere: "Thiết bị đó chốt việc có kết quả bị mất là chưa rõ.",
    settledIn: "Việc có kết quả bị mất được chốt là chưa rõ trong hội thoại của việc đó.",
    notResent: "Câu hỏi, câu trả lời hay việc duyệt bị mất sẽ không gửi lại; bên chờ sẽ chờ tới khi hết hạn.",
    nothingToSettle: "Không việc nào phải chốt lại vì các tin này.",
    guidanceOut: (name, count, consequences) =>
      `Máy này đã bỏ ${count === 1 ? "một tin" : `${String(count)} tin`} gửi tới thiết bị ${name} vì gửi mãi không được. ` +
      "Đã báo cho thiết bị đó; những tin gửi sau vẫn được giữ và gửi tiếp theo thứ tự. " +
      `${consequences} Nếu vẫn cần, hãy gửi lại. Đã bỏ: `,
    guidanceIn: (name, count, consequences) =>
      `Thiết bị ${name} báo đã bỏ ${count === 1 ? "một tin" : `${String(count)} tin`} gửi tới máy này vì gửi mãi không được. ` +
      `Máy này sẽ không nhận được ${count === 1 ? "tin đó" : "các tin đó"}; những tin khác từ thiết bị đó vẫn được nhận bình thường. ` +
      `${consequences} Nếu vẫn cần, hãy làm lại hoặc nhờ gửi lại. Tin đã mất: `,
    titleOut: (count) => `${count === 1 ? "Một tin" : `${String(count)} tin`} gửi tới thiết bị khác đã bị bỏ`,
    titleIn: (count) => `${count === 1 ? "Một tin" : `${String(count)} tin`} từ thiết bị khác đã bị mất`,
    stuckTitle: "Ghép cặp với thiết bị khác đang bị kẹt",
    stuckBody: (name) =>
      `Máy này đã bỏ ít nhất một tin gửi tới thiết bị ${name} sau nhiều lần thử, và thiết bị đó chưa cho biết nó bỏ qua được tin đã mất: ` +
      "nó sẽ từ chối mọi tin gửi sau từ máy này. Những tin còn lại vẫn nằm trong hàng đợi trên máy này và còn được thử lại một thời gian. " +
      "Hãy cập nhật ClarkCant trên thiết bị đó: khi có tin gửi tới, máy này sẽ tự báo cho nó những gì đã mất rồi gửi tiếp. " +
      "Thông báo này tự đóng khi thiết bị đó nhận được tin từ máy này.",
  },
};

const EN: NoticeText = {
  untitled: "(untitled)",
  workerOutcome: {
    succeeded: "Background work finished",
    failed: "Background work did not finish",
    cancelled: "Background work was cancelled",
    uncertain: "Background work has an unknown outcome",
  },
  packageUpdate: {
    title: (packageId) => `Update available: ${packageId}`,
    lane: {
      declarative: "data only",
      "isolated-ui": "isolated widget",
      service: "service in its own process",
      "trusted-native": "native Pi extension — runs in the same process",
    },
    body: (current, next, source, lane) => `${current} → ${next} · source ${source} · ${lane}`,
  },
  peerOutage: {
    title: {
      unreachable: "Could not send to another device",
      refused: "Another device refuses what this one sends",
      erroring: "Another device reports an error when receiving",
      "given-up": "Stopped sending to another device",
    },
    since: (time, atLeast) => `${atLeast ? "since at least" : "since"} ${time}`,
    readableTime: (time, day, zone) => `${time} on ${day} (${zone})`,
    dateLocale: "en-GB",
    body: (situation, name, since, status) => {
      const code = status === undefined ? "" : ` (code ${String(status)})`;
      switch (situation) {
        case "unreachable":
          return (
            `Could not send to the device ${name} ${since}: it does not answer. ` +
            "What has to be sent is still queued on this machine and is retried automatically for a while; this notice closes itself once it gets through. " +
            "If that device was switched off for good or changed its address, turn it on or pair it again."
          );
        case "refused":
          return (
            `The device ${name} still answers, but has refused what this machine sends ${since}${code}. ` +
            "This machine retries for a while and then stops; this notice closes itself if that device takes it. " +
            "Check the pairing on that device, or update ClarkCant on both machines."
          );
        case "erroring":
          return (
            `The device ${name} still answers, but reports an error when receiving what this machine sends ${since}${code}: it is running, but ClarkCant there cannot handle it yet. ` +
            "What has to be sent is still queued on this machine and is retried automatically for a while; this notice closes itself once it gets through. " +
            "If the error lasts, open ClarkCant on that device to see it, then restart or update it."
          );
        case "given-up":
          return (
            `This machine stopped sending to the device ${name}: what had to be sent ${since} did not get through after several tries and was given up on; it will not be sent again. ` +
            "Work handed to that device is settled in each task's conversation (failed or unknown). " +
            "Once that device works again, send again what is still needed; this notice closes itself when that device receives something new from this machine."
          );
      }
    },
  },
  peerTurnedDown: {
    title: "Another device did not take a notice",
    what: (title) => (title === undefined ? "a notice" : `the notice “${title}”`),
    reasons: {
      PEER_NOT_ALLOWED: {
        why: () => "that device's owner has not allowed working with this Clark",
        next: "If you want that device to take notices from this machine, its owner has to allow working with this Clark (for example with allow_peer_tasks), then send again.",
      },
      RATE_LIMITED: {
        why: (perMinute) => `this machine sent it more than ${String(perMinute)} notices in one minute`,
        next: "Wait a minute, then send again what is still needed.",
      },
      NOTICE_UNREADABLE: {
        why: () => "that device cannot read this notice",
        next: "Update ClarkCant on both machines, then send again.",
      },
      NOTICES_OFF: {
        why: () => "ClarkCant on that device does not record notices from other devices",
        next: "Update ClarkCant on that device if you want it to take notices.",
      },
    },
    otherWhy: (reason) => `that device answered: “${reason}”`,
    otherNext: "If needed, ask that device's owner about that reason, then send again.",
    body: (name, what, why, next) =>
      `The device ${name} received but did not record ${what} this machine sent: ${why}. Nothing was recorded there, and this machine will not send it again. ${next}`,
  },
  unknownEffect: {
    title: "It is not known whether an action took effect",
    forTask: (goal) => ` for “${goal}”`,
    stopped: "was stopped on request while it was running",
    browserNoAnswer: "was sent, but the page did not answer",
    noAnswer: "was sent, but no result came back",
    others: (count) => ` (and ${String(count)} other ${count === 1 ? "action" : "actions"} too)`,
    uncertain: "so it is not known whether it took effect",
    nextBrowser:
      "The work is kept with an unknown outcome and the browser sends nothing more, because sending again could do it twice. " +
      "Check on that site (for example a confirmation email), then record the outcome, before doing it again.",
    nextCommand:
      "The work is kept with an unknown outcome; every outgoing command it recognises is refused, because running again could do it twice. " +
      "Check where it was sent (for example the Git remote), then record the outcome, before running it again.",
    actionPrefix: "The step to ",
  },
  expired: {
    install: "An install request expired; nothing was installed",
    approval: "An approval request expired; nothing was run",
    question: "A question expired with nobody answering",
  },
  packageJob: {
    completed: "A package job finished",
    cancelled: "A package job was stopped",
    other: "A package job did not finish",
  },
  packageJobEnded: {
    completed: (ref) => `The package job for ${ref} completed. Its widget shows the result.`,
    produced: (ref, names, more, count) =>
      `The package job for ${ref} completed and produced ${names}${more > 0 ? ` and ${String(more)} more` : ""}. ` +
      `Open its widget to use ${count === 1 ? "it" : "them"}.`,
    notSent: (ref) => `The package job for ${ref} ended before its request was sent. Nothing ran; it can be started again from its widget.`,
    stopped: (ref) =>
      `The package job for ${ref} was stopped. The service may have finished its effect before it received the cancellation; ` +
      "check the result before starting it again.",
    failed: (ref) =>
      `The package job for ${ref} failed. The service may have done part of its work; check the result before starting it again.`,
    interrupted: (ref) =>
      `The package job for ${ref} was interrupted when the node restarted. Its service may have completed its effect; ` +
      "review it before retrying.",
  },
  githubPolling: {
    title: (repository) => `Cannot watch ${repository} yet`,
    keepsFailing: (repository, failures, reason) =>
      `Could not read the GitHub events of ${repository} after ${String(failures)} ${failures === 1 ? "try" : "tries"} (${reason}). The node keeps trying, less and less often, and automations about this repository wait until it can read them.`,
    tokenRefused: (secretName, repository, status) =>
      `GitHub refused the token “${secretName}” when the node read the events of ${repository} (${String(status)}): the token may have expired or may not be allowed to read this repository. Ask Clark to save the token again; the node tries again as soon as there is a new one.`,
    refused: (repository, status) =>
      `GitHub does not let this node read the events of ${repository} (${String(status)}). If this is a private repository, ask Clark to save a GitHub token for watching it; the node tries again as soon as there is one.`,
  },
  peerSkip: {
    kindWords: {
      handshake: "a connection greeting",
      "invite.claim": "a request to accept a pairing invitation",
      "pair.confirm": "a granted permission to work",
      revoke: "a request to withdraw a permission to work",
      delegate: "a handed-over task",
      accepted: "a confirmation that a task was taken",
      status: "a task status update",
      "input.request": "a question waiting for an answer",
      "input.response": "an answer",
      "approval.request": "an approval request",
      "approval.response": "an approval decision",
      "cancel.request": "a request to stop a task",
      result: "the result of a handed-over task",
      "artifact.offer": "a sent file",
      "artifact.accept": "an answer about a sent file",
      heartbeat: "a keep-alive signal",
      signal: "a signal",
      notice: "a notice",
    },
    forTask: (taskId) => ` (task ${taskId})`,
    howMany: (count) => (count === 1 ? "one message" : `${String(count)} messages`),
    andMore: (rest) => `and ${String(rest)} more`,
    settledOut: "A lost hand-over or stop request has been settled in that task's conversation.",
    resultUncertainThere: "That device settles a task whose result was lost as unknown.",
    settledIn: "A task whose result was lost has been settled as unknown in that task's conversation.",
    notResent: "A lost question, answer or approval is not sent again; whoever waits for it waits until it expires.",
    nothingToSettle: "No task had to be settled because of these messages.",
    guidanceOut: (name, count, consequences) =>
      `This machine gave up on ${count === 1 ? "one message" : `${String(count)} messages`} to the device ${name} after it could not be sent. ` +
      "That device was told; later messages are kept and sent on in order. " +
      `${consequences} If it is still needed, send it again. Given up on: `,
    guidanceIn: (name, count, consequences) =>
      `The device ${name} says it gave up on ${count === 1 ? "one message" : `${String(count)} messages`} to this machine after it could not be sent. ` +
      `This machine will not receive ${count === 1 ? "it" : "them"}; other messages from that device are received as usual. ` +
      `${consequences} If it is still needed, do it again or ask for it to be sent again. Lost: `,
    titleOut: (count) => `${count === 1 ? "A message" : `${String(count)} messages`} to another device ${count === 1 ? "was" : "were"} given up on`,
    titleIn: (count) => `${count === 1 ? "A message" : `${String(count)} messages`} from another device ${count === 1 ? "was" : "were"} lost`,
    stuckTitle: "The pairing with another device is stuck",
    stuckBody: (name) =>
      `This machine gave up on at least one message to the device ${name} after several tries, and that device has not said it can skip a lost message: ` +
      "it will refuse every later message from this machine. The remaining messages are still queued on this machine and are retried for a while. " +
      "Update ClarkCant on that device: the next time a message goes there, this machine tells it what was lost and carries on. " +
      "This notice closes itself when that device receives a message from this machine.",
  },
};

/** The notices' words in one language; Vietnamese when none is named. */
export function noticeText(locale: AppIntentLocale = "vi"): NoticeText {
  return locale === "en" ? EN : VI;
}
