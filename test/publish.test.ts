import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  copyFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { fixture } from './helpers.js';

function publish(authFailure = false, candidate = false) {
  const root = fixture();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'changes/unreleased'), { recursive: true });
  copyFileSync('package.json', join(root, 'package.json'));
  writeFileSync(
    join(root, 'changes/unreleased/14.md'),
    'kind: feature\n\nPackage skeleton\n',
  );
  const calls = join(root, 'calls.jsonl');
  // Only this finite set of exact calls can succeed. Everything else throws.
  const expectations = {
    npm: {
      '["view","@vworlds/vmethod","--json"]': {
        output: JSON.stringify({
          'dist-tags': { latest: '0.0.0' },
          versions: ['0.1.0-rc.1'],
        }),
      },
      '["run","build"]': { output: '' },
      [JSON.stringify([
        'publish',
        '--provenance',
        '--access',
        'public',
        '--tag',
        candidate ? 'next' : 'latest',
      ])]: authFailure
        ? { error: 'ENEEDAUTH trusted publishing unavailable' }
        : { output: '' },
    },
    git: {
      [JSON.stringify(['tag', candidate ? 'v0.1.0-rc.2' : 'v0.1.0'])]: {
        output: '',
      },
      [JSON.stringify([
        'push',
        'origin',
        candidate ? 'refs/tags/v0.1.0-rc.2' : 'refs/tags/v0.1.0',
      ])]: { output: '' },
    },
  };
  for (const [tool, expected] of Object.entries(expectations)) {
    const file = join(bin, tool);
    writeFileSync(
      file,
      `#!${process.execPath}\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(tool)}, ...args]) + '\\n');\nconst expected = ${JSON.stringify(expected)};\nconst result = expected[JSON.stringify(args)];\nif (!result) throw new Error('Unexpected ${tool} call: ' + JSON.stringify(args));\nif (result.error) { console.error(result.error); process.exit(1); }\nconsole.log(result.output);\n`,
    );
    chmodSync(file, 0o755);
  }
  const result = spawnSync(process.execPath, [resolve('scripts/publish.mjs')], {
    cwd: root,
    env: {
      PATH: bin,
      GITHUB_EVENT_NAME: candidate ? 'workflow_dispatch' : 'push',
      GITHUB_REF: candidate ? 'refs/heads/dev' : 'refs/heads/master',
    },
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    result,
    pkg: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
    calls: readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  };
}

test.each([false, true])(
  'publishes workspace-only version with provenance then immutable tag (RC=%s)',
  (candidate) => {
    const { result, pkg, calls } = publish(false, candidate);
    expect(result.status, result.stderr).toBe(0);
    expect(pkg.version).toBe(candidate ? '0.1.0-rc.2' : '0.1.0');
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ['npm', 'view'],
      ['npm', 'run'],
      ['npm', 'publish'],
      ['git', 'tag'],
      ['git', 'push'],
    ]);
    expect(JSON.parse(readFileSync('package.json', 'utf8')).version).toBe(
      '0.0.0-dev',
    );
  },
  15000,
);

test('missing trusted publisher fails clearly without creating or pushing a tag', () => {
  const { result, calls } = publish(true);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('trusted publisher not configured');
  expect(calls.every((call) => call[0] === 'npm')).toBe(true);
}, 15000);

test('manual publication outside dev fails before any external call', () => {
  const result = spawnSync(process.execPath, [resolve('scripts/publish.mjs')], {
    cwd: fixture(),
    env: {
      PATH: '',
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      GITHUB_REF: 'refs/heads/master',
    },
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Publishing requires refs/heads/dev');
}, 15000);
