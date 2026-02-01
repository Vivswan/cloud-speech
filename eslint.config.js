import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
	js.configs.recommended,
	{
		files: ["**/*.{js,jsx,ts,tsx,cjs,mjs}"],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				ecmaVersion: "latest",
				sourceType: "module",
			},
			globals: {
				// Browser globals
				window: "readonly",
				document: "readonly",
				navigator: "readonly",
				console: "readonly",
				// Node globals
				process: "readonly",
				__dirname: "readonly",
				__filename: "readonly",
				module: "readonly",
				require: "readonly",
				// ES6+ globals
				Promise: "readonly",
				Set: "readonly",
				Map: "readonly",
				// WebExtensions globals
				chrome: "readonly",
				browser: "readonly",
			},
		},
		plugins: {
			"@typescript-eslint": tsPlugin,
		},
		rules: {
			...tsPlugin.configs.recommended.rules,
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/explicit-function-return-type": "off",
			"@typescript-eslint/explicit-module-boundary-types": "off",
		},
	},
	{
		files: ["scripts/*.js", "scripts/*.cjs"],
		rules: {
			"@typescript-eslint/no-var-requires": "off",
		},
	},
	{
		ignores: ["dist/**/*", "node_modules/**/*", "builds/**/*", "coverage/**/*"],
	},
];
