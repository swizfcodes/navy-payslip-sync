"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { matchClassKey, suggestMapping } = require("../exporter/cli/setup");

test("class descriptions map to website databases", () => {
  assert.equal(matchClassKey("OFFICERS"), "officers");
  assert.equal(matchClassKey("W/OFFICERS"), "wofficers");
  assert.equal(matchClassKey("Warrant Officers"), "wofficers");
  assert.equal(matchClassKey("RATINGS"), "ratings");
  assert.equal(matchClassKey("Ratings A"), "ratingsA");
  assert.equal(matchClassKey("RATINGS-B"), "ratingsB");
  assert.equal(matchClassKey("Junior Trainees"), "juniorTrainee");
  assert.equal(matchClassKey("HicadData"), null);
});

test("suggestions come from py_payrollclass, then database names, then the master", async () => {
  const found = [
    { name: "HicadData", hasPayrollClass: true },
    { name: "HicadRatings", hasPayrollClass: false },
    { name: "HicadRatingsA", hasPayrollClass: false },
    { name: "WO_DB", hasPayrollClass: false },
  ];
  const fakeSource = {
    payrollClasses: async () => [
      { classcode: "1", classname: "OFFICERS", db_name: "HicadData" },
      { classcode: "2", classname: "W/OFFICERS", db_name: "wo_db" },
    ],
  };
  const s = await suggestMapping(fakeSource, found);
  assert.equal(s.officers, "HicadData");
  assert.equal(s.wofficers, "WO_DB");
  assert.equal(s.ratings, "HicadRatings");
  assert.equal(s.ratingsA, "HicadRatingsA");
  assert.equal(s.ratingsB, undefined);
});
