// PostgREST filter-value escaping (M-6).
//
// postgrest-js forwards `ilike` patterns and `or()` filter strings verbatim:
// `%` and `_` act as LIKE wildcards, and inside `or()` the characters `,`
// (branch separator) and `(`/`)` (grouping) reshape the predicate. Plain
// `.eq()`/`.neq()`/`.in()`/`.gte()`/`.lt()` values are parameterized and must
// NOT go through these helpers.
//
// Dots (e.g. in email addresses) are preserved: they are safe inside values.

/** Escape LIKE metacharacters so a value matches literally inside ilike patterns. */
export const escapeLikePattern = (value: unknown): string => {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
};

/**
 * Escape a single value embedded in a PostgREST `.or()` segment.
 * LIKE-escapes the value and strips the structural `.or()` characters
 * (`,`, `(`, `)`) so the value can never open a new OR branch or group.
 * Exotic inputs fail closed (match nothing) instead of reshaping the query.
 */
export const escapeOrSegment = (value: unknown): string => {
  return escapeLikePattern(value).replace(/[,()]/g, '');
};
