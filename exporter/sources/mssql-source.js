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

/**
 * Server names as people type them in SSMS: "." and "(local)" mean this computer,
 * "NAME,1433" carries a port. The driver understands neither, so turn them into
 * "localhost" and a separate port.
 */
function normaliseServer(server) {
  let s = String(server || "").trim();
  let port = null;
  const comma = s.match(/^(.*),\s*(\d{1,5})$/);
  if (comma) {
    s = comma[1].trim();
    port = Number(comma[2]);
  }
  s = s.replace(/^(\.|\(local\)|localhost)(?=\\|$)/i, "localhost");
  return { host: s, port };
}

// A read that waits on a lock held by another program (for example a payroll
// calculation still running) gives up after this long with a clear message,
// instead of waiting for ever. SQL Server error 1222.
const LOCK_TIMEOUT_MS = 120000;
const LOCK_PREFIX = `SET LOCK_TIMEOUT ${LOCK_TIMEOUT_MS};\n`;

function friendlyError(err, what) {
  if (err && (err.number === 1222 || /Lock request time out/i.test(err.message || ""))) {
    return new Error(
      `${what} is locked by another program (for example a payroll calculation that is still running). ` +
        "Wait for it to finish, then export again.",
    );
  }
  return err;
}

class MssqlSource {
  /**
   * sourceConfig: { server, port, user, encrypt, trustServerCertificate }
   * options: { maxConnections, database (default master), readOnly (default true) }
   */
  constructor(sourceConfig, password, { maxConnections = 8, database = "master", readOnly = true } = {}) {
    this.cfg = sourceConfig;
    this.password = password;
    this.maxConnections = maxConnections;
    this.database = database;
    this.readOnly = readOnly;
    this.pool = null;
  }

  async connect() {
    const { host, port: givenPort } = normaliseServer(this.cfg.server);
    const named = host.includes("\\");
    const port = givenPort || this.cfg.port;
    this.pool = new sql.ConnectionPool({
      server: host,
      port: named || !port ? undefined : Number(port),
      user: this.cfg.user,
      password: this.password,
      database: this.database,
      connectionTimeout: 30000,
      requestTimeout: 0, // streams of large tables must not time out
      pool: { max: this.maxConnections, min: 0, idleTimeoutMillis: 60000 },
      options: {
        encrypt: Boolean(this.cfg.encrypt),
        trustServerCertificate: this.cfg.trustServerCertificate !== false,
        enableArithAbort: true,
        readOnlyIntent: this.readOnly,
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
    try {
      const res = await req.query(LOCK_PREFIX + text);
      return res.recordset;
    } catch (err) {
      throw friendlyError(err, "A payroll table");
    }
  }

  /**
   * Payroll databases on this server: user databases that have both py_stdrate and py_elementtype.
   * (hr_employees may exist only in the master.)
   * [{ name, staff, staffLabel, period, hasPayrollClass }]
   */
  async listPayrollDatabases() {
    const dbs = await this.query(
      `SELECT name FROM sys.databases
        WHERE database_id > 4 AND state = 0 AND HAS_DBACCESS(name) = 1
        ORDER BY name`,
    );
    const out = [];
    for (const { name } of dbs) {
      if (!IDENT.test(name)) continue;
      const [probe] = await this.query(
        `SELECT OBJECT_ID(N'${name}.dbo.py_stdrate') AS stdrate,
                OBJECT_ID(N'${name}.dbo.py_elementtype') AS elm,
                OBJECT_ID(N'${name}.dbo.hr_employees') AS emp,
                OBJECT_ID(N'${name}.dbo.py_payrollclass') AS pclass`,
      );
      if (!probe.stdrate || !probe.elm) continue;
      let staff = null;
      let staffLabel = "staff";
      let period = null;
      try {
        period = await this.currentPeriod(name);
        if (probe.emp) {
          staff = await this.countRows(name, "hr_employees");
        } else if (period) {
          staff = (await this.totals(name, period.month)).staffCount;
          staffLabel = "paid";
        }
      } catch (_) {
        /* listed anyway; the Connect step reports details */
      }
      out.push({ name, staff, staffLabel, period, hasPayrollClass: Boolean(probe.pclass), hasEmployees: Boolean(probe.emp) });
    }
    return out;
  }

  /** Rows of py_payrollclass in one database, all columns as text ([] if unreadable). */
  async payrollClasses(database) {
    try {
      const cols = await this.columns(database, "py_payrollclass");
      if (!cols.length) return [];
      const list = cols.map((c) => `CONVERT(nvarchar(200), ${q(c.name)}) AS ${q(c.name)}`).join(", ");
      return await this.query(`SELECT ${list} FROM ${q(database)}.dbo.py_payrollclass`);
    } catch (_) {
      return [];
    }
  }

  /**
   * Admin connection only: create (or keep) a SQL login and give it read-only access
   * (db_datareader) on each database. Returns a list of what was done.
   */
  async createReadOnlyLogin(login, password, databases, { resetPassword = false } = {}) {
    if (!IDENT.test(login)) throw new Error(`Login name "${login}" has invalid characters`);
    const done = [];
    const [exists] = await this.query(`SELECT COUNT(*) AS n FROM sys.server_principals WHERE name = @l`, { l: login });
    if (!exists.n) {
      await this.query(
        `DECLARE @s nvarchar(max) = N'CREATE LOGIN ' + QUOTENAME(@l) + N' WITH PASSWORD = ' + QUOTENAME(@p, '''') + N', CHECK_POLICY = ON';
         EXEC sp_executesql @s;`,
        { l: login, p: password },
      );
      done.push(`created login ${login}`);
    } else if (resetPassword) {
      await this.query(
        `DECLARE @s nvarchar(max) = N'ALTER LOGIN ' + QUOTENAME(@l) + N' WITH PASSWORD = ' + QUOTENAME(@p, '''');
         EXEC sp_executesql @s;`,
        { l: login, p: password },
      );
      done.push(`reset password of login ${login}`);
    } else {
      done.push(`login ${login} already exists (password unchanged)`);
    }
    for (const db of databases) {
      await this.query(
        `DECLARE @s nvarchar(max) = N'USE ' + QUOTENAME(@d) + N';
           IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = ' + QUOTENAME(@l, '''') + N')
             EXEC(N''CREATE USER ' + REPLACE(QUOTENAME(@l), '''', '''''') + N' FOR LOGIN ' + REPLACE(QUOTENAME(@l), '''', '''''') + N''');
           EXEC sp_addrolemember N''db_datareader'', ' + QUOTENAME(@l, '''') + N';';
         EXEC sp_executesql @s;`,
        { d: db, l: login },
      );
      done.push(`${db}: read-only access for ${login}`);
    }
    return done;
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

  /** True if some index on the table has `column` as its first key column (so ORDER BY needs no sort). */
  async hasLeadingIndex(database, table, column) {
    const rows = await this.query(
      `SELECT TOP 1 1 AS ok
         FROM ${q(database)}.sys.indexes i
         JOIN ${q(database)}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN ${q(database)}.sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
        WHERE i.object_id = OBJECT_ID(@obj) AND ic.key_ordinal = 1 AND c.name = @c`,
      { obj: `${database}.dbo.${table}`, c: column },
    );
    return rows.length > 0;
  }

  async countRows(database, table) {
    const rows = await this.query(`SELECT COUNT_BIG(*) AS n FROM ${q(database)}.dbo.${q(table)}`);
    return Number(rows[0].n);
  }

  /**
   * IPPIS rows and staff for a period in py_ipis_payhistory, or null when the database
   * has no such table. Uses the period key column (indexed on the website side too).
   */
  async ippisForPeriod(database, period) {
    const cols = await this.columns(database, "py_ipis_payhistory");
    if (!cols.length) return null;
    const periodCol = (cols.find((c) => c.name.toLowerCase() === "period") || {}).name;
    const numbCol = (cols.find((c) => c.name.toLowerCase() === "numb") || {}).name;
    if (!periodCol) return null;
    const rows = await this.query(
      `SELECT COUNT_BIG(*) AS n${numbCol ? `, COUNT(DISTINCT ${q(numbCol)}) AS staff` : ""}
         FROM ${q(database)}.dbo.py_ipis_payhistory WHERE ${q(periodCol)} = @p`,
      { p: String(period) },
    );
    return { rows: Number(rows[0].n || 0), staff: numbCol ? Number(rows[0].staff || 0) : null };
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
      LOCK_PREFIX +
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
    req.on("error", (err) => readable.destroy(friendlyError(err, `${database}.${table}`)));
    req.on("done", () => readable.push(null));
    readable.on("close", () => {
      if (!readable.readableEnded) req.cancel();
    });
    // In stream mode errors also arrive as 'error' events; the promise is only caught to avoid an unhandled rejection.
    req.query(text).catch((err) => readable.destroy(err));
    return readable;
  }
}

module.exports = { MssqlSource, selectExpr, normaliseServer };
