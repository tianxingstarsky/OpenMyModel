const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { resolve, dirname } = require("node:path");

const source = resolve(__dirname, "cloud_bridge.js");
const destination = resolve(__dirname, "../release/scripts/cloud_bridge.js");
const expected = readFileSync(source);
if (process.argv.includes("--check")) {
  if (!expected.equals(readFileSync(destination))) {
    console.error("Release bridge differs from source. Run npm --prefix scripts run sync:release.");
    process.exitCode = 1;
  } else {
    console.log("Release bridge matches source.");
  }
} else {
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, expected);
  console.log("Synchronized release/scripts/cloud_bridge.js from scripts/cloud_bridge.js.");
}
