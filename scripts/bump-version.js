#!/usr/bin/env node

/**
 * Version Bumping Script
 *
 * This script handles version bumping for Foundation Fill extension.
 * It updates the version in package.json and not in manifest.json.
 *
 * Usage:
 *   node bump-version.js [major|minor|patch|<specific-version>]
 *
 * Examples:
 *   node bump-version.js patch     # Increments patch version (0.1.0 -> 0.1.1)
 *   node bump-version.js minor     # Increments minor version (0.1.0 -> 0.2.0)
 *   node bump-version.js major     # Increments major version (0.1.0 -> 1.0.0)
 *   node bump-version.js 1.2.3     # Sets version to specific value 1.2.3
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Get project root directory
const rootDir = path.resolve(__dirname, "..");

// Read package.json
const packageJsonPath = path.join(rootDir, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const currentVersion = packageJson.version;

// Parse current version
const [major, minor, patch] = currentVersion.split(".").map(Number);

// Get version type from command line arguments
const versionType = process.argv[2] || "patch";

let newVersion;

// Calculate new version based on version type
if (versionType === "patch") {
	newVersion = `${major}.${minor}.${patch + 1}`;
} else if (versionType === "minor") {
	newVersion = `${major}.${minor + 1}.0`;
} else if (versionType === "major") {
	newVersion = `${major + 1}.0.0`;
} else if (/^\d+\.\d+\.\d+$/.test(versionType)) {
	// If a specific version is provided
	newVersion = versionType;
} else {
	console.error("Invalid version type. Use major, minor, patch, or specific version (e.g., 1.2.3)");
	process.exit(1);
}

// Update package.json
packageJson.version = newVersion;
fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + "\n");

console.log(`Version bumped: ${currentVersion} -> ${newVersion}`);

// Return the new version for use in scripts
process.stdout.write(`${currentVersion} -> ${newVersion}`);
