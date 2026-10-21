"use strict";

/**
 * Phase 1 source: legacy SQL Server, read-only login, streaming reads.
 *
 * Values are converted to their exact wire form in SQL (CONVERT), so nothing is lost to
 * JavaScript numbers or time zones:
 *   money/smallmoney -> varchar, style 2 (4 decimals)    decimal/numeric -> varchar (full scale)
 *   bigint           -> varchar                          datetime*       -> 'YYYY-MM-DD HH:MM:SS'
 *   date -> 'YYYY-MM-DD'   time -> 'HH:MM:SS'   char/nchar -> RTRIM   bit -> tinyint
 * rowversion/timestamp columns are never exported.
 */

const sql = require("mssql");
const { Readable } = require("stream");
const { logicalFromMssql } = require("../../shared/type-map");

const IDENT = /^[A-Za-z0-9_]{1,128}$/;

function q(name) {
  if (!IDENT.test(name)) throw new Error(`Unsafe SQL identifier: ${name}`);
  return `[${name}]`;
}

function selectExpr(col) {
  const c = q(col.name);
  switch (col.dataType) {
    case "money":
    case "smallmoney":
      return `CONVERT(varchar(64), ${c}, 2) AS ${c}`;
    case "decimal":
    case "numeric":
    case "bigint":
      return `CONVERT(varchar(64), ${c}) AS ${c}`;
    case "datetime":
    case "datetime2":
    case "smalldatetime":
    case "datetimeoffset":
      return `CONVERT(varchar(19), ${c}, 120) AS ${c}`;
    case "date":
      return `CONVERT(varchar(10), ${c}, 23) AS ${c}`;
    case "time":
      return `CONVERT(varchar(8), ${c}, 108) AS ${c}`;
    case "char":
    case "nchar":
      return `RTRIM(${c}) AS ${c}`;
    case "uniqueidentifier":
      return `CONVERT(varchar(36), ${c}) AS ${c}`;
    case "bit":
      return `CAST(${c} AS tinyint) AS ${c}`;
    case "text":
    case "ntext":
    case "xml":
      return `CAST(${c} AS nvarchar(max)) AS ${c}`;
    default:
      return c;
  }
}

const SKIP_TYPES = new Set(["timestamp", "rowversion"]);

class MssqlSource {
  constructor(sourceConfig, password, { maxConnections = 8 } = {}) {
    this.cfg = sourceConfig;
    this.password = password;
    this.maxConnections = maxConnections;
    this.pool = null;
  }

  async connect() {
    const named = this.cfg.server.includes("\\");
    this.pool = new sql.ConnectionPool({
      server: this.cfg.server,
      port: named || !this.cfg.port ? undefined : Number(this.cfg.port),
      user: this.cfg.user,
      password: this.password,
      database: "master",
      connectionTimeout: 30000,
      requestTimeout: 0, // streams of large tables must not time out
      pool: { max: this.maxConnections, min: 0, idleTimeoutMillis: 60000 },
      options: {
        encrypt: Boolean(this.cfg.encrypt),
        trustServerCertificate: this.cfg.trustServerCertificate !== false,
        enableArithAbort: true,
        readOnlyIntent: true,
        appName: "navy-payslip-exporter",
      },
    });
    await this.pool.connect();
    this.password = null;
    return this;
  }

  async close() {
    if (this.pool) await this.pool.close();
    this.pool = null;
  }

  request() {
    if (!this.pool) throw new Error("Not connected");
    return this.pool.request();
  }

  async query(text, params = {}) {
    const req = this.request();
    for (const [name, value] of Object.entries(params)) req.input(name, sql.NVarChar, value == null ? null : String(value));
    const res = await req.query(text);
    return res.recordset;
  }

  /** [{ name, dataType, logical }] in table order; [] if the table does not exist. */
  async columns(database, table) {
    const rows = await this.query(
      `SELECT COLUMN_NAME AS name, DATA_TYPE AS dataType
         FROM ${q(database)}.INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @t
        ORDER BY ORDINAL_POSITION`,
      { t: table },
    );
    return rows
      .map((r) => ({ name: r.name, dataType: String(r.dataType).toLowerCase() }))
      .filter((c) => !SKIP_TYPES.has(c.dataType))
      .map((c) => ({ ...c, logical: logicalFromMssql(c.dataType) }));
  }

  /** Current processing period from py_stdrate BT05: { year, month, period: "YYYYMM" } or null. */
  async currentPeriod(database) {
    const rows = await this.query(
      `SELECT TOP 1 CONVERT(varchar(10), ord) AS ord, CONVERT(varchar(10), mth) AS mth
         FROM ${q(database)}.dbo.py_stdrate WHERE type = 'BT05'`,
    );
    if (!rows.length) return null;
    const year = parseInt(String(rows[0].ord).trim(), 10);
    const month = parseInt(String(rows[0].mth).trim(), 10);
    if (!year || !month || month < 1 || month > 12) return null;
    return { year, month, period: `${year}${String(month).padStart(2, "0")}` };
  }

  async countRows(database, table) {
    const rows = await this.query(`SELECT COUNT_BIG(*) AS n FROM ${q(database)}.dbo.${q(table)}`);
    return Number(rows[0].n);
  }

  /** Staff count and total net for the month, from py_mastercum (his_type = month number). */
  async totals(database, month) {
    const rows = await this.query(
      `SELECT COUNT(DISTINCT his_Empno) AS staff,
              CONVERT(varchar(64), SUM(CAST(his_netmth AS decimal(19,4)))) AS net
         FROM ${q(database)}.dbo.py_mastercum
        WHERE TRY_CAST(his_type AS int) = @m AND his_netmth IS NOT NULL`,
      { m: month },
    );
    return { staffCount: Number(rows[0].staff || 0), totalNet: rows[0].net || "0.0000" };
  }

  /**
   * Stream rows of one table as objects.
   *   columns: [{ name, dataType }]   orderBy: [names]   where: { column: value } (equality, AND-ed)
   */
  streamRows(database, table, { columns, orderBy = [], where = {} }) {
    const req = this.request();
    req.stream = true;
    const selectList = columns.map(selectExpr).join(", ");
    const conds = Object.keys(where).map((col, i) => {
      req.input(`w${i}`, sql.NVarChar, String(where[col]));
      return `${q(col)} = @w${i}`;
    });
    const text =
      `SELECT ${selectList} FROM ${q(database)}.dbo.${q(table)}` +
      (conds.length ? ` WHERE ${conds.join(" AND ")}` : "") +
      (orderBy.length ? ` ORDER BY ${orderBy.map(q).join(", ")}` : "");

    // Backpressure: pause the request while the consumer is busy.
    const readable = new Readable({
      objectMode: true,
      highWaterMark: 2000,
      read() {
        req.resume();
      },
    });
    req.on("row", (row) => {
      if (!readable.push(row)) req.pause();
    });
    req.on("error", (err) => readable.destroy(err));
    req.on("done", () => readable.push(null));
    readable.on("close", () => {
      if (!readable.readableEnded) req.cancel();
    });
    // In stream mode errors also arrive as 'error' events; the promise is only caught to avoid an unhandled rejection.
    req.query(text).catch((err) => readable.destroy(err));
    return readable;
  }
}

module.exports = { MssqlSource, selectExpr };
