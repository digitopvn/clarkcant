/*
 * The lookup widget's own code.
 *
 * The press reaches the package's service through a binding the host gave this instance; the service reaches the
 * provider only through the node, which adds the key. Nothing here ever holds the key, so nothing here can show it.
 *
 * The map button asks for a short-lived browser token through `tokens@1`. The token is kept in a variable and never
 * drawn: the widget shows only that it holds one and until when. It also tries to save the token in its state, which
 * the runtime refuses, and shows that refusal, so a reader sees the guard rather than having to trust it.
 */

const root = document.getElementById("root");
const DEFINE = "binding_lookup_define";

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
  title.textContent = String(props.title ?? "Lookup");

  const label = document.createElement("label");
  label.textContent = "Từ cần tra ";
  const field = document.createElement("input");
  field.type = "text";
  field.maxLength = 60;
  field.setAttribute("data-lookup-word", "true");
  label.append(field);

  const define = document.createElement("button");
  define.type = "button";
  define.textContent = "Tra từ";
  define.setAttribute("data-lookup-define", "true");

  const unavailable = document.createElement("p");
  unavailable.setAttribute("data-lookup-unavailable", "true");
  unavailable.setAttribute("role", "status");

  const output = document.createElement("p");
  output.setAttribute("data-lookup-output", "true");
  output.setAttribute("aria-live", "polite");

  define.addEventListener("click", () => {
    output.textContent = "đang gửi…";
    output.removeAttribute("data-lookup-state");
    void api.actions
      .invoke(DEFINE, { word: field.value }, crypto.randomUUID())
      .then((answer) => {
        output.textContent = answer ?? "host đã nhận hành động";
        output.setAttribute("data-lookup-state", "done");
      })
      .catch((error) => {
        output.textContent = String(error && error.message ? error.message : error);
        output.setAttribute("data-lookup-state", "refused");
      });
  });

  const map = document.createElement("button");
  map.type = "button";
  map.textContent = "Mở bản đồ";
  map.setAttribute("data-lookup-map", "true");
  const unscoped = document.createElement("button");
  unscoped.type = "button";
  unscoped.textContent = "Thử nhà cung cấp không giới hạn phạm vi";
  unscoped.setAttribute("data-lookup-unscoped", "true");
  const token = document.createElement("p");
  token.setAttribute("data-lookup-token", "none");
  token.setAttribute("aria-live", "polite");
  const leak = document.createElement("p");
  leak.setAttribute("data-lookup-token-leak", "untried");

  // Held here and nowhere else: not in the page, not in state, not in what the widget publishes.
  let held;
  map.addEventListener("click", () => {
    token.textContent = "đang xin token…";
    void api.tokens
      .request({ provider: "fixture.maps", scopes: ["tiles:read"], ttlSeconds: 300 })
      .then(async (issued) => {
        held = issued;
        token.textContent = `Đang giữ token ${issued.provider} (${issued.scopes.join(", ")}) đến ${issued.expiresAt}`;
        token.setAttribute("data-lookup-token", "held");
        try {
          await api.state.update(api.state.revision(), { mapToken: held.value });
          leak.setAttribute("data-lookup-token-leak", "saved");
        } catch (error) {
          leak.textContent = String(error && error.message ? error.message : error);
          leak.setAttribute("data-lookup-token-leak", "refused");
        }
      })
      .catch((error) => {
        token.textContent = String(error && error.message ? error.message : error);
        token.setAttribute("data-lookup-token", "refused");
      });
  });
  unscoped.addEventListener("click", () => {
    void api.tokens
      .request({ provider: "fixture.unscoped", scopes: ["everything"] })
      .then(() => token.setAttribute("data-lookup-token", "unscoped-held"))
      .catch((error) => {
        token.textContent = String(error && error.message ? error.message : error);
        token.setAttribute("data-lookup-token", "refused");
      });
  });
  if (!api.tokens.available()) {
    map.disabled = true;
    unscoped.disabled = true;
  }

  /*
   * What the host last said about the service-backed binding. Disabled with the host's reason when it cannot run —
   * for example before the person has given the package its key.
   */
  const announce = (entries) => {
    const entry = entries.find((candidate) => candidate.actionBindingId === DEFINE);
    if (entries.length > 0) root.setAttribute("data-lookup-announced", "true");
    const off = entry !== undefined && !entry.available;
    define.disabled = off;
    unavailable.textContent = off ? `Chưa tra được: ${entry.reason ?? ""}` : "";
    root.setAttribute("data-lookup-service", off ? "unavailable" : "available");
  };
  announce(api.actions.availability());
  api.actions.subscribe(announce);

  root.append(title, label, define, unavailable, output, map, unscoped, token, leak);
  root.setAttribute("data-widget-ready", "true");

  const report = () => api.host.resize({ height: Math.ceil(root.getBoundingClientRect().bottom) + 8 });
  new window.ResizeObserver(report).observe(root);
}

draw();
