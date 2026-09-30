/*
 * A widget that holds files by reference.
 *
 * Everything it does with a file goes through `api.artifacts`: the person picks in the host's chrome, the widget reads
 * the bytes in bounded chunks, writes a copy, fixes it, and asks the host to save or attach it. It never sees a path,
 * because nothing it is given has one — which is what the browser journey checks from outside.
 */

const root = document.getElementById("root");
/** One read: the bridge's own ceiling, so a file larger than this takes more than one. */
const CHUNK = 262_144;

function element(tag, attributes, text) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

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
  let picked;
  let copy;
  let text = "";

  const title = element("h2", { "data-widget-title": "true" }, String(props.title ?? ""));
  const available = element(
    "p",
    { "data-artifact-available": String(api.artifacts.available()), class: "muted" },
    api.artifacts.available() ? "Host cho phép dùng tệp." : "Host này không cho dùng tệp.",
  );
  const status = element("p", { "data-artifact-status": "idle", role: "status" }, "Chưa có tệp.");
  const say = (state, message) => {
    status.setAttribute("data-artifact-status", state);
    status.textContent = message;
  };
  const failed = (error) => say("refused", String(error && error.message ? error.message : error));

  const pick = element("button", { type: "button", "data-artifact-pick": "true" }, "Chọn tệp");
  const read = element("button", { type: "button", "data-artifact-read": "true", disabled: "" }, "Đọc tệp");
  const create = element("button", { type: "button", "data-artifact-create": "true", disabled: "" }, "Tạo bản viết hoa của đoạn đầu");
  const save = element("button", { type: "button", "data-artifact-export": "true", disabled: "" }, "Lưu thành…");
  const attach = element("button", { type: "button", "data-artifact-attach": "true", disabled: "" }, "Đính kèm");
  const actions = element("div", { class: "actions" });
  actions.append(pick, read, create, save, attach);

  const pickedLine = element("p", { "data-artifact-picked": "" });
  const readLine = element("p", { "data-artifact-read-bytes": "", "data-artifact-read-chunks": "" });
  const preview = element("p", { "data-artifact-read-text": "", class: "muted" });
  const copyLine = element("p", { "data-artifact-copy": "" });

  pick.addEventListener("click", () => {
    say("working", "Đang chờ bạn chọn tệp…");
    void api.artifacts
      .pick({ accept: ["text/*"] })
      .then((ref) => {
        if (ref === undefined) {
          say("cancelled", "Bạn đã đóng hộp chọn tệp.");
          return;
        }
        picked = ref;
        pickedLine.setAttribute("data-artifact-picked", ref.name);
        pickedLine.textContent = `${ref.name} · ${String(ref.sizeBytes)} byte · ${ref.kind}`;
        read.disabled = false;
        say("picked", "Đã nhận tệp.");
      })
      .catch(failed);
  });

  read.addEventListener("click", () => {
    if (picked === undefined) return;
    say("working", "Đang đọc…");
    void (async () => {
      const parts = [];
      let offset = 0;
      let chunks = 0;
      for (;;) {
        const { bytes, eof } = await api.artifacts.read(picked, { offset, length: CHUNK });
        parts.push(bytes);
        offset += bytes.byteLength;
        chunks += 1;
        if (eof || bytes.byteLength === 0) break;
      }
      const all = new Uint8Array(offset);
      let at = 0;
      for (const part of parts) {
        all.set(part, at);
        at += part.byteLength;
      }
      text = new window.TextDecoder().decode(all);
      readLine.setAttribute("data-artifact-read-bytes", String(offset));
      readLine.setAttribute("data-artifact-read-chunks", String(chunks));
      readLine.textContent = `Đã đọc ${String(offset)} byte trong ${String(chunks)} lần.`;
      preview.setAttribute("data-artifact-read-text", text.slice(0, 40));
      preview.textContent = text.slice(0, 120);
      create.disabled = false;
      say("read", "Đã đọc xong.");
    })().catch(failed);
  });

  create.addEventListener("click", () => {
    say("working", "Đang ghi bản sao…");
    void (async () => {
      // The opening of the file, not all of it: enough to show a written copy, small enough to attach and quote back.
      const bytes = new window.TextEncoder().encode(text.slice(0, 2_000).toUpperCase());
      let ref = await api.artifacts.create({ mimeType: "text/plain", name: "ban-viet-hoa.txt" });
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
        ref = await api.artifacts.write(ref, bytes.subarray(offset, offset + CHUNK));
      }
      copy = await api.artifacts.finalize(ref);
      copyLine.setAttribute("data-artifact-copy", copy.kind);
      copyLine.textContent = `${copy.name} · ${String(copy.sizeBytes)} byte · ${copy.kind}`;
      save.disabled = false;
      attach.disabled = false;
      say("finalized", "Bản sao đã được cố định.");
    })().catch(failed);
  });

  save.addEventListener("click", () => {
    if (copy === undefined) return;
    say("working", "Đang chờ bạn lưu…");
    void api.artifacts
      .export(copy, { suggestedName: "ban-viet-hoa.txt" })
      .then((saved) => say(saved ? "saved" : "cancelled", saved ? "Đã lưu." : "Bạn đã không lưu."))
      .catch(failed);
  });

  attach.addEventListener("click", () => {
    if (copy === undefined) return;
    void api.artifacts
      .attachToConversation(copy)
      .then(() => say("attached", "Đã đưa vào ô soạn tin."))
      .catch(failed);
  });

  api.semantic.publish(String(props.title ?? "widget tệp"), []);
  root.append(title, available, actions, status, pickedLine, readLine, preview, copyLine);
  /*
   * The frame opens at the host's default height and cannot grow on its own. On a phone the buttons wrap and push the
   * status lines below that default, so the widget asks for its content's height whenever that changes.
   */
  const fit = () => api.host.resize({ height: Math.ceil(document.documentElement.scrollHeight) });
  new window.ResizeObserver(fit).observe(document.body);
  fit();
  root.setAttribute("data-widget-ready", "true");
}

draw();
