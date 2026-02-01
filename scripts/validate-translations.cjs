#!/usr/bin/env node

/**
 * Translation Validator Script
 *
 * This script validates that all language YAML files in src/localization/
 * have the same structure and keys. It helps ensure translation completeness
 * and consistency across all supported languages.
 *
 * Usage: node scripts/validate-translations.js
 */

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const LOCALIZATION_DIR = require("../src/localization/self_path.cjs");
const SRC_DIR = require("../src/self_path.cjs");

/**
 * Recursively extracts all keys from a nested object
 */
function extractKeys(obj, prefix = "") {
	const keys = [];

	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;

		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			keys.push(...extractKeys(value, fullKey));
		} else {
			keys.push(fullKey);
		}
	}

	return keys.sort();
}

/**
 * Loads and parses a YAML file
 */
function loadYamlFile(filename) {
	const filePath = path.join(LOCALIZATION_DIR, filename);

	if (!fs.existsSync(filePath)) {
		throw new Error(`File not found: ${filePath}`);
	}

	try {
		const content = fs.readFileSync(filePath, "utf8");
		return yaml.load(content, { schema: yaml.DEFAULT_SCHEMA });
	} catch (error) {
		throw new Error(`Failed to parse ${filename}: ${error.message}`);
	}
}

/**
 * Gets all .yaml files in the localization directory
 */
function getYamlFiles() {
	try {
		const files = fs.readdirSync(LOCALIZATION_DIR);
		return files.filter((file) => file.endsWith(".yaml")).sort();
	} catch (error) {
		throw new Error(`Failed to read localization directory: ${error.message}`);
	}
}

/**
 * Recursively gets all source files (.tsx, .js, .jsx, .js) from src directory
 * Also checks root manifest.js file
 */
function getSourceFiles(dir = SRC_DIR) {
	const sourceFiles = new Set();

	try {
		const items = fs.readdirSync(dir);

		for (const item of items) {
			const fullPath = path.join(dir, item);
			const stat = fs.statSync(fullPath);

			if (stat.isDirectory()) {
				// Skip localization directory to avoid self-referencing
				if (item !== "localization") {
					const nestedFiles = getSourceFiles(fullPath);
					nestedFiles.forEach((file) => sourceFiles.add(file));
				}
			} else if (stat.isFile() && /\.(tsx?|jsx?)$/.test(item)) {
				sourceFiles.add(fullPath);
			}
		}

		// Also check manifest.js in the project root
		const rootDir = path.join(__dirname, "..");
		const manifestPath = path.join(rootDir, "manifest.js");
		if (fs.existsSync(manifestPath)) {
			sourceFiles.add(manifestPath);
		}
	} catch (error) {
		console.warn(`Warning: Could not read directory ${dir}: ${error.message}`);
	}

	return Array.from(sourceFiles);
}

/**
 * Extracts translation keys from t() function calls in source code
 */
function extractTranslationKeysFromSource() {
	const sourceFiles = getSourceFiles();
	const usedKeys = new Set();
	const fileUsages = {};

	console.log(`Scanning ${sourceFiles.length} source files for t() function calls...\n`);

	for (const filePath of sourceFiles) {
		try {
			const content = fs.readFileSync(filePath, "utf8");
			const relativePath = path.relative(path.join(__dirname, ".."), filePath);

			// Only match t() and translate() function calls with proper translation key patterns
			const translationPatterns = [
				/\bt\s*\(\s*['"`]([a-zA-Z][a-zA-Z0-9_.]*?)['"`]/g, // t('key') or t('key.subkey')
				/\btranslate\s*\(\s*['"`]([a-zA-Z][a-zA-Z0-9_.]*?)['"`]/g, // translate('key')
			];

			const fileKeys = [];

			for (const regex of translationPatterns) {
				let match;
				while ((match = regex.exec(content)) !== null) {
					const key = match[1];
					// Only include keys that look like valid translation keys (contain at least one dot)
					if (key.includes(".") && key.length >= 3 && !key.includes(" ")) {
						usedKeys.add(key);
						fileKeys.push(key);
					}
				}
			}

			if (fileKeys.length > 0) {
				const uniqueKeys = [...new Set(fileKeys)]; // Remove duplicates
				fileUsages[relativePath] = uniqueKeys;
				console.log(`${relativePath}: Found ${uniqueKeys.length} unique translation keys`);
			}
		} catch (error) {
			console.warn(`Warning: Could not read file ${filePath}: ${error.message}`);
		}
	}

	console.log(`\nTotal unique translation keys used in code: ${usedKeys.size}`);

	return { usedKeys, fileUsages };
}

/**
 * Validates that used translation keys exist in YAML files and finds unused keys
 */
function validateKeyUsage(translationKeys, usedKeys) {
	console.log("\nValidating translation key usage...\n");

	const missingKeys = [];
	const unusedKeys = [];

	// Check for missing keys (used in code but not in YAML)
	for (const key of usedKeys) {
		if (!translationKeys.has(key)) {
			missingKeys.push(key);
		}
	}

	// Check for unused keys (in YAML but not used in code)
	for (const key of translationKeys) {
		if (!usedKeys.has(key)) {
			unusedKeys.push(key);
		}
	}

	let hasErrors = false;

	if (missingKeys.length > 0) {
		hasErrors = true;
		console.log(`MISSING translation keys (${missingKeys.length}):`);
		console.log("   These keys are used in code but not found in YAML files:");
		missingKeys.slice(0, 20).forEach((key) => console.log(`      - ${key}`));
		if (missingKeys.length > 20) {
			console.log(`      ... and ${missingKeys.length - 20} more`);
		}
		console.log("");
	}

	if (unusedKeys.length > 0) {
		// Categorize unused keys - some might be used in build scripts, manifest, or are utility keys
		const buildKeys = unusedKeys.filter(
			(key) =>
				key.startsWith("extension.") ||
				key.startsWith("common.") ||
				key.startsWith("units.") ||
				key.includes("audio_formats") ||
				key.includes("engines.") ||
				key.includes("voices.gender") ||
				key.includes("languages.") ||
				key.includes("default_text")
		);
		const genuinelyUnused = unusedKeys.filter((key) => !buildKeys.includes(key));

		if (genuinelyUnused.length > 0) {
			console.log(`WARNING: Unused translation keys (${genuinelyUnused.length}):`);
			console.log("   These keys exist in YAML files but are not used in TypeScript/JSX code:");
			genuinelyUnused.slice(0, 20).forEach((key) => console.log(`      - ${key}`));
			if (genuinelyUnused.length > 20) {
				console.log(`      ... and ${genuinelyUnused.length - 20} more`);
			}
			console.log("");
		}

		if (buildKeys.length > 0) {
			console.log(`INFO: Keys likely used in build/runtime (${buildKeys.length}):`);
			console.log("   These keys may be used by build scripts, manifest, or dynamic runtime usage:");
			buildKeys.slice(0, 15).forEach((key) => console.log(`      - ${key}`));
			if (buildKeys.length > 15) {
				console.log(`      ... and ${buildKeys.length - 15} more`);
			}
			console.log("");
		}
	}

	if (!hasErrors && unusedKeys.length === 0) {
		console.log("OK: All translation keys are properly used!");
		console.log(`   ${usedKeys.size} keys found in code match ${translationKeys.size} keys in YAML files.\n`);
	} else if (!hasErrors) {
		console.log("OK: No missing translation keys found!");
		console.log(`   All ${usedKeys.size} keys used in code exist in YAML files.\n`);
	}

	return hasErrors;
}

/**
 * Validates that all translation files have the same keys
 */
function validateTranslations() {
	console.log("Validating translation files...\n");

	const yamlFiles = getYamlFiles();

	if (yamlFiles.length === 0) {
		console.error("ERROR: No YAML files found in localization directory");
		return false;
	}

	console.log(`Found ${yamlFiles.length} YAML files: ${yamlFiles.join(", ")}\n`);

	const fileData = {};
	const allKeys = {};

	// Load all YAML files and extract their keys
	for (const file of yamlFiles) {
		try {
			console.log(`Loading ${file}...`);
			const data = loadYamlFile(file);
			const keys = extractKeys(data);

			fileData[file] = data;
			allKeys[file] = new Set(keys);

			console.log(`   OK: Found ${keys.length} translation keys`);
		} catch (error) {
			console.error(`   ERROR loading ${file}: ${error.message}`);
			return false;
		}
	}

	console.log("");

	// Use English as the reference (it should be the most complete)
	const referenceFile = "en.yaml";
	const referenceKeys = allKeys[referenceFile];

	if (!referenceKeys) {
		console.error(`ERROR: Reference file ${referenceFile} not found or invalid`);
		return false;
	}

	console.log(`Using ${referenceFile} as reference (${referenceKeys.size} keys)\n`);

	let hasErrors = false;

	// Compare each file against the reference
	for (const file of yamlFiles) {
		if (file === referenceFile) continue;

		const currentKeys = allKeys[file];
		const missingKeys = [...referenceKeys].filter((key) => !currentKeys.has(key));
		const extraKeys = [...currentKeys].filter((key) => !referenceKeys.has(key));

		console.log(`Checking ${file}:`);

		if (missingKeys.length === 0 && extraKeys.length === 0) {
			console.log(`   OK: Perfect match! All ${currentKeys.size} keys present\n`);
		} else {
			hasErrors = true;

			if (missingKeys.length > 0) {
				console.log(`   WARNING: Missing ${missingKeys.length} keys:`);
				missingKeys.slice(0, 10).forEach((key) => console.log(`      - ${key}`));
				if (missingKeys.length > 10) {
					console.log(`      ... and ${missingKeys.length - 10} more`);
				}
			}

			if (extraKeys.length > 0) {
				console.log(`   WARNING: Extra ${extraKeys.length} keys:`);
				extraKeys.slice(0, 10).forEach((key) => console.log(`      + ${key}`));
				if (extraKeys.length > 10) {
					console.log(`      ... and ${extraKeys.length - 10} more`);
				}
			}

			console.log("");
		}
	}

	// Validate key usage against source code
	if (!hasErrors) {
		const { usedKeys } = extractTranslationKeysFromSource();
		const keyUsageErrors = validateKeyUsage(referenceKeys, usedKeys);
		hasErrors = hasErrors || keyUsageErrors;
	}

	// Summary
	if (hasErrors) {
		console.log("FAILED: Translation validation failed!");
		console.log("   Some files are missing keys, have extra keys, or keys are missing/unused.");
		console.log("   Please ensure all translation files have the same structure and all keys are properly used.\n");
	} else {
		console.log("PASSED: Translation validation passed!");
		console.log("   All files have matching keys and structure, and all keys are properly used.\n");
	}

	return !hasErrors;
}

/**
 * Main execution
 */
function main() {
	try {
		console.log("Translation Validator for Azure Speech Chrome Extension\n");

		// Check if localization directory exists
		if (!fs.existsSync(LOCALIZATION_DIR)) {
			console.error(`ERROR: Localization directory not found: ${LOCALIZATION_DIR}`);
			process.exit(1);
		}

		// Run validation
		const success = validateTranslations();

		// Exit with appropriate code
		process.exit(success ? 0 : 1);
	} catch (error) {
		console.error(`ERROR: Unexpected error: ${error.message}`);
		process.exit(1);
	}
}

// Run if called directly
if (require.main === module) {
	main();
}

module.exports = { validateTranslations, extractKeys };
