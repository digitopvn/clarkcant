/*
 * Reference app D: a media render tool with a job the person can stop.
 *
 * The frame code. The person picks a WAV clip in the host's chrome; the widget holds it only as an ArtifactRef and sends
 * the package's service its id through the widget's own `render` binding, named in props by whoever placed it. The host
 * checks the grant and the size cap of the resource profile it granted the package, then streams the clip to the
 * service a chunk at a time. The press answers with a JobRef the widget keeps in state, so a remounted frame follows the
 * same render. Progress is the service's own; the rendered file is offered only when the job completed, so a stopped or
 * failed render never shows a file as finished.
 *
 * The rules (what is kept, what a snapshot means, how a WAV becomes a waveform) live in `render-core.js`.
 */

import {
  ACCEPTED_TYPES,
  GAIN_INPUT,
  RENDER_LIMITS,
  createPeaks,
  endedWithoutOutput,
  formatBytes,
  formatSeconds,
  jobView,
  outputHeader,
  readParameters,
  readPersistedState,
  renderedName,
  statusText,
} from "./render-core.js";

const TEXT = {
  pick: "Chọn tệp WAV",
  render: "Dựng",
  cancel: "Dừng dựng",
  attach: "Đính kèm vào cuộc trò chuyện",
  export: "Lưu bản dựng",
  noSource: "Chưa chọn tệp nào",
  gain: "Âm lượng (dB)",
  trimStart: "Cắt đầu (ms)",
  trimEnd: "Cắt cuối (ms)",
  noBinding: "Dịch vụ dựng chưa được gắn vào widget này, nên chưa dựng được.",
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

/** Host colour tokens this tool draws with. The values passed the host's schema; only their names are chosen here. */
const COLOR_TOKENS = {
  canvas: "--mr-canvas",
  card: "--mr-surface",
  code: "--mr-field",
  text: "--mr-text",
  textMuted: "--mr-muted",
  border: "--mr-line",
  accent: "--mr-accent",
  onAccent: "--mr-on-accent",
  focus: "--mr-focus",
  danger: "--mr-danger",
  success: "--mr-success",
  warning: "--mr-warning",
};

function start() {
  const runtime = window.clarkcantWidget;
  if (runtime === undefined || runtime.status() !== "ready") {
    setTimeout(start, 20);
    return;
  }
  if (root.dataset.drawn === "true") return;
  root.dataset.drawn = "true";
  const api = runtime.api();

  let saved = readPersistedState(api.state.get());
  let following;
  let unfollow = () => undefined;
  let busy = false;
  let peaks;
  let previewFor;
  let disposed = false;
  let lastPublished = "";
  /** The last snapshot of the followed job, so the view and the semantic document say the same thing. */
  let current;

  const renderBinding = () => {
    const value = api.props.read().renderBinding;
    return typeof value === "string" && value !== "" ? value : undefined;
  };

  /* ------------------------------------------------------------ markup */

  const title = element("h2", { id: "media-title" }, "");
  const sourceRow = element("div", { class: "row" });
  const pickButton = element("button", { type: "button", "data-media-pick": "" }, TEXT.pick);
  const sourceName = element("p", { class: "source", "data-media-source": "" }, TEXT.noSource);
  sourceRow.append(pickButton, sourceName);

  const field = (id, label, attributes) => {
    const wrap = element("label", { class: "field", for: id });
    wrap.append(element("span", {}, label));
    const input = element("input", { id, type: "number", inputmode: "decimal", ...attributes });
    wrap.append(input);
    return { wrap, input };
  };
  // Text, not a number field: see GAIN_INPUT. The range is said in the error next to it, and checked again on press.
  const gain = field("media-gain", TEXT.gain, { ...GAIN_INPUT, "data-media-gain": "" });
  const trimStart = field("media-trim-start", TEXT.trimStart, { min: "0", step: "100", "data-media-trim-start": "" });
  const trimEnd = field("media-trim-end", TEXT.trimEnd, { min: "0", step: "100", "data-media-trim-end": "" });
  const params = element("fieldset", { class: "params" });
  params.append(element("legend", {}, "Thông số dựng"), gain.wrap, trimStart.wrap, trimEnd.wrap);

  const actions = element("div", { class: "row" });
  const renderButton = element("button", { type: "button", class: "primary", "data-media-render": "", "aria-describedby": "media-unavailable media-param-error" }, TEXT.render);
  const cancelButton = element("button", { type: "button", "data-media-cancel": "" }, TEXT.cancel);
  actions.append(renderButton, cancelButton);
  const paramError = element("p", { id: "media-param-error", class: "error", "data-media-param-error": "" }, "");
  const unavailable = element("p", { id: "media-unavailable", class: "notice", role: "status", "data-media-unavailable": "" }, "");

  const job = element("section", { class: "job", "aria-labelledby": "media-job-title", "data-media-job": "", hidden: "" });
  const jobTitle = element("h3", { id: "media-job-title" }, "Bản dựng");
  const progress = element("progress", { max: "1", "aria-labelledby": "media-job-title", "data-media-progress": "" });
  const jobMessage = element("p", { class: "muted", "data-media-job-message": "" }, "");
  job.append(jobTitle, progress, jobMessage);

  const preview = element("section", { class: "preview", "aria-labelledby": "media-preview-title", "data-media-preview": "", hidden: "" });
  const previewTitle = element("h3", { id: "media-preview-title", tabindex: "-1" }, "Bản dựng hoàn tất");
  const canvas = element("canvas", { role: "img", "aria-label": "Dạng sóng của bản dựng", "data-media-waveform": "" });
  const previewMeta = element("p", { class: "muted", "data-media-preview-meta": "" }, "");
  const previewDigest = element("p", { class: "digest", "data-media-digest": "" }, "");
  const previewActions = element("div", { class: "row" });
  const attachButton = element("button", { type: "button", "data-media-attach": "" }, TEXT.attach);
  const exportButton = element("button", { type: "button", "data-media-export": "" }, TEXT.export);
  previewActions.append(attachButton, exportButton);
  preview.append(previewTitle, canvas, previewMeta, previewDigest, previewActions);

  const status = element("p", { role: "status", "aria-live": "polite", "data-media-status": "idle" }, "");
  root.append(title, sourceRow, params, actions, paramError, unavailable, job, preview, status);

  gain.input.value = String(saved.gainDb);
  trimStart.input.value = String(saved.trimStartMs);
  trimEnd.input.value = String(saved.trimEndMs);

  /* ------------------------------------------------------------ view */

  const say = (state, message) => {
    status.setAttribute("data-media-status", state);
    status.textContent = message;
  };

  function availabilityReason() {
    const binding = renderBinding();
    if (binding === undefined) return TEXT.noBinding;
    const entry = api.actions.availability().find((candidate) => candidate.actionBindingId === binding);
    if (entry === undefined || entry.available) return undefined;
    return entry.reason ?? "Dịch vụ dựng chưa chạy được.";
  }

  function render() {
    title.textContent = String(api.props.read().title ?? "Trình dựng âm thanh");
    const reason = availabilityReason();
    const view = current === undefined ? undefined : jobView(current);
    const running = view !== undefined && view.open;
    const parameters = readParameters({ gainDb: gain.input.value, trimStartMs: trimStart.input.value, trimEndMs: trimEnd.input.value });
    sourceName.textContent = saved.source === null ? TEXT.noSource : `${saved.source.name} · ${formatBytes(saved.source.sizeBytes)}`;
    sourceName.setAttribute("data-media-source", saved.source === null ? "" : saved.source.name);
    pickButton.disabled = busy || running;
    for (const input of [gain.input, trimStart.input, trimEnd.input]) input.disabled = running;
    renderButton.disabled = busy || running || reason !== undefined || saved.source === null || !parameters.ok;
    cancelButton.disabled = !running;
    paramError.textContent = parameters.ok ? "" : parameters.reason;
    unavailable.textContent = reason === undefined ? "" : `Chưa dựng được: ${reason}`;
    root.setAttribute("data-media-available", reason === undefined ? "true" : "false");
    root.setAttribute("data-media-busy", String(busy));
    attachButton.disabled = busy;
    exportButton.disabled = busy;
  }

  function publish() {
    const view = current === undefined ? undefined : jobView(current);
    const values = {
      source: saved.source === null ? "" : saved.source.name,
      gainDb: saved.gainDb,
      trimStartMs: saved.trimStartMs,
      trimEndMs: saved.trimEndMs,
      jobStatus: view === undefined ? "none" : view.status,
      progressPercent: view === undefined || view.fraction === undefined ? 0 : Math.round(view.fraction * 100),
      output: saved.output === null ? "" : saved.output.name,
    };
    const summary =
      saved.source === null
        ? "Trình dựng âm thanh, chưa chọn tệp."
        : `Trình dựng âm thanh với “${saved.source.name}”, bản dựng: ${values.jobStatus}${saved.output === null ? "" : ", đã có tệp kết quả"}.`;
    const key = JSON.stringify([summary, values]);
    if (key === lastPublished) return;
    lastPublished = key;
    api.semantic.publish(summary, [], values);
  }

  /* ------------------------------------------------------------ state */

  let writing = Promise.resolve();
  /** Write a change to widget state, one write at a time, each at the revision the host holds after the last. */
  function keep(patch) {
    saved = { ...saved, ...patch };
    writing = writing.then(async () => {
      if (disposed) return;
      try {
        await api.state.update(api.state.revision(), patch);
      } catch (error) {
        say("refused", `Chưa giữ được trạng thái: ${reasonOf(error)}`);
      }
    });
    return writing;
  }

  /* ------------------------------------------------------------ preview */

  function color(name, fallback) {
    const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value === "" ? fallback : value;
  }

  function drawWaveform() {
    const width = Math.max(1, Math.floor(canvas.clientWidth));
    const height = Math.max(1, Math.floor(canvas.clientHeight));
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = color("--mr-field", "#f6f6f7");
    context.fillRect(0, 0, width, height);
    if (peaks === undefined) return;
    context.fillStyle = color("--mr-accent", "#2563eb");
    const columns = peaks.min.length;
    const middle = height / 2;
    for (let x = 0; x < width; x += 1) {
      const column = Math.min(columns - 1, Math.floor((x * columns) / width));
      const top = middle - peaks.max[column] * middle;
      const bottom = middle - peaks.min[column] * middle;
      context.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }

  /** Read the rendered file once, a chunk at a time, into a waveform; the bytes are not kept. */
  async function loadPreview(ref) {
    previewFor = ref.artifactId;
    preview.hidden = false;
    previewMeta.textContent = "Đang đọc bản dựng…";
    previewDigest.textContent = ref.digest === undefined ? "" : `Mã băm: ${ref.digest}`;
    previewDigest.setAttribute("data-media-digest", ref.digest ?? "");
    const head = await api.artifacts.read(ref, { offset: 0, length: Math.min(RENDER_LIMITS.chunkBytes, Math.max(44, ref.sizeBytes)) });
    if (previewFor !== ref.artifactId) return;
    const header = outputHeader(head.bytes);
    if (header === undefined) throw new Error("Bản dựng không phải tệp WAV mà dịch vụ này viết ra.");
    const next = createPeaks(header, 512);
    next.add(head.bytes.subarray(44));
    let offset = head.bytes.byteLength;
    let eof = head.eof;
    while (!eof && offset < ref.sizeBytes) {
      const part = await api.artifacts.read(ref, { offset, length: RENDER_LIMITS.chunkBytes });
      if (previewFor !== ref.artifactId) return;
      if (part.bytes.byteLength === 0) break;
      next.add(part.bytes);
      offset += part.bytes.byteLength;
      eof = part.eof;
    }
    peaks = next;
    drawWaveform();
    const channels = header.channels === 1 ? "đơn kênh" : "hai kênh";
    previewMeta.textContent = `${ref.name} · ${formatSeconds(header.durationSeconds)} · ${channels}, ${String(header.sampleRate)} Hz · ${formatBytes(ref.sizeBytes)}`;
    previewMeta.setAttribute("data-media-duration", header.durationSeconds.toFixed(3));
    preview.setAttribute("data-media-preview", "ready");
  }

  function hidePreview() {
    previewFor = undefined;
    peaks = undefined;
    preview.hidden = true;
    preview.setAttribute("data-media-preview", "");
    previewMeta.textContent = "";
    previewMeta.removeAttribute("data-media-duration");
    previewDigest.textContent = "";
    previewDigest.setAttribute("data-media-digest", "");
  }

  function showPreview(ref, announce) {
    void loadPreview(ref)
      .then(() => {
        if (announce) previewTitle.focus();
      })
      .catch((error) => {
        previewMeta.textContent = `Không đọc được bản dựng: ${reasonOf(error)}`;
        preview.setAttribute("data-media-preview", "unreadable");
      });
  }

  /* ------------------------------------------------------------ job */

  function onSnapshot(jobId, snapshot) {
    if (following !== jobId || disposed) return;
    const wasOpen = current !== undefined && jobView(current).open;
    current = snapshot;
    const view = jobView(snapshot);
    job.hidden = false;
    job.setAttribute("data-media-job-id", jobId);
    job.setAttribute("data-media-job-status", view.status);
    if (view.fraction === undefined) progress.removeAttribute("value");
    else progress.value = view.fraction;
    progress.setAttribute("data-media-progress", view.fraction === undefined ? "" : String(Math.round(view.fraction * 100)));
    const ending = view.status === "failed" || view.status === "cancelled" ? view.error ?? "" : view.note ?? "";
    // A completed job that kept no file says what failed in the widget's own words, not the host's note.
    const keptNothing = view.status === "completed" && view.output === undefined;
    jobMessage.textContent = [statusText(view), view.open ? view.message : keptNothing ? "" : ending].filter((part) => part !== "").join(" ");
    if (view.output !== undefined && saved.output?.artifactId !== view.output.artifactId) {
      void keep({ output: view.output });
      showPreview(view.output, wasOpen);
      say("completed", `Đã dựng xong “${view.output.name}”.`);
    } else if (endedWithoutOutput(view)) {
      say(view.status === "completed" ? "unkept" : view.status, statusText(view));
    }
    render();
    publish();
    // Focus moves only once Render is enabled again; a disabled button cannot take it.
    if (wasOpen && endedWithoutOutput(view)) renderButton.focus();
  }

  function follow(jobId) {
    unfollow();
    following = jobId;
    unfollow = api.jobs.subscribe(jobId, (snapshot) => onSnapshot(jobId, snapshot));
  }

  /* ------------------------------------------------------------ actions */

  async function run(task) {
    busy = true;
    render();
    try {
      await task();
    } catch (error) {
      say("refused", reasonOf(error));
    } finally {
      busy = false;
      render();
      publish();
    }
  }

  pickButton.addEventListener("click", () => {
    void run(async () => {
      say("working", "Đang chờ bạn chọn tệp…");
      const ref = await api.artifacts.pick({ accept: ACCEPTED_TYPES });
      if (ref === undefined) {
        say("cancelled", "Bạn đã đóng hộp chọn tệp.");
        return;
      }
      await keep({ source: ref });
      say("picked", `Đã chọn “${ref.name}”.`);
    });
  });

  for (const input of [gain.input, trimStart.input, trimEnd.input]) {
    input.addEventListener("input", () => render());
    input.addEventListener("change", () => {
      const parameters = readParameters({ gainDb: gain.input.value, trimStartMs: trimStart.input.value, trimEndMs: trimEnd.input.value });
      if (parameters.ok) void keep(parameters.value);
      render();
      publish();
    });
  }

  renderButton.addEventListener("click", () => {
    const binding = renderBinding();
    const parameters = readParameters({ gainDb: gain.input.value, trimStartMs: trimStart.input.value, trimEndMs: trimEnd.input.value });
    if (binding === undefined || saved.source === null || !parameters.ok || availabilityReason() !== undefined) return;
    const source = saved.source;
    void run(async () => {
      say("working", "Đang gửi yêu cầu dựng…");
      // The earlier render stays on screen, with Attach and Save, until this press is accepted: a refused press keeps it.
      const jobId = await api.actions.invoke(binding, { source: source.artifactId, ...parameters.value }, window.crypto.randomUUID());
      if (typeof jobId !== "string" || !/^job_/.test(jobId)) throw new Error("Host trả lời mà không có việc dựng nào.");
      // Accepted: the earlier output stays a file of its own, but it is not this render's and is no longer shown.
      unfollow();
      following = undefined;
      hidePreview();
      current = undefined;
      job.hidden = true;
      await keep({ ...parameters.value, output: null, job: jobId });
      follow(jobId);
      say("started", "Đã bắt đầu dựng.");
    });
  });

  cancelButton.addEventListener("click", () => {
    if (following === undefined) return;
    cancelButton.disabled = true;
    say("working", "Đang dừng…");
    void api.jobs.cancel(following).catch((error) => {
      // Refused: the render goes on, so Stop and Escape are offered again.
      say("refused", `Chưa dừng được: ${reasonOf(error)}. Bản dựng vẫn đang chạy; bấm Dừng dựng để thử lại.`);
      render();
    });
  });

  attachButton.addEventListener("click", () => {
    const output = saved.output;
    if (output === null) return;
    void run(async () => {
      await api.artifacts.attachToConversation(output);
      say("attached", `Đã đưa “${output.name}” vào ô soạn tin; gửi tin nhắn để chia sẻ.`);
    });
  });

  exportButton.addEventListener("click", () => {
    const output = saved.output;
    if (output === null) return;
    void run(async () => {
      say("working", "Đang chờ bạn lưu ở hộp của ứng dụng…");
      const done = await api.artifacts.export(output, { suggestedName: renderedName(saved.source?.name) });
      say(done ? "exported" : "cancelled", done ? "Đã giao bản dựng cho ứng dụng; xem thông báo của ứng dụng để biết nó ở đâu." : "Chưa lưu: bạn đã đóng hộp lưu.");
    });
  });

  document.addEventListener("keydown", (event) => {
    // Escape stops a render in progress, the same as the Stop button.
    if (event.key === "Escape" && !cancelButton.disabled) {
      event.preventDefault();
      cancelButton.click();
    }
  });

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
    drawWaveform();
  }
  applyAppearance(api.appearance.current());
  api.appearance.subscribe(applyAppearance);

  api.actions.subscribe(() => {
    render();
  });
  api.props.subscribe(() => render());
  api.lifecycle.onDispose(() => {
    disposed = true;
    unfollow();
  });

  /*
   * The frame opens at the host's default height and cannot grow on its own, so it asks for its content's height
   * whenever that changes — on a phone the fields stack and the preview pushes the status line down.
   */
  const fit = () => api.host.resize({ height: Math.ceil(document.documentElement.scrollHeight) });
  new window.ResizeObserver(() => {
    fit();
    drawWaveform();
  }).observe(document.body);

  // A remount picks up what this widget held: the clip, the job it was following and the file that job made.
  if (saved.output !== null) showPreview(saved.output, false);
  if (saved.job !== null && api.jobs.available()) {
    follow(saved.job);
    say("restored", "Đang theo dõi lại bản dựng trước.");
  }
  render();
  publish();
  fit();
  root.setAttribute("data-media-ready", "true");
}

start();
