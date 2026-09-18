import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";

export function attachRealtimeServer(server, config, logger) {
  const rooms = new Map();
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

  function createRoom(id) {
    const room = {
      id,
      hostId: null,
      clients: new Map(),
      sequence: 0,
      state: {
        mediaUrl: "",
        mediaTitle: "",
        paused: true,
        position: 0,
        executeAt: Date.now(),
      },
      messages: [],
    };
    rooms.set(id, room);
    return room;
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

    return {
      playback: {
        mediaUrl: String(playback.mediaUrl || "").slice(0, 2048),
        position: Math.max(0, Number(playback.position) || 0),
        ready: Boolean(playback.ready),
        buffering: Boolean(playback.buffering),
        bufferedAhead: Math.max(0, Math.min(300, Number(playback.bufferedAhead) || 0)),
        loadedPercent: Math.max(0, Math.min(100, Number(playback.loadedPercent) || 0)),
      },
      network: {
        latencyMs: Number.isFinite(latency) ? Math.max(0, Math.min(10000, Math.round(latency))) : null,
        packetLoss: Number.isFinite(packetLoss) ? Math.max(0, Math.min(100, packetLoss)) : null,
        connectionState: connectionStates.has(network.connectionState) ? network.connectionState : "new",
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
    };
    return { ...state, executeAt: state.serverTime };
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

    const wasHost = room.hostId === session.id;
    room.clients.delete(session.id);
    broadcast(room, { type: "peer-left", peerId: session.id });
    if (session.voiceEnabled) appendVoiceEvent(room, session, false);
    if (wasHost) promoteNextHost(room);

    if (room.clients.size === 0) rooms.delete(room.id);
    session.id = null;
    session.roomId = null;
  }

  wss.on("connection", (socket, request) => {
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
    };

    socket.on("message", (buffer) => {
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
        leaveRoom(session);
        const roomId = sanitizeRoomId(message.roomId);
        if (!roomId) return;

        const room = rooms.get(roomId) || createRoom(roomId);
        session.id = randomUUID();
        session.roomId = roomId;
        session.name = sanitizeName(message.name);
        room.clients.set(session.id, session);
        if (!room.hostId) room.hostId = session.id;

        send(socket, {
          type: "joined",
          clientId: session.id,
          hostId: room.hostId,
          roomId,
          members: [...room.clients.values()].map(publicMember),
          messages: room.messages,
          state: currentState(room),
        });
        broadcast(room, { type: "peer-joined", peer: publicMember(session) }, session.id);
        appendSystemMessage(room, `${session.name}加入了房间`);
        return;
      }

      const room = rooms.get(session.roomId);
      if (!room || !session.id) return;

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

        const command = message.command;
        if (!command || command.sequence <= room.sequence) return;
        room.sequence = command.sequence;
        room.state = {
          mediaUrl: String(command.mediaUrl || room.state.mediaUrl).slice(0, 2048),
          mediaTitle: String(command.mediaTitle || room.state.mediaTitle).slice(0, 120),
          paused: Boolean(command.paused),
          position: Math.max(0, Number(command.position) || 0),
          executeAt: Number(command.executeAt) || Date.now(),
        };
        broadcast(room, { type: "sync-command", command });
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

  const heartbeatInterval = setInterval(() => {
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
    return { rooms: rooms.size, clients: wss.clients.size };
  }

  async function close() {
    clearInterval(heartbeatInterval);
    if (wss.clients.size === 0) {
      await new Promise((resolve) => wss.close(() => resolve()));
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
  }

  return { close, getStats };
}
