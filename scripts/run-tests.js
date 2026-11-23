import fg from "fast-glob";
import { spawn } from "node:child_process";

const testFiles = await fg("dist/tests/**/*.test.js");

if (testFiles.length === 0) {
    console.error("No test files found matching dist/tests/**/*.test.js");
    process.exit(1);
}

// Pass resolved individual file paths directly to node --test
// This is 100% compatible across Node 18, 20, 22+, and all OSs
const child = spawn(
    process.execPath,
    ["--test", "--test-concurrency=1", ...testFiles],
    { stdio: "inherit" }
);

child.on("close", (code) => {
    process.exit(code ?? 0);
});
