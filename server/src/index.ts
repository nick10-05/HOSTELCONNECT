import { createApp } from "./app";
import { loadConfig } from "./config";
import { loadDotEnv } from "./loadEnv";

loadDotEnv();
const config = loadConfig();

createApp().listen(config.PORT, () => {
  console.log(`HostelConnect server listening on port ${config.PORT}`);
});
