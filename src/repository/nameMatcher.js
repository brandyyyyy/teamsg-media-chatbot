'use strict';

/**
 * Splits a name into a normalized token set, tolerant of the
 * "SURNAME, GIVEN NAMES" all-caps passport format used by the live
 * roster (e.g. "SIM EN XI, SARAH") as well as multi-person cells for
 * team/pair events ("CHEO AI LIN,\nTAN QIAN NI JANICE").
 */
function tokenize(name) {
  return String(name || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/**
 * A query matches a stored name if every token in the query appears
 * somewhere in the stored name's token set, regardless of order,
 * punctuation, or which of "given name" / "surname" comes first. This
 * transparently covers every permutation of a name ("Sarah Sim", "Sim
 * Sarah", "Sarah") without enumerating them.
 *
 * A query with only one or two common tokens (e.g. a bare surname) can
 * legitimately match several different athletes - callers should treat
 * multiple results as "list them all", not silently pick one.
 */
function nameMatches(storedName, query) {
  if (!query) return true;
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return true;
  const nameTokens = new Set(tokenize(storedName));
  return queryTokens.every((t) => nameTokens.has(t));
}

/** Standard edit-distance DP; tokens here are short (names), so this is cheap. */
function levenshtein(a, b) {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, (_, i) => [i, ...Array(cols - 1).fill(0)]);
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[rows - 1][cols - 1];
}

/**
 * Two tokens are "close enough" to be a likely typo of one another.
 * Tokens under 4 characters require an exact match - fuzzing short tokens
 * (e.g. "wei") produces too many coincidental false positives to be useful.
 */
function tokensCloseEnough(a, b) {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  const maxDistance = a.length >= 7 || b.length >= 7 ? 2 : 1;
  return levenshtein(a, b) <= maxDistance;
}

/**
 * Typo-tolerant fallback for when nameMatches() finds nothing. Intended to
 * surface UNCONFIRMED candidates (e.g. a source-data typo like "Branon"
 * for "Brandon") for a human to eyeball, not to silently stand in for an
 * exact match - callers should present the stored name distinctly and
 * flag it as approximate.
 */
function nameFuzzyMatches(storedName, query) {
  if (!query) return false;
  const queryTokens = tokenize(query);
  if (!queryTokens.length) return false;
  const nameTokens = tokenize(storedName);
  return queryTokens.every((qt) => nameTokens.some((nt) => tokensCloseEnough(qt, nt)));
}

module.exports = { tokenize, nameMatches, nameFuzzyMatches };
