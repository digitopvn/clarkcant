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

const CALENDAR_ROWS: Record<string, unknown>[] = [
  { date: "2026-09-08", title: "Kiểm thử hồi quy", allDay: true },
  { date: "2026-09-11", title: "Rà soát catalog", allDay: false },
  { date: "2026-09-18", title: "Chạy E2E", allDay: false },
];

function calendarDataset(): FixtureDataset {
  return {
    datasetId: "fixture_calendar",
    source: "sample",
    columns: ["date", "title", "allDay"],
    rows: CALENDAR_ROWS,
  };
}

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

export const FIXTURES: Record<string, readonly WidgetFixture[]> = {
  "canvas.line@1": chartFixtures("line"),
  "canvas.bar@1": chartFixtures("bar"),
  "canvas.donut@1": chartFixtures("donut"),
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
      id: "calendar.empty",
      label: "Tháng trống",
      props: { datasetRef: "fixture_calendar_empty", month: "2026-10", timezone: "Europe/Berlin" },
      dataset: { datasetId: "fixture_calendar_empty", source: "sample", columns: ["date", "title"], rows: [] },
      mode: "read-only",
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
  "canvas.cta@1": [
    {
      id: "cta.normal",
      label: "Lưu khung nhìn",
      props: { label: "Lưu khung nhìn", actionId: "view.save", description: "Ghim khung nhìn hiện tại" },
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
