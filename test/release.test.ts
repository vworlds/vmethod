import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

// Exercise the actual release planner with JSON fixtures; no registry/network calls.
function plan(
  kinds: string[],
  candidate = false,
  versions: string[] = [],
  latest = '1.2.3',
) {
  const script = `import {releasePlan} from './scripts/release-plan.mjs'; console.log(JSON.stringify(releasePlan(${JSON.stringify({ 'dist-tags': { latest }, versions })}, ${JSON.stringify(kinds.map((kind) => `kind: ${kind}\n\nDescription`))}, ${candidate})));`;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 5000 },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

test('release bump priority, reset lower components, and numbered next RCs', () => {
  expect(plan(['fix'])).toEqual({ version: '1.2.4', tag: 'latest' });
  expect(plan(['fix', 'feature'])).toEqual({ version: '1.3.0', tag: 'latest' });
  expect(plan(['breaking', 'feature'])).toEqual({
    version: '2.0.0',
    tag: 'latest',
  });
  expect(
    plan(['feature'], true, ['1.3.0-rc.1', '1.3.0-rc.4', '1.4.0-rc.9']),
  ).toEqual({ version: '1.3.0-rc.5', tag: 'next' });
  expect(plan(['feature'], false, [], '0.0.0')).toMatchObject({
    version: '0.1.0',
  });
}, 15000);

test('release fails on absent or malformed fragments and duplicate versions', () => {
  expect(() => plan([])).toThrow('nothing to release');
  expect(() => plan(['invalid'])).toThrow('kind:');
  expect(() => plan(['fix'], false, ['1.2.4'])).toThrow('already published');
}, 15000);
