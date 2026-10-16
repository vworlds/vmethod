import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { expect, test } from 'vitest';
import { peer, validProject } from './helpers.js';

test('packed consumer installs offline with a metadata-only Mermaid fixture and no git/gh', () => {
  const build = spawnSync(process.execPath, ['scripts/build.mjs'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  expect(build.status, build.stderr).toBe(0);
  const map = JSON.parse(readFileSync('dist/vmethod.mjs.map', 'utf8')) as {
    sources: string[];
    sourcesContent: string[];
  };
  for (const file of [
    'schema/vmethod.schema.json',
    'schema/people.schema.json',
    'schema/models.schema.json',
    'board/migrations/0001-baseline.json',
  ]) {
    const index = map.sources.findIndex(
      (source) =>
        resolve(dirname('dist/vmethod.mjs.map'), source) === resolve(file),
    );
    expect(
      index,
      `${file} must be embedded in the bundle sourcemap`,
    ).toBeGreaterThanOrEqual(0);
    expect(
      map.sourcesContent[index],
      `${file} must match the editable source`,
    ).toBe(readFileSync(file, 'utf8'));
  }
  const result = spawnSync(process.execPath, ['scripts/smoke.mjs'], {
    encoding: 'utf8',
    timeout: 90000,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('Tarball smoke passed');
  const root = validProject();
  const cli = resolve('dist/vmethod.mjs');
  const run = () =>
    spawnSync(process.execPath, [cli, 'check'], {
      cwd: root,
      env: {},
      encoding: 'utf8',
      timeout: 5000,
    });
  expect(run().status).toBe(0);
  peer(root, '0.0.0');
  expect(run().status).toBe(1);
  rmSync(join(root, 'node_modules/mermaid'), { recursive: true });
  expect(run().status).toBe(2);
}, 120000);
