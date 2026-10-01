import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = "D:/web302";
let checked = 0;
for (const file of ["docs/api.html", "vi/docs/api.html"]) {
  const source = readFileSync(resolve(root, file), "utf8");
  const ids = [...source.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  if (new Set(ids).size !== ids.length) throw new Error(`${file}: duplicate IDs`);
  if (!ids.includes("reference-themes")) throw new Error(`${file}: missing reference anchor`);
  for (const match of source.matchAll(/\bhref="([^"]+)"/g)) {
    const href = match[1];
    if (/^(https?:|mailto:|tel:)/.test(href)) continue;
    const url = new URL(href, `https://local.invalid/${file}`);
    let target = resolve(root, decodeURIComponent(url.pathname).slice(1));
    if (!existsSync(target)) throw new Error(`${file}: missing ${href}`);
    if (statSync(target).isDirectory()) target = resolve(target, "index.html");
    if (url.hash) {
      const anchor = decodeURIComponent(url.hash.slice(1));
      const targetSource = readFileSync(target, "utf8");
      if (![...targetSource.matchAll(/\bid="([^"]+)"/g)].some((entry) => entry[1] === anchor)) {
        throw new Error(`${file}: missing anchor ${href}`);
      }
    }
    checked += 1;
  }
}
console.log(`${checked} local documentation links and anchors passed; reference anchors and IDs are valid.`);
