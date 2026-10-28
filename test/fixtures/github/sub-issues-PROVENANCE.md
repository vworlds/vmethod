# Sub-issue relation recordings

These GraphQL response envelopes were captured live against `vworlds/vmethod`
issues #342 and #355 on 2026-10-28 using the exact parent-query and relation-mutation
documents from this branch's `26aed20` build. The verified project orchestrator
supplied them in [PR 349's answer](https://github.com/vworlds/vmethod/pull/349#issuecomment-6477624220).

`sub-issues.json` preserves the supplied envelopes and wire types without redaction:

- `attached`: parent query for #355, parent #342.
- `unattached`: parent query for #342, with an explicit null parent.
- `removeSubIssue` and `addSubIssue`: successful relation mutations for #342/#355.
- `duplicate`: a second direct add, rejected by GitHub with partial null data and a
  validation error. Normal CLI re-attachment reads the existing parent and skips
  this mutation; the error recording exercises a concurrent attachment race.

`test/gateway/parent.test.ts` clones the envelopes and projects node IDs, issue
numbers and repository names onto isolated fixture identities. Synthetic invalid
responses intentionally remove or corrupt fields to check fail-closed decoding.
The duplicate-error envelope is used unchanged through the real gateway client.
