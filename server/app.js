import { createServer } from "node:http";
import { createHttpHandler } from "./http.js";
import { createCatalog } from "./catalog.js";
import { createIceServerProvider } from "./ice.js";
import { createLogger } from "./logger.js";
import { fetchMacCms } from "./maccms.js";
import { createOss } from "./oss.js";
import { createSources } from "./sources.js";
import { attachRealtimeServer } from "./realtime.js";
import { createDatabase } from "./database.js";
import { createAccounts } from "./accounts.js";
import { createDiscovery } from "./discovery.js";
import { createSettings } from "./settings.js";

export function createApplication(config, logger = createLogger(config.nodeEnv)) {
  let ready = false;
  let closed = false;
  let realtime = null;
  const database = createDatabase(config.databaseUrl, config.databaseSchema);
  const accounts = createAccounts(database, config.secureCookies);
  const catalog = createCatalog(config.dataDir, database);
  const sources = createSources(config.dataDir, config.macCmsSources, database);
  const settings = createSettings(config.dataDir, database);
  const oss = createOss(config.oss);
  const getServiceStatus = () => ({
    ready,
    turnConfigured: config.turnUrls.length > 0,
    ...(realtime?.getStats() || { rooms: 0, clients: 0 }),
  });
  const roomAdmin = {
    listRooms: () => realtime.listRooms(),
    closeRoom: (id) => realtime.closeRoom(id),
    preparePlaylist: (playlist) => realtime.preparePlaylist(playlist),
    endSession: (key) => realtime.endSession(key),
    mediaInUse: (url) => realtime.mediaInUse(url),
  };
  const discovery = createDiscovery(sources, roomAdmin.preparePlaylist);
  const server = createServer(createHttpHandler(config, getServiceStatus, { catalog, accounts, discovery, settings, realtime: roomAdmin, oss, sources, fetchMacCms }));
  const createIceServers = createIceServerProvider(config);
  realtime = attachRealtimeServer(server, config, logger, createIceServers, catalog, accounts, discovery);

  server.on("clientError", (error, socket) => {
    logger.warn("Invalid HTTP client request", { error: error.message });
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  async function listen() {
    await database.initialize();
    await realtime.restoreRooms();
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
      turnConfigured: config.turnUrls.length > 0,
      wsPath: config.wsPath,
    });
    return address;
  }

  async function close() {
    if (closed) return;
    closed = true;
    ready = false;
    await realtime.close();
    await accounts.flush();
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await database.close();
  }

  return { server, listen, close };
}
