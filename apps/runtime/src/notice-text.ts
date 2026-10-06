import type { AppIntentLocale, RiskLane } from "@clarkcant/contracts";

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
}

const VI: NoticeText = {
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
};

const EN: NoticeText = {
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
    title: "Not known whether an action took effect",
    forTask: (goal) => ` for “${goal}”`,
    stopped: "was stopped on request while it was running",
    browserNoAnswer: "was sent, but the page did not answer",
    noAnswer: "was sent, but no result came back",
    others: (count) => ` (and ${String(count)} other ${count === 1 ? "action" : "actions"} too)`,
    uncertain: "so whether it took effect is not known",
    nextBrowser:
      "The work is kept with an unknown outcome and the browser sends nothing more, because sending again could do it twice. " +
      "Check on that site (for example a confirmation email), then record the outcome, before doing it again.",
    nextCommand:
      "The work is kept with an unknown outcome; every outgoing command it recognises is refused, because running again could do it twice. " +
      "Check where it was sent (for example the Git remote), then record the outcome, before running it again.",
    actionPrefix: "The action ",
  },
};

/** The notices' words in one language; Vietnamese when none is named. */
export function noticeText(locale: AppIntentLocale = "vi"): NoticeText {
  return locale === "en" ? EN : VI;
}
