import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const mutations = [
  ['initial', 'packages/widget-host/src/session.ts', '...(appearance === undefined ? {} : { appearance }),', '...{},', 'packages/widget-host/test/session.spec.ts'],
  ['live', 'packages/widget-host/src/session.ts', 'input.post({ kind: "appearance.changed", nonce: input.nonce, revision: checked.revision, appearance: checked });', 'void checked;', 'packages/widget-host/test/session.spec.ts'],
  ['readonly', 'packages/widget-sdk/src/runtime.ts', 'appearance = freezeSnapshot(next);', 'appearance = next;', 'packages/widget-sdk/test/runtime.spec.ts'],
  ['fixed', 'packages/conversation-client/src/widget-library/WidgetGallery.tsx', 'entry.definition.appearanceMode === "fixed" &&', 'false &&', 'packages/conversation-client/test/widget-appearance-disclosure.spec.ts'],
];
const results = [];
for (const [name, path, before, after, test] of mutations) {
  const original = readFileSync(path);
  const source = original.toString('utf8');
  if (source.split(before).length !== 2) throw new Error(`mutation ${name}: expected exactly one target`);
  let result;
  try {
    writeFileSync(path, source.replace(before, after));
    result = spawnSync('cmd.exe', ['/d', '/c', `corepack pnpm exec vitest run ${test} -t appearance`], { encoding: 'utf8', timeout: 90_000 });
    writeFileSync(`plans/reports/mutation-299-${name}.log`, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  } finally {
    writeFileSync(path, original);
  }
  const restored = createHash('sha256').update(readFileSync(path)).digest('hex') === createHash('sha256').update(original).digest('hex');
  const detected = result.status !== 0 && /FAIL|failed/i.test(result.stdout);
  results.push({ name, detected, restored, exit: result.status });
  if (!detected || !restored) throw new Error(`mutation ${name}: verification failed`);
}
writeFileSync('plans/reports/mutation-299-results.json', JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results));
