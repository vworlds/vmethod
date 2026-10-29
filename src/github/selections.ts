/** Shared wire selections. Whitespace is part of the existing request contract. */
export const actorFields = "__typename login ... on User { databaseId } ... on Bot { databaseId }";
export const identityFields = `id author { ${actorFields} } editor { ${actorFields} } lastEditedAt repository { nameWithOwner owner { login } }`;

export const fieldSelection =
  "... on ProjectV2Field { id name dataType createdAt } ... on ProjectV2IterationField { id name dataType createdAt } ... on ProjectV2SingleSelectField { id name dataType createdAt options { id name color description } }";
export const pageInfo = "pageInfo { hasNextPage endCursor }";
export const contentSelection =
  "content { __typename ... on Issue { id number closedAt repository { nameWithOwner } assignees(first: 100) { nodes { login } } } ... on PullRequest { id number closedAt repository { nameWithOwner } assignees(first: 100) { nodes { login } } } }";
export const valueSelection =
  "... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } } ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } } ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }";
export const initialValues = `fieldValues(first: 100) { nodes { ${valueSelection} } ${pageInfo} }`;
export const reviewCommentFields = `id databaseId url author { ${actorFields} } editor { ${actorFields} } lastEditedAt body createdAt`;
export const labelEvents = `__typename ... on LabeledEvent { id createdAt actor { ${actorFields} } label { name } } ... on UnlabeledEvent { id createdAt actor { ${actorFields} } label { name } }`;
