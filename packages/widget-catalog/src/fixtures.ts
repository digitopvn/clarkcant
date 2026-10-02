import type { FixtureDataset, WidgetFixture } from "@clarkcant/contracts";

/**
 * Deterministic fixtures, one set per built-in definition.
 *
 * Two rules make these useful rather than decorative:
 *
 *   - **They are data, never code.** No fixture carries an executable payload or an effect binding,
 *     so displaying the whole library cannot perform a real action.
 *   - **A dataset-backed fixture binds its own dataset.** A renderer reads rows from the `dataset`
 *     prop, not from the `datasetRef` string, so a fixture whose `props.datasetRef` does not equal
 *     its `dataset.datasetId` renders the "unavailable" state while looking complete. The bind is
 *     enforced by a test, not by convention.
 */

const USAGE_COLUMNS = ["week", "runs", "failures", "medianMinutes"];

const USAGE_ROWS: Record<string, unknown>[] = [
  { week: "W36", runs: 128, failures: 6, medianMinutes: 4.2 },
  { week: "W37", runs: 141, failures: 4, medianMinutes: 3.9 },
  { week: "W38", runs: 137, failures: 9, medianMinutes: 4.6 },
  { week: "W39", runs: 164, failures: 3, medianMinutes: 3.4 },
  { week: "W40", runs: 158, failures: 5, medianMinutes: 3.6 },
];

function usageDataset(source: "sample" | "cached" = "sample"): FixtureDataset {
  return { datasetId: "fixture_usage", source, columns: USAGE_COLUMNS, rows: USAGE_ROWS };
}

function emptyUsageDataset(): FixtureDataset {
  return { datasetId: "fixture_usage_empty", source: "sample", columns: USAGE_COLUMNS, rows: [] };
}

/** Thirteen weeks, so a five-row page has pages to move between. Deterministic: no clock, no randomness. */
const QUARTER_ROWS: Record<string, unknown>[] = Array.from({ length: 13 }, (_, index) => {
  const runs = 120 + ((index * 37) % 60);
  const failures = 2 + ((index * 5) % 9);
  const day = 6 + index * 7;
  const endsOn = new Date(Date.UTC(2026, 6, day)).toISOString().slice(0, 10);
  return { week: `W${28 + index}`, runs, failureRate: Math.round((failures / runs) * 10_000) / 10_000, endsOn };
});

function quarterDataset(): FixtureDataset {
  return {
    datasetId: "fixture_usage_quarter",
    source: "sample",
    columns: ["week", "runs", "failureRate", "endsOn"],
    rows: QUARTER_ROWS,
  };
}

/**
 * A month with each kind of event a calendar places: single all-day days, dated rows with no time, a three-day all-day
 * run, and a timed event that crosses midnight in Berlin, so the week and agenda views show every case.
 */
const CALENDAR_ROWS: Record<string, unknown>[] = [
  { eventId: "cal-regression", date: "2026-09-08", title: "Kiểm thử hồi quy", allDay: true },
  { eventId: "cal-catalog", date: "2026-09-11", title: "Rà soát catalog", allDay: false },
  { eventId: "cal-offsite", title: "Offsite nhóm", allDay: true, startDate: "2026-09-15", endDate: "2026-09-18" },
  { eventId: "cal-release", title: "Phát hành đêm", startsAt: "2026-09-16T20:30:00Z", endsAt: "2026-09-16T23:30:00Z", timezone: "UTC" },
  { eventId: "cal-e2e", date: "2026-09-18", title: "Chạy E2E", allDay: false },
];

function calendarDataset(): FixtureDataset {
  return {
    datasetId: "fixture_calendar",
    source: "sample",
    columns: ["eventId", "date", "title", "allDay", "startDate", "endDate", "startsAt", "endsAt", "timezone"],
    rows: CALENDAR_ROWS,
  };
}

/**
 * A release's activity, as a model would state it: instants with their own offsets, one all-day entry, every tone, an
 * actor on some, and one description long enough to collapse. In Asia/Saigon the alert at 17:40 UTC on the 29th is
 * shortly after midnight on the 30th.
 */
const TIMELINE_ENTRIES: Record<string, unknown>[] = [
  { id: "freeze", at: "2026-09-30", title: "Đóng băng mã nguồn", tone: "info", actor: "Nhóm phát hành" },
  {
    id: "deploy-started",
    at: "2026-09-30T21:05:00+07:00",
    title: "Bắt đầu triển khai production",
    tone: "info",
    actor: "Pipeline",
    description:
      "Triển khai theo từng đợt: 10% máy chủ trước, theo dõi tỉ lệ lỗi trong 15 phút rồi mới mở rộng.\n" +
      "Nếu tỉ lệ lỗi vượt 1%, pipeline tự dừng và giữ phiên bản cũ. Không cần thao tác tay trong lúc chờ; " +
      "kết quả từng đợt được ghi vào kênh phát hành.",
  },
  { id: "tests-passed", at: "2026-09-30T08:42:00Z", title: "Toàn bộ kiểm thử đã qua", tone: "success", actor: "CI" },
  { id: "disk-alert", at: "2026-09-29T17:40:00Z", title: "Cảnh báo dung lượng đĩa", tone: "warning", description: "Ổ /var đạt 91%. Đã xếp lịch dọn log." },
  { id: "migration-failed", at: "2026-09-29T10:20:00+07:00", title: "Chạy thử migration thất bại", tone: "danger", actor: "Lan" },
  { id: "rc-tagged", at: "2026-09-28T16:00:00+07:00", title: "Gắn thẻ bản RC1", actor: "Minh" },
  { id: "kickoff", at: "2026-09-28T02:00:00Z", title: "Họp khởi động phát hành" },
];

const METRIC_ROWS: Record<string, unknown>[] = [
  { label: "Số lần chạy", value: 158, unit: "lần" },
  { label: "Lần thất bại", value: 5, unit: "lần" },
  { label: "Thời gian trung vị", value: 3.6, unit: "phút" },
];

function metricsDataset(): FixtureDataset {
  return {
    datasetId: "fixture_metrics",
    source: "sample",
    columns: ["label", "value", "unit"],
    rows: METRIC_ROWS,
  };
}

/**
 * Pictures a preview may show, keyed by the opaque reference a fixture names.
 *
 * Inline `data:` URLs on purpose: the library has no host, no gateway and no bearer token, and a
 * preview that reached for one would cross a trust boundary to draw a thumbnail.
 */
export const FIXTURE_PICTURES: Record<string, string> = {
  fixture_image:
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
};

function chartFixtures(prefix: string): readonly WidgetFixture[] {
  const base: WidgetFixture[] = [
    {
      id: "normal",
      label: "Dữ liệu mẫu",
      props: { title: "Số lần chạy theo tuần", datasetRef: "fixture_usage", unit: "lần" },
      dataset: usageDataset(),
      mode: "read-only",
    },
    {
      id: "empty",
      label: "Chưa có dữ liệu",
      props: { title: "Số lần chạy theo tuần", datasetRef: "fixture_usage_empty", unit: "lần" },
      dataset: emptyUsageDataset(),
      mode: "read-only",
    },
    {
      id: "cached",
      label: "Dữ liệu đã lưu",
      props: { title: "Số lần chạy theo tuần", datasetRef: "fixture_usage", unit: "lần" },
      dataset: usageDataset("cached"),
      mode: "read-only",
    },
  ];
  return base.map((fixture) => ({ ...fixture, id: `${prefix}.${fixture.id}` }));
}

/**
 * Six hundred readings of load against latency, more than an area or scatter chart draws, so the preview shows the
 * truncation label. Deterministic: the values come from the row index, never from a clock or a random source.
 */
const LOAD_ROWS: Record<string, unknown>[] = Array.from({ length: 600 }, (_, index) => {
  const load = 10 + ((index * 37) % 90);
  const spread = (index * 53) % 23;
  return { load, latencyMs: 40 + Math.round(load * 1.6) + spread, p95Ms: 90 + Math.round(load * 2.9) + spread * 2 };
});

function loadDataset(): FixtureDataset {
  return { datasetId: "fixture_load", source: "sample", columns: ["load", "latencyMs", "p95Ms"], rows: LOAD_ROWS };
}

const USAGE_LABELS = { runs: "Số lần chạy", failures: "Lần thất bại", medianMinutes: "Thời gian trung vị" };

export const FIXTURES: Record<string, readonly WidgetFixture[]> = {
  "canvas.line@1": chartFixtures("line"),
  "canvas.bar@1": chartFixtures("bar"),
  "canvas.donut@1": chartFixtures("donut"),
  "canvas.area@1": [
    {
      id: "area.normal",
      label: "Hai chuỗi theo tuần",
      props: {
        title: "Lần chạy và lần thất bại",
        datasetRef: "fixture_usage",
        x: "week",
        y: ["runs", "failures"],
        labels: { runs: USAGE_LABELS.runs, failures: USAGE_LABELS.failures },
        unit: "lần",
      },
      dataset: usageDataset(),
      mode: "interactive",
    },
    {
      id: "area.stacked",
      label: "Xếp chồng",
      props: {
        title: "Tổng lần chạy, xếp chồng",
        datasetRef: "fixture_usage",
        x: "week",
        y: ["runs", "failures"],
        labels: { runs: USAGE_LABELS.runs, failures: USAGE_LABELS.failures },
        unit: "lần",
        stacked: true,
      },
      dataset: usageDataset(),
      mode: "interactive",
    },
    {
      // A view a person left: one series hidden and a point selected, as the node would hand it back.
      id: "area.selected",
      label: "Đã ẩn một chuỗi và chọn một điểm",
      props: {
        title: "Lần chạy và lần thất bại",
        datasetRef: "fixture_usage",
        x: "week",
        y: ["runs", "failures"],
        labels: { runs: USAGE_LABELS.runs, failures: USAGE_LABELS.failures },
        unit: "lần",
      },
      state: { hiddenSeries: ["failures"], selected: { series: "runs", index: 3 } },
      dataset: usageDataset(),
      mode: "interactive",
    },
    {
      id: "area.empty",
      label: "Chưa có dữ liệu",
      props: { title: "Lần chạy theo tuần", datasetRef: "fixture_usage_empty", x: "week", y: ["runs"], unit: "lần" },
      dataset: emptyUsageDataset(),
      mode: "read-only",
    },
  ],
  "canvas.scatter@1": [
    {
      id: "scatter.normal",
      label: "Thời gian và số lần chạy",
      props: {
        title: "Thời gian trung vị so với số lần chạy",
        datasetRef: "fixture_usage",
        x: "medianMinutes",
        y: ["runs"],
        pointLabel: "week",
        labels: { medianMinutes: USAGE_LABELS.medianMinutes, runs: USAGE_LABELS.runs },
        xUnit: "phút",
        unit: "lần",
      },
      dataset: usageDataset(),
      mode: "interactive",
    },
    {
      id: "scatter.truncated",
      label: "Nhiều điểm, đã giới hạn",
      props: {
        title: "Tải và độ trễ",
        datasetRef: "fixture_load",
        x: "load",
        y: ["latencyMs", "p95Ms"],
        labels: { load: "Tải", latencyMs: "Độ trễ trung vị", p95Ms: "Độ trễ p95" },
        xUnit: "%",
        unit: "ms",
      },
      dataset: loadDataset(),
      mode: "interactive",
    },
    {
      id: "scatter.empty",
      label: "Chưa có dữ liệu",
      props: { title: "Thời gian so với số lần chạy", datasetRef: "fixture_usage_empty", x: "medianMinutes", y: ["runs"] },
      dataset: emptyUsageDataset(),
      mode: "read-only",
    },
  ],
  "canvas.table@1": [
    {
      id: "table.normal",
      label: "Bảng dữ liệu mẫu",
      props: { title: "Bảng dữ liệu mẫu", datasetRef: "fixture_usage", pageSize: 5 },
      dataset: usageDataset(),
      mode: "read-only",
    },
    {
      id: "table.empty",
      label: "Bảng rỗng",
      props: { title: "Bảng rỗng", datasetRef: "fixture_usage_empty", pageSize: 5 },
      dataset: emptyUsageDataset(),
      mode: "read-only",
    },
    {
      id: "table.read-only",
      label: "Chỉ đọc",
      props: { title: "Bảng đã chốt", datasetRef: "fixture_usage", pageSize: 5 },
      dataset: usageDataset("cached"),
      mode: "read-only",
    },
    {
      // Every optional part of the contract at once: declared columns with types and formats, search, multi-select,
      // totals and more rows than one page, starting sorted.
      id: "table.full",
      label: "Đủ tính năng",
      props: {
        title: "Số lần chạy theo tuần",
        datasetRef: "fixture_usage_quarter",
        pageSize: 5,
        searchable: true,
        selection: "multi",
        rowIdField: "week",
        columns: [
          { key: "week", label: "Tuần" },
          { key: "runs", label: "Số lần chạy", type: "number", format: { unit: "lần" } },
          { key: "failureRate", label: "Tỷ lệ lỗi", type: "number", format: { style: "percent", decimals: 1 } },
          { key: "endsOn", label: "Kết thúc", type: "date" },
        ],
        totals: [
          { column: "runs", fn: "sum" },
          { column: "failureRate", fn: "avg" },
        ],
      },
      state: { sort: { column: "runs", direction: "desc" } },
      dataset: quarterDataset(),
      mode: "read-only",
    },
  ],
  "canvas.metrics@1": [
    {
      id: "metrics.normal",
      label: "Ba số liệu",
      props: { datasetRef: "fixture_metrics", title: "Tuần này" },
      dataset: metricsDataset(),
      mode: "read-only",
    },
    {
      id: "metrics.empty",
      label: "Chưa có số liệu",
      props: { datasetRef: "fixture_metrics_empty", title: "Tuần này" },
      dataset: { datasetId: "fixture_metrics_empty", source: "sample", columns: ["label", "value"], rows: [] },
      mode: "read-only",
    },
  ],
  "canvas.filter@1": [
    {
      id: "filter.normal",
      label: "Chọn theo tuần",
      props: { period: "week", timezone: "Europe/Berlin", title: "Khoảng thời gian" },
      mode: "interactive",
    },
  ],
  "canvas.calendar@1": [
    {
      id: "calendar.normal",
      label: "Tháng có sự kiện",
      props: { datasetRef: "fixture_calendar", month: "2026-09", timezone: "Europe/Berlin" },
      dataset: calendarDataset(),
      mode: "read-only",
    },
    {
      id: "calendar.week",
      label: "Một tuần, có sự kiện nhiều ngày và qua đêm",
      props: { datasetRef: "fixture_calendar", month: "2026-09", timezone: "Europe/Berlin", view: "week" },
      state: { view: "week", selectedDate: "2026-09-16", selectedEventId: "cal-release@2026-09-16T20:30:00.000Z" },
      dataset: calendarDataset(),
      mode: "read-only",
    },
    {
      id: "calendar.agenda",
      label: "Lịch trình của tháng",
      props: { datasetRef: "fixture_calendar", month: "2026-09", timezone: "Europe/Berlin", view: "agenda" },
      state: { view: "agenda" },
      dataset: calendarDataset(),
      mode: "read-only",
    },
    {
      id: "calendar.empty",
      label: "Tháng trống",
      props: { datasetRef: "fixture_calendar_empty", month: "2026-10", timezone: "Europe/Berlin" },
      dataset: { datasetId: "fixture_calendar_empty", source: "sample", columns: ["date", "title"], rows: [] },
      mode: "read-only",
    },
  ],
  "canvas.timeline@1": [
    {
      id: "timeline.normal",
      label: "Hoạt động phát hành, mới nhất trước",
      props: {
        title: "Phát hành 2.4",
        timezone: "Asia/Saigon",
        entries: TIMELINE_ENTRIES,
      },
      state: { selectedId: "deploy-started" },
      mode: "interactive",
    },
    {
      id: "timeline.oldest",
      label: "Cũ nhất trước, chia trang",
      props: { title: "Phát hành 2.4", timezone: "Asia/Saigon", order: "oldest", pageSize: 5, entries: TIMELINE_ENTRIES },
      mode: "interactive",
    },
    {
      id: "timeline.truncated",
      label: "Đã lược bớt mục",
      props: { title: "Nhật ký gần đây", timezone: "Europe/Berlin", truncated: true, entries: TIMELINE_ENTRIES.slice(0, 3) },
      mode: "read-only",
    },
    {
      id: "timeline.empty",
      label: "Chưa có hoạt động",
      props: { title: "Nhật ký gần đây", timezone: "Asia/Saigon", entries: [] },
      mode: "read-only",
    },
  ],
  "canvas.tree@1": [
    {
      id: "tree.normal",
      label: "Cây phân cấp có lựa chọn",
      props: {
        title: "Dự án",
        initiallyExpanded: ["project", "client"],
        nodes: [
          { id: "project", label: "ClarkCant", icon: "project", children: [
            { id: "client", label: "Ứng dụng", icon: "folder", children: [
              { id: "composer", label: "Trình soạn thảo", secondary: "Đang hoạt động", icon: "document" },
              { id: "library", label: "Thư viện widget", icon: "folder" },
            ] },
            { id: "runtime", label: "Runtime", icon: "branch", children: [
              { id: "worker", label: "Worker", icon: "task" },
            ] },
          ] },
          { id: "people", label: "Cộng tác viên", icon: "group", children: [{ id: "owner", label: "Chủ dự án", icon: "person" }] },
        ],
      },
      state: { selectedId: "composer", expandedIds: ["project", "client"] },
      mode: "interactive",
    },
    { id: "tree.empty", label: "Cây trống", props: { title: "Không có mục", nodes: [] }, mode: "read-only" },
  ],
  "canvas.diagram@1": [
    {
      id: "diagram.normal",
      label: "Sơ đồ quy trình có lựa chọn",
      props: {
        title: "Quy trình phát hành",
        nodes: [
          { id: "plan", label: "Lên kế hoạch", shape: "round" },
          { id: "build", label: "Xây dựng", group: "Tích hợp liên tục" },
          { id: "test", label: "Kiểm thử đạt?", shape: "diamond", group: "Tích hợp liên tục" },
          { id: "fix", label: "Sửa lỗi" },
          { id: "ship", label: "Phát hành", shape: "circle" },
          { id: "docs", label: "Cập nhật tài liệu" },
        ],
        edges: [
          { from: "plan", to: "build" },
          { from: "build", to: "test" },
          { from: "test", to: "ship", label: "đạt" },
          { from: "test", to: "fix", label: "chưa đạt" },
          { from: "fix", to: "build" },
          { from: "ship", to: "docs", direction: "none" },
        ],
      },
      state: { selectedId: "test" },
      mode: "interactive",
    },
    { id: "diagram.empty", label: "Sơ đồ trống", props: { title: "Chưa có bước nào", nodes: [] }, mode: "read-only" },
  ],
  "canvas.board@1": [
    {
      id: "board.normal",
      label: "Bảng giao hàng có thể thao tác",
      props: {
        title: "Giao hàng",
        columns: [{ id: "todo", title: "Cần làm" }, { id: "doing", title: "Đang làm" }, { id: "done", title: "Hoàn tất" }],
        cards: [{ id: "schema", columnId: "todo", title: "Cập nhật hợp đồng", labels: [{ text: "P1", tone: "warning" }] }, { id: "review", columnId: "doing", title: "Rà soát thay đổi", assignee: "Linh" }],
      },
      mode: "interactive",
    },
  ],
  "canvas.image@1": [
    {
      id: "image.normal",
      label: "Một ảnh có mô tả",
      props: { imageRef: "fixture_image", alt: "Một điểm ảnh mẫu", title: "Ảnh mẫu" },
      mode: "read-only",
    },
    {
      id: "image.unavailable",
      label: "Ảnh chưa tải được",
      props: { imageRef: "fixture_image_missing", alt: "Mô tả vẫn đọc được", title: "Ảnh thiếu" },
      mode: "read-only",
    },
  ],
  "canvas.carousel@1": [
    {
      id: "carousel.normal",
      label: "Hai ảnh lần lượt",
      props: { imageRefs: ["fixture_image"], alts: ["Một điểm ảnh mẫu"], title: "Bộ ảnh" },
      mode: "read-only",
    },
  ],
  "canvas.gallery@1": [
    {
      id: "gallery.normal",
      label: "Lưới ảnh",
      props: {
        imageRefs: ["fixture_image", "fixture_image"],
        alts: ["Một điểm ảnh mẫu", "Một điểm ảnh mẫu thứ hai"],
        title: "Thư viện ảnh",
      },
      mode: "read-only",
    },
  ],
  "canvas.youtube@1": [
    {
      id: "youtube.normal",
      label: "Video YouTube",
      props: { videoId: "dQw4w9WgXcQ", title: "Video mẫu", description: "Nhúng từ YouTube" },
      mode: "read-only",
    },
  ],
  "canvas.video@1": [
    {
      id: "video.normal",
      label: "Video trên máy",
      props: { videoRef: "fixture_video", alt: "Video mẫu", title: "Video trên máy" },
      mode: "read-only",
    },
  ],
  "canvas.audio@1": [
    {
      id: "audio.normal",
      label: "Âm thanh có bản ghi lời",
      props: {
        title: "Bản tin buổi sáng",
        audioRef: "artifact:fixture_audio",
        mimeType: "audio/mpeg",
        durationSeconds: 95.4,
        sizeBytes: 1_526_400,
        transcript: "Chào buổi sáng. Hôm nay có ba việc cần làm: gửi báo cáo, họp nhóm lúc mười giờ và xem lại bản nháp.",
      },
      mode: "read-only",
    },
  ],
  "canvas.document@1": [
    {
      id: "document.normal",
      label: "Xem trước PDF nhiều trang",
      props: {
        name: "ke-hoach-quy-4.pdf",
        mimeType: "application/pdf",
        documentRef: "attachment:fixture_document",
        pages: [
          "Kế hoạch quý 4\n\nMục tiêu: hoàn thiện bản phát hành, giảm thời gian phản hồi và mở rộng thư viện widget.",
          "Lịch trình\n\nTháng 10: chốt phạm vi. Tháng 11: kiểm thử trên ba hệ điều hành. Tháng 12: phát hành.",
        ],
        sourcePages: 2,
        totalChars: 200,
        truncated: false,
      },
      mode: "read-only",
    },
    {
      id: "document.truncated",
      label: "Tệp văn bản bị cắt bớt",
      props: {
        name: "nhat-ky.txt",
        mimeType: "text/plain",
        documentRef: "attachment:fixture_log",
        pages: ["Dòng 1: khởi động\nDòng 2: đọc cấu hình\nDòng 3: sẵn sàng"],
        totalChars: 48_000,
        truncated: true,
      },
      mode: "read-only",
    },
  ],
  "canvas.cta@1": [
    {
      id: "cta.normal",
      label: "Lưu khung nhìn",
      props: { label: "Lưu khung nhìn", actionId: "view.save", description: "Ghim khung nhìn hiện tại" },
      mode: "read-only",
    },
  ],
  "canvas.code@1": [
    {
      id: "code.normal",
      label: "Đoạn mã TypeScript",
      props: {
        path: "src/lib/greet.ts",
        startLine: 12,
        code: [
          "// Chào theo giờ trong ngày.",
          "export function greet(name: string, hour: number): string {",
          '  const part = hour < 12 ? "sáng" : hour < 18 ? "chiều" : "tối";',
          "  return `Chào buổi ${part}, ${name}!`;",
          "}",
        ].join("\n"),
      },
      mode: "read-only",
    },
    {
      id: "code.long",
      label: "Mã dài, đã cắt bớt",
      props: {
        title: "Nhật ký bản dựng",
        language: "bash",
        truncated: true,
        code: Array.from({ length: 40 }, (_, index) =>
          index === 3
            ? `echo "${"một dòng rất dài để thử cuộn ngang bên trong khối mã ".repeat(4).trim()}"`
            : `echo "bước ${String(index + 1)}"`,
        ).join("\n"),
      },
      mode: "read-only",
    },
    {
      id: "code.plain",
      label: "Văn bản không rõ ngôn ngữ",
      props: { path: "notes/ghi-chu.xyz", code: "<b>không in đậm</b>\nchỉ là chữ" },
      mode: "read-only",
    },
  ],
  "canvas.diff@1": [
    {
      id: "diff.normal",
      label: "Diff hai tệp",
      props: {
        title: "Sửa lời chào",
        files: [
          {
            path: "src/lib/greet.ts",
            hunks: [
              {
                oldStart: 12,
                newStart: 12,
                section: "export function greet(name: string, hour: number): string {",
                lines: [
                  { kind: "context", text: "export function greet(name: string, hour: number): string {" },
                  { kind: "remove", text: '  const part = hour < 12 ? "sáng" : "chiều";' },
                  { kind: "add", text: '  const part = hour < 12 ? "sáng" : hour < 18 ? "chiều" : "tối";' },
                  { kind: "context", text: "  return `Chào buổi ${part}, ${name}!`;" },
                ],
              },
            ],
          },
          {
            path: "src/lib/greet.spec.ts",
            hunks: [
              {
                oldStart: 0,
                newStart: 1,
                lines: [
                  { kind: "add", text: 'import { greet } from "./greet.ts";' },
                  { kind: "add", text: 'it("chào buổi tối", () => expect(greet("An", 20)).toBe("Chào buổi tối, An!"));' },
                ],
              },
            ],
          },
        ],
      },
      mode: "read-only",
    },
    {
      id: "diff.renamed",
      label: "Đổi tên và lược bớt",
      props: {
        truncated: true,
        files: [
          {
            path: "docs/huong-dan.md",
            oldPath: "docs/guide.md",
            hunks: [
              { oldStart: 1, newStart: 1, lines: [{ kind: "remove", text: "# Guide" }, { kind: "add", text: "# Hướng dẫn" }] },
              {
                oldStart: 40,
                newStart: 40,
                lines: [
                  { kind: "context", text: "" },
                  { kind: "remove", text: "See the setup section." },
                  { kind: "add", text: "Xem phần cài đặt." },
                ],
              },
            ],
          },
        ],
      },
      mode: "read-only",
    },
  ],
  "canvas.file@1": [
    {
      id: "file.normal",
      label: "Tệp PDF",
      props: {
        name: "bao-cao-quy-3.pdf",
        mediaType: "application/pdf",
        sizeBytes: 482_133,
        source: "Clark tạo từ bảng doanh thu",
        path: "Tài liệu/Báo cáo/bao-cao-quy-3.pdf",
        summary: "Doanh thu quý 3, so với quý 2 và cùng kỳ năm trước.",
      },
      mode: "read-only",
    },
    {
      id: "file.minimal",
      label: "Chỉ có tên",
      props: { name: "README" },
      mode: "read-only",
    },
  ],
  "canvas.action@1": [
    {
      id: "action.normal",
      label: "Nút chính",
      props: { label: "Tóm tắt tuần này", description: "Clark đọc các task của tuần và tóm tắt", emphasis: "primary", icon: "send" },
      mode: "read-only",
    },
    {
      id: "action.unavailable",
      label: "Nút chưa dùng được",
      props: { label: "Chạy quy trình", emphasis: "secondary", icon: "play" },
      state: { unavailableReason: "Dịch vụ phía sau nút này không chạy trên máy này." },
      mode: "read-only",
    },
    {
      id: "action.pending",
      label: "Nút đang chạy",
      props: { label: "Thêm ghi chú", icon: "add" },
      state: { pending: true },
      mode: "read-only",
    },
  ],
  "canvas.choice@1": [
    {
      id: "choice.normal",
      label: "Chip chọn nhiều",
      props: {
        label: "Kênh nhận tin",
        kind: "chips",
        help: "Chọn một hoặc vài kênh.",
        options: [
          { value: "email", label: "Email" },
          { value: "chat", label: "Chat" },
          { value: "sms", label: "SMS" },
        ],
        value: ["chat"],
      },
      mode: "interactive",
    },
    {
      id: "choice.toggle",
      label: "Công tắc",
      props: { label: "Nhắc trước 10 phút", kind: "toggle", value: true },
      mode: "interactive",
    },
    {
      id: "choice.radio",
      label: "Chọn một",
      props: {
        label: "Mức ưu tiên",
        kind: "radio",
        options: [
          { value: "low", label: "Thấp" },
          { value: "normal", label: "Bình thường" },
          { value: "high", label: "Cao" },
        ],
      },
      mode: "interactive",
    },
  ],
  "canvas.input@1": [
    {
      id: "input.normal",
      label: "Thanh trượt",
      props: { label: "Thời lượng (phút)", kind: "slider", min: 15, max: 120, step: 15, value: 45 },
      mode: "interactive",
    },
    {
      id: "input.date-range",
      label: "Khoảng ngày",
      props: { label: "Khoảng ngày", kind: "date-range", value: { start: "2026-10-01", end: "2026-10-03" } },
      mode: "interactive",
    },
    {
      id: "input.text",
      label: "Ô chữ",
      props: { label: "Chủ đề", kind: "text", placeholder: "Ví dụ: rà soát quý", maxLength: 120 },
      mode: "interactive",
    },
  ],
  "canvas.search@1": [
    {
      id: "search.normal",
      label: "Ô tìm kiếm",
      props: { label: "Tìm trong bảng", placeholder: "Ngày, số việc…" },
      mode: "interactive",
    },
    {
      id: "search.query",
      label: "Đang có truy vấn",
      props: { label: "Tìm việc", query: "hoá đơn" },
      mode: "interactive",
    },
  ],
  "canvas.form@1": [
    {
      id: "form.normal",
      label: "Biểu mẫu đặt lịch",
      props: {
        title: "Đặt lịch họp",
        submitLabel: "Gửi cho Clark",
        fields: [
          { name: "topic", label: "Chủ đề", kind: "text", required: true, maxLength: 120 },
          { name: "day", label: "Ngày", kind: "date", required: true },
          { name: "minutes", label: "Thời lượng (phút)", kind: "slider", min: 15, max: 120, step: 15 },
          {
            name: "room",
            label: "Phòng",
            kind: "radio",
            options: [
              { value: "online", label: "Trực tuyến" },
              { value: "hq", label: "Văn phòng" },
            ],
          },
        ],
      },
      mode: "read-only",
    },
    {
      id: "form.refused",
      label: "Bị từ chối, bản nháp còn nguyên",
      props: {
        title: "Ghi chú nhanh",
        submitLabel: "Lưu",
        fields: [{ name: "body", label: "Nội dung", kind: "text", multiline: true, required: true }],
      },
      state: {
        draft: { body: "Gọi lại cho khách trước thứ Sáu" },
        message: "Dịch vụ ghi chú chưa sẵn sàng.",
        tone: "refused",
      },
      mode: "read-only",
    },
  ],
  "canvas.list@1": [
    {
      id: "list.normal",
      label: "Danh sách nhiều trang",
      props: {
        title: "Việc chờ xử lý",
        selection: "multi",
        pageSize: 5,
        items: Array.from({ length: 7 }, (_, index) => ({
          id: `task-${String(index + 1)}`,
          title: `Việc số ${String(index + 1)}`,
          subtitle: index % 2 === 0 ? "Từ hộp thư" : "Từ lịch",
          meta: `${String(index + 1)} ngày`,
        })),
      },
      state: { selected: ["task-2"] },
      mode: "read-only",
    },
    {
      id: "list.empty",
      label: "Danh sách trống",
      props: { title: "Việc chờ xử lý", items: [], emptyText: "Không còn việc nào chờ." },
      mode: "read-only",
    },
    {
      id: "list.loading",
      label: "Đang tải",
      props: { title: "Việc chờ xử lý", items: [{ id: "task-1", title: "Việc số 1" }] },
      state: { loading: true },
      mode: "read-only",
    },
  ],
  "canvas.status@1": [
    {
      id: "status.normal",
      label: "Cảnh báo có chi tiết",
      props: {
        title: "Bản dựng đêm qua",
        label: "Chạy xong nhưng có 2 test chập chờn",
        tone: "warning",
        detail: "Hai test E2E phải chạy lại mới qua.",
        asOf: "2026-09-30T07:30:00+07:00",
      },
      mode: "read-only",
    },
    {
      id: "status.success",
      label: "Ổn, không có chi tiết",
      props: { label: "Sao lưu đã hoàn tất", tone: "success" },
      mode: "read-only",
    },
    {
      id: "status.danger",
      label: "Lỗi",
      props: { title: "Đồng bộ lịch", label: "Không kết nối được", tone: "danger", detail: "Máy chủ lịch trả lỗi 503.", asOf: "2026-09-29" },
      mode: "read-only",
    },
  ],
  "canvas.progress@1": [
    {
      id: "progress.normal",
      label: "Tiến độ theo giá trị",
      props: { title: "Nhập ảnh", label: "Ảnh đã nhập", value: 42, max: 120, unit: "ảnh" },
      mode: "read-only",
    },
    {
      id: "progress.steps",
      label: "Tiến độ theo bước",
      props: {
        title: "Chuyển nhà",
        steps: [
          { label: "Đóng thùng", status: "done" },
          { label: "Thuê xe", status: "done" },
          { label: "Chuyển đồ", status: "current", detail: "Đang ở chuyến thứ hai" },
          { label: "Lắp internet", status: "pending" },
          { label: "Sơn lại phòng", status: "skipped" },
        ],
        asOf: "2026-09-30",
      },
      mode: "read-only",
    },
    {
      id: "progress.failed",
      label: "Có bước lỗi",
      props: {
        label: "Phát hành bản 1.4",
        steps: [
          { label: "Build", status: "done" },
          { label: "Ký gói", status: "failed", detail: "Chứng chỉ đã hết hạn" },
          { label: "Đăng tải", status: "pending" },
        ],
      },
      mode: "read-only",
    },
  ],
  "canvas.details@1": [
    {
      id: "details.normal",
      label: "Chi tiết một đơn hàng",
      props: {
        title: "Đơn #1042",
        items: [
          { label: "Khách hàng", value: "Nguyễn Thị Lan" },
          { label: "Tổng tiền", value: "1.250.000 ₫" },
          { label: "Trạng thái", value: "Đang giao" },
          { label: "Địa chỉ", value: "12 Lý Tự Trọng, Quận 1, TP. Hồ Chí Minh" },
        ],
        asOf: "2026-09-30T10:15:00+07:00",
      },
      mode: "read-only",
    },
    {
      id: "details.long",
      label: "Giá trị dài",
      props: {
        items: [
          { label: "Đường dẫn", value: "https://example.com/reports/2026/09/very-long-path-that-must-wrap-inside-the-card" },
          { label: "Ghi chú", value: "Một giá trị dài phải xuống dòng bên trong thẻ, không đẩy trang rộng ra trên màn hình hẹp." },
        ],
      },
      mode: "read-only",
    },
  ],
  "canvas.note@1": [
    {
      id: "note.normal",
      label: "Ghi chú có nội dung",
      props: { title: "Ghi chú mẫu", body: "Nội dung chạy hoàn toàn trên máy bạn." },
      state: { body: "Nội dung chạy hoàn toàn trên máy bạn.", revision: 1 },
      mode: "interactive",
    },
    {
      id: "note.read-only",
      label: "Ghi chú chỉ đọc",
      props: { title: "Ghi chú đã chốt", body: "Bản này không sửa được." },
      state: { body: "Bản này không sửa được.", revision: 3 },
      mode: "read-only",
    },
  ],
};

export function fixturesFor(definitionId: string): readonly WidgetFixture[] {
  return FIXTURES[definitionId] ?? [];
}
