/*
 * A spreadsheet in its own frame.
 *
 * Files come and go through `api.artifacts`: the person picks a CSV or TSV file in the host's chrome, the widget reads it
 * in bounded chunks and stops at the sheet's ceiling, and an export is written as a new file the host offers to save.
 * The widget never sees a path, and the frame has no network.
 *
 * The widget's durable state is small on purpose: the file the sheet came from, the edits made since and the formats.
 * The sheet itself is rebuilt from the file on mount. When the edits grow too large for the state, the widget writes
 * the whole sheet as its own file and starts again from that one (see `store.js`). The active cell and the selection are
 * view state the host keeps for the frame but never writes to the node.
 *
 * Clark can format the selection through the one bound action the host attached to this instance. The press sends
 * nothing; the host reads the selection from what this widget published, and Clark's reply is applied only when it is
 * exactly the instruction the widget expects for that selection. The selection is held still until the reply is in.
 */

import { delimiterFor, writeDelimited } from "./csv.js";
import { evaluateSheet, isError } from "./formula.js";
import { MAX_FORMATS, applyFormat, displayValue, formatAt, readFormatDirective } from "./formats.js";
import { semanticDocument } from "./semantic.js";
import {
  MAX_CELLS,
  MAX_COLUMNS,
  MAX_ROWS,
  cellName,
  clearRange,
  columnName,
  createSheet,
  normalizeRange,
  parseCellName,
  rangeName,
  truncationNotice,
} from "./sheet.js";
import { createStore, readSheetFile, readTruncated, writeTextFile } from "./store.js";

const ROW_HEIGHT = 28;
const COLUMN_WIDTH = 96;
const HEADER_WIDTH = 52;
const OVERSCAN = 6;
/** Moving the cursor writes view state no sooner than this after the last move. */
const CURSOR_SAVE_MS = 250;
/** Format changes Undo can step back through. */
const MAX_UNDO = 20;

const TEXT = {
  vi: {
    import: "Nhập CSV/TSV",
    exportCsv: "Xuất CSV",
    exportTsv: "Xuất TSV",
    askFormat: "Nhờ Clark định dạng phần trăm",
    selectRange: "Chọn vùng",
    undoFormat: "Hoàn tác định dạng",
    grid: "Bảng tính",
    formula: "Nội dung ô",
    exportName: "bang-tinh",
    empty: "Chưa có dữ liệu. Nhập một tệp CSV hoặc TSV, hoặc gõ vào ô.",
    noFiles: "Host này không cho dùng tệp, nên không nhập hay xuất được.",
    picking: "Đang chờ bạn chọn tệp…",
    cancelled: "Bạn đã đóng hộp chọn tệp; bảng tính giữ nguyên.",
    reading: "Đang đọc tệp…",
    loaded: (name, rows, columns) => `Đã nhập ${name}: ${String(rows)} hàng × ${String(columns)} cột.`,
    exporting: "Đang ghi tệp xuất…",
    saved: "Đã lưu tệp xuất.",
    notSaved: "Bạn đã không lưu; bảng tính giữ nguyên.",
    asking: "Đang hỏi Clark… Vùng chọn được giữ nguyên cho tới khi có trả lời.",
    applied: (range) => `Clark đã định dạng ${range} thành phần trăm.`,
    appliedOther: (range, format) => `Clark đã định dạng ${range} (${format}).`,
    dropped: (ranges) =>
      `Định dạng cũ nhất (${ranges}) đã bị bỏ vì bảng tính giữ tối đa ${String(MAX_FORMATS)} định dạng.`,
    undone: "Đã hoàn tác định dạng.",
    rangeMode: (cell) => `Chạm một ô để chọn vùng từ ${cell}. Bấm “Chọn vùng” lần nữa để tắt.`,
    refusedReply: "Câu trả lời của Clark không phải lệnh bảng tính này áp dụng được; không có gì thay đổi.",
    refusedRange: (range) => `Clark trả lời cho vùng ${range}, không phải vùng đang chọn; không có gì thay đổi.`,
    failed: (message) => `Không làm được: ${message}. Bảng tính giữ nguyên.`,
    full: `Bảng tính giữ tối đa ${String(MAX_CELLS)} ô; ô này nằm ngoài giới hạn nên không được ghi.`,
    sourceGone: "Không đọc lại được tệp gốc (có thể đã hết hạn). Các sửa đổi vẫn được giữ; hãy nhập lại tệp.",
    stateRefused: "Không lưu được trạng thái; thay đổi chỉ còn trong khung này.",
    circular: (cells) => `Tham chiếu vòng: ${cells}.`,
    limited: "Một số công thức tham chiếu quá nhiều ô nên không được tính và hiện #LIMIT!.",
  },
  en: {
    import: "Import CSV/TSV",
    exportCsv: "Export CSV",
    exportTsv: "Export TSV",
    askFormat: "Ask Clark to format as percent",
    selectRange: "Select range",
    undoFormat: "Undo format",
    grid: "Spreadsheet",
    formula: "Cell contents",
    exportName: "spreadsheet",
    empty: "No data yet. Import a CSV or TSV file, or type into a cell.",
    noFiles: "This host does not offer files, so import and export are unavailable.",
    picking: "Waiting for you to choose a file…",
    cancelled: "You closed the file prompt; the sheet is unchanged.",
    reading: "Reading the file…",
    loaded: (name, rows, columns) => `Imported ${name}: ${String(rows)} rows × ${String(columns)} columns.`,
    exporting: "Writing the export…",
    saved: "The export was saved.",
    notSaved: "You did not save; the sheet is unchanged.",
    asking: "Asking Clark… The selection is held until the answer arrives.",
    applied: (range) => `Clark formatted ${range} as percent.`,
    appliedOther: (range, format) => `Clark formatted ${range} (${format}).`,
    dropped: (ranges) => `The oldest format (${ranges}) was removed because the sheet keeps at most ${String(MAX_FORMATS)} formats.`,
    undone: "The format was undone.",
    rangeMode: (cell) => `Tap a cell to select the range from ${cell}. Press “Select range” again to stop.`,
    refusedReply: "Clark's reply was not an instruction this sheet can apply; nothing was changed.",
    refusedRange: (range) => `Clark answered for ${range}, not the selected range; nothing was changed.`,
    failed: (message) => `That did not work: ${message}. The sheet is unchanged.`,
    full: `The sheet holds at most ${String(MAX_CELLS)} cells; that cell is outside the bound and was not written.`,
    sourceGone: "The original file could not be read again (it may have expired). Your edits are kept; import the file again.",
    stateRefused: "The state could not be saved; changes live only in this frame.",
    circular: (cells) => `Circular reference: ${cells}.`,
    limited: "Some formulas reach too many cells to evaluate and show #LIMIT!.",
  },
};

const root = document.getElementById("root");

function element(tag, attributes = {}, text) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function messageOf(error) {
  return String(error && error.message ? error.message : error);
}

/** Host colours, applied as CSS variables; the stylesheet's own light and dark values stand in until they arrive. */
function applyAppearance(snapshot) {
  const style = document.documentElement.style;
  if (snapshot === undefined) return;
  const color = snapshot.tokens?.color ?? {};
  const pairs = [
    ["--canvas", color.canvas],
    ["--card", color.card],
    ["--border", color.border],
    ["--text", color.text],
    ["--muted", color.textMuted],
    ["--accent", color.accent],
    ["--on-accent", color.onAccent],
    ["--danger", color.danger],
    ["--warning", color.warning],
    ["--focus", color.focus],
  ];
  for (const [name, value] of pairs) if (typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/u.test(value)) style.setProperty(name, value);
  if (snapshot.scheme === "light" || snapshot.scheme === "dark") {
    document.documentElement.dataset.scheme = snapshot.scheme;
    style.colorScheme = snapshot.scheme;
  }
}

function start() {
  const runtime = window.clarkcantWidget;
  if (runtime === undefined || runtime.status() !== "ready") {
    setTimeout(start, 20);
    return;
  }
  if (root.dataset.drawn === "true") return;
  root.dataset.drawn = "true";
  mount(runtime.api());
}

function mount(api) {
  let props = api.props.read();
  const locale = () => (props.locale === "en" ? "en" : "vi");
  const t = () => TEXT[locale()];
  const filesAvailable = api.artifacts.available();

  applyAppearance(api.appearance.current());
  api.appearance.subscribe(applyAppearance);
  document.documentElement.lang = locale();

  /* ------------------------------------------------------------ the model */

  let sheet = createSheet();
  let parsedFormulas = new Map();
  let evaluation = evaluateSheet(sheet);
  const status = element("p", { role: "status", "data-sheet-status": "idle", class: "status" }, filesAvailable ? t().empty : t().noFiles);
  const say = (state, text) => {
    status.setAttribute("data-sheet-status", state);
    status.textContent = text;
  };
  const store = createStore({
    state: api.state,
    artifacts: filesAvailable ? api.artifacts : undefined,
    snapshot: () => sheet.rawRows(),
    onRefused: () => say("refused", t().stateRefused),
    onFailed: (error) => say("refused", t().failed(messageOf(error))),
  });
  const initial = store.saved();
  let formats = Array.isArray(initial.formats) ? initial.formats.filter((entry) => entry && typeof entry.range === "string") : [];
  /** Earlier format lists, latest last, for Undo. */
  const formatHistory = [];
  let truncated = readTruncated(initial.truncated);
  let active = parseCellName(String(initial.active ?? "A1")) ?? { row: 0, column: 0 };
  let anchor = parseCellName(String(initial.anchor ?? "A1")) ?? active;
  let lastExport;
  let busy = false;
  /** Clark is answering for the selection: it does not move until the answer is in. */
  let asking = false;
  /** Taps extend the selection from the anchor, for touch, where there is no Shift. */
  let rangeMode = false;

  const recompute = () => {
    evaluation = evaluateSheet(sheet, parsedFormulas);
    parsedFormulas = evaluation.parsed;
  };
  const valueAt = (row, column) => evaluation.get(row, column);
  const selection = () => normalizeRange(anchor, active);

  /* -------------------------------------------------------------- the DOM */

  const title = element("h2", { "data-sheet-title": "" }, String(props.title ?? ""));
  const importButton = element("button", { type: "button", "data-sheet-import": "" }, t().import);
  const exportCsv = element("button", { type: "button", "data-sheet-export": "csv" }, t().exportCsv);
  const exportTsv = element("button", { type: "button", "data-sheet-export": "tsv" }, t().exportTsv);
  const askFormat = element("button", { type: "button", "data-sheet-ask-format": "" }, t().askFormat);
  const selectRange = element("button", { type: "button", "data-sheet-select-range": "", "aria-pressed": "false" }, t().selectRange);
  const undoFormat = element("button", { type: "button", "data-sheet-undo-format": "", hidden: "" }, t().undoFormat);
  const actions = element("div", { class: "actions" });
  actions.append(importButton, exportCsv, exportTsv, askFormat, selectRange, undoFormat);
  const bar = element("header", { class: "bar" });
  bar.append(title, actions);

  const notice = element("p", { "data-sheet-notice": "", class: "notice", hidden: "" });
  const address = element("span", { class: "address", "data-sheet-address": "" }, "A1");
  const formula = element("output", { class: "formula-text", "data-sheet-formula": "", "aria-label": t().formula });
  const formulaBar = element("div", { class: "formula" });
  formulaBar.append(address, formula);

  // The grid is one stop in the tab order: arrows, Home/End and the page keys move inside it, Tab and Shift+Tab leave.
  const viewport = element("div", {
    class: "viewport",
    role: "grid",
    tabindex: "0",
    "aria-label": t().grid,
    "aria-multiselectable": "true",
    "data-sheet-grid": "",
  });
  const canvas = element("div", { class: "canvas", role: "presentation" });
  const head = element("div", { class: "row head", role: "row", "aria-rowindex": "1" });
  const body = element("div", { class: "body", role: "rowgroup" });
  const editor = element("input", { class: "editor", type: "text", "data-sheet-editor": "", hidden: "", "aria-label": t().formula });
  canvas.append(head, body, editor);
  viewport.append(canvas);

  root.append(bar, status, notice, formulaBar, viewport);

  /* --------------------------------------------------------- dimensions */

  const shown = () => {
    const size = sheet.used();
    const columns = Math.min(MAX_COLUMNS, Math.max(size.columns + 2, 8, active.column + 1));
    const rows = Math.min(MAX_ROWS, Math.max(size.rows + 20, 30, active.row + 1));
    return { rows, columns };
  };

  /* ------------------------------------------------------------ rendering */

  let rendered = { first: -1, last: -1, firstColumn: -1, lastColumn: -1 };
  let editing = false;

  const cellId = (row, column) => `cell-${String(row)}-${String(column)}`;

  const renderNotice = () => {
    const parts = [];
    const size = sheet.used();
    const cut = truncationNotice(truncated, size, locale());
    if (cut !== undefined) parts.push(cut);
    if (evaluation.cycles.length > 0) parts.push(t().circular(evaluation.cycles.slice(0, 12).join(", ")));
    if (evaluation.limited) parts.push(t().limited);
    notice.hidden = parts.length === 0;
    notice.textContent = parts.join(" ");
    notice.setAttribute("data-truncated", String(cut !== undefined));
    notice.setAttribute("data-circular", evaluation.cycles.join(","));
  };

  const renderGrid = (force = false) => {
    const dims = shown();
    viewport.setAttribute("aria-rowcount", String(dims.rows + 1));
    viewport.setAttribute("aria-colcount", String(dims.columns + 1));
    canvas.style.height = `${String((dims.rows + 1) * ROW_HEIGHT)}px`;
    canvas.style.width = `${String(HEADER_WIDTH + dims.columns * COLUMN_WIDTH)}px`;

    const top = viewport.scrollTop;
    const height = viewport.clientHeight || ROW_HEIGHT * 12;
    const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(dims.rows - 1, Math.ceil((top + height) / ROW_HEIGHT) + OVERSCAN);
    const left = viewport.scrollLeft;
    const width = viewport.clientWidth || COLUMN_WIDTH * 6;
    const firstColumn = Math.max(0, Math.floor((left - HEADER_WIDTH) / COLUMN_WIDTH) - 1);
    const lastColumn = Math.min(dims.columns - 1, Math.ceil((left + width) / COLUMN_WIDTH) + 1);
    if (!force && first === rendered.first && last === rendered.last && firstColumn === rendered.firstColumn && lastColumn === rendered.lastColumn) {
      return;
    }
    rendered = { first, last, firstColumn, lastColumn };
    const range = selection();

    const spacer = (columns) => element("div", { class: "spacer", role: "presentation", style: `width:${String(columns * COLUMN_WIDTH)}px` });

    head.replaceChildren();
    head.append(element("div", { class: "corner", role: "columnheader", "aria-colindex": "1" }, ""));
    if (firstColumn > 0) head.append(spacer(firstColumn));
    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const selected = column >= range.left && column <= range.right;
      head.append(
        element("div", { class: selected ? "colhead selected" : "colhead", role: "columnheader", "aria-colindex": String(column + 2) }, columnName(column)),
      );
    }

    const rows = [];
    for (let row = first; row <= last; row += 1) {
      const line = element("div", { class: "row", role: "row", "aria-rowindex": String(row + 2), style: `top:${String((row + 1) * ROW_HEIGHT)}px` });
      const rowSelected = row >= range.top && row <= range.bottom;
      line.append(element("div", { class: rowSelected ? "rowhead selected" : "rowhead", role: "rowheader", "aria-colindex": "1" }, String(row + 1)));
      if (firstColumn > 0) line.append(spacer(firstColumn));
      for (let column = firstColumn; column <= lastColumn; column += 1) {
        const value = valueAt(row, column);
        const text = displayValue(value, formatAt(formats, row, column));
        const selected = rowSelected && column >= range.left && column <= range.right;
        const classes = ["cell"];
        if (typeof value === "number") classes.push("number");
        if (isError(value)) classes.push("error");
        if (selected) classes.push("selected");
        if (row === active.row && column === active.column) classes.push("active");
        line.append(
          element(
            "div",
            {
              id: cellId(row, column),
              class: classes.join(" "),
              role: "gridcell",
              "aria-colindex": String(column + 2),
              "aria-selected": String(selected),
              "data-cell": cellName(row, column),
            },
            text,
          ),
        );
      }
      rows.push(line);
    }
    body.replaceChildren(...rows);
    canvas.setAttribute("data-rendered-rows", String(rows.length));
    const activeShown = active.row >= first && active.row <= last && active.column >= firstColumn && active.column <= lastColumn;
    if (activeShown) viewport.setAttribute("aria-activedescendant", cellId(active.row, active.column));
    else viewport.removeAttribute("aria-activedescendant");
  };

  const renderFormula = () => {
    address.textContent = rangeName(selection()) === cellName(active.row, active.column)
      ? cellName(active.row, active.column)
      : `${cellName(active.row, active.column)} · ${rangeName(selection())}`;
    formula.textContent = sheet.raw(active.row, active.column);
  };

  const publish = () => {
    const doc = semanticDocument({
      title: String(props.title ?? ""),
      locale: locale(),
      size: sheet.used(),
      selection: selection(),
      active,
      raw: sheet.raw,
      value: valueAt,
      formats,
      truncated: truncated.rows || truncated.columns || truncated.clipped,
      cycles: evaluation.cycles,
    });
    api.semantic.publish(doc.summary, doc.selectedIds, doc.values);
  };

  const render = (force = true) => {
    renderGrid(force);
    renderFormula();
    renderNotice();
  };

  const scrollIntoView = () => {
    const top = (active.row + 1) * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top - ROW_HEIGHT < viewport.scrollTop) viewport.scrollTop = Math.max(0, top - ROW_HEIGHT);
    else if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom - viewport.clientHeight;
    const left = HEADER_WIDTH + active.column * COLUMN_WIDTH;
    const right = left + COLUMN_WIDTH;
    if (left - HEADER_WIDTH < viewport.scrollLeft) viewport.scrollLeft = Math.max(0, left - HEADER_WIDTH);
    else if (right > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = right - viewport.clientWidth;
  };

  let frameRequested = false;
  viewport.addEventListener("scroll", () => {
    if (frameRequested) return;
    frameRequested = true;
    window.requestAnimationFrame(() => {
      frameRequested = false;
      renderGrid(false);
    });
  });

  /* -------------------------------------------------------- durable state */

  // The cursor is view state (`ephemeralStateKeys`): the host keeps it for the frame and never writes it to the node.
  // Moves are still coalesced, so holding an arrow key sends one message, not thirty a second.
  let cursorTimer;
  const saveCursor = () => {
    window.clearTimeout(cursorTimer);
    cursorTimer = window.setTimeout(() => {
      void store.persist({ active: cellName(active.row, active.column), anchor: cellName(anchor.row, anchor.column) });
    }, CURSOR_SAVE_MS);
  };

  const restore = async () => {
    const loaded = await store.load();
    sheet = loaded.sheet;
    truncated = loaded.truncated;
    if (loaded.gone) say("refused", t().sourceGone);
    recompute();
    render();
    publish();
  };

  /* --------------------------------------------------------------- moving */

  const moveTo = (row, column, extend) => {
    const dims = shown();
    active = {
      row: Math.max(0, Math.min(MAX_ROWS - 1, Math.min(row, dims.rows))),
      column: Math.max(0, Math.min(MAX_COLUMNS - 1, Math.min(column, dims.columns))),
    };
    if (!extend) anchor = active;
    scrollIntoView();
    render();
    publish();
    saveCursor();
  };

  const pageRows = () => Math.max(1, Math.floor(viewport.clientHeight / ROW_HEIGHT) - 1);

  /* -------------------------------------------------------------- editing */

  const write = (row, column, value) => {
    if (!sheet.set(row, column, value)) {
      say("refused", t().full);
      return false;
    }
    store.record([[cellName(row, column), sheet.raw(row, column)]]);
    return true;
  };

  const openEditor = (initialText) => {
    editing = true;
    editor.hidden = false;
    editor.style.top = `${String((active.row + 1) * ROW_HEIGHT)}px`;
    editor.style.left = `${String(HEADER_WIDTH + active.column * COLUMN_WIDTH)}px`;
    editor.value = initialText ?? sheet.raw(active.row, active.column);
    editor.setAttribute("data-cell", cellName(active.row, active.column));
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
  };

  const closeEditor = (commit, refocus = true) => {
    if (!editing) return;
    editing = false;
    const value = editor.value;
    editor.hidden = true;
    if (commit && value !== sheet.raw(active.row, active.column)) {
      if (write(active.row, active.column, value)) {
        recompute();
        store.save();
      }
    }
    render();
    publish();
    if (refocus) viewport.focus();
  };

  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      closeEditor(true);
      moveTo(active.row + (event.shiftKey ? -1 : 1), active.column, false);
    } else if (event.key === "Tab") {
      // Tab commits and moves along the row while editing; outside the editor Tab leaves the grid.
      event.preventDefault();
      closeEditor(true);
      moveTo(active.row, active.column + (event.shiftKey ? -1 : 1), false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeEditor(false);
    }
    event.stopPropagation();
  });
  editor.addEventListener("blur", () => closeEditor(true, false));

  const clearSelection = () => {
    const cleared = clearRange(sheet, selection());
    if (cleared.length === 0) return;
    store.record(cleared.map((name) => [name, ""]));
    recompute();
    store.save();
    render();
    publish();
  };

  /* --------------------------------------------------------------- formats */

  const renderUndo = () => {
    undoFormat.hidden = formatHistory.length === 0;
  };

  const setFormats = (next) => {
    formats = next;
    render();
    publish();
    renderUndo();
    return store.persist({ formats });
  };

  const undoLastFormat = () => {
    if (busy || formatHistory.length === 0) return;
    const previous = formatHistory.pop() ?? [];
    void setFormats(previous);
    say("formatted", t().undone);
  };

  /* -------------------------------------------------------------- keyboard */

  viewport.addEventListener("keydown", (event) => {
    if (editing) return;
    // Tab and Shift+Tab always leave the grid, so a keyboard user can reach the buttons and the rest of the page.
    if (event.key === "Tab") return;
    if (asking) {
      event.preventDefault();
      return;
    }
    const ctrl = event.ctrlKey || event.metaKey;
    const extend = event.shiftKey;
    const size = sheet.used();
    if (ctrl && !extend && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      undoLastFormat();
      return;
    }
    let handled = true;
    switch (event.key) {
      case "ArrowUp":
        moveTo(active.row - 1, active.column, extend);
        break;
      case "ArrowDown":
        moveTo(active.row + 1, active.column, extend);
        break;
      case "ArrowLeft":
        moveTo(active.row, active.column - 1, extend);
        break;
      case "ArrowRight":
        moveTo(active.row, active.column + 1, extend);
        break;
      case "Home":
        if (ctrl) moveTo(0, 0, extend);
        else moveTo(active.row, 0, extend);
        break;
      case "End":
        if (ctrl) moveTo(Math.max(0, size.rows - 1), Math.max(0, size.columns - 1), extend);
        else moveTo(active.row, Math.max(0, size.columns - 1), extend);
        break;
      case "PageDown":
        moveTo(active.row + pageRows(), active.column, extend);
        break;
      case "PageUp":
        moveTo(active.row - pageRows(), active.column, extend);
        break;
      case "Escape":
        // A range collapses to its active cell; a single cell lets Escape go on to the host.
        if (anchor.row !== active.row || anchor.column !== active.column) moveTo(active.row, active.column, false);
        else handled = false;
        break;
      case "Enter":
      case "F2":
        openEditor();
        break;
      case "Delete":
      case "Backspace":
        clearSelection();
        break;
      default:
        if (event.key.length === 1 && !ctrl && !event.altKey) openEditor(event.key);
        else handled = false;
    }
    if (handled) event.preventDefault();
  });

  /* --------------------------------------------------------------- pointer */

  const cellAt = (target) => {
    const node = target instanceof window.Element ? target.closest(".cell[data-cell]") : null;
    return node === null ? undefined : parseCellName(node.getAttribute("data-cell") ?? "");
  };

  /*
   * A mouse selects on press and extends while dragged. A finger or pen selects on tap (a click), so a swipe still
   * scrolls the grid; "Select range" makes the next taps extend the selection, which is how touch selects a range.
   */
  let pointerKind = "mouse";
  let dragging = false;
  viewport.addEventListener("pointerdown", (event) => {
    pointerKind = event.pointerType === "" ? "mouse" : event.pointerType;
    if (pointerKind !== "mouse" || event.button !== 0) return;
    const cell = cellAt(event.target);
    if (cell === undefined) return;
    if (editing) closeEditor(true);
    event.preventDefault();
    viewport.focus();
    if (asking) return;
    moveTo(cell.row, cell.column, event.shiftKey || rangeMode);
    dragging = true;
  });
  viewport.addEventListener("pointermove", (event) => {
    if (!dragging || asking) return;
    const cell = cellAt(document.elementFromPoint(event.clientX, event.clientY));
    if (cell !== undefined && (cell.row !== active.row || cell.column !== active.column)) moveTo(cell.row, cell.column, true);
  });
  const endDrag = () => {
    dragging = false;
  };
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  viewport.addEventListener("click", (event) => {
    if (pointerKind === "mouse") return;
    const cell = cellAt(event.target);
    if (cell === undefined) return;
    if (editing) closeEditor(true);
    viewport.focus({ preventScroll: true });
    if (asking) return;
    moveTo(cell.row, cell.column, event.shiftKey || rangeMode);
  });
  viewport.addEventListener("dblclick", (event) => {
    if (!asking && cellAt(event.target) !== undefined) openEditor();
  });

  selectRange.addEventListener("click", () => {
    rangeMode = !rangeMode;
    selectRange.setAttribute("aria-pressed", String(rangeMode));
    if (rangeMode) say("idle", t().rangeMode(cellName(anchor.row, anchor.column)));
  });

  undoFormat.addEventListener("click", undoLastFormat);

  /* ------------------------------------------------------- files: import */

  const setBusy = (next) => {
    busy = next;
    for (const button of [importButton, exportCsv, exportTsv]) button.disabled = next || !filesAvailable;
    askFormat.disabled = next || typeof props.formatBinding !== "string" || props.formatBinding === "";
    undoFormat.disabled = next;
  };

  importButton.addEventListener("click", () => {
    if (busy) return;
    setBusy(true);
    say("working", t().picking);
    void (async () => {
      const ref = await api.artifacts.pick({ accept: ["text/csv", "text/tab-separated-values"] });
      if (ref === undefined) {
        say("cancelled", t().cancelled);
        return;
      }
      say("working", t().reading);
      const delimiter = delimiterFor(ref.mimeType, ref.name);
      const result = await readSheetFile(api.artifacts, ref, delimiter);
      sheet = createSheet(result.rows);
      formats = [];
      formatHistory.length = 0;
      renderUndo();
      truncated = result.truncated;
      active = { row: 0, column: 0 };
      anchor = active;
      viewport.scrollTop = 0;
      viewport.scrollLeft = 0;
      recompute();
      render();
      publish();
      await store.replaceSource({
        source: ref,
        delimiter,
        name: String(ref.name ?? "").slice(0, 200),
        formats: [],
        truncated,
        active: "A1",
        anchor: "A1",
      });
      const size = sheet.used();
      say("loaded", t().loaded(String(ref.name ?? ""), size.rows, size.columns));
    })()
      .catch((error) => say("refused", t().failed(messageOf(error))))
      .finally(() => setBusy(false));
  });

  /* ------------------------------------------------------- files: export */

  const exportAs = (kind) => {
    if (busy) return;
    setBusy(true);
    say("working", t().exporting);
    const delimiter = kind === "tsv" ? "\t" : ",";
    const mimeType = kind === "tsv" ? "text/tab-separated-values" : "text/csv";
    const base = String(store.saved().name ?? "").replace(/\.[A-Za-z0-9]{1,8}$/u, "") || t().exportName;
    void (async () => {
      const size = sheet.used();
      const rows = [];
      for (let row = 0; row < size.rows; row += 1) {
        const cells = [];
        for (let column = 0; column < size.columns; column += 1) {
          const value = valueAt(row, column);
          cells.push(isError(value) ? value.error : value);
        }
        rows.push(cells);
      }
      // A byte-order mark, as the host's own table export writes, so a spreadsheet opens the file as UTF-8.
      const ref = await writeTextFile(api.artifacts, `\uFEFF${writeDelimited(rows, delimiter)}`, mimeType, `${base}.${kind}`);
      if (lastExport !== undefined) await api.artifacts.discard(lastExport).catch(() => undefined);
      lastExport = ref;
      const done = await api.artifacts.export(ref, { suggestedName: `${base}.${kind}` });
      say(done ? "saved" : "cancelled", done ? t().saved : t().notSaved);
    })()
      .catch((error) => say("refused", t().failed(messageOf(error))))
      .finally(() => setBusy(false));
  };
  exportCsv.addEventListener("click", () => exportAs("csv"));
  exportTsv.addEventListener("click", () => exportAs("tsv"));

  /* ---------------------------------------------------- Clark formatting */

  const lockSelection = (locked) => {
    asking = locked;
    viewport.setAttribute("aria-busy", String(locked));
    viewport.toggleAttribute("data-selection-locked", locked);
  };

  askFormat.addEventListener("click", () => {
    const binding = props.formatBinding;
    if (busy || typeof binding !== "string" || binding === "") return;
    if (editing) closeEditor(true, false);
    setBusy(true);
    // The host reads the selection from what this widget published; it stays put until the answer is in, and the
    // answer is applied only to this range.
    lockSelection(true);
    const asked = selection();
    say("working", t().asking);
    askFormat.setAttribute("data-format-result", "pending");
    void (async () => {
      const reply = await api.actions.invoke(binding, {}, randomId());
      const directive = readFormatDirective(reply, asked);
      if (!directive.ok) {
        askFormat.setAttribute("data-format-result", "refused");
        say("refused", directive.reason === "other-range" ? t().refusedRange(directive.range) : t().refusedReply);
        return;
      }
      const next = applyFormat(formats, directive.range, directive.format);
      formatHistory.push(formats);
      if (formatHistory.length > MAX_UNDO) formatHistory.shift();
      await setFormats(next.formats);
      askFormat.setAttribute("data-format-result", "applied");
      const name = rangeName(directive.range);
      const done = directive.format === "percent" ? t().applied(name) : t().appliedOther(name, directive.format);
      const lost = next.dropped.map((entry) => entry.range).join(", ");
      say("formatted", lost === "" ? done : `${done} ${t().dropped(lost)}`);
    })()
      .catch((error) => {
        askFormat.setAttribute("data-format-result", "failed");
        say("refused", t().failed(messageOf(error)));
      })
      .finally(() => {
        lockSelection(false);
        setBusy(false);
      });
  });

  /* ------------------------------------------------------------ the rest */

  api.props.subscribe((next) => {
    props = next;
    title.textContent = String(props.title ?? "");
    setBusy(busy);
  });

  const fit = () => api.host.resize({ height: Math.ceil(document.documentElement.scrollHeight) });
  new window.ResizeObserver(() => {
    renderGrid(false);
    fit();
  }).observe(document.body);

  setBusy(false);
  render();
  fit();
  void restore().then(() => {
    root.setAttribute("data-widget-ready", "true");
    fit();
  });
}

start();
