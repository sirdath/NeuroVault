/* Bundles src/extension.ts into a single CommonJS file in out/.
 * The vscode module must stay external since it is provided by the
 * extension host at runtime. */
const esbuild = require("esbuild");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const ctx = esbuild.context({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: "node",
  target: "node18",
  outfile: "out/extension.js",
  external: ["vscode"],
  logLevel: "info",
});

ctx.then(async (c) => {
  if (watch) {
    await c.watch();
  } else {
    await c.rebuild();
    await c.dispose();
  }
});
