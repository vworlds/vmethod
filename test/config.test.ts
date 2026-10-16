import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { configValue, getConfig, loadYaml } from '../src/config.js';
import { validProject } from './helpers.js';

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

test('VMETHOD board, track, base, owner and board-project switches map to config', () => {
  const root = validProject();
  const config = getConfig(root, {
    VMETHOD_BOARD: 'off',
    VMETHOD_TRACK: 'track-name',
    VMETHOD_BASE: 'track/base',
    VMETHOD_OWNER: 'board-owner',
    VMETHOD_BOARD_PROJECT: '42',
    VECS_BOARD: 'on',
    VECS_TRACK: 'foreign',
    VECS_BASE: 'foreign',
    VECS_OWNER: 'foreign',
    VECS_BOARD_PROJECT: '99',
  });
  expect(config).toMatchObject({
    track: 'track-name',
    baseBranch: 'track/base',
    board: { enabled: false, owner: 'board-owner', number: 42 },
  });
}, 15000);

test('schema rejects missing numeric ids, unknown model families, duplicate YAML keys and unknown config keys', () => {
  const root = validProject();
  writeFileSync(join(root, 'people.yaml'), '- login: owner\n  role: owner\n');
  expect(() => loadYaml(root, 'people')).toThrow(/people.yaml:1:.*id/);
  writeFileSync(
    join(root, 'models.yaml'),
    '- family: imaginary\n  model: provider/model\n  kind: worker\n  gate: none\n',
  );
  expect(() => loadYaml(root, 'models')).toThrow(/models.yaml:1:.*allowed/);
  const path = join(root, 'vmethod.yaml');
  writeFileSync(path, readFileSync(path, 'utf8') + '\nunknown: value\n');
  expect(() => getConfig(root, {})).toThrow('additional properties');
  writeFileSync(path, 'repo: a/b\nrepo: c/d\n');
  expect(() => getConfig(root, {})).toThrow('DUPLICATE_KEY');
}, 15000);
