import { createServer } from "node:http";
import { createHttpHandler } from "./http.js";
import { createLogger } from "./logger.js";
import { attachRealtimeServer } from "./realtime.js";

export function createApplication(config, logger = createLogger(config.nodeEnv)) {
  let ready = false;
  let realtime = null;
  const getServiceStatus = () => ({ ready, ...(realtime?.getStats() || { rooms: 0, clients: 0 }) });
  const server = createServer(createHttpHandler(config, getServiceStatus));
  realtime = attachRealtimeServer(server, config, logger);

  server.on("clientError", (error, socket) => {
    logger.warn("Invalid HTTP client request", { error: error.message });
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  async function listen() {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    ready = true;
    const address = server.address();
    logger.info("Server started", {
      host: config.host,
      port: typeof address === "object" ? address.port : config.port,
      staticFiles: config.serveStatic,
      wsPath: config.wsPath,
    });
    return address;
  }

  async function close() {
    ready = false;
    await realtime.close();
    if (!server.listening) return;
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }

  return { server, listen, close };
}
