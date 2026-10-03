/*
 * Reference app C: an image generator whose images come from a provider the node reaches for it.
 *
 * The frame code. The prompt goes to the `invoke` binding named in props (`generateBinding`), which calls the
 * package's `image.generate@1` capability. That answers at once with a JobRef: the image is made as a durable job the
 * node owns, so it goes on while this frame is gone. The frame asks the host for this widget's jobs — including ones
 * started by voice or by Clark through the same binding — follows the open ones, and reads finished images as
 * ArtifactRefs, in bounded chunks, into the gallery. Attach and Export hand an image to the host; Attach proposes a file
 * name made from the prompt, which the host sanitizes. The frame never sees a path or the provider's key, because
 * nothing it is given has one.
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
  // The service's own words, quoted as theirs; the sentence around them is this widget's.
  serviceSaid: (words) =>
    `Không tạo được ảnh. Dịch vụ tạo ảnh báo: “${words}”. Có thể nó đã làm một phần trước khi dừng; hãy xem lại trước khi tạo lại.`,
  listUnavailable: "Máy chủ này chưa cho widget xem lại các lần tạo ảnh trước, nên ở đây chỉ có ảnh tạo trong lần mở này.",
};

/** How the host quotes a service's own words in a failed job's error (`job-host.ts`). */
const SERVICE_WORDS = /^The package service reported an error: “([^”]*)”/;

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
const IMAGE_EXTENSIONS = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
/** Characters of the prompt a proposed file name keeps, and of the job's id that keep two names apart. */
const NAME_SLUG_MAX = 48;
const NAME_SUFFIX_CHARS = 6;
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

/** A prompt as a short file-name slug: lower-case ASCII words joined by dashes, Vietnamese marks dropped. */
function slugOf(text) {
  return text
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .replace(/đ/gu, "d")
    .replace(/Đ/gu, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, NAME_SLUG_MAX)
    .replace(/-+$/, "");
}

/**
 * The prompt in a finished job's output, for a job this frame did not start (Clark, voice, another view, a reload): a
 * job snapshot carries the output, not the input. It depends on the wording of `result()` in `service/server.mjs`,
 * `Image for “<prompt>” (<size> PNG).` — change both together. When it does not match, the name falls back to `anh`.
 */
const OUTPUT_PROMPT = /“([^”]*)”/u;

/**
 * The file name this widget proposes when it attaches an image: a slug of the prompt, the end of the job's id so two
 * images never share a name, and the image's number when one job made several. The prompt is the one this frame sent
 * when it started the job, and otherwise the one in the job's output. Only a proposal: the host makes it safe and
 * decides the extension from the bytes.
 */
function proposedName(job, ref, indexInJob, sentPrompt) {
  const prompt = sentPrompt ?? OUTPUT_PROMPT.exec(job.output ?? "")?.[1] ?? "";
  const slug = slugOf(prompt) || "anh";
  const suffix = job.jobId.replace(/^job_/, "").replace(/[^A-Za-z0-9]/g, "").slice(-NAME_SUFFIX_CHARS).toLowerCase();
  const parts = [slug, suffix, indexInJob > 0 ? String(indexInJob + 1) : ""].filter((part) => part !== "");
  return `${parts.join("-")}.${IMAGE_EXTENSIONS[ref.mimeType] ?? "png"}`;
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

  // One panel per job worth showing: every open job, each with its own progress and Stop, and a newest one that ended
  // without an image.
  const jobPanels = element("div", { class: "jobs", "data-image-jobs": "true" });

  const galleryHeading = element("h3", { id: "image-gallery-heading" }, TEXT.gallery);
  const listNote = element("p", { class: "muted", "data-image-list-note": "true" });
  listNote.hidden = true;
  const empty = element("p", { class: "muted", "data-image-empty": "true" }, TEXT.empty);
  const gallery = element("ul", { class: "gallery", "aria-labelledby": "image-gallery-heading", "data-image-gallery": "true" });

  root.append(title, form, unavailable, status, jobPanels, galleryHeading, listNote, empty, gallery);

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
  /** The prompt this frame sent for each job it started, by JobRef: what an attached image is named after. */
  const sentPrompts = new Map();
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

  /*
   * Whether this host lists a widget's jobs. `jobs.list` came after `jobs@1`, as its own extension, so a host that
   * offers only `jobs@1` — or an injected runtime that predates the call — is asked nothing it cannot answer. Without
   * it the gallery holds only the jobs this frame started and follows, and says so.
   */
  const canList =
    api.jobs.available() && typeof api.jobs.list === "function" && typeof api.jobs.canList === "function" && api.jobs.canList();
  listNote.textContent = TEXT.listUnavailable;
  listNote.hidden = canList || !api.jobs.available();

  let listTimer;
  const refresh = () => {
    window.clearTimeout(listTimer);
    if (!canList) return;
    void api.jobs
      .list()
      .then((listed) => {
        const known = new Set(jobs.map((job) => job.jobId));
        jobs = listed.slice();
        // A job that appeared since the last read answers a press that was waiting, such as one a person approved on
        // the host's card: the note about that wait is no longer true.
        if (jobs.some((job) => !known.has(job.jobId)) && status.getAttribute("data-image-state") === "refused") {
          status.textContent = "";
          status.removeAttribute("data-image-state");
        }
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
    const words = SERVICE_WORDS.exec(job.error ?? "");
    if (words !== null) return TEXT.serviceSaid(words[1] ?? "");
    return `${TEXT.failed}${job.error === undefined ? "." : `: ${job.error}`}`;
  };

  /** The panels drawn so far, by JobRef, reused so a focused Stop keeps its focus between reads. */
  const panels = new Map();

  const panelFor = (jobId) => {
    const existing = panels.get(jobId);
    if (existing !== undefined) return existing;
    const section = element("section", { class: "panel", "aria-label": TEXT.running, "data-image-job": "true", "data-image-job-id": jobId });
    const text = element("p", { "aria-live": "polite", "data-image-job-text": "true" });
    const bar = element("progress", { "data-image-progress": "true" });
    const cancel = element("button", { type: "button", "data-image-cancel": "true" }, TEXT.cancel);
    cancel.addEventListener("click", () => {
      // Held off until the job's ending arrives, so a second press does not ask again.
      cancel.disabled = true;
      cancel.setAttribute("data-image-cancelling", "true");
      void api.jobs
        .cancel(jobId)
        .then(refresh)
        .catch((error) => {
          cancel.removeAttribute("data-image-cancelling");
          cancel.disabled = false;
          status.textContent = errorText(error);
          status.setAttribute("data-image-state", "refused");
        });
    });
    section.append(text, bar, cancel);
    const panel = { section, text, bar, cancel };
    panels.set(jobId, panel);
    return panel;
  };

  const drawPanel = (job) => {
    const { section, text, bar, cancel } = panelFor(job.jobId);
    const open = OPEN.includes(job.status);
    section.setAttribute("data-image-job-status", job.status);
    section.setAttribute("data-image-job-progress", String(job.progress?.current ?? 0));
    text.textContent = describeJob(job);
    bar.hidden = !open;
    if (job.progress?.total !== undefined) {
      bar.max = job.progress.total;
      bar.value = job.progress.current;
    } else {
      bar.removeAttribute("value");
    }
    cancel.hidden = !open;
    if (!open) cancel.disabled = true;
    else if (cancel.getAttribute("data-image-cancelling") !== "true") cancel.disabled = false;
    return section;
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
      const indexInJob = job.resultRefs.filter((candidate) => IMAGE_TYPES.includes(candidate.mimeType)).indexOf(ref);
      void api.artifacts
        .attachToConversation(ref, { name: proposedName(job, ref, indexInJob, sentPrompts.get(job.jobId)) })
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
    /*
     * The jobs the panels show, newest first: every open one, so each running job keeps its progress and its Stop, and
     * the newest job when it ended without an image, so its reason stays in view until something newer starts.
     */
    const newest = jobs[0];
    const shownJobs = jobs.filter(
      (job) => OPEN.includes(job.status) || (job === newest && (job.status === "failed" || job.status === "cancelled")),
    );
    const drawn = shownJobs.map(drawPanel);
    // Moved, not rebuilt, so the button that has focus keeps it.
    if (drawn.length !== jobPanels.children.length || drawn.some((section, index) => jobPanels.children[index] !== section)) {
      jobPanels.replaceChildren(...drawn);
    }
    for (const jobId of panels.keys()) if (!shownJobs.some((job) => job.jobId === jobId)) panels.delete(jobId);

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
        sentPrompts.set(jobId, prompt);
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
