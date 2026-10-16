import { object, type ObjectData, type PeopleFilter } from './people.js';

export interface ApprovalPR {
  headRefOid: string;
  reviews: ObjectData[];
  timeline: ObjectData[];
}

export function isOwnerApproved(
  pr: ApprovalPR,
  filter: PeopleFilter,
): boolean | 'unknown' {
  if (!/^[a-f\d]{40}$/i.test(pr.headRefOid)) return 'unknown';
  const owner = (actor: unknown) => filter.identity(actor)?.role === 'owner';
  if (
    pr.reviews.some(
      (review) =>
        review.state === 'APPROVED' &&
        object(review.commit).oid === pr.headRefOid &&
        owner(review.author) &&
        (review.lastEditedAt == null || owner(review.editor)),
    )
  )
    return true;
  let unknown = false;
  for (const event of pr.timeline) {
    if (
      event.__typename !== 'ProjectV2ItemStatusChangedEvent' ||
      event.field !== 'Status' ||
      event.status !== 'Approved'
    )
      continue;
    if (event.actor == null) unknown = true;
    else if (owner(event.actor)) return true;
  }
  return unknown ? 'unknown' : false;
}
