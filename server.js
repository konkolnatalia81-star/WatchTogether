const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const AWS = require("aws-sdk");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingInterval: 25000,
  pingTimeout: 20000
});

const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;
const ROOM_CAPACITY = 12;
const RECONNECT_GRACE_MS = 25000;
const STORAGE_MODE = process.env.AWS_S3_BUCKET && process.env.AWS_REGION && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY ? "s3" : "local";

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const s3 = STORAGE_MODE === "s3" ? new AWS.S3({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  signatureVersion: "v4"
}) : null;

app.disable("x-powered-by");
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: "1h" }));
app.use("/uploads", express.static(UPLOAD_DIR, {
  acceptRanges: true,
  fallthrough: false,
  setHeaders(res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
}));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12).replace(/[^.\w-]/g, "");
    cb(null, `${crypto.randomBytes(16).toString("hex")}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/^video\/[\w.+-]+$/i.test(file.mimetype)) return cb(null, true);
    cb(new Error("Можно загружать только видеофайлы."));
  }
});

const rooms = new Map();
const socketRoom = new Map();
const sessionRegistry = new Map();
const mediaLibrary = new Map();
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const code = Array.from({ length: 6 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join("");
    if (!rooms.has(code)) return code;
  }
  throw new Error("Не удалось сгенерировать код комнаты.");
}

function cleanName(value) {
  return String(value || "Гость").replace(/[<>]/g, "").trim().slice(0, 24) || "Гость";
}

function cleanRoomName(value) {
  return String(value || "Комната просмотра").replace(/[<>]/g, "").trim().slice(0, 50) || "Комната просмотра";
}

function validYoutubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const validHost = host === "youtu.be" || host === "www.youtube.com" || host === "youtube.com" || host === "m.youtube.com";
    if (url.protocol !== "https:" || !validHost) return false;
    const id = host === "youtu.be" ? url.pathname.slice(1).split("/")[0] : url.searchParams.get("v") || url.pathname.split("/")[2];
    return /^[\w-]{11}$/.test(id || "");
  } catch {
    return false;
  }
}

function cleanMedia(media) {
  if (!media || !["file", "youtube"].includes(media.type)) return null;
  const url = String(media.url || "").trim();
  if (!url) return null;
  if (media.type === "youtube" && !validYoutubeUrl(url)) return null;
  if (media.type === "file" && !/^\/uploads\/[A-Za-z0-9._-]+$/i.test(url) && !/^https?:\/\//i.test(url)) return null;

  return {
    type: media.type,
    url,
    id: media.id || null,
    title: String(media.title || "Видео").replace(/[<>]/g, "").slice(0, 120) || "Видео"
  };
}

function publicRoom(room) {
  return {
    code: room.code,
    name: room.name,
    ownerId: room.ownerId,
    participants: [...room.members.values()].map((member) => ({
      id: member.id,
      name: member.name,
      isOwner: member.id === room.ownerId,
      offline: Boolean(member.offline)
    })),
    media: room.media,
    playback: room.playback
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
}

function findMemberBySession(room, sessionId) {
  if (!sessionId || !room) return null;
  return [...room.members.values()].find((member) => member.sessionId === sessionId) || null;
}

function assignSessionRoom(sessionId, roomCode, socketId, name, isOwner = false) {
  if (!sessionId) return;
  sessionRegistry.set(sessionId, { roomCode, socketId, name, isOwner, updatedAt: Date.now() });
}

function clearSession(sessionId) {
  if (!sessionId) return;
  sessionRegistry.delete(sessionId);
}

function isOwner(socket, room) {
  return Boolean(room && room.ownerId === socket.id && room.members.has(socket.id));
}

function transferOwnership(room) {
  if (!room || room.members.size === 0) return;
  if (!room.members.has(room.ownerId)) room.ownerId = room.members.keys().next().value;
}

function removeMember(socket, room, options = {}) {
  const { force = false, explicit = false } = options;
  if (!room || !socket) return;
  const sessionId = socket.data?.sessionId || null;
  const member = room.members.get(socket.id) || findMemberBySession(room, sessionId);
  if (!member) return;

  if (force || explicit) {
    room.members.delete(member.id);
    if (socket.data?.sessionId) clearSession(socket.data.sessionId);
    if (room.members.size === 0) {
      rooms.delete(room.code);
      return;
    }
    transferOwnership(room);
    socket.to(room.code).emit("chat:system", `${member.name} покинул(а) комнату`);
    emitRoom(room);
    return;
  }

  member.offline = true;
  assignSessionRoom(sessionId, room.code, member.id, member.name, room.ownerId === member.id);
  emitRoom(room);
}

function leaveRoom(socket, options = {}) {
  const { force = false, explicit = false } = options;
  const code = socketRoom.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  socketRoom.delete(socket.id);
  socket.leave(code);
  if (!room) return;

  if (force || explicit) {
    removeMember(socket, room, { force: true, explicit });
    return;
  }

  const member = room.members.get(socket.id) || findMemberBySession(room, socket.data?.sessionId);
  if (!member) return;
  member.offline = true;
  assignSessionRoom(socket.data?.sessionId, code, member.id, member.name, room.ownerId === member.id);
  io.to(code).emit("room:update", publicRoom(room));
  if (member.id !== socket.id) socket.to(code).emit("chat:system", `${member.name} временно отключился(ась)`);
}

async function persistUploadedFile(file) {
  const filename = file.filename;
  const originalName = path.basename(file.originalname).slice(0, 120);

  if (STORAGE_MODE === "s3" && s3) {
    const key = `uploads/${filename}`;
    const body = fs.readFileSync(file.path);
    const publicBase = process.env.AWS_PUBLIC_BASE_URL || `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;
    const url = `${publicBase.replace(/\/$/, "")}/${key}`;
    await s3.putObject({
      Bucket: process.env.AWS_S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: file.mimetype || "application/octet-stream",
      ACL: "public-read"
    }).promise();
    fs.unlinkSync(file.path);
    return {
      url,
      name: originalName,
      size: file.size,
      mime: file.mimetype,
      storage: "s3"
    };
  }

  return {
    url: `/uploads/${filename}`,
    name: originalName,
    size: file.size,
    mime: file.mimetype,
    storage: "local"
  };
}

app.post("/api/upload", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не получен." });

  try {
    const media = await persistUploadedFile(req.file);
    const fileId = crypto.randomUUID();
    const record = {
      id: fileId,
      type: "file",
      url: media.url,
      title: media.name,
      size: media.size,
      mime: media.mime,
      createdAt: Date.now(),
      storage: media.storage
    };
    mediaLibrary.set(fileId, record);

    res.status(201).json({
      id: fileId,
      url: media.url,
      name: media.name,
      size: media.size,
      mime: media.mime
    });
  } catch (error) {
    console.error("Upload failed:", error);
    res.status(500).json({ error: "Не удалось сохранить видео." });
  }
});

app.get("/api/library", (_req, res) => {
  const items = [...mediaLibrary.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ items });
});

app.delete("/api/library/:id", async (req, res) => {
  const existing = mediaLibrary.get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Файл не найден." });

  try {
    if (existing.storage === "s3" && s3 && process.env.AWS_S3_BUCKET) {
      const key = new URL(existing.url).pathname.replace(/^\//, "");
      await s3.deleteObject({ Bucket: process.env.AWS_S3_BUCKET, Key: key }).promise();
    } else {
      const target = path.join(UPLOAD_DIR, path.basename(existing.url));
      if (fs.existsSync(target)) fs.unlinkSync(target);
    }
  } catch (error) {
    console.warn("Library delete file failed", error.message);
  }

  mediaLibrary.delete(req.params.id);
  res.json({ ok: true });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "WatchTogether", storage: STORAGE_MODE }));

app.get("/api/voice-config", (_req, res) => {
  const iceServers = [{ urls: process.env.STUN_URL || "stun:stun.l.google.com:19302" }];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(",").map((value) => value.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({ iceServers });
});

io.on("connection", (socket) => {
  socket.data.sessionId = socket.handshake.auth?.sessionId || socket.handshake.query?.sessionId || crypto.randomUUID();

  socket.on("room:create", (payload = {}, reply = () => {}) => {
    const sessionId = String(payload.sessionId || socket.data.sessionId || crypto.randomUUID());
    socket.data.sessionId = sessionId;
    leaveRoom(socket, { force: true });

    let code;
    try { code = makeCode(); } catch {
      return reply({ ok: false, error: "Не удалось создать комнату. Попробуй ещё раз." });
    }

    const room = {
      code,
      name: cleanRoomName(payload.roomName),
      ownerId: socket.id,
      members: new Map(),
      media: null,
      playback: { playing: false, currentTime: 0, updatedAt: Date.now() }
    };

    const member = { id: socket.id, name: cleanName(payload.name), sessionId, offline: false };
    room.members.set(socket.id, member);
    rooms.set(code, room);
    socket.join(code);
    socketRoom.set(socket.id, code);
    assignSessionRoom(sessionId, code, socket.id, member.name, true);
    reply({ ok: true, room: publicRoom(room) });
  });

  socket.on("room:join", (payload = {}, reply = () => {}) => {
    const sessionId = String(payload.sessionId || socket.data.sessionId || crypto.randomUUID());
    socket.data.sessionId = sessionId;
    const normalized = String(payload.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalized.length !== 6) return reply({ ok: false, error: "Код должен содержать 6 символов." });

    const room = rooms.get(normalized);
    if (!room) return reply({ ok: false, error: "Группа не найдена. Проверь код." });

    const savedSession = sessionRegistry.get(sessionId);
    if (savedSession && savedSession.roomCode === normalized) {
      const existingMember = findMemberBySession(room, sessionId);
      if (existingMember && existingMember.id !== socket.id) {
        room.members.delete(existingMember.id);
        socketRoom.delete(existingMember.id);
      }
    }

    if (room.members.has(socket.id)) {
      const member = room.members.get(socket.id);
      member.name = cleanName(payload.name || member.name);
      member.sessionId = sessionId;
      member.offline = false;
      assignSessionRoom(sessionId, normalized, socket.id, member.name, room.ownerId === socket.id);
      reply({ ok: true, room: publicRoom(room) });
      return;
    }

    if (room.members.size >= ROOM_CAPACITY) return reply({ ok: false, error: `В комнате может быть не более ${ROOM_CAPACITY} участников.` });

    leaveRoom(socket, { force: true });

    const name = cleanName(payload.name);
    const member = { id: socket.id, name, sessionId, offline: false };
    room.members.set(socket.id, member);
    socket.join(normalized);
    socketRoom.set(socket.id, normalized);
    assignSessionRoom(sessionId, normalized, socket.id, name, room.ownerId === socket.id);

    reply({ ok: true, room: publicRoom(room) });
    emitRoom(room);
    socket.to(normalized).emit("chat:system", `${name} присоединился(ась) к комнате`);
  });

  socket.on("room:leave", (payload = {}) => {
    const explicit = Boolean(payload.explicit === true || payload.leave === true);
    const code = socketRoom.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const member = room.members.get(socket.id) || findMemberBySession(room, socket.data?.sessionId);
    if (explicit) {
      if (member) socket.to(code).emit("chat:system", `${member.name} вышел(а) из комнаты`);
      removeMember(socket, room, { force: true, explicit: true });
      clearSession(socket.data?.sessionId);
      socketRoom.delete(socket.id);
      return;
    }

    leaveRoom(socket, { force: false, explicit: false });
  });

  socket.on("chat:send", (payload = {}) => {
    const code = socketRoom.get(socket.id);
    const room = rooms.get(code);
    const member = room?.members.get(socket.id) || findMemberBySession(room, socket.data?.sessionId);
    const text = String(payload.text || "").trim().slice(0, 1000);
    if (!member || !text) return;
    io.to(code).emit("chat:message", {
      id: crypto.randomUUID(),
      name: member.name,
      text,
      time: new Date().toISOString(),
      isOwner: socket.id === room.ownerId
    });
  });

  socket.on("media:set", (payload = {}) => {
    const room = rooms.get(socketRoom.get(socket.id));
    if (!isOwner(socket, room)) return;
    const media = cleanMedia(payload.media);
    if (!media) return socket.emit("app:error", "Ссылка на видео недействительна.");
    room.media = media;
    room.playback = { playing: false, currentTime: 0, updatedAt: Date.now() };
    emitRoom(room);
    io.to(room.code).emit("playback:update", room.playback);
  });

  socket.on("playback:control", (payload = {}) => {
    const room = rooms.get(socketRoom.get(socket.id));
    if (!isOwner(socket, room) || !room.media) return;
    const { action } = payload;
    if (!["play", "pause", "seek"].includes(action)) return;
    const requested = Number(payload.currentTime);
    const currentTime = Number.isFinite(requested) ? Math.min(Math.max(0, requested), 7 * 24 * 60 * 60) : room.playback.currentTime;
    const wasPlaying = room.playback.playing;
    const now = Date.now();
    const baseTime = wasPlaying ? room.playback.currentTime + (now - room.playback.updatedAt) / 1000 : room.playback.currentTime;

    room.playback = {
      playing: action === "play" ? true : action === "pause" ? false : wasPlaying,
      currentTime: action === "seek" && payload.currentTime == null ? baseTime : currentTime,
      updatedAt: now
    };

    io.to(room.code).emit("playback:update", room.playback);
  });

  socket.on("voice:signal", (payload = {}) => {
    const room = rooms.get(socketRoom.get(socket.id));
    const target = String(payload.to || "");
    if (!room?.members.has(socket.id) || !room.members.has(target) || !payload.data || typeof payload.data !== "object") return;
    io.to(target).emit("voice:signal", { from: socket.id, data: payload.data });
  });

  socket.on("voice:ready", () => {
    const code = socketRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room?.members.has(socket.id)) return;
    socket.to(code).emit("voice:peer-joined", { id: socket.id });
  });

  socket.on("disconnect", () => {
    const sessionId = socket.data?.sessionId;
    const code = socketRoom.get(socket.id);
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    const member = room.members.get(socket.id) || findMemberBySession(room, sessionId);
    if (!member) return;

    member.offline = true;
    assignSessionRoom(sessionId, code, member.id, member.name, room.ownerId === member.id);
    socket.to(code).emit("voice:peer-left", { id: socket.id });
    emitRoom(room);
    socket.to(code).emit("chat:system", `${member.name} временно отключился(ась)`);

    const timeout = setTimeout(() => {
      const liveRoom = rooms.get(code);
      if (!liveRoom) return;
      const currentMember = findMemberBySession(liveRoom, sessionId);
      if (!currentMember) return;
      if (liveRoom.members.has(currentMember.id) && !liveRoom.members.has(socket.id)) {
        const nextOwner = liveRoom.members.keys().next().value;
        if (liveRoom.ownerId === currentMember.id) liveRoom.ownerId = nextOwner;
        liveRoom.members.delete(currentMember.id);
        emitRoom(liveRoom);
        io.to(code).emit("chat:system", `${currentMember.name} покинул(а) комнату`);
      }
    }, RECONNECT_GRACE_MS);

    socket.data._disconnectTimer = timeout;
  });
});

app.use((err, _req, res, _next) => {
  console.error(err.message);
  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Размер файла превышает 500 МБ." });
  }
  res.status(400).json({ error: err.message || "Ошибка запроса." });
});

server.listen(PORT, () => console.log(`WatchTogether запущен на порту ${PORT}`));

module.exports = { app, server, rooms, mediaLibrary, STORAGE_MODE };
