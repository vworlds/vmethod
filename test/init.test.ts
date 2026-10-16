import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { init } from '../src/init.js';
import { loadYaml } from '../src/config.js';
import { fixture, templates } from './helpers.js';

test('init refuses symlink destinations before writing files', () => {
  const root = fixture();
  const target = fixture();
  symlinkSync(target, join(root, 'scripts'));
  expect(() => init(root, templates)).toThrow('Refusing to initialize symlink');
  expect(existsSync(join(root, 'vmethod.yaml'))).toBe(false);
  expect(existsSync(join(target, 'agent'))).toBe(false);
}, 15000);

test('init dry-run, idempotence, and safety for unmarked files and permissions', () => {
  const root = fixture();
  expect(init(root, templates, true)).toContain('Would write vmethod.yaml');
  expect(existsSync(join(root, 'vmethod.yaml'))).toBe(false);
  init(root, templates);
  expect(init(root, templates)).toEqual([]);
  expect(existsSync(join(root, '.claude'))).toBe(false);
  writeFileSync(
    join(root, 'scripts/agent/check.sh'),
    '#!/bin/sh\necho custom\n',
  );
  writeFileSync(
    join(root, 'scripts/agent/version.sh'),
    '#!/bin/sh\n# vmethod stub\nold\n',
  );
  expect(init(root, templates)).toEqual(['Wrote scripts/agent/version.sh']);
  expect(readFileSync(join(root, 'scripts/agent/check.sh'), 'utf8')).toContain(
    'echo custom',
  );
}, 15000);

test('stub resolves git root and preserves hostile arguments without shell evaluation', () => {
  const root = fixture();
  init(root, templates);
  const bin = join(root, 'fake-bin');
  mkdirSync(bin);
  const fakeGit = join(bin, 'git');
  writeFileSync(
    fakeGit,
    `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== '["rev-parse","--show-toplevel"]') throw new Error('Unexpected git call'); console.log(${JSON.stringify(root)});\n`,
  );
  chmodSync(fakeGit, 0o755);
  const cli = join(root, 'node_modules/.bin/vmethod');
  const args = ['$(touch should-not-exist)', 'a; echo bad', 'with spaces'];
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  writeFileSync(
    cli,
    `#!${process.execPath}\nconst args = process.argv.slice(2); if (JSON.stringify(args) !== ${JSON.stringify(JSON.stringify(['check', ...args]))}) throw new Error('Unexpected vmethod call'); console.log(JSON.stringify(args));\n`,
  );
  chmodSync(cli, 0o755);
  const result = spawnSync(
    '/bin/sh',
    [join(root, 'scripts/agent/check.sh'), ...args],
    { cwd: root, env: { PATH: bin }, encoding: 'utf8', timeout: 5000 },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual(['check', ...args]);
  expect(existsSync(join(root, 'should-not-exist'))).toBe(false);
  const fallback = spawnSync(
    '/bin/sh',
    [join(root, 'scripts/agent/check.sh'), ...args],
    {
      cwd: root,
      env: { PATH: join(root, 'no-git'), VMETHOD_ROOT: root },
      encoding: 'utf8',
      timeout: 5000,
    },
  );
  expect(fallback.status, fallback.stderr).toBe(0);
  expect(JSON.parse(fallback.stdout)).toEqual(['check', ...args]);
}, 15000);

test('converts models.tsv once, preserving gate and original TSV', () => {
  const root = fixture();
  const text =
    'family\tmodel\tkind\tgate\nsol\tprovider/model\tworker\towner\n';
  writeFileSync(join(root, 'models.tsv'), text);
  init(root, templates);
  expect(loadYaml(root, 'models')).toEqual([
    { family: 'sol', model: 'provider/model', kind: 'worker', gate: 'owner' },
  ]);
  writeFileSync(join(root, 'models.tsv'), 'invalid');
  expect(init(root, templates)).toEqual([]);
  expect(loadYaml(root, 'models')).toMatchObject([{ gate: 'owner' }]);
  const broken = fixture();
  writeFileSync(
    join(broken, 'models.tsv'),
    'family\tmodel\tkind\tgate\nwrong\ta/b\tworker\tnone\n',
  );
  expect(() => init(broken, templates)).toThrow('models.tsv conversion');
  expect(existsSync(join(broken, 'vmethod.yaml'))).toBe(false);
}, 15000);

test('stub without git or node_modules fails cleanly and never downloads', () => {
  const root = fixture();
  init(root, templates);
  const emptyPath = join(root, 'empty-bin');
  mkdirSync(emptyPath);
  const result = spawnSync('/bin/sh', [join(root, 'scripts/agent/check.sh')], {
    cwd: root,
    env: { PATH: emptyPath, VMETHOD_ROOT: root },
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('run npm ci');
}, 15000);
