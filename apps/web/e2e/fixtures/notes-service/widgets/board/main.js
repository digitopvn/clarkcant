/*
 * The notes widget's own code.
 *
 * It keeps nothing itself: the notes live in the package's service, reached through two bindings the host gave this
 * instance. The widget asks; the host checks the binding, the service's readiness and the policy, and calls the service.
 * When the host says a binding cannot run, the button is disabled and the host's reason is shown next to it, while the
 * rest of the widget keeps working.
 */

const root = document.getElementById("root");
const ADD = "binding_notes_add";
const LIST = "binding_notes_list";
const MALFORMED = "binding_notes_malformed";
const EXPORT = "binding_notes_export";

function draw() {
  const runtime = window.clarkcantWidget;
  if (runtime === undefined || runtime.status() !== "ready") {
    setTimeout(draw, 20);
    return;
  }
  if (root.dataset.drawn === "true") return;
  root.dataset.drawn = "true";

  const api = runtime.api();
  const props = api.props.read();

  const title = document.createElement("h2");
  title.textContent = String(props.title ?? "Notes");

  const label = document.createElement("label");
  label.textContent = "Ghi chú mới ";
  const field = document.createElement("input");
  field.type = "text";
  field.maxLength = 500;
  field.setAttribute("data-notes-text", "true");
  label.append(field);

  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "Thêm ghi chú";
  add.setAttribute("data-notes-add", "true");

  const list = document.createElement("button");
  list.type = "button";
  list.textContent = "Tải danh sách";
  list.setAttribute("data-notes-list", "true");

  const malformed = document.createElement("button");
  malformed.type = "button";
  malformed.textContent = "Test malformed fixture";
  malformed.setAttribute("data-notes-malformed", "true");

  const unavailable = document.createElement("p");
  unavailable.setAttribute("data-notes-unavailable", "true");
  unavailable.setAttribute("role", "status");

  const output = document.createElement("p");
  output.setAttribute("data-notes-output", "true");
  output.setAttribute("aria-live", "polite");

  const run = (binding, input) => {
    output.textContent = "đang gửi…";
    output.removeAttribute("data-notes-state");
    void api.actions
      .invoke(binding, input, crypto.randomUUID())
      .then((answer) => {
        output.textContent = answer ?? "host đã nhận hành động";
        output.setAttribute("data-notes-state", "done");
      })
      .catch((error) => {
        output.textContent = String(error && error.message ? error.message : error);
        output.setAttribute("data-notes-state", "refused");
      });
  };

  /*
   * The export runs as a job: the press answers with a JobRef, which the widget keeps in its state so a remount picks
   * the same job up again. Progress, the ending and the result file are the host's snapshot, never the widget's guess.
   */
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.textContent = "Xuất ghi chú";
  exportButton.setAttribute("data-notes-export", "true");
  const cancelExport = document.createElement("button");
  cancelExport.type = "button";
  cancelExport.textContent = "Dừng xuất";
  cancelExport.disabled = true;
  cancelExport.setAttribute("data-notes-export-cancel", "true");
  const job = document.createElement("p");
  job.setAttribute("data-notes-job", "true");
  job.setAttribute("aria-live", "polite");
  let following;
  let unfollow = () => undefined;
  const follow = (jobId) => {
    unfollow();
    following = jobId;
    job.setAttribute("data-notes-job-id", jobId);
    unfollow = api.jobs.subscribe(jobId, (snapshot) => {
      if (following !== jobId) return;
      const open = ["queued", "running", "waiting"].includes(snapshot.status);
      cancelExport.disabled = !open;
      job.setAttribute("data-notes-job-status", snapshot.status);
      if (snapshot.progress !== undefined) job.setAttribute("data-notes-job-progress", String(snapshot.progress.current));
      const files = snapshot.resultRefs.map((ref) => ref.name).join(", ");
      job.setAttribute("data-notes-job-files", files);
      const progress = snapshot.progress?.message ?? "";
      job.textContent = [snapshot.status, progress, files, snapshot.output ?? "", snapshot.error ?? ""].filter((part) => part !== "").join(" · ");
    });
  };
  exportButton.addEventListener("click", () => {
    job.textContent = "đang gửi…";
    void api.actions
      .invoke(EXPORT, { steps: Number(root.dataset.exportSteps ?? 3), stepMs: Number(root.dataset.exportStepMs ?? 400) }, crypto.randomUUID())
      .then((jobId) => {
        if (typeof jobId !== "string") throw new Error("the host answered without a job");
        follow(jobId);
        // Kept so a remount follows the same job; a host that cannot save state still shows it until then.
        return api.state.update(api.state.revision(), { exportJob: jobId }).catch(() => undefined);
      })
      .catch((error) => {
        job.textContent = String(error && error.message ? error.message : error);
        job.setAttribute("data-notes-job-status", "refused");
      });
  });
  cancelExport.addEventListener("click", () => {
    if (following === undefined) return;
    cancelExport.disabled = true;
    void api.jobs.cancel(following).catch((error) => {
      job.textContent = String(error && error.message ? error.message : error);
    });
  });
  const saved = api.state.get().exportJob;
  if (typeof saved === "string" && api.jobs.available()) follow(saved);

  add.addEventListener("click", () => run(ADD, { text: field.value }));
  list.addEventListener("click", () => run(LIST, {}));
  malformed.addEventListener("click", () => run(MALFORMED, {}));

  /*
   * What the host last said about the service-backed bindings. A binding it cannot run is disabled, and its reason is
   * the host's — the registry's — not something this widget made up.
   */
  const showAvailability = (entries) => {
    const reasons = [];
    for (const [binding, button] of [
      [ADD, add],
      [LIST, list],
      [EXPORT, exportButton],
    ]) {
      const entry = entries.find((candidate) => candidate.actionBindingId === binding);
      const off = entry !== undefined && !entry.available;
      button.disabled = off;
      if (off && entry.reason !== undefined && !reasons.includes(entry.reason)) reasons.push(entry.reason);
    }
    unavailable.textContent = reasons.length === 0 ? "" : `Dịch vụ chưa chạy: ${reasons.join("; ")}`;
    root.setAttribute("data-notes-service", reasons.length === 0 ? "available" : "unavailable");
  };
  // Marked once the host has said something, so a reader can tell "told it can run" from "not told yet". The host may
  // have said it before this code ran, which is why the current answer is read as well as subscribed to.
  const announce = (entries) => {
    if (entries.length > 0) root.setAttribute("data-notes-announced", "true");
    showAvailability(entries);
  };
  announce(api.actions.availability());
  api.actions.subscribe(announce);

  root.append(title, label, add, list, malformed, exportButton, cancelExport, unavailable, output, job);
  root.setAttribute("data-widget-ready", "true");

  // The host sizes the frame; the widget says how tall its content is, again whenever that changes.
  const report = () => api.host.resize({ height: Math.ceil(root.getBoundingClientRect().bottom) + 8 });
  new window.ResizeObserver(report).observe(root);
}

draw();
