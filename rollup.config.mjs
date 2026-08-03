import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";

export default {
  input: "src/plugin.ts",
  output: {
    file: "com.claudecode.monitor.sdPlugin/bin/plugin.js",
    format: "esm",
    sourcemap: true
  },
  plugins: [nodeResolve({ preferBuiltins: true }), commonjs(), json(), typescript()],
  external: [/^node:/]
};
