module.exports = {
	presets: [
		["@babel/preset-env", { targets: { browsers: ["chrome >= 88"] } }],
		["@babel/preset-react", { runtime: "automatic" }],
		"@babel/preset-typescript",
	],
	plugins: [
		[
			"babel-plugin-react-compiler",
			{
				compilationMode: "annotation",
			},
		],
	],
};
