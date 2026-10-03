import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { mediaUrl } from "./catalog.js";
import { episodeKey } from "./discovery.js";
import { SYNC_TICK_MS, SYNC_LEASE_MS, SYNC_PROTOCOL, memberSyncIssue, reportedPosition } from "../shared/sync.js";

function episodeLabel(item) {
  return item?.label || item?.episodeLabel || (item?.title?.includes(" · ") ? item.title.split(" · ").pop() : "正片");
}

export function attachRealtimeServer(server, config, logger, createIceServers, catalog, accounts, discovery) {
  const rooms = new Map();
  const selections = new Map();
  const roomWrites = new Map();
  const allowedOrigins = new Set(config.allowedOrigins);
  const wss = new WebSocketServer({
    server,
    path: config.wsPath,
    maxPayload: config.maxPayloadBytes,
    verifyClient: ({ origin }, done) => {
      const allowed = allowedOrigins.size === 0 || allowedOrigins.has("*") || !origin || allowedOrigins.has(origin);
      done(allowed, allowed ? undefined : 403, allowed ? undefined : "Origin not allowed");
    },
  });

  function preparePlaylist(input) {
    const items = input.items.map((item) => ({ url: mediaUrl(item.url), title: String(item.title || item.label || "未命名视频").slice(0, 120), label: item.label || item.episodeLabel || "", poster: item.poster || input.poster || "" }));
    const selectionId = randomUUID();
    for (const [key, selection] of selections) if (selection.expiresAt < Date.now()) selections.delete(key);
    if (selections.size >= 100) selections.delete(selections.keys().next().value);
    selections.set(selectionId, { title: String(input.title || "剧集").slice(0, 120), items, context: input.context || {}, expiresAt: Date.now() + 3600000 });
    return selectionId;
  }

  function createRoom(id, resourceId = "", initialMedia = null, selection = {}) {
    const resource = catalog.find(resourceId);
    if (resourceId && !resource?.enabled) throw new Error("Resource is not available");
    let media = resource?.enabled ? resource : null;
    if (!resourceId && initialMedia) {
      media = { url: mediaUrl(initialMedia.url), title: String(initialMedia.title || "未命名视频").slice(0, 120) };
    }
    let playlist = [];
    let playlistTitle = "";
    let playlistIndex = -1;
    let historyContext = { title: media?.title || "", poster: resource?.poster || initialMedia?.poster || "", resourceId: resourceId || "" };
    let collectionItems = [];
    if (selection.collectionId) throw new Error("Saved collections are no longer supported");
    if (selection.libraryGroupId || selection.selectionId) {
      const selected = selection.libraryGroupId ? catalog.group(selection.libraryGroupId) : selections.get(selection.selectionId);
      if (!selected || selected.expiresAt < Date.now() || !selected.items.length) throw new Error("Series is not available");
      playlist = selected.items.map((item) => ({ title: item.title, url: item.url, label: episodeLabel(item), poster: item.poster || selected.poster || "" }));
      collectionItems = selected.items;
      historyContext = selection.libraryGroupId ? { title: selected.title, poster: selected.poster, libraryGroupId: selected.id, contentKey: selected.id } : selected.context;
      if (!historyContext.title) historyContext = { ...historyContext, title: selected.title, poster: selected.poster || selected.items[0]?.poster || "" };
      playlistTitle = selected.title;
      playlistIndex = Math.max(0, Math.min(playlist.length - 1, Math.floor(Number(selection.playlistIndex) || 0)));
      if (selection.collectionResourceId) {
        playlistIndex = selected.items.findIndex((item) => item.id === selection.collectionResourceId);
        if (playlistIndex < 0 && selection.libraryGroupId) {
          const alternative = catalog.find(selection.collectionResourceId);
          if (alternative?.enabled) playlistIndex = selected.items.findIndex(item => catalog.identity(item) === catalog.identity(alternative));
          if (playlistIndex >= 0) {
            collectionItems = [...selected.items];
            collectionItems[playlistIndex] = alternative;
            playlist[playlistIndex] = { ...playlist[playlistIndex], url: alternative.url, title: alternative.title, poster: alternative.poster || selected.poster || "" };
          }
        }
        if (playlistIndex < 0) throw new Error("Episode is not available");
      }
      media = playlist[playlistIndex];
    }
    const room = {
      id,
      createdAt: Date.now(),
      hostId: null,
      clients: new Map(),
      sequence: 0,
      playlist,
      playlistTitle,
      historyContext,
      collectionItems,
      lineChoices: new Map(),
      state: {
        mediaUrl: media?.url || "",
        mediaTitle: media?.title || "",
        paused: true,
        position: Math.max(0, Math.min(604800, Number(selection.resumePosition) || 0)),
        executeAt: Date.now(),
        playlistIndex,
        autoAdvance: true,
        mediaPoster: media?.poster || historyContext.poster || "",
        lineLabel: "默认线路",
      },
      messages: [],
    };
    rooms.set(id, room);
    persistRoom(room);
    return room;
  }

  function persistRoom(room, remove = false) {
    const state = currentState(room);
    const signature = `${room.sequence}:${Math.floor(state.position / 5)}:${room.messages.at(-1)?.id || ''}`;
    if (!remove && room.persistedSignature === signature && Date.now() - (room.persistedAt || 0) < 300000) return;
    room.persistedSignature = signature;
    room.persistedAt = Date.now();
    const data = { id: room.id, createdAt: room.createdAt, sequence: room.sequence, playlist: room.playlist, playlistTitle: room.playlistTitle,
      historyContext: room.historyContext, collectionItems: room.collectionItems, messages: room.messages,
      state: { ...state, executeAt: Date.now(), paused: true } };
    const operation = (roomWrites.get(room.id) || Promise.resolve()).then(() => remove ? accounts.deleteRoom(room.id) : accounts.saveRoom(room.id, data));
    const settled = operation.catch(error => { room.persistedSignature = ""; logger.error("Room persistence failed", { error: error.message }); });
    roomWrites.set(room.id, settled);
    settled.finally(() => { if (roomWrites.get(room.id) === settled) roomWrites.delete(room.id); });
  }

  async function restoreRooms() {
    for (const saved of await accounts.loadRooms()) {
      rooms.set(saved.id, { ...saved, hostId: null, clients: new Map(), lineChoices: new Map(), state: { ...saved.state, paused: true, executeAt: Date.now() } });
    }
  }

  function send(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  }

  function broadcast(room, payload, exceptId = null) {
    for (const [clientId, client] of room.clients) {
      if (clientId !== exceptId) send(client.socket, payload);
    }
  }

  function appendMessage(room, message) {
    room.messages.push(message);
    room.messages = room.messages.slice(-100);
    persistRoom(room);
    broadcast(room, { type: "chat", message });
  }

  function appendSystemMessage(room, text) {
    appendMessage(room, {
      id: randomUUID(),
      type: "system",
      text,
      sentAt: Date.now(),
    });
  }

  function appendVoiceEvent(room, session, joined) {
    appendSystemMessage(room, `${session.name}${joined ? "加入了语音" : "退出了语音"}`);
  }

  function publicMember(client) {
    return {
      id: client.id,
      name: client.name,
      playback: client.playback,
      network: client.network,
      voiceEnabled: client.voiceEnabled,
      voiceMuted: client.voiceMuted,
    };
  }

  function sanitizeMemberStatus(message) {
    const playback = message.playback || {};
    const network = message.network || {};
    const latency = Number(network.latencyMs);
    const packetLoss = Number(network.packetLoss);
    const connectionStates = new Set(["new", "connecting", "connected", "disconnected", "failed", "closed"]);
    const connectionPaths = new Set(["checking", "direct", "relay"]);

    return {
      playback: {
        mediaUrl: String(playback.mediaUrl || "").slice(0, 2048),
        position: Math.max(0, Number(playback.position) || 0),
        duration: Math.max(0, Math.min(604800, Number(playback.duration) || 0)),
        ready: Boolean(playback.ready),
        buffering: Boolean(playback.buffering),
        bufferedAhead: Math.max(0, Math.min(300, Number(playback.bufferedAhead) || 0)),
        loadedPercent: Math.max(0, Math.min(100, Number(playback.loadedPercent) || 0)),
        paused: Boolean(playback.paused),
        sequence: Number.isInteger(playback.sequence) ? playback.sequence : -1,
        sampledAt: Number(playback.sampledAt) || 0,
        syncRttMs: Number.isFinite(playback.syncRttMs) ? Math.max(0, playback.syncRttMs) : 10000,
      },
      network: {
        latencyMs: Number.isFinite(latency) ? Math.max(0, Math.min(10000, Math.round(latency))) : null,
        packetLoss: Number.isFinite(packetLoss) ? Math.max(0, Math.min(100, packetLoss)) : null,
        connectionState: connectionStates.has(network.connectionState) ? network.connectionState : "new",
        path: connectionPaths.has(network.path) ? network.path : "checking",
      },
    };
  }

  function currentState(room) {
    const now = Date.now();
    const state = { ...room.state, sequence: room.sequence, serverTime: now };
    if (!state.paused && now > state.executeAt) {
      state.position += (now - state.executeAt) / 1000;
      state.executeAt = now;
    }
    const playback = room.clients.get(room.hostId)?.playback;
    if (playback?.mediaUrl === state.mediaUrl && playback.duration > 0 && state.position >= playback.duration) {
      state.position = playback.duration;
      state.paused = true;
      room.state = { ...room.state, position: playback.duration, paused: true, executeAt: now };
    }
    return state;
  }

  function rebaseRoomState(room) {
    const state = currentState(room);
    room.state = {
      mediaUrl: state.mediaUrl,
      mediaTitle: state.mediaTitle,
      paused: state.paused,
      position: state.position,
      executeAt: state.serverTime,
      playlistIndex: state.playlistIndex,
      autoAdvance: state.autoAdvance,
      mediaPoster: state.mediaPoster,
      lineLabel: state.lineLabel,
    };
    return { ...state, executeAt: state.serverTime };
  }

  function pauseForSync(room, reason, resume = false, automatic = true) {
    const state = currentState(room);
    if (state.paused && !resume) return;
    if (room.syncWaiting && state.paused && automatic) return;
    const positions = [...room.clients.values()].filter((client) => client.playback?.mediaUrl === state.mediaUrl && client.playback.sequence === room.sequence)
      .map((client) => reportedPosition(client.playback, state.serverTime));
    const position = Math.max(0, Math.min(state.position, ...positions));
    room.sequence += 1;
    room.syncWaiting = automatic;
    room.state = { ...room.state, paused: true, position, executeAt: state.serverTime };
    broadcast(room, { type: "sync-command", command: { ...room.state, id: randomUUID(), sequence: room.sequence, resumePlay: automatic, requireHostResume: !automatic, syncReason: reason } });
    persistRoom(room);
  }

  function promoteNextHost(room) {
    room.hostId = room.clients.keys().next().value || null;
    if (!room.hostId) return;
    const state = rebaseRoomState(room);
    const nextHost = room.clients.get(room.hostId);
    broadcast(room, { type: "host-changed", hostId: room.hostId, state });
    appendSystemMessage(room, `${nextHost.name}成为了新房主`);
  }

  function sanitizeRoomId(value) {
    return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  }

  function sanitizeName(value) {
    return String(value || "游客").trim().slice(0, 20) || "游客";
  }

  function leaveRoom(session) {
    if (!session.roomId || !session.id) return;
    const room = rooms.get(session.roomId);
    if (!room || !room.clients.has(session.id)) return;
    saveHistory(session, true);

    if (room.clients.size > 1) pauseForSync(room, "成员离线，已暂停；确认后可继续", true, false);

    const wasHost = room.hostId === session.id;
    room.clients.delete(session.id);
    broadcast(room, { type: "peer-left", peerId: session.id });
    if (session.voiceEnabled) appendVoiceEvent(room, session, false);
    if (wasHost) promoteNextHost(room);

    if (room.clients.size === 0) {
      room.persistedSignature = "";
      persistRoom(room);
      rooms.delete(room.id);
    }
    session.id = null;
    session.roomId = null;
  }

  function saveHistory(session, force = false) {
    const room = rooms.get(session.roomId);
    if (!room || !session.user || (!force && Date.now() - session.historySavedAt < 10000)) return;
    session.historySavedAt = Date.now();
    const playback = session.playback?.mediaUrl === room.state.mediaUrl ? session.playback : null;
    const media = { ...room.historyContext, url: room.state.mediaUrl, episodeTitle: room.state.mediaTitle, playlistIndex: room.state.playlistIndex,
      playlistLength: room.playlist.length,
      collectionResourceId: room.collectionItems[room.state.playlistIndex]?.id || "", episodeLabel: room.playlist[room.state.playlistIndex]?.label || "",
      episodeIdentity: room.collectionItems[room.state.playlistIndex] ? catalog.identity(room.collectionItems[room.state.playlistIndex]) : "" };
    accounts.recordHistory(session.user.id, media, playback?.position ?? currentState(room).position, playback?.duration || 0)
      ?.catch((error) => logger.error("History persistence failed", { error: error.message }));
  }

  function episodeNumber(label) {
    return episodeKey(label);
  }

  async function availableLines(room) {
    const item = room.collectionItems[room.state.playlistIndex] || catalog.find(room.historyContext.resourceId);
    const seriesTitle = item?.seriesTitle || item?.title?.split(" · ")[0] || room.historyContext.title || room.state.mediaTitle.split(" · ")[0];
    let detail = null;
    if (!item || !["OSS", "manual"].includes(item.source) || item.networkReferences?.length) {
      try { detail = await discovery.findByTitle(seriesTitle, item?.year || room.historyContext.year || "", room.state.mediaUrl); } catch { /* Stored resources still provide a fallback. */ }
    }
    if (!detail && room.historyContext.references?.length) {
      try { detail = await discovery.detailsFromReferences(room.historyContext.references, room.historyContext.contentKey); } catch { /* Keep local alternatives available. */ }
    }
    room.lineChoices.clear();
    for (const line of detail?.lines || []) room.lineChoices.set(line.selectionId, { ...line, seriesTitle });
    const alternatives = catalog.list().filter((resource) => item ? catalog.identity(resource) === catalog.identity(item) : resource.title === room.state.mediaTitle)
      .sort((a, b) => Number(b.url === room.state.mediaUrl) - Number(a.url === room.state.mediaUrl));
    for (const resource of alternatives) {
      if ([...room.lineChoices.values()].some((line) => line.episodes.some((episode) => episode.url === resource.url))) continue;
      const id = randomUUID();
      room.lineChoices.set(id, { name: `线路 ${room.lineChoices.size + 1}`, seriesTitle, episodes: [{ label: item?.episodeLabel || room.playlist[room.state.playlistIndex]?.label || "正片", url: resource.url }], poster: resource.poster });
    }
    const label = episodeLabel(room.playlist[room.state.playlistIndex] || catalog.find(room.historyContext.resourceId));
    return [...room.lineChoices].map(([id, line], index) => {
      const matched = line.episodes.find(episode => episodeNumber(episode.label) === episodeNumber(label)) || (line.episodes.length === 1 ? line.episodes[0] : null);
      return matched ? { id, name: `线路 ${index + 1}`, current: matched.url === room.state.mediaUrl, url: matched.url } : null;
    }).filter(Boolean);
  }

  function switchLine(room, choiceId, position) {
    const line = room.lineChoices.get(choiceId);
    if (!line) throw new Error("线路列表已更新，请重新打开线路选择");
    const label = episodeLabel(room.playlist[room.state.playlistIndex] || catalog.find(room.historyContext.resourceId));
    const matched = line.episodes.find((episode) => episodeNumber(episode.label) === episodeNumber(label)) || (line.episodes.length === 1 ? line.episodes[0] : null);
    if (!matched) throw new Error("这条线路暂时没有当前分集，请选择其他线路");
    if (room.playlist.length) {
      room.playlist = room.playlist.map((item, index) => {
        const stored = room.collectionItems[index];
        if (stored && (stored.seriesTitle || stored.title.split(" · ")[0]) !== line.seriesTitle) return item;
        const episode = line.episodes.find((episode) => episodeNumber(episode.label) === episodeNumber(item.label));
        return episode ? { ...item, url: episode.url, poster: line.poster || item.poster } : item;
      });
      room.playlist[room.state.playlistIndex] = { ...room.playlist[room.state.playlistIndex], url: matched.url };
    }
    const resumePlay = !room.state.paused;
    room.sequence += 1;
    room.state = { ...room.state, mediaUrl: matched.url, lineLabel: line.name, paused: true, position: Math.max(0, Math.min(604800, Number(position) || 0)), executeAt: Date.now() + 350 };
    broadcast(room, { type: "playlist", items: room.playlist, title: room.playlistTitle });
    broadcast(room, { type: "sync-command", command: { ...currentState(room), id: randomUUID(), resumePlay, lineLabel: line.name } });
    persistRoom(room);
    for (const client of room.clients.values()) saveHistory(client, true);
  }

  wss.on("connection", (socket, request) => {
    socket.sessionKey = accounts.sessionKey(request);
    socket.isAlive = true;
    socket.on("pong", () => {
      socket.isAlive = true;
    });

    const session = {
      socket,
      id: null,
      roomId: null,
      name: null,
      playback: null,
      network: null,
      voiceEnabled: false,
      voiceMuted: false,
      user: null,
      historySavedAt: 0,
      joinVersion: 0,
    };

    socket.on("message", async (buffer) => {
      let message;
      try {
        message = JSON.parse(buffer.toString());
      } catch {
        return;
      }

      if (!message || typeof message !== "object") return;

      if (message.type === "clock-ping") {
        send(socket, {
          type: "clock-pong",
          requestId: message.requestId,
          clientSentAt: message.clientSentAt,
          serverAt: Date.now(),
        });
        return;
      }

      if (message.type === "join") {
        const version = ++session.joinVersion;
        try {
          session.user = await accounts.getUser(request);
        } catch {
          send(socket, { type: "join-error", error: "账户服务暂时不可用，请稍后再试" });
          return;
        }
        if (version !== session.joinVersion || socket.readyState !== WebSocket.OPEN) return;
        if (!session.user) {
          send(socket, { type: "join-error", code: 401, error: "登录后即可开房，并保存观看进度" });
          return;
        }
        if (message.syncProtocol !== SYNC_PROTOCOL) {
          send(socket, { type: "join-error", code: 426, error: "同步机制已升级，请刷新页面后重新加入房间" });
          return;
        }
        leaveRoom(session);
        const roomId = sanitizeRoomId(message.roomId);
        if (!roomId) return;

        let room;
        try {
          if (!rooms.has(roomId)) {
            await roomWrites.get(roomId);
            const saved = await accounts.room(roomId);
            if (saved) rooms.set(roomId, { ...saved, hostId: null, clients: new Map(), lineChoices: new Map(), state: { ...saved.state, paused: true, executeAt: Date.now() } });
            else if (message.reconnect) {
              send(socket, { type: "join-error", code: 410, error: "这个房间已经结束，请重新开房" });
              return;
            }
          }
          if (version !== session.joinVersion || socket.readyState !== WebSocket.OPEN) return;
          room = rooms.get(roomId) || createRoom(roomId, String(message.resourceId || ""), message.media, message);
        } catch {
          send(socket, { type: "join-error", error: "片源地址无效，请重新选择资源" });
          return;
        }
        session.id = randomUUID();
        session.roomId = roomId;
        session.name = sanitizeName(message.name);
        room.clients.set(session.id, session);
        if (!room.hostId) room.hostId = session.id;
        if (!room.state.paused) pauseForSync(room, "等待新成员对齐");

        send(socket, {
          type: "joined",
          clientId: session.id,
          hostId: room.hostId,
          roomId,
          members: [...room.clients.values()].map(publicMember),
          messages: room.messages,
          state: currentState(room),
          playlist: room.playlist,
          playlistTitle: room.playlistTitle,
          mediaPoster: room.state.mediaPoster || "",
          iceServers: createIceServers(session.id),
        });
        for (const [clientId, client] of room.clients) {
          if (clientId === session.id) continue;
          send(client.socket, {
            type: "peer-joined",
            peer: publicMember(session),
            iceServers: createIceServers(clientId),
          });
        }
        appendSystemMessage(room, `${session.name}加入了房间`);
        saveHistory(session, true);
        return;
      }

      const room = rooms.get(session.roomId);
      if (!room || !session.id) return;

      if (message.type === "sync-hold") {
        pauseForSync(room, "等待全员同步");
        send(socket, { type: "sync-state", state: { ...currentState(room), syncWaiting: room.syncWaiting, validUntil: Date.now() + SYNC_LEASE_MS }, hostId: room.hostId });
        return;
      }

      if (message.type === "request-lines") {
        try { send(socket, { type: "available-lines", roomId: room.id, lines: await availableLines(room) }); }
        catch { send(socket, { type: "line-error", error: "线路获取失败，请稍后再试" }); }
        return;
      }
      if (message.type === "switch-line") {
        if (room.hostId !== session.id) return;
        try { switchLine(room, String(message.id || ""), message.position); }
        catch (error) { send(socket, { type: "line-error", error: error.message }); }
        return;
      }

      if (message.type === "signal") {
        const target = room.clients.get(message.target);
        if (target) send(target.socket, { type: "signal", from: session.id, data: message.data });
        return;
      }

      if (message.type === "sync-command") {
        if (room.hostId !== session.id) {
          send(socket, { type: "room-state", state: currentState(room), hostId: room.hostId });
          return;
        }

        let command = message.command;
        if (!command || !Number.isInteger(command.sequence)) return;
        if (command.sequence <= room.sequence) { send(socket, { type: "room-state", state: currentState(room), hostId: room.hostId }); return; }
        if (!command.paused) {
          const target = { ...currentState(room), position: Number(command.position) || 0 };
          if ([...room.clients.values()].some((client) => memberSyncIssue(client, target, Date.now(), true))) {
            room.syncWaiting = false;
            pauseForSync(room, "等待全员缓冲与进度确认", true);
            return;
          }
        }
        const index = Number(command.playlistIndex);
        if (Number.isInteger(index) && index >= 0 && index < room.playlist.length) {
          command = { ...command, playlistIndex: index, mediaUrl: room.playlist[index].url, mediaTitle: room.playlist[index].title };
        } else {
          command = { ...command, playlistIndex: -1 };
          if (room.playlist.length) {
            room.playlist = [];
            room.playlistTitle = "";
            broadcast(room, { type: "playlist", items: [], title: "" });
          }
        }
        room.sequence = command.sequence;
        room.syncWaiting = false;
        if (command.playlistIndex < 0 && command.mediaUrl && command.mediaUrl !== room.state.mediaUrl) {
          room.historyContext = { title: String(command.mediaTitle || "未命名视频").slice(0, 120), poster: "" };
          room.collectionItems = [];
        }
        command = { ...command, mediaPoster: room.playlist[command.playlistIndex]?.poster || room.historyContext.poster || "" };
        room.state = {
          mediaUrl: String(command.mediaUrl || room.state.mediaUrl).slice(0, 2048),
          mediaTitle: String(command.mediaTitle || room.state.mediaTitle).slice(0, 120),
          paused: Boolean(command.paused),
          position: Math.max(0, Number(command.position) || 0),
          executeAt: Number(command.executeAt) || Date.now(),
          playlistIndex: command.playlistIndex,
          autoAdvance: typeof command.autoAdvance === "boolean" ? command.autoAdvance : room.state.autoAdvance,
          mediaPoster: command.mediaPoster,
          lineLabel: room.state.lineLabel,
        };
        broadcast(room, { type: "sync-command", command });
        persistRoom(room);
        for (const client of room.clients.values()) saveHistory(client, true);
        return;
      }

      if (message.type === "chat") {
        const text = String(message.text || "").trim().slice(0, 500);
        if (!text) return;
        appendMessage(room, {
          id: randomUUID(),
          senderId: session.id,
          senderName: session.name,
          text,
          sentAt: Date.now(),
        });
        return;
      }

      if (message.type === "typing") {
        broadcast(room, {
          type: "typing",
          peerId: session.id,
          name: session.name,
          active: Boolean(message.active),
        }, session.id);
        return;
      }

      if (message.type === "member-status") {
        const status = sanitizeMemberStatus(message);
        session.playback = status.playback;
        session.network = status.network;
        session.statusAt = Date.now();
        saveHistory(session);
        broadcast(room, { type: "member-status", peerId: session.id, ...status }, session.id);
        return;
      }

      if (message.type === "voice-state") {
        const wasEnabled = session.voiceEnabled;
        session.voiceEnabled = Boolean(message.enabled);
        session.voiceMuted = session.voiceEnabled && Boolean(message.muted);
        broadcast(room, {
          type: "voice-state",
          peerId: session.id,
          enabled: session.voiceEnabled,
          muted: session.voiceMuted,
        });
        if (wasEnabled !== session.voiceEnabled) appendVoiceEvent(room, session, session.voiceEnabled);
      }
    });

    socket.on("error", (error) => {
      logger.warn("WebSocket client error", { error: error.message, remoteAddress: request.socket.remoteAddress });
    });
    socket.on("close", () => leaveRoom(session));
  });

  wss.on("error", (error) => logger.error("WebSocket server error", { error: error.message }));

  const syncInterval = setInterval(() => {
    for (const room of rooms.values()) {
      if (!room.clients.size || !room.state.mediaUrl) continue;
      const state = currentState(room);
      if (!state.paused && Date.now() > room.state.executeAt + 200) {
        const issue = [...room.clients.values()].map((client) => memberSyncIssue(client, state, Date.now())).find(Boolean);
        if (issue) pauseForSync(room, issue);
      }
      broadcast(room, { type: "sync-state", state: { ...currentState(room), syncWaiting: room.syncWaiting, validUntil: Date.now() + SYNC_LEASE_MS }, hostId: room.hostId });
    }
  }, SYNC_TICK_MS);
  syncInterval.unref();

  const heartbeatInterval = setInterval(() => {
    for (const room of rooms.values()) if (room.clients.size) persistRoom(room);
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, config.heartbeatIntervalMs);
  heartbeatInterval.unref();

  function getStats() {
    return { rooms: [...rooms.values()].filter(room => room.clients.size).length, clients: wss.clients.size };
  }

  function listRooms() {
    return [...rooms.values()].filter(room => room.clients.size).map((room) => ({
      id: room.id,
      hostId: room.hostId,
      members: [...room.clients.values()].map((client) => ({ id: client.id, name: client.name })),
      mediaTitle: room.state.mediaTitle,
      createdAt: room.createdAt,
    }));
  }

  function closeRoom(id) {
    const room = rooms.get(id);
    if (!room) return false;
    for (const client of room.clients.values()) {
      saveHistory(client, true);
      send(client.socket, { type: "room-closed" });
      client.socket.close(1000, "Room closed by admin");
      client.roomId = null;
      client.id = null;
    }
    rooms.delete(id);
    persistRoom(room, true);
    return true;
  }

  function endSession(key) {
    if (!key) return;
    for (const socket of wss.clients) if (socket.sessionKey === key) {
      send(socket, { type: "account-logout" });
      socket.close(4001, "Signed out");
    }
  }

  function mediaInUse(url) {
    return [...rooms.values()].some(room => room.clients.size && (room.state.mediaUrl === url || room.playlist.some(item => item.url === url)));
  }

  async function close() {
    for (const room of rooms.values()) { room.persistedSignature = ""; persistRoom(room); }
    clearInterval(heartbeatInterval);
    clearInterval(syncInterval);
    if (wss.clients.size === 0) {
      await new Promise((resolve) => wss.close(() => resolve()));
      await Promise.all(roomWrites.values());
      return;
    }

    for (const socket of wss.clients) socket.close(1001, "Server shutting down");
    await new Promise((resolve) => {
      const forceClose = setTimeout(() => {
        for (const socket of wss.clients) socket.terminate();
      }, 1000);
      forceClose.unref();
      wss.close(() => {
        clearTimeout(forceClose);
        resolve();
      });
    });
    await Promise.all(roomWrites.values());
  }

  return { close, getStats, listRooms, closeRoom, preparePlaylist, restoreRooms, endSession, mediaInUse };
}
