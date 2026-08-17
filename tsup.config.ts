import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    platform: "node",
    target: "node18",
    bundle: true,
    clean: true,
  },
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: true,
    platform: "node",
    target: "node18",
    bundle: true,
  },
]);
