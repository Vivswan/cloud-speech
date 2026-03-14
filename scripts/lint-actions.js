#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const workflowsDir = path.join(rootDir, ".github", "workflows");
const workflowPattern = ".github/workflows/*.{yml,yaml}";

if (!existsSync(workflowsDir)) {
	console.log("No GitHub Actions workflows found.");
	process.exit(0);
}

const executable =
	process.platform === "win32"
		? path.join(rootDir, "node_modules", ".bin", "node-actionlint.cmd")
		: path.join(rootDir, "node_modules", ".bin", "node-actionlint");

const result = spawnSync(executable, [workflowPattern], {
	stdio: "inherit",
	shell: process.platform === "win32",
});

if (result.error) {
	console.error(`Failed to run actionlint: ${result.error.message}`);
	process.exit(1);
}

process.exit(result.status ?? 1);
