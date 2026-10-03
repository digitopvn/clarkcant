/*
 * Reference app A: a text editor that opens and saves a real file.
 *
 * The frame code. It holds a file only as an ArtifactRef from `api.artifacts`: the person picks in the host's chrome,
 * the editor reads the bytes in bounded chunks, keeps the draft in widget state, and asks the host to save a finalized
 * copy — back over the original on the desktop, as a download on the web — or to attach it to the conversation. It never
 * sees a path, a handle or a secret, because nothing it is given has one.
 *
 * Asking Clark goes through the editor's own `agent` binding, named in props by whoever placed it. The host sends the
 * semantic document this code publishes before it runs the press, reads the selection from it, starts the turn, and
 * returns Clark's reply as the binding's output. The reply is shown for review and touches the text only when the
 * person accepts it.
 *
 * The rules (what is unsaved, what is kept, which draft wins, what a reply may change) live in `editor-core.js`.
 */

import {
  ACCEPTED_TYPES,
  EDITOR_LIMITS,
  applyReplacement,
  askableSelection,
  chunksOf,
  clampSelection,
  createLoadOrder,
  decodeText,
  extractReplacement,
  isDirty,
  lineCount,
  markSaved,
  openDocument,
  persistedState,
  readPersistedState,
  reconcileState,
  restoreDocument,
  semanticProposal,
  withDraft,
} from "./editor-core.js";

/** How long typing must pause before the draft is written to widget state. */
const DRAFT_WRITE_DELAY_MS = 400;

const TEXT = {
  open: "Mở tệp",
  save: "Lưu",
  attach: "Đính kèm vào cuộc trò chuyện",
  ask: "Nhờ Clark viết lại đoạn chọn",
  apply: "Thay đoạn đã chọn",
  dismiss: "Bỏ qua",
  keepMine: "Giữ bản của tôi",
  useTheirs: "Dùng bản kia",
  discardAndOpen: "Bỏ thay đổi và mở tệp khác",
  cancel: "Huỷ",
  noFile: "Chưa mở tệp nào",
  label: "Nội dung tệp",
  unsaved: "chưa lưu",
  saved: "đã lưu",
  lines: (count) => `${String(count)} dòng`,
  selected: (count) => `đã chọn ${String(count)} ký tự`,
  askReason: {
    "no-binding": "Clark chưa được gắn vào trình soạn thảo này, nên chưa nhờ được.",
    "no-file": "Mở một tệp trước.",
    empty: "Chọn một đoạn văn bản để nhờ Clark viết lại.",
    "too-long": `Đoạn chọn quá dài: Clark chỉ đọc được tối đa ${String(EDITOR_LIMITS.excerptChars)} ký tự; hãy chọn ít hơn.`,
    "one-line": "Clark sẽ đọc đoạn này thành một dòng, nên câu trả lời không giữ được xuống dòng hay khoảng trắng liền nhau; hãy chọn trong một dòng.",
    hidden: "Đoạn chọn có ký tự ẩn hoặc khoảng trắng đặc biệt (như khoảng trắng không ngắt dòng) mà Clark sẽ đọc thành dấu cách; hãy chọn đoạn không có chúng.",
    redacted: "Đoạn chọn có nội dung Clark không được xem vì có thể là thông tin riêng (địa chỉ e-mail, dãy số dài, đường dẫn thư mục hay chuỗi giống khoá bí mật); hãy chọn đoạn không có chúng.",
    // The status line already says what the editor is waiting for; a second sentence would only repeat it.
    busy: "",
  },
};

const root = document.getElementById("root");

function element(tag, attributes = {}, text) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** A refusal's sentence: the SDK rejects with the host's code first, which is the part a person can act on. */
function reasonOf(error) {
  const message = error && typeof error.message === "string" ? error.message : String(error);
  return message.slice(0, 400);
}

/** Host colour tokens this editor draws with. The values passed the host's schema; only their names are chosen here. */
const COLOR_TOKENS = {
  canvas: "--ed-canvas",
  card: "--ed-surface",
  code: "--ed-field",
  text: "--ed-text",
  textMuted: "--ed-muted",
  border: "--ed-line",
  accent: "--ed-accent",
  onAccent: "--ed-on-accent",
  focus: "--ed-focus",
  danger: "--ed-danger",
  success: "--ed-success",
  warning: "--ed-warning",
};

function applyAppearance(snapshot) {
  if (snapshot === undefined || snapshot === null) return;
  const style = document.documentElement.style;
  const colors = snapshot.tokens && snapshot.tokens.color ? snapshot.tokens.color : {};
  for (const [token, variable] of Object.entries(COLOR_TOKENS)) {
    const value = colors[token];
    if (typeof value === "string" && value.length <= 64) style.setProperty(variable, value);
  }
  style.setProperty("color-scheme", snapshot.scheme === "dark" ? "dark" : "light");
  document.documentElement.setAttribute("data-scheme", snapshot.scheme === "dark" ? "dark" : "light");
}

function start() {
  const runtime = window.clarkcantWidget;
  if (runtime === undefined || runtime.status() !== "ready") {
    setTimeout(start, 20);
    return;
  }
  if (root.dataset.drawn === "true") return;
  root.dataset.drawn = "true";
  const api = runtime.api();

  applyAppearance(api.appearance.current());
  api.appearance.subscribe(applyAppearance);

  /** @type {import("./editor-core.js").EditorDocument | undefined} */
  let doc;
  /** What this view last knew the host held, so a change from another view can be told from this view's own. */
  let synced = readPersistedState(api.state.get());
  let selection = { start: 0, end: 0 };
  let busy = false;
  /** True from the press until Clark answers: the text area is read-only and the published selection is held. */
  let asking = false;
  let asked;
  let proposal;
  let incomingConflict;
  let draftTimer;
  let writing = false;
  let writeAgain = false;
  /** This view's write the host has not answered yet, so its commit is recognized as this view's own. */
  let pendingWrite;
  /** Holds state committed during the first restore, and drops a load a newer one has overtaken. */
  const loads = createLoadOrder();
  let lastPublished = "";
  let disposed = false;

  const props = () => api.props.read();
  const rewriteBinding = () => {
    const value = props().rewriteBinding;
    return typeof value === "string" && value !== "" ? value : undefined;
  };

  /* ------------------------------------------------------------ markup */

  const header = element("div", { class: "header" });
  const name = element("h2", { "data-editor-name": "", id: "editor-name" }, TEXT.noFile);
  const badge = element("span", { class: "badge", "data-editor-dirty": "false" }, "");
  header.append(name, badge);

  const toolbar = element("div", { class: "toolbar", role: "toolbar", "aria-label": "Trình soạn thảo" });
  const openButton = element("button", { type: "button", "data-editor-open": "" }, TEXT.open);
  const saveButton = element("button", { type: "button", "data-editor-save": "", "aria-keyshortcuts": "Control+S Meta+S" }, TEXT.save);
  const attachButton = element("button", { type: "button", "data-editor-attach": "" }, TEXT.attach);
  const askButton = element("button", { type: "button", class: "agent", "data-editor-ask": "", "aria-describedby": "editor-ask-reason" }, TEXT.ask);
  toolbar.append(openButton, saveButton, attachButton, askButton);

  const fieldLabel = element("label", { for: "editor-text", class: "visually-hidden" }, TEXT.label);
  const textarea = element("textarea", {
    id: "editor-text",
    "data-editor-text": "",
    spellcheck: "false",
    rows: "12",
    "aria-describedby": "editor-meta editor-status",
  });
  textarea.disabled = true;

  const meta = element("p", { id: "editor-meta", class: "muted", "data-editor-meta": "" }, "");
  const askReason = element("p", { id: "editor-ask-reason", class: "muted", "data-editor-ask-reason": "" }, "");
  const status = element("p", { id: "editor-status", role: "status", "aria-live": "polite", "data-editor-status": "idle" }, "");
  const notice = element("p", { class: "notice", "data-editor-notice": "", hidden: "" }, "");

  // Asked before discarding unsaved work; the choice is the person's and stays inside the editor.
  const discardPanel = element("div", { class: "panel", role: "group", "aria-labelledby": "editor-discard-title", "data-editor-discard": "", hidden: "" });
  const discardTitle = element("p", { id: "editor-discard-title", tabindex: "-1" }, "Bạn có thay đổi chưa lưu. Mở tệp khác sẽ bỏ chúng.");
  const discardYes = element("button", { type: "button", "data-editor-discard-confirm": "" }, TEXT.discardAndOpen);
  const discardNo = element("button", { type: "button", "data-editor-discard-cancel": "" }, TEXT.cancel);
  discardPanel.append(discardTitle, element("div", { class: "actions" }));
  discardPanel.lastChild.append(discardYes, discardNo);

  // Another view of this editor changed the draft while this one had unsent edits. Neither is thrown away.
  const conflictPanel = element("div", { class: "panel warning", role: "group", "aria-labelledby": "editor-conflict-title", "data-editor-conflict": "", hidden: "" });
  const conflictTitle = element(
    "p",
    { id: "editor-conflict-title", tabindex: "-1" },
    "Một cửa sổ khác của trình soạn thảo này vừa đổi bản nháp. Bản của bạn vẫn còn ở đây; hãy chọn giữ bản nào.",
  );
  const keepMine = element("button", { type: "button", "data-editor-keep-mine": "" }, TEXT.keepMine);
  const useTheirs = element("button", { type: "button", "data-editor-use-theirs": "" }, TEXT.useTheirs);
  conflictPanel.append(conflictTitle, element("div", { class: "actions" }));
  conflictPanel.lastChild.append(keepMine, useTheirs);

  // Clark's answer, shown before it touches anything. It is untrusted text, and it changes the draft only when accepted.
  const proposalPanel = element("section", { class: "panel proposal", "aria-labelledby": "editor-proposal-title", "data-editor-proposal": "", hidden: "" });
  const proposalTitle = element("h3", { id: "editor-proposal-title", tabindex: "-1" }, "");
  // The text the replacement would take the place of, so accepting it is a judgement the person can make.
  const proposalReplaces = element("p", { class: "muted", "data-editor-proposal-replaces": "" }, "");
  const proposalText = element("pre", { "data-editor-proposal-text": "" }, "");
  const applyButton = element("button", { type: "button", class: "primary", "data-editor-apply": "" }, TEXT.apply);
  const dismissButton = element("button", { type: "button", "data-editor-dismiss": "" }, TEXT.dismiss);
  proposalPanel.append(proposalTitle, proposalReplaces, proposalText, element("div", { class: "actions" }));
  proposalPanel.lastChild.append(applyButton, dismissButton);

  root.append(header, toolbar, discardPanel, conflictPanel, fieldLabel, textarea, meta, askReason, notice, proposalPanel, status);

  /* ------------------------------------------------------------ view */

  const say = (state, message) => {
    status.setAttribute("data-editor-status", state);
    status.textContent = message;
  };

  function askState() {
    if (rewriteBinding() === undefined) return { ok: false, reason: "no-binding" };
    if (busy) return { ok: false, reason: "busy" };
    return askableSelection(doc, selection);
  }

  function render() {
    const dirty = isDirty(doc);
    name.textContent = doc === undefined ? TEXT.noFile : doc.file.name;
    name.setAttribute("data-editor-name", doc === undefined ? "" : doc.file.name);
    badge.textContent = doc === undefined ? "" : dirty ? TEXT.unsaved : TEXT.saved;
    badge.setAttribute("data-editor-dirty", String(dirty));
    textarea.disabled = doc === undefined;
    openButton.disabled = busy;
    saveButton.disabled = busy || doc === undefined;
    attachButton.disabled = busy || doc === undefined;
    const ask = askState();
    askButton.disabled = !ask.ok;
    askReason.textContent = ask.ok ? "" : TEXT.askReason[ask.reason];
    const range = doc === undefined ? { start: 0, end: 0 } : clampSelection(doc.draft, selection);
    const chosen = doc === undefined ? 0 : Array.from(doc.draft.slice(range.start, range.end)).length;
    meta.textContent = doc === undefined ? "" : [TEXT.lines(lineCount(doc.draft)), ...(chosen > 0 ? [TEXT.selected(chosen)] : [])].join(" · ");
    const tooLarge = doc !== undefined && persistedState(doc).draftTooLarge;
    notice.hidden = !tooLarge;
    notice.textContent = tooLarge ? "Bản nháp này quá lớn để giữ lại khi tải lại trang; hãy lưu để không mất." : "";
    root.setAttribute("data-editor-busy", String(busy));
  }

  /** Tell the host what the editor shows. Unchanged documents are not sent again. */
  function publish() {
    const next = semanticProposal(doc, selection);
    const key = JSON.stringify(next);
    if (key === lastPublished) return;
    lastPublished = key;
    api.semantic.publish(next.summary, next.selectedIds, next.values);
  }

  function readSelection() {
    // While Clark is asked, the selection it was asked about stays the one published; it is read again afterwards.
    if (doc === undefined || asking) return;
    const next = clampSelection(doc.draft, { start: textarea.selectionStart, end: textarea.selectionEnd });
    if (next.start === selection.start && next.end === selection.end) return;
    selection = next;
    render();
    publish();
  }

  /* ------------------------------------------------------------ state */

  /** Write what the editor holds to widget state, one write at a time; a refusal is answered by the host's state. */
  async function writeState() {
    // A view with no document has nothing of its own to keep; until the person opens a file, it never writes.
    if (doc === undefined) return;
    if (writing) {
      writeAgain = true;
      return;
    }
    writing = true;
    const next = persistedState(doc);
    const expectedRevision = api.state.revision();
    // Set before the write: the host's commit reaches `onState` before the write's promise resolves here.
    pendingWrite = { state: next, expectedRevision };
    try {
      await api.state.update(expectedRevision, next);
      synced = next;
    } catch (error) {
      // A stale or refused write is followed by the host's committed state, which `onState` reconciles. Anything
      // else is said, and the draft stays on screen.
      if (!/STALE|REVISION/i.test(reasonOf(error))) say("refused", `Chưa giữ được bản nháp: ${reasonOf(error)}`);
    } finally {
      pendingWrite = undefined;
      writing = false;
      if (writeAgain && !disposed) {
        writeAgain = false;
        void writeState();
      }
    }
  }

  function scheduleWrite() {
    if (draftTimer !== undefined) window.clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      draftTimer = undefined;
      void writeState();
    }, DRAFT_WRITE_DELAY_MS);
  }

  async function readAll(ref) {
    const parts = [];
    let offset = 0;
    for (;;) {
      const { bytes, eof } = await api.artifacts.read(ref, { offset, length: EDITOR_LIMITS.chunkBytes });
      parts.push(bytes);
      offset += bytes.byteLength;
      if (offset > EDITOR_LIMITS.openBytes) throw new Error("FILE_TOO_LARGE: the file is larger than this editor opens");
      if (eof || bytes.byteLength === 0) break;
    }
    const text = decodeText(parts);
    if (text === undefined) throw new Error("NOT_UTF8: the file is not UTF-8 text, so it is not opened as text");
    return text;
  }

  /**
   * Rebuild the document from persisted state: read the saved bytes again, then lay the unsaved draft over them.
   * Resolves `false`, having changed nothing, when a newer load or an opened file overtook it while it read.
   */
  async function load(persisted) {
    const current = loads.begin();
    if (persisted.file === null || persisted.base === null) {
      doc = undefined;
      textarea.value = "";
      return true;
    }
    let text;
    let failure;
    try {
      text = await readAll(persisted.base);
    } catch (error) {
      failure = reasonOf(error);
    }
    if (!current()) return false;
    doc = restoreDocument(persisted, text);
    textarea.value = doc === undefined ? "" : doc.draft;
    if (failure !== undefined) {
      // The draft is still the person's when the saved copy cannot be read back, so it is shown and kept unsaved.
      // Without one there is nothing to show, and an empty text area must not pass for the file.
      say(
        "refused",
        doc === undefined
          ? `Không đọc lại được “${persisted.file.name}”: ${failure}. Hãy mở lại tệp.`
          : `Không đọc lại được tệp đã lưu: ${failure}. Bản nháp của bạn vẫn ở đây.`,
      );
      return true;
    }
    if (persisted.draftTooLarge) {
      say("draft-lost", "Bản nháp chưa lưu lần trước quá lớn để giữ lại khi tải lại; đây là bản đã lưu gần nhất.");
    }
    return true;
  }

  async function onState(state, revision) {
    if (disposed) return;
    // Still restoring is not "no document": what arrives now is reconciled once the restore has finished.
    if (!loads.offer({ state, revision })) return;
    const incoming = readPersistedState(state);
    const decision = reconcileState({
      local: persistedState(doc),
      synced,
      incoming,
      revision,
      pending: pendingWrite,
      documentOpen: doc !== undefined,
    });
    if (decision === "unchanged" || decision === "echo") {
      // An echo is this view's own write; anything typed since is written by the write already scheduled for it.
      synced = incoming;
      return;
    }
    if (decision === "keep") return;
    if (decision === "adopt") {
      synced = incoming;
      // Overtaken by a newer load: that one shows its state and says so.
      if (!(await load(incoming))) return;
      selection = { start: 0, end: 0 };
      render();
      publish();
      say("updated", "Bản nháp đã được cập nhật từ một cửa sổ khác.");
      return;
    }
    incomingConflict = incoming;
    conflictPanel.hidden = false;
    // Someone typing keeps the keyboard; the panel is announced by the status line and waits for them.
    if (document.activeElement !== textarea) conflictTitle.focus();
    say("conflict", "Hai bản nháp khác nhau; chưa bản nào bị bỏ.");
  }

  /* ------------------------------------------------------------ actions */

  async function finalizedCopy() {
    const bytes = new window.TextEncoder().encode(doc.draft);
    let ref = await api.artifacts.create({ mimeType: doc.file.mimeType, name: doc.file.name });
    for (const chunk of chunksOf(bytes)) ref = await api.artifacts.write(ref, chunk);
    return api.artifacts.finalize(ref);
  }

  /** Give back a copy this editor made. The picked file is the person's and is never discarded here. */
  function release(ref) {
    if (ref === undefined || doc === undefined || ref.artifactId === doc.file.artifactId) return;
    api.artifacts.discard(ref).catch((error) => {
      // Space is returned when the conversation's files are cleaned up anyway; the person has nothing to do here.
      window.console.warn(`the editor could not give back a copy it no longer needs: ${reasonOf(error)}`);
    });
  }

  async function run(state, message, task) {
    busy = true;
    render();
    say(state, message);
    try {
      await task();
    } catch (error) {
      say("refused", reasonOf(error));
    } finally {
      busy = false;
      render();
    }
  }

  function pickAndOpen() {
    discardPanel.hidden = true;
    void run("working", "Đang chờ bạn chọn tệp…", async () => {
      const ref = await api.artifacts.pick({ accept: ACCEPTED_TYPES });
      if (ref === undefined) {
        say("cancelled", "Bạn đã đóng hộp chọn tệp.");
        return;
      }
      if (ref.sizeBytes > EDITOR_LIMITS.openBytes) {
        say("refused", `“${ref.name}” lớn hơn 1 MiB, nên trình soạn thảo này không mở.`);
        return;
      }
      const previous = doc;
      const text = await readAll(ref);
      if (previous !== undefined && previous.base.artifactId !== previous.file.artifactId) release(previous.base);
      // The picked file replaces the document: a load still reading an older state must not land over it.
      loads.begin();
      doc = openDocument(ref, text);
      textarea.value = text;
      selection = { start: 0, end: 0 };
      proposal = undefined;
      proposalPanel.hidden = true;
      await writeState();
      publish();
      say("opened", `Đã mở “${ref.name}”.`);
    });
  }

  openButton.addEventListener("click", () => {
    if (isDirty(doc)) {
      discardPanel.hidden = false;
      discardTitle.focus();
      return;
    }
    pickAndOpen();
  });
  discardYes.addEventListener("click", pickAndOpen);
  discardNo.addEventListener("click", () => {
    discardPanel.hidden = true;
    openButton.focus();
  });

  function save() {
    if (doc === undefined || busy) return;
    void run("working", "Đang chuẩn bị bản để lưu…", async () => {
      const text = doc.draft;
      const copy = await finalizedCopy();
      say("working", "Đang chờ bạn lưu ở hộp của ứng dụng…");
      const saved = await api.artifacts.export(copy, { suggestedName: doc.file.name });
      if (!saved) {
        release(copy);
        say("cancelled", "Chưa lưu: bạn đã đóng hộp lưu.");
        return;
      }
      const previousBase = doc.base;
      doc = markSaved(doc, copy, text);
      if (previousBase.artifactId !== doc.file.artifactId) release(previousBase);
      await writeState();
      publish();
      /*
       * The host decided where it went and says so in its own words. The editor only knows the host took the copy: on
       * the desktop it was written, on the web a download has only started. So this says what is true in both.
       */
      say("saved", `Đã giao bản lưu “${doc.file.name}” cho ứng dụng; xem thông báo của ứng dụng để biết nó ở đâu.`);
    });
  }
  saveButton.addEventListener("click", save);

  attachButton.addEventListener("click", () => {
    if (doc === undefined) return;
    void run("working", "Đang chuẩn bị bản để đính kèm…", async () => {
      const copy = await finalizedCopy();
      await api.artifacts.attachToConversation(copy);
      say("attached", `Đã đưa “${doc.file.name}” vào ô soạn tin; gửi tin nhắn để chia sẻ.`);
    });
  });

  askButton.addEventListener("click", () => {
    const binding = rewriteBinding();
    const ask = askableSelection(doc, selection);
    if (binding === undefined || !ask.ok || busy) return;
    /*
     * The range Clark is asked about is the trimmed selection, published as it is now. The host sends any publish still
     * settling before it runs the press, so Clark reads this selection; and until the answer comes the text area is
     * read-only and the published selection is held, so nothing on screen moves away from what Clark read.
     */
    asking = true;
    textarea.readOnly = true;
    selection = { start: ask.start, end: ask.end };
    textarea.setSelectionRange(ask.start, ask.end);
    publish();
    asked = ask;
    void run("asking", "Đang nhờ Clark…", async () => {
      try {
        const output = await api.actions.invoke(binding, {}, window.crypto.randomUUID());
        const replacement = extractReplacement(output);
        if (replacement === undefined) {
          // Not a proposal: shown as what Clark said, with nothing to apply.
          proposal = undefined;
          showProposal("Clark trả lời", typeof output === "string" ? output.slice(0, EDITOR_LIMITS.replyChars) : "", false);
          say("no-proposal", "Clark đã trả lời nhưng không kèm đúng một đoạn thay thế trong khối ```, nên không có gì để thay.");
          return;
        }
        proposal = replacement;
        showProposal("Clark đề xuất thay cho đoạn đã chọn", replacement, true);
        say("proposed", "Clark đã đề xuất một đoạn thay thế. Xem rồi chọn thay hoặc bỏ qua.");
      } finally {
        asking = false;
        textarea.readOnly = false;
      }
    });
  });

  function showProposal(title, text, applicable) {
    proposalTitle.textContent = title;
    proposalReplaces.textContent = asked === undefined ? "" : `Thay cho: «${asked.text}»`;
    proposalReplaces.hidden = !applicable;
    proposalText.textContent = text;
    applyButton.hidden = !applicable;
    proposalPanel.hidden = false;
    proposalTitle.focus();
  }

  /**
   * Put the accepted text in through the browser's editing, so Undo takes it back like any typed change; the `input`
   * event that follows updates the draft. Where that is not available the value is set directly, which the browser does
   * not record for Undo, and the answer says so by not offering it.
   */
  function insertReplacement(range, replacement, expected) {
    textarea.focus();
    textarea.setSelectionRange(range.start, range.end);
    let inserted;
    try {
      inserted = document.execCommand("insertText", false, replacement);
    } catch {
      inserted = false;
    }
    if (inserted && textarea.value === expected) return true;
    textarea.value = expected;
    textarea.dispatchEvent(new window.Event("input"));
    return false;
  }

  applyButton.addEventListener("click", () => {
    if (doc === undefined || proposal === undefined || asked === undefined) return;
    const applied = applyReplacement(doc, asked, proposal);
    proposalPanel.hidden = true;
    proposal = undefined;
    if (!applied.ok) {
      say("changed", "Đoạn bạn đã chọn đã thay đổi từ lúc hỏi Clark, nên chưa thay. Hãy chọn lại và hỏi lại.");
      textarea.focus();
      return;
    }
    const undoable = insertReplacement(asked, applied.doc.draft.slice(asked.start, applied.selection.end), applied.doc.draft);
    selection = applied.selection;
    textarea.setSelectionRange(selection.start, selection.end);
    render();
    publish();
    say("applied", `Đã thay đoạn đã chọn. Thay đổi chưa được lưu vào tệp${undoable ? "; Ctrl+Z để hoàn tác" : ""}.`);
  });

  /*
   * The action this widget offers Clark (`offeredActions` in widget.json): replace the selected text. The host has
   * already checked the input against the declared schema and the person's policy. The widget acts only on a selection
   * Clark could read in full — the same rule as the ask button — and, when Clark says what it read, only while the
   * selection still is that text. It goes in through the browser's editing, so Ctrl+Z takes it back like a typed change.
   */
  if (typeof api.actions.offer === "function") {
    api.actions.offer("replaceSelection", (input) => {
      if (busy || asking) throw new Error("EDITOR_BUSY: trình soạn thảo đang bận; không có gì thay đổi");
      const ask = askableSelection(doc, selection);
      if (!ask.ok) throw new Error(`NO_USABLE_SELECTION: ${TEXT.askReason[ask.reason] || "không có đoạn chọn dùng được"}; không có gì thay đổi`);
      if (typeof input.expected === "string" && input.expected !== ask.text) {
        throw new Error("SELECTION_CHANGED: đoạn đang chọn không còn là đoạn Clark đã đọc; không có gì thay đổi");
      }
      const replacement = String(input.text ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "");
      const applied = applyReplacement(doc, ask, replacement);
      if (!applied.ok) throw new Error("SELECTION_CHANGED: đoạn đang chọn đã thay đổi; không có gì thay đổi");
      const undoable = insertReplacement(ask, replacement, applied.doc.draft);
      selection = applied.selection;
      textarea.setSelectionRange(selection.start, selection.end);
      render();
      publish();
      const said = `Clark đã thay đoạn đã chọn. Thay đổi chưa được lưu vào tệp${undoable ? "; Ctrl+Z để hoàn tác" : ""}.`;
      say("applied", said);
      return said;
    });
  }

  dismissButton.addEventListener("click", () => {
    proposalPanel.hidden = true;
    proposal = undefined;
    say("dismissed", "Đã bỏ qua đề xuất của Clark.");
    textarea.focus();
  });

  keepMine.addEventListener("click", () => {
    conflictPanel.hidden = true;
    // Only a view with a document has a draft to keep; `writeState` would refuse anyway, so nothing is claimed kept.
    if (doc === undefined) {
      incomingConflict = undefined;
      return;
    }
    // Mine is written over theirs at the revision the host now holds, which is what keeping it means.
    if (incomingConflict !== undefined) synced = incomingConflict;
    incomingConflict = undefined;
    void writeState();
    say("kept", "Đã giữ bản nháp của bạn.");
    textarea.focus();
  });

  useTheirs.addEventListener("click", () => {
    conflictPanel.hidden = true;
    const incoming = incomingConflict;
    incomingConflict = undefined;
    if (incoming === undefined) return;
    synced = incoming;
    void load(incoming).then((applied) => {
      if (!applied) return;
      selection = { start: 0, end: 0 };
      render();
      publish();
      say("updated", "Đã dùng bản nháp từ cửa sổ kia.");
      textarea.focus();
    });
  });

  textarea.addEventListener("input", () => {
    if (doc === undefined) return;
    doc = withDraft(doc, textarea.value);
    selection = clampSelection(doc.draft, { start: textarea.selectionStart, end: textarea.selectionEnd });
    render();
    publish();
    scheduleWrite();
  });
  for (const type of ["select", "keyup", "mouseup", "focus"]) textarea.addEventListener(type, readSelection);
  document.addEventListener("selectionchange", readSelection);

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      save();
      return;
    }
    if (event.key !== "Escape") return;
    if (!proposalPanel.hidden) {
      event.preventDefault();
      dismissButton.click();
    } else if (!discardPanel.hidden) {
      event.preventDefault();
      discardNo.click();
    } else if (!conflictPanel.hidden) {
      // Closing the question keeps what is on screen, which is this view's draft.
      event.preventDefault();
      keepMine.click();
    }
  });

  api.state.subscribe((state, revision) => void onState(state, revision));
  api.props.subscribe(() => render());
  api.lifecycle.onDispose(() => {
    disposed = true;
    if (draftTimer !== undefined) window.clearTimeout(draftTimer);
  });

  /*
   * The frame opens at the host's default height and cannot grow on its own, so it asks for its content's height
   * whenever that changes — on a phone the toolbar wraps and the panels push the status line down.
   */
  const fit = () => api.host.resize({ height: Math.ceil(document.documentElement.scrollHeight) });
  new window.ResizeObserver(fit).observe(document.body);

  void (async () => {
    const restored = readPersistedState(api.state.get());
    if (restored.file !== null) say("working", `Đang mở lại “${restored.file.name}”…`);
    // Overtaken only when the person opened a file meanwhile, which then shows itself.
    if (await load(restored)) {
      render();
      publish();
      if (restored.file !== null && status.getAttribute("data-editor-status") === "working") {
        say("restored", isDirty(doc) ? "Đã mở lại tệp cùng bản nháp chưa lưu." : "Đã mở lại tệp.");
      }
    }
    // State another view committed while this one restored is reconciled against what the restore produced.
    const held = loads.finishRestore();
    if (held !== undefined) await onState(held.state, held.revision);
    fit();
    root.setAttribute("data-editor-ready", "true");
  })();
}

start();
