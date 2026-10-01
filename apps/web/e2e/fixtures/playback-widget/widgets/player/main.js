/*
 * The playback widget's own code: a clock that counts while this document runs.
 *
 * It stands in for media that plays. A frame that keeps running out of view keeps counting; a suspended frame is
 * unmounted, so its document and its clock are gone. Whether it keeps running is never this code's choice: the host
 * decides, from the profile the package was granted and what the person pressed in host chrome.
 */

const root = document.getElementById("root");

function draw() {
  const runtime = window.clarkcantWidget;
  if (runtime === undefined || runtime.status() !== "ready") {
    setTimeout(draw, 20);
    return;
  }
  if (root.dataset.drawn === "true") return;
  root.dataset.drawn = "true";

  const props = runtime.api().props.read();
  const title = document.createElement("h2");
  title.textContent = String(props.title ?? "Playback");

  const clock = document.createElement("p");
  clock.setAttribute("data-playback-ticks", "0");
  let ticks = 0;
  clock.textContent = "0";
  window.setInterval(() => {
    ticks += 1;
    clock.textContent = String(ticks);
    clock.setAttribute("data-playback-ticks", String(ticks));
  }, 100);

  root.append(title, clock);
  root.setAttribute("data-playback-ready", "true");
}

draw();
