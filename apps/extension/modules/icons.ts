import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { defineWxtModule } from "wxt/modules";

/**
 * Rasterizes the extension icons from the SVG drawings in src/assets at build
 * time, so the repository stays SVG-source-only. Browsers show the toolbar
 * icon at 16 and 32 px, where shrinking the full mark blurs its glass band and
 * light into a pixel each; those two sizes come from icon-16.svg, the dedicated
 * flat drawing, and the larger ones from icon.svg, the full mark. sharp
 * re-renders the vector at each target size (no bitmap upscaling).
 */
const ICONS: ReadonlyArray<{ size: number; source: string }> = [
  { size: 16, source: "icon-16.svg" },
  { size: 32, source: "icon-16.svg" },
  { size: 48, source: "icon.svg" },
  { size: 128, source: "icon.svg" },
];

const outputPath = (size: number) => `icons/${size}.png`;

export default defineWxtModule({
  name: "icons",
  setup(wxt) {
    wxt.hooks.hook("build:manifestGenerated", (_, manifest) => {
      const icons = Object.fromEntries(ICONS.map(({ size }) => [size, outputPath(size)]));
      manifest.icons = icons;
      if (manifest.action) manifest.action.default_icon = icons;
    });

    wxt.hooks.hook("build:done", async (wxt, output) => {
      await mkdir(resolve(wxt.config.outDir, "icons"), { recursive: true });
      for (const { size, source } of ICONS) {
        await sharp(resolve(wxt.config.srcDir, "assets", source))
          .resize(size, size)
          .png()
          .toFile(resolve(wxt.config.outDir, outputPath(size)));
        output.publicAssets.push({ type: "asset", fileName: outputPath(size) });
      }
    });

    // Keeps `/icons/<size>.png` in WXT's typed PublicPath union (the popup
    // renders /icons/32.png).
    wxt.hooks.hook("prepare:publicPaths", (_, paths) => {
      for (const { size } of ICONS) paths.push(outputPath(size));
    });
  },
});
