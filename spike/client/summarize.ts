// Turns the localnet results into a table: one row per step.
// Usage: node summarize.ts <results json> <program id>
import { readFileSync } from "node:fs";

const [file, program] = process.argv.slice(2);
if (!file || !program) throw new Error("usage: node summarize.ts <results json> <program id>");
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const { steps } = JSON.parse(readFileSync(file, "utf8"));

// Compute units Token-2022 itself reports for the instructions it ran as a
// CPI of the throwaway program (depth 2), and the program's own total.
function inner(logs: string[]) {
  const stack: string[] = [];
  const token: number[] = [];
  let programTotal: number | null = null;
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]/.exec(line);
    if (invoke) {
      stack.length = Number(invoke[2]) - 1;
      stack.push(invoke[1] as string);
      continue;
    }
    const consumed = /^Program (\S+) consumed (\d+) of \d+ compute units/.exec(line);
    if (consumed) {
      const depth = stack.lastIndexOf(consumed[1] as string) + 1;
      if (consumed[1] === program && depth === 1) programTotal = (programTotal ?? 0) + Number(consumed[2]);
      else if (consumed[1] === TOKEN_2022 && depth === 2 && stack[0] === program) token.push(Number(consumed[2]));
      continue;
    }
    const done = /^Program (\S+) (success|failed)/.exec(line);
    if (done) stack.length = Math.max(0, stack.lastIndexOf(done[1] as string));
  }
  return { token, programTotal };
}

const size = (s: { size?: number; limit?: number; fits?: boolean }) =>
  s.size === undefined ? "n/a" : `${s.size}${s.fits ? "" : " (over)"}`;
console.log("| Step | Result | Sent as | Compute units | Program instruction | Token-2022 inside it | Bytes as v0 (limit 1232) | Bytes as v1 (limit 4096) |");
console.log("|---|---|---|---|---|---|---|---|");
for (const step of steps) {
  const { token, programTotal } = inner(step.logs);
  const outcome = step.ok ? "pass" : "fail";
  const expected = step.expected === "fail" ? `${outcome}, as expected` : outcome;
  const sent = step.signature ? `v${step.version}` : `v${step.version}, simulated`;
  console.log(
    `| ${step.name} | ${expected} | ${sent} | ${step.unitsConsumed ?? ""} | ${programTotal ?? ""} | ${token.join(" + ")} | ${size(step.sizeV0)} | ${size(step.sizeV1)} |`,
  );
}
