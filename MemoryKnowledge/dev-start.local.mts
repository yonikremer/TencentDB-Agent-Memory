import { serve } from "@hono/node-server";
import { createApp } from "./src/server.ts";

const { app, config, knowledgeTelemetry } = createApp();
await knowledgeTelemetry.initialize();
serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log("Knowledge service listening on http://localhost:" + info.port);
});
