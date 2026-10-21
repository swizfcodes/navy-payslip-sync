"use strict";

const { formatDuration } = require("../../shared/timings");

const dots = (label, width = 16) => `${label} ${".".repeat(Math.max(2, width - label.length))}`;
const num = (n) => Number(n || 0).toLocaleString("en-US");
const mb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const col = (s, w) => String(s).padEnd(w);
const rcol = (s, w) => String(s).padStart(w);

module.exports = { dots, num, mb, col, rcol, formatDuration };
