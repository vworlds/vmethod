import { expect, test } from 'vitest';
import { isOwnerApproved } from '../../src/gateway/approval.js';
import { PeopleFilter } from '../../src/gateway/people.js';
import { Digest } from '../../src/gateway/digest.js';
import { fixture } from '../helpers.js';
import { actor, people, sha } from './helpers.js';

test('only owner reviews on the head or owner status-change actors approve; card status and peers cannot', () => {
  const filter = new PeopleFilter(
    people,
    'example',
    new Digest({ XDG_STATE_HOME: fixture() }, 'state', () => 0),
  );
  const pr = { headRefOid: sha, reviews: [], timeline: [] };
  const review = { author: actor(), state: 'APPROVED', commit: { oid: sha } };
  const event = {
    __typename: 'ProjectV2ItemStatusChangedEvent',
    field: 'Status',
    status: 'Approved',
    actor: actor(),
  };
  expect(isOwnerApproved({ ...pr, reviews: [review] }, filter)).toBe(true);
  expect(
    isOwnerApproved(
      { ...pr, reviews: [{ ...review, commit: { oid: 'old-head' } }] },
      filter,
    ),
  ).toBe(false);
  expect(
    isOwnerApproved(
      { ...pr, reviews: [{ ...review, author: actor(2) }] },
      filter,
    ),
  ).toBe(false);
  expect(isOwnerApproved({ ...pr, timeline: [event] }, filter)).toBe(true);
  expect(
    isOwnerApproved(
      { ...pr, timeline: [{ ...event, actor: actor(2) }] },
      filter,
    ),
  ).toBe(false);
  expect(
    isOwnerApproved({ ...pr, timeline: [{ ...event, actor: null }] }, filter),
  ).toBe('unknown');
  expect(
    isOwnerApproved({ ...pr, timeline: [{ status: 'Approved' }] }, filter),
  ).toBe(false);
  expect(
    isOwnerApproved(
      { ...pr, reviews: [review], timeline: [{ ...event, actor: null }] },
      filter,
    ),
  ).toBe(true);
  expect(
    isOwnerApproved(
      {
        ...pr,
        reviews: [{ ...review, lastEditedAt: 'now', editor: actor(2) }],
      },
      filter,
    ),
  ).toBe(false);
  expect(
    isOwnerApproved(
      {
        ...pr,
        timeline: [{ ...event, actor: { ...actor(), databaseId: 999 } }],
      },
      filter,
    ),
  ).toBe(false);
}, 15000);
