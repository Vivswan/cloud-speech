import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
	test: {
		globals: true,
		environment: "happy-dom",
		setupFiles: ["./tests/setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			exclude: ["node_modules/**", "dist/**", "tests/**", "scripts/**", "**/*.d.ts", "**/*.config.*", "**/manifest.js"],
			thresholds: {
				lines: 60,
				functions: 60,
				branches: 60,
				statements: 60,
			},
		},
		include: ["tests/**/*.{test,spec}.{ts,tsx}"],
		exclude: ["node_modules", "dist", "builds"],
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
	plugins: [
		// YAML loader plugin for importing translation files
		{
			name: "yaml-loader",
			async transform(src, id) {
				if (id.endsWith(".yaml") || id.endsWith(".yml")) {
					const jsYaml = await import("js-yaml");
					const obj = jsYaml.load(src);
					return {
						code: `export default ${JSON.stringify(obj)}`,
						map: null,
					};
				}
			},
		},
	],
});
