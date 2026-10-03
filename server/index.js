import { createApplication } from "./app.js";
import { loadConfig, loadEnvironment } from "./config.js";
import { createLogger } from "./logger.js";

let config;
try {
  loadEnvironment();
  config = loadConfig();
} catch (error) {
  console.error(`Invalid server configuration: ${error.message}`);
  process.exit(1);
}

const logger = createLogger(config.nodeEnv);
const app = createApplication(config, logger);
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("Server shutdown started", { signal });
  const forceExit = setTimeout(() => {
    logger.error("Server shutdown timed out");
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref();

  try {
    await app.close();
    clearTimeout(forceExit);
    logger.info("Server shutdown complete");
  } catch (error) {
    logger.error("Server shutdown failed", { error: error.message });
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

try {
  await app.listen();
} catch (error) {
  logger.error("Server failed to start", { error: error.message });
  process.exit(1);
}
