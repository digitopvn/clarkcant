/*
 * The connected app's frame code.
 *
 * It lists the tasks in the account the person connected and renames one. Both go through action bindings the host
 * gave this instance (named in props), which call the package's service; the service reaches the provider only through
 * the node, which adds the connection's token. Nothing here ever holds a token, a code or the account: the frame sees
 * what the service answered, and, when a binding cannot run, the host's reason — for example that the connection was
 * revoked — which it shows as it is.
 *
 * A rename is an external write. The host decides it through the person's execution policy, so a press may wait for
 * an approval card in the conversation; and when the answer never comes back, the host says the outcome is unknown and
 * that it was not retried. Either way the press does not finish here: the widget shows the host's sentence as it is and
 * does not press again on its own.
 */

import { readTaskList, readUpdatedTask, titleProblem } from "./tasks-core.js";

const root = document.getElementById("root");

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
  const LIST = typeof props.listBinding === "string" ? props.listBinding : undefined;
  const UPDATE = typeof props.updateBinding === "string" ? props.updateBinding : undefined;

  const title = document.createElement("h2");
  title.textContent = String(props.title || "Công việc");

  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  const load = document.createElement("button");
  load.type = "button";
  load.className = "primary";
  load.textContent = "Tải công việc";
  load.setAttribute("data-tasks-load", "true");
  toolbar.append(load);

  const unavailable = document.createElement("p");
  unavailable.setAttribute("data-tasks-unavailable", "true");
  unavailable.setAttribute("role", "status");

  const list = document.createElement("ul");
  list.setAttribute("data-tasks-list", "true");
  list.setAttribute("aria-label", "Công việc");

  const output = document.createElement("p");
  output.setAttribute("data-tasks-output", "true");
  output.setAttribute("role", "status");
  output.setAttribute("aria-live", "polite");

  const hint = document.createElement("p");
  hint.className = "muted";
  if (LIST === undefined) hint.textContent = "Widget này chưa được gắn với dịch vụ nên chưa tải được công việc.";

  /** What the host last said about each binding: whether it can run and, when not, why. */
  let availability = new Map();
  const saveButtons = new Set();

  function say(text, state) {
    output.textContent = text;
    if (state === undefined) output.removeAttribute("data-tasks-state");
    else output.setAttribute("data-tasks-state", state);
  }

  function errorText(error) {
    return String(error && error.message ? error.message : error);
  }

  function refreshControls() {
    const listEntry = LIST === undefined ? undefined : availability.get(LIST);
    const updateEntry = UPDATE === undefined ? undefined : availability.get(UPDATE);
    load.disabled = LIST === undefined || (listEntry !== undefined && !listEntry.available);
    for (const button of saveButtons) button.disabled = UPDATE === undefined || (updateEntry !== undefined && !updateEntry.available);
    const reasons = [listEntry, updateEntry]
      .filter((entry) => entry !== undefined && !entry.available)
      .map((entry) => entry.reason ?? "dịch vụ chưa sẵn sàng");
    unavailable.textContent = reasons.length === 0 ? "" : `Chưa dùng được: ${[...new Set(reasons)].join(" · ")}`;
    root.setAttribute("data-tasks-list-ready", listEntry === undefined || listEntry.available ? "true" : "false");
    root.setAttribute("data-tasks-update-ready", updateEntry === undefined || updateEntry.available ? "true" : "false");
  }

  function rename(task, field) {
    const problem = titleProblem(field.value);
    if (problem !== undefined) {
      say(problem, "not-done");
      return;
    }
    say("đang lưu…", undefined);
    void api.actions
      .invoke(UPDATE, { id: task.id, title: field.value.trim() }, crypto.randomUUID())
      .then((answer) => {
        const updated = readUpdatedTask(answer);
        if (updated !== undefined) field.value = updated.title;
        say(`Đã lưu “${updated?.title ?? field.value}”.`, "done");
      })
      // The host's own sentence, as it is: the account is not connected, the policy is asking the person in the
      // conversation (nothing was sent yet), or the answer never came back and whether it took effect is unknown.
      .catch((error) => say(errorText(error), "not-done"));
  }

  function render(tasks) {
    list.replaceChildren();
    saveButtons.clear();
    if (tasks.length === 0) {
      const empty = document.createElement("li");
      empty.className = "muted";
      empty.textContent = "Tài khoản này chưa có công việc nào.";
      list.append(empty);
    }
    for (const task of tasks) {
      const item = document.createElement("li");
      item.setAttribute("data-task-id", task.id);
      item.setAttribute("data-task-done", task.done ? "true" : "false");
      const field = document.createElement("input");
      field.type = "text";
      field.maxLength = 200;
      field.value = task.title;
      field.setAttribute("aria-label", `Tên công việc ${task.id}`);
      field.setAttribute("data-task-title", task.id);
      const save = document.createElement("button");
      save.type = "button";
      save.textContent = "Lưu";
      save.setAttribute("data-task-save", task.id);
      save.addEventListener("click", () => rename(task, field));
      field.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !save.disabled) rename(task, field);
      });
      saveButtons.add(save);
      item.append(field, save);
      list.append(item);
    }
    refreshControls();
  }

  load.addEventListener("click", () => {
    say("đang tải…", undefined);
    void api.actions
      .invoke(LIST, {}, crypto.randomUUID())
      .then((answer) => {
        const read = readTaskList(answer);
        if (!read.ok) {
          say(read.problem, "not-done");
          return;
        }
        render(read.tasks);
        say(`Đã tải ${String(read.tasks.length)} công việc.`, "done");
        root.setAttribute("data-tasks-loaded", "true");
      })
      .catch((error) => say(errorText(error), "not-done"));
  });

  const announce = (entries) => {
    availability = new Map(entries.map((entry) => [entry.actionBindingId, entry]));
    if (entries.length > 0) root.setAttribute("data-tasks-announced", "true");
    refreshControls();
  };
  announce(api.actions.availability());
  api.actions.subscribe(announce);

  root.append(title, toolbar, unavailable, hint, list, output);
  root.setAttribute("data-widget-ready", "true");

  const report = () => api.host.resize({ height: Math.ceil(root.getBoundingClientRect().bottom) + 12 });
  new window.ResizeObserver(report).observe(root);
}

draw();
