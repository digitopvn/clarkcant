/*
 * The connected app's rules as pure functions, so they can be tested without a frame.
 *
 * The service answers a press with text; these read that text into what the widget draws, and refuse anything that is
 * not the shape the service sends rather than drawing a guess.
 */

export const TASK_LIMITS = Object.freeze({ tasks: 50, titleChars: 200 });

/** A task as the widget draws it, or undefined for anything else. */
function readTask(value) {
  if (typeof value !== "object" || value === null) return undefined;
  if (typeof value.id !== "string" || !/^[A-Za-z0-9-]{1,40}$/.test(value.id)) return undefined;
  if (typeof value.title !== "string") return undefined;
  return { id: value.id, title: value.title.slice(0, TASK_LIMITS.titleChars), done: value.done === true };
}

/** What `list-tasks` answered: `{ ok, tasks }`, or `{ ok: false, problem }` when it is not a task list. */
export function readTaskList(output) {
  let parsed;
  try {
    parsed = JSON.parse(String(output ?? ""));
  } catch {
    return { ok: false, problem: "Dịch vụ trả về thứ không phải danh sách công việc." };
  }
  if (!Array.isArray(parsed?.tasks)) return { ok: false, problem: "Dịch vụ trả về thứ không phải danh sách công việc." };
  const tasks = parsed.tasks.slice(0, TASK_LIMITS.tasks).map(readTask).filter((task) => task !== undefined);
  return { ok: true, tasks };
}

/** What `update-task` answered: the task as renamed, or undefined. */
export function readUpdatedTask(output) {
  try {
    return readTask(JSON.parse(String(output ?? ""))?.task);
  } catch {
    return undefined;
  }
}

/** The title a person typed, as the service will accept it, or the reason it will not. */
export function titleProblem(title) {
  const trimmed = String(title ?? "").trim();
  if (trimmed.length === 0) return "Tên công việc không được để trống.";
  if (trimmed.length > TASK_LIMITS.titleChars) return `Tên công việc dài tối đa ${String(TASK_LIMITS.titleChars)} ký tự.`;
  return undefined;
}
