import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { gatewayVerb } from '../../src/cli/gateway.js';
import type { CallContext } from '../../src/gateway/transport.js';
import { actor, fixtureServer, graph, item } from './helpers.js';

test('workers cannot call orchestrator-only operations, even with a taskPr', async () => {
  const fixture = fixtureServer([]);
  for (const ctx of [
    { role: 'worker' },
    { role: 'worker', taskPr: 3 },
  ] as const) {
    await expect(
      fixture.gateway.call('ghRead', { source: '/repos/example/project' }, ctx),
    ).rejects.toThrow('denied');
    await expect(fixture.gateway.call('dropped', {}, ctx)).rejects.toThrow(
      'denied',
    );
    await expect(
      fixture.gateway.call('ownerApproved', { ref: '3' }, ctx),
    ).rejects.toThrow('denied');
  }
  fixture.done();
}, 15000);

test('worker posting requires its own taskPr in the configured repo before reading files or networking', async () => {
  const fixture = fixtureServer([]);
  for (const taskPr of [undefined, 0, -1, 1.5, NaN, 4]) {
    await expect(
      fixture.gateway.call(
        'post',
        { ref: '3', file: 'must-not-read' },
        { role: 'worker', taskPr },
      ),
    ).rejects.toThrow('own taskPr');
  }
  for (const ref of ['4', 'example/other#3', 'outside/project#3']) {
    await expect(
      fixture.gateway.call(
        'post',
        { ref, file: 'must-not-read' },
        { role: 'worker', taskPr: 3 },
      ),
    ).rejects.toThrow();
  }
  fixture.done();
}, 15000);

test('missing and invalid client roles deny every operation', async () => {
  const fixture = fixtureServer([]);
  for (const ctx of [
    undefined,
    {},
    { role: 'owner' },
    { role: 'system' },
  ] as unknown as CallContext[]) {
    await expect(
      fixture.gateway.call('read', { kind: 'pr', ref: '3' }, ctx),
    ).rejects.toThrow('denied');
    await expect(
      fixture.gateway.call('post', { ref: '3', file: 'must-not-read' }, ctx),
    ).rejects.toThrow('denied');
    await expect(
      fixture.gateway.call('ghRead', { source: 'must-not-read.graphql' }, ctx),
    ).rejects.toThrow('denied');
    await expect(fixture.gateway.call('dropped', {}, ctx)).rejects.toThrow(
      'denied',
    );
    await expect(
      fixture.gateway.call('ownerApproved', { ref: '3' }, ctx),
    ).rejects.toThrow('denied');
  }
  fixture.done();
}, 15000);

test('CLI defaults to worker and parses its taskPr; worker reads and its own post are allowed', async () => {
  const fixture = fixtureServer([
    graph({
      repository: {
        pullRequest: item({ author: { ...actor(), databaseId: 999 } }),
      },
    }),
    graph({ repository: { issueOrPullRequest: item() } }),
    {
      path: '/repos/example/project/issues/3/comments',
      body: { body: '[worker] ACK\n' },
    },
  ]);
  expect(await gatewayVerb(fixture.gateway, 'read', ['pr', '3'])).toBe(
    'No accepted thread',
  );
  await expect(gatewayVerb(fixture.gateway, 'dropped', [])).rejects.toThrow(
    'denied',
  );
  await expect(
    gatewayVerb(fixture.gateway, 'gh-read', ['/repos/example/project']),
  ).rejects.toThrow('denied');
  await expect(
    gatewayVerb(fixture.gateway, 'post', ['3', 'must-not-read']),
  ).rejects.toThrow('own taskPr');
  const file = join(fixture.root, 'post.md');
  writeFileSync(file, '[worker] ACK\n');
  expect(
    await gatewayVerb(fixture.gateway, 'post', ['3', file], {
      VMETHOD_TASK_PR: '3',
    }),
  ).toContain('Posted');
  expect(
    await gatewayVerb(fixture.gateway, 'dropped', [], {
      VMETHOD_ROLE: 'orchestrator',
    }),
  ).toContain('Dropped: 1');
  for (const VMETHOD_ROLE of ['owner', '', 'Worker'])
    await expect(
      gatewayVerb(fixture.gateway, 'dropped', [], { VMETHOD_ROLE }),
    ).rejects.toThrow('Invalid VMETHOD_ROLE');
  for (const VMETHOD_TASK_PR of [
    '',
    '0',
    '-1',
    '3.5',
    '1e2',
    '9007199254740992',
  ])
    await expect(
      gatewayVerb(fixture.gateway, 'read', ['pr', '3'], { VMETHOD_TASK_PR }),
    ).rejects.toThrow('Invalid VMETHOD_TASK_PR');
  fixture.done();
}, 15000);
