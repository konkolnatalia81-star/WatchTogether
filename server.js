const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 1e6,
  pingInterval: 25000,
  pingTimeout: 20000
});
const PORT = Number(process.env.PORT) || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOM_CAPACITY = 12;
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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

function publicRoom(room) {
  return {
    code: room.code,
    name: room.name,
    ownerId: room.ownerId,
    participants: [...room.members.values()].map(member => ({
      id: member.id,
      name: member.name,
      isOwner: member.id === room.ownerId
    })),
    media: room.media,
    playback: room.playback
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
}

function leaveRoom(socket) {
  const code = socketRoom.get(socket.id);
  if (!code) return;

  const room = rooms.get(code);
  socketRoom.delete(socket.id);
  socket.leave(code);

  if (!room) return;

  const member = room.members.get(socket.id);
  room.members.delete(socket.id);

  if (room.members.size === 0) {
    rooms.delete(code);
    return;
  }

  if (room.ownerId === socket.id) {
    const nextOwner = room.members.keys().next().value;
    room.ownerId = nextOwner || room.ownerId;
  }

  socket.to(code).emit("voice:peer-left", { id: socket.id });
  emitRoom(room);
  if (member) {
    socket.to(code).emit("chat:system", `${member.name} покинул(а) комнату`);
  }
}

function isOwner(socket, room) {
  return Boolean(room && room.ownerId === socket.id && room.members.has(socket.id));
}

function validYoutubeUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const validHost = host === "youtu.be" || host === "www.youtube.com" || host === "youtube.com" || host === "m.youtube.com";
    if (url.protocol !== "https:" || !validHost) return false;
    const id = host === "youtu.be"
      ? url.pathname.slice(1).split("/")[0]
      : url.searchParams.get("v") || url.pathname.split("/")[2];
    return /^[\w-]{11}$/.test(id || "");
  } catch {
    return false;
  }
}

function cleanMedia(media) {
  if (!media || !["file", "youtube"].includes(media.type)) return null;

  const url = String(media.url || "").trim();
  if (media.type === "youtube" && !validYoutubeUrl(url)) return null;
  if (media.type === "file" && !/^\/uploads\/[a-f0-9]{32}(?:\.[\w-]{1,12})?$/i.test(url)) return null;

  return {
    type: media.type,
    url,
    title: String(media.title || "Видео").replace(/[<>]/g, "").slice(0, 120) || "Видео"
  };
}

app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не получен." });

  res.status(201).json({
    url: `/uploads/${req.file.filename}`,
    name: path.basename(req.file.originalname).slice(0, 120),
    size: req.file.size
  });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "WatchTogether" }));

app.get("/api/voice-config", (_req, res) => {
  const iceServers = [{ urls: process.env.STUN_URL || "stun:stun.l.google.com:19302" }];

  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(",").map(value => value.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL
    });
  }

  res.setHeader("Cache-Control", "no-store");
  res.json({ iceServers });
});

io.on("connection", socket => {
  socket.on("room:create", (payload = {}, reply = () => {}) => {
    leaveRoom(socket);

    let code;
    try {
      code = makeCode();
    } catch {
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

    room.members.set(socket.id, { id: socket.id, name: cleanName(payload.name) });
    rooms.set(code, room);
    socket.join(code);
    socketRoom.set(socket.id, code);
    reply({ ok: true, room: publicRoom(room) });
  });

  socket.on("room:join", (payload = {}, reply = () => {}) => {
    const normalized = String(payload.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (normalized.length !== 6) {
      return reply({ ok: false, error: "Код должен содержать 6 символов." });
    }

    const room = rooms.get(normalized);
    if (!room) return reply({ ok: false, error: "Группа не найдена. Проверь код." });
    if (room.members.has(socket.id)) return reply({ ok: true, room: publicRoom(room) });
    if (room.members.size >= ROOM_CAPACITY) {
      return reply({ ok: false, error: `В комн��те может быть не более ${ROOM_CAPACITY} участников.` });
    }

    leaveRoom(socket);

    const name = cleanName(payload.name);
    room.members.set(socket.id, { id: socket.id, name });
    socket.join(normalized);
    socketRoom.set(socket.id, normalized);

    reply({ ok: true, room: publicRoom(room) });
    emitRoom(room);
    socket.to(normalized).emit("chat:system", `${name} присоединился(ась) к комнате`);
  });

  socket.on("room:leave", () => leaveRoom(socket));

  socket.on("chat:send", (payload = {}) => {
    const code = socketRoom.get(socket.id);
    const room = rooms.get(code);
    const member = room?.members.get(socket.id);
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
    const currentTime = Number.isFinite(requested)
      ? Math.min(Math.max(0, requested), 7 * 24 * 60 * 60)
      : room.playback.currentTime;

    const wasPlaying = room.playback.playing;
    const now = Date.now();
    const baseTime = wasPlaying
      ? room.playback.currentTime + (now - room.playback.updatedAt) / 1000
      : room.playback.currentTime;

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

  socket.on("disconnect", () => leaveRoom(socket));
});

app.use((err, _req, res, _next) => {
  console.error(err.message);

  if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Размер файла превышает 500 МБ." });
  }

  res.status(400).json({ error: err.message || "Ошибка запроса." });
});

server.listen(PORT, () => {
  console.log(`WatchTogether запущен на порту ${PORT}`);
});
