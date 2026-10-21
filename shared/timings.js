"use strict";

/** Tiny stopwatch: timings.start('extract'); ... timings.stop('extract'); timings.toJSON() -> { extract: ms } */
class Timings {
  constructor() {
    this.totals = {};
    this.open = {};
  }

  start(name) {
    this.open[name] = process.hrtime.bigint();
  }

  stop(name) {
    const t0 = this.open[name];
    if (t0 === undefined) return 0;
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    delete this.open[name];
    this.totals[name] = Math.round((this.totals[name] || 0) + ms);
    return ms;
  }

  async time(name, fn) {
    this.start(name);
    try {
      return await fn();
    } finally {
      this.stop(name);
    }
  }

  toJSON() {
    return { ...this.totals };
  }
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}

module.exports = { Timings, formatDuration };
