/*
 * Reference app C: an image generator whose images come from a provider the node reaches for it.
 *
 * The frame code. The prompt goes to the `invoke` binding named in props (`generateBinding`), which calls the
 * package's `image.generate@1` capability. That answers at once with a JobRef: the image is made as a durable job the
 * node owns, so it goes on while this frame is gone. The frame asks the host for this widget's jobs — including ones
 * started by voice or by Clark through the same binding — follows the open ones, and reads finished images as
 * ArtifactRefs, in bounded chunks, into the gallery. Attach and Export hand an image to the host; the frame never sees a
 * path or the provider's key, because nothing it is given has one.
 *
 * Progress is the job's, which is the service's, which is the provider's. Nothing here guesses it.
 */

const TEXT = {
  promptLabel: "Mô tả ảnh",
  promptHint: "Ctrl+Enter để tạo",
  generate: "Tạo ảnh",
  sending: "Đang gửi…",
  cancel: "Dừng",
  attach: "Đính kèm vào cuộc trò chuyện",
  exportFile: "Xuất tệp",
  attached: "Đã đưa ảnh vào ô soạn tin.",
  exported: "Đã xuất tệp.",
  exportCancelled: "Đã huỷ xuất tệp.",
  gallery: "Ảnh đã tạo",
  empty: "Chưa có ảnh nào. Mô tả một bức ảnh rồi bấm “Tạo ảnh”.",
  loadingImage: "Đang đọc ảnh…",
  noBinding: "Widget này chưa được gắn với dịch vụ tạo ảnh, nên chưa tạo ảnh được.",
  unavailable: "Dịch vụ tạo ảnh chưa dùng được",
  needPrompt: "Hãy mô tả bức ảnh trước.",
  queued: "Đang chờ",
  running: "Đang tạo ảnh",
  cancelled: "Đã dừng. Nhà cung cấp có thể đã làm xong một phần trước khi dừng.",
  failed: "Không tạo được ảnh",
};

const COLOR_TOKENS = {
  canvas: "--ig-canvas",
  card: "--ig-surface",
  code: "--ig-field",
  text: "--ig-text",
  textMuted: "--ig-muted",
  border: "--ig-line",
  accent: "--ig-accent",
  onAccent: "--ig-on-accent",
  focus: "--ig-focus",
  danger: "--ig-danger",
  success: "--ig-success",
  warning: "--ig-warning",
};

/** How long typing must pause before the draft prompt is written to widget state. */
const DRAFT_WRITE_DELAY_MS = 400;
/** How often the host is asked for this widget's jobs: soon while one is open, rarely otherwise. */
const LIST_OPEN_MS = 1_000;
const LIST_IDLE_MS = 4_000;
/** One bridge read, and the most this frame reads of one image. */
const READ_CHUNK = 262_144;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const SHOWN_IMAGES = 12;
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const OPEN = ["queued", "running", "waiting"];

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

function element(tag, attributes = {}, text) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorText(error) {
  return String(error && error.message ? error.message : error);
}

function toDataUrl(mimeType, chunks) {
  let binary = "";
  for (const chunk of chunks) {
    for (let index = 0; index < chunk.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, chunk.subarray(index, index + 0x8000));
    }
  }
  return `data:${mimeType};base64,${window.btoa(binary)}`;
}

function start() {
  const runtime = window.clarkcantWidget;
  if (runtime === undefined || runtime.status() !== "ready") {
    setTimeout(start, 20);
    return;
  }
  const root = document.getElementById("root");
  if (root.dataset.drawn === "true") return;
  root.dataset.drawn = "true";

  const api = runtime.api();
  applyAppearance(api.appearance.current());
  api.appearance.subscribe(applyAppearance);

  const props = api.props.read();
  const binding = typeof props.generateBinding === "string" ? props.generateBinding : undefined;

  /* ---------------------------------------------------------------- the DOM */

  const title = element("h2", {}, String(props.title ?? "Trình tạo ảnh"));

  const form = element("form", { class: "prompt", "data-image-form": "true" });
  const label = element("label", { for: "image-prompt" }, TEXT.promptLabel);
  const field = element("textarea", {
    id: "image-prompt",
    rows: "3",
    maxlength: "500",
    "aria-describedby": "image-prompt-hint",
    "data-image-prompt": "true",
  });
  const hint = element("p", { id: "image-prompt-hint", class: "muted" }, TEXT.promptHint);
  const generate = element("button", { type: "button", class: "primary", "data-image-generate": "true" }, TEXT.generate);
  const actions = element("div", { class: "actions" });
  actions.append(generate);
  form.append(label, field, hint, actions);

  const unavailable = element("p", { role: "status", class: "notice", "data-image-unavailable": "true" });
  const status = element("p", { role: "status", "aria-live": "polite", "data-image-status": "true" });

  const jobPanel = element("section", { class: "panel", "aria-label": TEXT.running, "data-image-job": "true" });
  jobPanel.hidden = true;
  const jobText = element("p", { "aria-live": "polite", "data-image-job-text": "true" });
  const bar = element("progress", { "data-image-progress": "true" });
  const cancel = element("button", { type: "button", "data-image-cancel": "true" }, TEXT.cancel);
  jobPanel.append(jobText, bar, cancel);

  const galleryHeading = element("h3", { id: "image-gallery-heading" }, TEXT.gallery);
  const empty = element("p", { class: "muted", "data-image-empty": "true" }, TEXT.empty);
  const gallery = element("ul", { class: "gallery", "aria-labelledby": "image-gallery-heading", "data-image-gallery": "true" });

  root.append(title, form, unavailable, status, jobPanel, galleryHeading, empty, gallery);

  /* ---------------------------------------------------------- the draft */

  const saved = api.state.get();
  field.value = typeof saved.prompt === "string" ? saved.prompt : "";
  let draftTimer;
  let writing = false;
  let writeAgain = false;
  // Kept in widget state so a reload, another window, voice and Clark all see the prompt being written.
  const writeDraft = () => {
    if (writing) {
      writeAgain = true;
      return;
    }
    writing = true;
    void api.state
      .update(api.state.revision(), { prompt: field.value.slice(0, 500) })
      .catch(() => undefined)
      .finally(() => {
        writing = false;
        if (writeAgain) {
          writeAgain = false;
          writeDraft();
        }
      });
  };
  field.addEventListener("input", () => {
    window.clearTimeout(draftTimer);
    draftTimer = setTimeout(writeDraft, DRAFT_WRITE_DELAY_MS);
  });
  api.state.subscribe((next) => {
    // Another view wrote the prompt; taken only while the person is not typing here.
    if (document.activeElement !== field && typeof next.prompt === "string") field.value = next.prompt;
  });

  /* ---------------------------------------------------------- the jobs */

  /** This widget's jobs, newest first, as the host last reported them. */
  let jobs = [];
  /** Open jobs followed for their progress, by JobRef. */
  const following = new Map();
  /** Images read so far, by artifact id: a data URL, or the reason it could not be read. */
  const images = new Map();
  const outcomes = new Map();
  let lastSummary = "";

  const upsert = (snapshot) => {
    const index = jobs.findIndex((job) => job.jobId === snapshot.jobId);
    if (index >= 0) jobs[index] = snapshot;
    else jobs = [snapshot, ...jobs];
  };

  const follow = (jobId) => {
    if (following.has(jobId) || following.size >= 3 || !api.jobs.available()) return;
    try {
      const stop = api.jobs.subscribe(jobId, (snapshot) => {
        upsert(snapshot);
        if (!OPEN.includes(snapshot.status)) following.delete(jobId);
        render();
      });
      following.set(jobId, stop);
    } catch {
      // At the frame's subscription limit: the list read below still shows how it is going.
    }
  };

  let listTimer;
  const refresh = () => {
    window.clearTimeout(listTimer);
    if (!api.jobs.available()) return;
    void api.jobs
      .list()
      .then((listed) => {
        jobs = listed.slice();
        for (const job of jobs) if (OPEN.includes(job.status)) follow(job.jobId);
        render();
      })
      .catch(() => undefined)
      .finally(() => {
        const open = jobs.some((job) => OPEN.includes(job.status));
        listTimer = setTimeout(refresh, open ? LIST_OPEN_MS : LIST_IDLE_MS);
      });
  };

  const readImage = async (ref) => {
    if (ref.sizeBytes > MAX_IMAGE_BYTES) throw new Error("ảnh lớn hơn mức widget này đọc");
    const chunks = [];
    let offset = 0;
    for (;;) {
      const { bytes, eof } = await api.artifacts.read(ref, { offset, length: READ_CHUNK });
      chunks.push(bytes);
      offset += bytes.length;
      if (eof || bytes.length === 0 || offset >= ref.sizeBytes) break;
    }
    return toDataUrl(ref.mimeType, chunks);
  };

  const loadImage = (ref) => {
    if (images.has(ref.artifactId)) return;
    images.set(ref.artifactId, { loading: true });
    void readImage(ref)
      .then((url) => images.set(ref.artifactId, { url }))
      .catch((error) => images.set(ref.artifactId, { error: errorText(error) }))
      .finally(render);
  };

  /* -------------------------------------------------------- the render */

  const describeJob = (job) => {
    if (job.status === "queued" || job.status === "waiting") return TEXT.queued;
    if (job.status === "running") {
      const step = job.progress;
      return step === undefined || step.total === undefined
        ? `${TEXT.running}…`
        : `${TEXT.running}: bước ${String(step.current)}/${String(step.total)}`;
    }
    if (job.status === "cancelled") return TEXT.cancelled;
    return `${TEXT.failed}${job.error === undefined ? "." : `: ${job.error}`}`;
  };

  const galleryItem = (job, ref, index) => {
    const item = element("li", { "data-image-item": ref.artifactId, "data-image-job-id": job.jobId });
    const figure = element("figure");
    const caption = job.output === undefined ? ref.name : job.output.split("\n")[0];
    const shown = images.get(ref.artifactId);
    if (shown !== undefined && shown.url !== undefined) {
      const img = element("img", { src: shown.url, alt: caption, width: "192", height: "192", "data-image-loaded": "true" });
      img.addEventListener("load", report);
      figure.append(img);
    } else {
      figure.append(element("div", { class: "placeholder", role: "img", "aria-label": caption }, shown?.error ?? TEXT.loadingImage));
    }
    figure.append(element("figcaption", {}, caption));

    const buttons = element("div", { class: "actions" });
    const attach = element("button", { type: "button", "data-image-attach": "true" }, TEXT.attach);
    const exportButton = element("button", { type: "button", "data-image-export": "true" }, TEXT.exportFile);
    const outcome = element("p", { role: "status", class: "muted", "data-image-item-status": "true" }, outcomes.get(ref.artifactId) ?? "");
    const said = (text, state) => {
      outcomes.set(ref.artifactId, text);
      outcome.textContent = text;
      outcome.setAttribute("data-image-item-state", state);
    };
    attach.addEventListener("click", () => {
      attach.disabled = true;
      void api.artifacts
        .attachToConversation(ref)
        .then(() => said(TEXT.attached, "attached"))
        .catch((error) => said(errorText(error), "refused"))
        .finally(() => { attach.disabled = false; });
    });
    exportButton.addEventListener("click", () => {
      exportButton.disabled = true;
      void api.artifacts
        .export(ref, { suggestedName: `anh-${String(index + 1)}.png` })
        .then((taken) => said(taken ? TEXT.exported : TEXT.exportCancelled, taken ? "exported" : "cancelled"))
        .catch((error) => said(errorText(error), "refused"))
        .finally(() => { exportButton.disabled = false; });
    });
    buttons.append(attach, exportButton);
    item.append(figure, buttons, outcome);
    return item;
  };

  let drawnGallery = "";
  function render() {
    // The job the panel shows: the newest one, while it is open or when it did not end with an image.
    const newest = jobs[0];
    const current = newest !== undefined && newest.status !== "completed" ? newest : undefined;
    jobPanel.hidden = current === undefined;
    if (current !== undefined) {
      const open = OPEN.includes(current.status);
      jobPanel.setAttribute("data-image-job-id", current.jobId);
      jobPanel.setAttribute("data-image-job-status", current.status);
      jobPanel.setAttribute("data-image-job-progress", String(current.progress?.current ?? 0));
      jobText.textContent = describeJob(current);
      bar.hidden = !open;
      if (current.progress?.total !== undefined) {
        bar.max = current.progress.total;
        bar.value = current.progress.current;
      } else {
        bar.removeAttribute("value");
      }
      cancel.hidden = !open;
      cancel.disabled = !open;
    }

    const finished = [];
    for (const job of jobs) {
      if (job.status !== "completed") continue;
      for (const ref of job.resultRefs) if (IMAGE_TYPES.includes(ref.mimeType)) finished.push({ job, ref });
    }
    const shown = finished.slice(0, SHOWN_IMAGES);
    for (const { ref } of shown) loadImage(ref);
    empty.hidden = shown.length > 0;
    // Redrawn only when something it shows changed, so a focused button keeps its focus between list reads.
    const key = JSON.stringify(shown.map(({ ref }) => [ref.artifactId, images.get(ref.artifactId)?.url !== undefined, images.get(ref.artifactId)?.error]));
    if (key !== drawnGallery) {
      drawnGallery = key;
      const focused = document.activeElement;
      const focusKey = focused instanceof window.HTMLElement && gallery.contains(focused)
        ? [focused.closest("[data-image-item]")?.getAttribute("data-image-item"), focused.hasAttribute("data-image-export") ? "export" : "attach"]
        : undefined;
      gallery.replaceChildren(...shown.map(({ job, ref }, index) => galleryItem(job, ref, index)));
      if (focusKey !== undefined) {
        gallery.querySelector(`[data-image-item="${focusKey[0]}"] [data-image-${focusKey[1]}]`)?.focus();
      }
    }
    root.setAttribute("data-image-count", String(shown.length));

    const open = jobs.find((job) => OPEN.includes(job.status));
    const summary = `Trình tạo ảnh: ${String(finished.length)} ảnh đã tạo${open === undefined ? "" : `; ${describeJob(open)}`}.`;
    if (summary !== lastSummary) {
      lastSummary = summary;
      try {
        api.semantic.publish(summary, []);
      } catch {
        // A host that does not take semantic documents still shows the widget.
      }
    }
  }

  /* -------------------------------------------------------- the actions */

  const submit = () => {
    const prompt = field.value.trim();
    if (binding === undefined) return;
    if (prompt === "") {
      status.textContent = TEXT.needPrompt;
      status.setAttribute("data-image-state", "refused");
      field.focus();
      return;
    }
    generate.disabled = true;
    status.textContent = TEXT.sending;
    status.setAttribute("data-image-state", "sending");
    void api.actions
      .invoke(binding, { prompt }, crypto.randomUUID())
      .then((jobId) => {
        if (typeof jobId !== "string") throw new Error("host trả lời mà không kèm job");
        status.textContent = "";
        status.setAttribute("data-image-state", "started");
        follow(jobId);
        refresh();
      })
      .catch((error) => {
        status.textContent = errorText(error);
        status.setAttribute("data-image-state", "refused");
      })
      .finally(() => showAvailability(api.actions.availability()));
  };
  // A click, not a form submission: the frame's sandbox does not allow forms, so a submit event would never fire.
  generate.addEventListener("click", submit);
  form.addEventListener("submit", (event) => event.preventDefault());
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  });
  cancel.addEventListener("click", () => {
    const jobId = jobPanel.getAttribute("data-image-job-id");
    if (jobId === null) return;
    cancel.disabled = true;
    void api.jobs
      .cancel(jobId)
      .then(refresh)
      .catch((error) => {
        status.textContent = errorText(error);
        status.setAttribute("data-image-state", "refused");
      });
  });

  /*
   * What the host last said about the binding. One it cannot run — the service starting, the key not given yet — is
   * disabled with the host's reason, not one this widget made up.
   */
  function showAvailability(entries) {
    if (entries.length > 0) root.setAttribute("data-image-announced", "true");
    if (binding === undefined) {
      generate.disabled = true;
      unavailable.textContent = TEXT.noBinding;
      root.setAttribute("data-image-service", "unbound");
      return;
    }
    const entry = entries.find((candidate) => candidate.actionBindingId === binding);
    const off = entry !== undefined && !entry.available;
    generate.disabled = off;
    unavailable.textContent = off ? `${TEXT.unavailable}: ${entry.reason ?? ""}` : "";
    root.setAttribute("data-image-service", off ? "unavailable" : "available");
  }
  showAvailability(api.actions.availability());
  api.actions.subscribe(showAvailability);

  render();
  refresh();
  root.setAttribute("data-widget-ready", "true");

  // The host sizes the frame; the widget says how tall its content is, again whenever that changes.
  function report() {
    api.host.resize({ height: Math.ceil(document.documentElement.scrollHeight) });
  }
  new window.ResizeObserver(report).observe(document.body);
  api.lifecycle.onDispose(() => {
    window.clearTimeout(listTimer);
    for (const stop of following.values()) stop();
  });
}

start();
