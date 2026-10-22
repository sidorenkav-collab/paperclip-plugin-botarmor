// Same output as the SDK's bundler presets: one ESM file per entry for Node 24, the SDK bundled into the worker.
import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "esm", target: "node24", sourcemap: true, logLevel: "info" };
await build({ ...common, entryPoints: ["src/worker.js"], outfile: "dist/worker.js", external: ["react", "react-dom"] });
await build({ ...common, entryPoints: ["src/manifest.js"], outfile: "dist/manifest.js", external: ["@paperclipai/plugin-sdk"] });
