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

  root.append(title, label, add, list, malformed, unavailable, output);
  root.setAttribute("data-widget-ready", "true");

  // The host sizes the frame; the widget says how tall its content is, again whenever that changes.
  const report = () => api.host.resize({ height: Math.ceil(root.getBoundingClientRect().bottom) + 8 });
  new window.ResizeObserver(report).observe(root);
}

draw();
