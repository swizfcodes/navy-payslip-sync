"use strict";

/**
 * Worker process: exports ONE database and streams its encoded batches to the main process,
 * which writes the single package file. Running each database in its own process lets the
 * export use several CPU cores (one Node process only ever uses one).
 *
 * Started by export-job.js as a copy of this same program with NAVY_SYNC_WORKER=1.
 * Messages (IPC, "advanced" serialization so Buffers pass through):
 *   main -> worker  { type: "start", sourceConfig, password, db, kind, period, payhistoryMonths, batchRows, packQuality }
 *                   { type: "ack", id, error? }          (batch written)
 *                   { type: "cancel" }
 *   worker -> main  { type: "batch", id, name, buffer }
 *                   { type: "event", event }
 *                   { type: "done", result } | { type: "error", message }
 * The worker keeps at most MAX_IN_FLIGHT batches unacknowledged (back-pressure).
 */

const MAX_IN_FLIGHT = 3;

function runWorker() {
  let cancelled = false;
  let started = false;
  let nextId = 0;
  const pending = new Map();

  const send = (msg) =>
    new Promise((resolve, reject) => {
      if (!process.connected) return reject(new Error("Main process went away"));
      process.send(msg, (err) => (err ? reject(err) : resolve()));
    });

  process.on("disconnect", () => {
    cancelled = true;
    for (const p of pending.values()) p.reject(new Error("Main process went away"));
    pending.clear();
  });

  process.on("message", async (msg) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "ack") {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve();
      }
      return;
    }
    if (msg.type === "cancel") {
      cancelled = true;
      return;
    }
    if (msg.type !== "start" || started) return;
    started = true;

    // Loaded here so the main process never loads the driver twice for nothing.
    const { MssqlSource } = require("./sources/mssql-source");
    const { extractDatabase } = require("./extract/extractor");

    const inFlight = [];
    const addBatch = async (name, buffer) => {
      nextId += 1;
      const id = nextId;
      const acked = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      acked.catch(() => {}); // awaited below; avoid unhandled-rejection noise
      inFlight.push(acked);
      await send({ type: "batch", id, name, buffer });
      while (inFlight.length >= MAX_IN_FLIGHT) await inFlight.shift();
    };

    let source;
    try {
      source = new MssqlSource(msg.sourceConfig, msg.password, { maxConnections: 2 });
      await source.connect();
      const result = await extractDatabase({
        source,
        db: msg.db,
        kind: msg.kind,
        period: msg.period,
        payhistoryMonths: msg.payhistoryMonths,
        batchRows: msg.batchRows,
        packQuality: msg.packQuality,
        addBatch,
        onEvent: (event) => {
          send({ type: "event", event }).catch(() => {});
        },
        isCancelled: () => cancelled,
      });
      while (inFlight.length) await inFlight.shift();
      await send({ type: "done", result });
    } catch (err) {
      await send({ type: "error", message: err.message }).catch(() => {});
      process.exitCode = 1;
    } finally {
      if (source) await source.close().catch(() => {});
      if (process.connected) process.disconnect();
    }
  });
}

module.exports = { runWorker };
