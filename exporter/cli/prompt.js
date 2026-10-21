"use strict";

/** Minimal console prompts (Node readline only, so the .exe needs no extra packages). */

const readline = require("readline");

function createPrompt() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  const origWrite = rl._writeToOutput ? rl._writeToOutput.bind(rl) : null;
  if (origWrite) {
    rl._writeToOutput = (s) => {
      if (!muted) return origWrite(s);
      // while typing a password: one * per typed character, nothing else
      if (s.length === 1 && s !== "\r" && s !== "\n") return origWrite("*");
      return undefined;
    };
  }

  const ask = (question, defaultValue = "") =>
    new Promise((resolve) => {
      const suffix = defaultValue !== "" && defaultValue != null ? ` [${defaultValue}]` : "";
      rl.question(`${question}${suffix}: `, (answer) => {
        const a = answer.trim();
        resolve(a === "" ? String(defaultValue ?? "") : a);
      });
    });

  const askHidden = (question) =>
    new Promise((resolve) => {
      rl.question(`${question}: `, (answer) => {
        muted = false;
        process.stdout.write("\n");
        resolve(answer);
      });
      muted = true;
    });

  const confirm = async (question, defaultYes = true) => {
    const a = (await ask(`${question} (${defaultYes ? "Y/n" : "y/N"})`)).toLowerCase();
    if (a === "") return defaultYes;
    return a === "y" || a === "yes";
  };

  const choose = async (question, options, defaultIndex = 0) => {
    const list = options.map((o, i) => `[${i + 1}] ${o}`).join("  ");
    for (;;) {
      const a = await ask(`${question} ${list}`, String(defaultIndex + 1));
      const n = Number(a);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      console.log(`  Enter a number from 1 to ${options.length}.`);
    }
  };

  return { ask, askHidden, confirm, choose, close: () => rl.close() };
}

module.exports = { createPrompt };
