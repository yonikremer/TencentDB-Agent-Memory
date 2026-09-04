import { defineConfig } from "@kubb/core";
import { pluginOas } from "@kubb/plugin-oas";
import { pluginTs } from "@kubb/plugin-ts";
import { pluginZod } from "@kubb/plugin-zod";

export default defineConfig({
  root: ".",
  input: {
    // Team memory extension version contract: adds optional IdFields (team_id / agent_id / user_id / task_id) on top of the 13 offload.yaml interfaces for service-mode isolation.
    // (When old clients omit IdFields they work with the original offload.yaml semantics.)
    path: "./docs/team-api-仅memory.yaml",
  },
  output: {
    path: "./src/gateway/generated",
    clean: true,
    barrelType: false,
  },
  plugins: [
    pluginOas({
      generators: [],
    }),
    pluginTs({
      output: {
        path: "./types.ts",    // single file
        barrelType: false,
      },
    }),
    pluginZod({
      output: {
        path: "./schemas.ts",  // single file
        barrelType: false,
      },
      typed: true,
      importPath: "zod",
    }),
  ],
});
