import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';

const root = resolve(process.argv[2]);
const pages = ['docs/index.html', 'docs/api.html', 'docs/websocket.html', 'vi/docs/index.html', 'vi/docs/api.html', 'vi/docs/cli.html', 'vi/docs/mcp.html', 'vi/docs/websocket.html'];
let checked = 0;
const failures = [];
for (const page of pages) {
  const file = resolve(root, page);
  const html = readFileSync(file, 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(x => x[1]);
  if (new Set(ids).size !== ids.length) failures.push(`${page}: duplicate id`);
  for (const [, href] of html.matchAll(/\bhref="([^"]+)"/g)) {
    if (/^(?:https?:|mailto:|data:)/.test(href)) continue;
    const [path, anchor] = href.split('#');
    let target = path ? resolve(path.startsWith('/') ? root : dirname(file), path.replace(/^\//, '').split('?')[0]) : file;
    if (!existsSync(target)) { failures.push(`${page}: missing ${href}`); continue; }
    if (statSync(target).isDirectory()) target = join(target, 'index.html');
    if (!existsSync(target)) { failures.push(`${page}: missing index ${href}`); continue; }
    if (anchor && target.endsWith('.html')) {
      const targetHtml = readFileSync(target, 'utf8');
      if (!targetHtml.includes(`id="${anchor}"`)) failures.push(`${page}: missing anchor ${href}`);
    }
    checked++;
  }
  if (page.startsWith('vi/') && /conformance-traceability\.vi\.md/.test(html)) failures.push(`${page}: translated ledger`);
  if (page.startsWith('vi/') && !html.includes('Sổ trạng thái (tiếng Anh)')) failures.push(`${page}: missing English ledger label`);
}
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`${pages.length} pages: ${checked} local links/anchors checked; no duplicate ids or translated ledger links.`);
