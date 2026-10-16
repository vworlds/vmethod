import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { configValue, getConfig, loadYaml } from '../src/config.js';
import { validProject } from './helpers.js';

test.each([
  { kind: 'opencode', model: 'provider/model', gate: 'none', valid: true },
  { kind: 'claude', model: 'claude-sonnet-5-5', gate: 'none', valid: true },
  { kind: 'claude', model: 'claude-opus-5-5', gate: 'owner', valid: true },
  { kind: 'opencode', model: 'bare-model', gate: 'none', valid: false },
  { kind: 'claude', model: 'provider/model', gate: 'none', valid: false },
  { kind: 'claude', model: 'model with spaces', gate: 'none', valid: false },
  { kind: 'opencode', model: 'provider/model', gate: '-', valid: false },
])(
  'models schema validates kind=$kind model=$model gate=$gate (valid=$valid)',
  ({ kind, model, gate, valid }) => {
    const root = validProject();
    writeFileSync(
      join(root, 'models.yaml'),
      `- family: other\n  kind: ${kind}\n  model: ${model}\n  gate: "${gate}"\n`,
    );
    if (valid)
      expect(loadYaml(root, 'models')).toEqual([
        { family: 'other', kind, model, gate },
      ]);
    else expect(() => loadYaml(root, 'models')).toThrow('models.yaml:');
  },
  15000,
);

test('YAML 1.2 strings, nested keys, explicit validation and unknown keys', () => {
  const root = validProject();
  const path = join(root, 'vmethod.yaml');
  writeFileSync(
    path,
    readFileSync(path, 'utf8') + '\ntrack: no\nstateName: "1.10"\n',
  );
  expect(configValue(getConfig(root, {}), 'track')).toBe('no');
  expect(configValue(getConfig(root, {}), 'stateName')).toBe('1.10');
  expect(configValue(getConfig(root, {}), 'board.number')).toBe(1);
  expect(() => configValue(getConfig(root, {}), 'unknown')).toThrow(
    'Unknown config key',
  );
  writeFileSync(
    path,
    readFileSync(path, 'utf8').replace('number: 1', 'number: wrong'),
  );
  expect(() => getConfig(root, {})).toThrow(/vmethod.yaml:8:.*integer/);
}, 15000);

test('VMETHOD overrides config; VECS, SPACEROCKS and bare BASE are ignored', () => {
  const root = validProject();
  expect(
    getConfig(root, {
      VECS_BASE: 'foreign',
      SPACEROCKS_BASE: 'foreign',
      BASE: 'foreign',
    }).baseBranch,
  ).toBe('dev');
  expect(
    getConfig(root, {
      VMETHOD_BOARD_NUMBER: '7',
      VECS_BOARD_PROJECT: '8',
      SPACEROCKS_BOARD_NUMBER: '9',
    }).board,
  ).toMatchObject({ number: 7 });
  expect(
    getConfig(root, { VMETHOD_BASE: 'track', VECS_BASE: 'legacy' }).baseBranch,
  ).toBe('track');
  expect(() => getConfig(root, { VMETHOD_BOARD_NUMBER: 'wrong' })).toThrow(
    'integer',
  );
}, 15000);

test('default board switch, arrays and credential-name overrides are typed and validated', () => {
  const root = validProject();
  const path = join(root, 'vmethod.yaml');
  writeFileSync(
    path,
    readFileSync(path, 'utf8') + '\ncredentials:\n  githubToken: GH_TOKEN\n',
  );
  expect(getConfig(root, {})).toMatchObject({ board: { enabled: true } });
  expect(
    getConfig(root, {
      VMETHOD_CREDENTIALS_GITHUB_TOKEN: 'OTHER_TOKEN',
      VMETHOD_BOARD_REPOS: '[example/one, example/two]',
    }),
  ).toMatchObject({
    credentials: { githubToken: 'OTHER_TOKEN' },
    board: { repos: ['example/one', 'example/two'] },
  });
  expect(() =>
    getConfig(root, { VMETHOD_CREDENTIALS_GITHUB_TOKEN: 'literal-value' }),
  ).toThrow('pattern');
}, 15000);

test('VMETHOD board, track and base switches map to config', () => {
  const root = validProject();
  const config = getConfig(root, {
    VMETHOD_BOARD: 'off',
    VMETHOD_TRACK: 'track-name',
    VMETHOD_BASE: 'track/base',
    VECS_BOARD: 'on',
    VECS_TRACK: 'foreign',
    VECS_BASE: 'foreign',
    VECS_OWNER: 'foreign',
    VECS_BOARD_PROJECT: '99',
  });
  expect(config).toMatchObject({
    track: 'track-name',
    baseBranch: 'track/base',
    board: { enabled: false, owner: 'example', number: 1 },
  });
  expect(getConfig(root, { VMETHOD_BOARD: 'on' })).toMatchObject({
    board: { enabled: true },
  });
}, 15000);

test('owner authority cannot be supplied by VMETHOD_OWNER; obsolete board node-id switch is ignored', () => {
  const root = validProject();
  const people = loadYaml(root, 'people');
  const config = getConfig(root, {
    VMETHOD_OWNER: 'attacker',
    VMETHOD_BOARD_PROJECT: 'PVT_node_id',
  });
  expect(config).toEqual(getConfig(root, {}));
  expect(loadYaml(root, 'people', { VMETHOD_OWNER: 'attacker' })).toEqual(
    people,
  );
  expect(
    getConfig(root, {
      VMETHOD_BOARD_OWNER: 'board-org',
      VMETHOD_BOARD_NUMBER: '42',
    }),
  ).toMatchObject({ board: { owner: 'board-org', number: 42 } });
}, 15000);

test('schema rejects missing numeric ids, unknown model families, duplicate YAML keys and unknown config keys', () => {
  const root = validProject();
  writeFileSync(join(root, 'people.yaml'), '- login: owner\n  role: owner\n');
  expect(() => loadYaml(root, 'people')).toThrow(/people.yaml:1:.*id/);
  writeFileSync(
    join(root, 'models.yaml'),
    '- family: imaginary\n  model: provider/model\n  kind: opencode\n  gate: none\n',
  );
  expect(() => loadYaml(root, 'models')).toThrow(/models.yaml:1:.*allowed/);
  const path = join(root, 'vmethod.yaml');
  writeFileSync(path, readFileSync(path, 'utf8') + '\nunknown: value\n');
  expect(() => getConfig(root, {})).toThrow('additional properties');
  writeFileSync(path, 'repo: a/b\nrepo: c/d\n');
  expect(() => getConfig(root, {})).toThrow('DUPLICATE_KEY');
}, 15000);
