"use strict";

/**
 * Logical column types carried in every batch (`types` array), so the website
 * knows how to bind each value without guessing.
 *
 * Values on the wire (JSON):
 *   string   -> string (char/nchar already right-trimmed by the source)
 *   int      -> number
 *   bigint   -> string (exact)
 *   decimal  -> string (exact, e.g. "250000.0000"); money is decimal
 *   float    -> number
 *   bit      -> 0 | 1
 *   date     -> "YYYY-MM-DD"
 *   datetime -> "YYYY-MM-DD HH:MM:SS"
 *   time     -> "HH:MM:SS"
 *   binary   -> base64 string
 *   null     -> null for any type
 */

const LOGICAL_TYPES = ["string", "int", "bigint", "decimal", "float", "bit", "date", "datetime", "time", "binary"];

const MSSQL_TO_LOGICAL = {
  char: "string", nchar: "string", varchar: "string", nvarchar: "string",
  text: "string", ntext: "string", uniqueidentifier: "string", xml: "string", sysname: "string",
  tinyint: "int", smallint: "int", int: "int",
  bigint: "bigint",
  decimal: "decimal", numeric: "decimal", money: "decimal", smallmoney: "decimal",
  float: "float", real: "float",
  bit: "bit",
  date: "date",
  datetime: "datetime", datetime2: "datetime", smalldatetime: "datetime", datetimeoffset: "datetime",
  time: "time",
  binary: "binary", varbinary: "binary", image: "binary", timestamp: "binary", rowversion: "binary",
};

const MYSQL_TO_LOGICAL = {
  char: "string", varchar: "string", text: "string", tinytext: "string", mediumtext: "string",
  longtext: "string", enum: "string", set: "string", json: "string",
  tinyint: "int", smallint: "int", mediumint: "int", int: "int", integer: "int", year: "int",
  bigint: "bigint",
  decimal: "decimal", numeric: "decimal",
  float: "float", double: "float",
  bit: "bit",
  date: "date",
  datetime: "datetime", timestamp: "datetime",
  time: "time",
  binary: "binary", varbinary: "binary", blob: "binary", tinyblob: "binary",
  mediumblob: "binary", longblob: "binary",
};

function logicalFromMssql(dataType) {
  return MSSQL_TO_LOGICAL[String(dataType).toLowerCase()] || "string";
}

function logicalFromMysql(dataType) {
  return MYSQL_TO_LOGICAL[String(dataType).toLowerCase()] || "string";
}

/** Normalise a value read from a driver into its wire form for the given logical type. */
function toWire(value, logical) {
  if (value === null || value === undefined) return null;
  switch (logical) {
    case "string":
      return typeof value === "string" ? value : String(value);
    case "int":
      return typeof value === "number" ? value : Number(value);
    case "bigint":
    case "decimal":
      return typeof value === "string" ? value.trim() : String(value);
    case "float":
      return typeof value === "number" ? value : Number(value);
    case "bit":
      return value === true || value === 1 || value === "1" ? 1 : 0;
    case "binary":
      return Buffer.isBuffer(value) ? value.toString("base64") : String(value);
    case "date":
    case "datetime":
    case "time":
      if (value instanceof Date) return dateToWire(value, logical);
      return String(value);
    default:
      return value;
  }
}

function pad(n, w = 2) {
  return String(n).padStart(w, "0");
}

// Only reached if a driver hands back a Date object; the MSSQL source converts in SQL instead.
function dateToWire(d, logical) {
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  if (logical === "date") return date;
  if (logical === "time") return time;
  return `${date} ${time}`;
}

module.exports = { LOGICAL_TYPES, logicalFromMssql, logicalFromMysql, toWire };
