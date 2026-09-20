/*
 * The widget's own code.
 *
 * It reaches the host only through `window.clarkcantWidget`, which the document the node served created for it. It has
 * no session, no storage and no route of its own — that is what an opaque origin means — so everything it shows comes
 * from the props it was handed, and everything it asks for goes over the bridge.
 */

const root = document.getElementById("root");
const BINDING = "binding_frame_widget_fixture";

function draw() {
  const runtime = window.clarkcantWidget;
  // The runtime is `awaiting-init` until the host's init message arrives, which is later than this script running.
  if (runtime === undefined || runtime.status() !== "ready") {
    setTimeout(draw, 20);
    return;
  }
  if (root.dataset.drawn === "true") return;
  root.dataset.drawn = "true";

  const api = runtime.api();
  const props = api.props.read();

  const title = document.createElement("h2");
  title.textContent = String(props.title ?? "");
  title.setAttribute("data-widget-title", "true");

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Gửi ý định";
  button.setAttribute("data-widget-action", "true");

  const outcome = document.createElement("p");
  outcome.setAttribute("data-widget-outcome", "true");

  button.addEventListener("click", () => {
    outcome.textContent = "đang gửi…";
    // The promise settles from the host's `action-result`: resolved when it was accepted, rejected with its reason
    // otherwise. That round trip is what this button exists to make visible.
    void api.actions
      .invoke(BINDING, {}, crypto.randomUUID())
      .then(() => {
        outcome.textContent = "host đã nhận hành động";
        outcome.setAttribute("data-widget-outcome-state", "accepted");
      })
      .catch((error) => {
        outcome.textContent = String(error && error.message ? error.message : error);
        outcome.setAttribute("data-widget-outcome-state", "refused");
      });
  });

  api.lifecycle.onMount(() => {
    root.setAttribute("data-widget-mounted", "true");
  });
  api.semantic.publish(String(props.title ?? "widget"), []);

  root.append(title, button, outcome);
  root.setAttribute("data-widget-ready", "true");
}

draw();
