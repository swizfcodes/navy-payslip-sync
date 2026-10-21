"use strict";

/**
 * Deterministic JSON: object keys sorted at every level, no whitespace.
 * Used for anything that is signed or hashed, so both sides produce identical bytes.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

module.exports = { canonicalJson };
