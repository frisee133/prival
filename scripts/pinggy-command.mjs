import { spawn } from "node:child_process";
import { openSync, closeSync } from "node:fs";

const [executable, milliseconds, stdoutPath, stderrPath, ...args] = process.argv.slice(2);
const out = openSync(stdoutPath, "w");
const err = openSync(stderrPath, "w");
const child = spawn(executable, args, {
  windowsHide: true,
  stdio: ["ignore", out, err],
});
closeSync(out);
closeSync(err);
let finished = false;
function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  console.log(JSON.stringify(result));
}
const timer = setTimeout(() => {
  child.kill();
  finish({ timedOut: true });
}, Number(milliseconds));
child.on("error", (error) => finish({ error: error.message }));
// File handles can remain open in a daemon. Never wait for pipe EOF.
child.on("exit", (code, signal) => finish({ code, signal }));
