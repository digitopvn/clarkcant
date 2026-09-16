/**
 * Shell renderer.
 *
 * Reads only from `window.clarkcant`, the named bridge the preload exposes. It has no direct
 * access to Electron, Node, or IPC channels, which is why every result here — including every
 * refusal — arrives as a value rather than as a thrown permission error.
 */

const output = document.querySelector("#output");
const statusList = document.querySelector("#status");

function show(value) {
  output.textContent = JSON.stringify(value, null, 2);
}

async function call(name, ...args) {
  try {
    show(await window.clarkcant[name](...args));
  } catch (error) {
    show({ threw: String(error) });
  }
}

async function renderStatus() {
  const status = await window.clarkcant.status();
  statusList.replaceChildren();
  for (const [key, value] of Object.entries(status)) {
    if (key === "ok" || key === "channels") continue;
    const term = document.createElement("dt");
    term.textContent = key;
    const description = document.createElement("dd");
    description.textContent = String(value);
    statusList.append(term, description);
  }
}

const actions = {
  "open-https": () => call("openExternal", "https://clarkcant.dev/"),
  "open-http": () => call("openExternal", "http://example.com/"),
  "open-file": () => call("openExternal", "file:///etc/passwd"),
  "credential-vague": () => call("requestCredential", { requestId: "ui-1", purpose: "x" }),
  "keep-running": async () => {
    const current = await window.clarkcant.status();
    show(await window.clarkcant.setKeepRunningOnWindowClose(!current.keepRunningOnWindowClose));
    await renderStatus();
  },
};

for (const [id, action] of Object.entries(actions)) {
  document.querySelector(`#${id}`).addEventListener("click", action);
}

renderStatus().catch((error) => show({ threw: String(error) }));
