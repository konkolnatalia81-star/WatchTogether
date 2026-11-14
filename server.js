const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12).replace(/[^.\w-]/g, "");
    cb(null, `${crypto.randomBytes(12).toString("hex")}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("video/")) return cb(null, true);
    cb(new Error("Можно загружать только видеофайлы."));
  }
});

const rooms = new Map();
const socketRoom = new Map();

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function publicRoom(room) {
  return {
    code: room.code,
    name: room.name,
    ownerId: room.ownerId,
    participants: [...room.members.values()].map(m => ({
      id: m.id, name: m.name, isOwner: m.id === room.ownerId
    })),
    media: room.media,
    playback: room.playback
  };
}
function emitRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
}
function cleanName(value) {
  return String(value || "Гость").trim().replace(/[<>]/g, "").slice(0, 24) || "Гость";
}
function leaveRoom(socket) {
  const code = socketRoom.get(socket.id);
  if (!code) return;
  const room = rooms.get(code);
  socketRoom.delete(socket.id);
  socket.leave(code);
  if (!room) return;
  room.members.delete(socket.id);
  if (room.ownerId === socket.id) {
    const next = room.members.keys().next();
    if (!next.done) room.ownerId = next.value;
    else {
      rooms.delete(code);
      return;
    }
  }
  if (room.members.size === 0) rooms.delete(code);
  else emitRoom(room);
}
function isOwner(socket, room) {
  return room && room.ownerId === socket.id;
}

app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не получен." });
  res.json({
    url: `/uploads/${req.file.filename}`,
    name: req.file.originalname.slice(0, 120),
    size: req.file.size
  });
});
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "WatchTogether" }));

io.on("connection", socket => {
  socket.on("room:create", ({ name, roomName } = {}, reply = () => {}) => {
    leaveRoom(socket);
    const code = makeCode();
    const room = {
      code, name: String(roomName || "Комната просмотра").trim().slice(0, 50) || "Комната просмотра",
      ownerId: socket.id,
      members: new Map(),
      media: null,
      playback: { playing: false, currentTime: 0, updatedAt: Date.now() }
    };
    room.members.set(socket.id, { id: socket.id, name: cleanName(name) });
    rooms.set(code, room);
    socket.join(code);
    socketRoom.set(socket.id, code);
    reply({ ok: true, room: publicRoom(room) });
  });

  socket.on("room:join", ({ code, name } = {}, reply = () => {}) => {
    leaveRoom(socket);
    const normalized = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
    const room = rooms.get(normalized);
    if (!room) return reply({ ok: false, error: "Группа не найдена. Проверь код." });
    if (room.members.size >= 12) return reply({ ok: false, error: "В этой версии максимум 12 участников." });
    room.members.set(socket.id, { id: socket.id, name: cleanName(name) });
    socket.join(normalized);
    socketRoom.set(socket.id, normalized);
    reply({ ok: true, room: publicRoom(room) });
    emitRoom(room);
    socket.to(normalized).emit("chat:system", `${cleanName(name)} присоединился(ась) к группе`);
  });

  socket.on("room:leave", () => leaveRoom(socket));

  socket.on("chat:send", ({ text } = {}) => {
    const code = socketRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return;
    const body = String(text || "").trim().slice(0, 1000);
    if (!body) return;
    const member = room.members.get(socket.id);
    io.to(code).emit("chat:message", {
      id: crypto.randomUUID(), name: member.name, text: body,
      time: new Date().toISOString(), isOwner: socket.id === room.ownerId
    });
  });

  socket.on("media:set", ({ media } = {}) => {
    const room = rooms.get(socketRoom.get(socket.id));
    if (!isOwner(socket, room)) return;
    if (!media || !["file", "youtube"].includes(media.type)) return;
    room.media = {
      type: media.type,
      url: String(media.url || "").slice(0, 2000),
      title: String(media.title || "Видео").slice(0, 120)
    };
    room.playback = { playing: false, currentTime: 0, updatedAt: Date.now() };
    emitRoom(room);
  });

  socket.on("playback:control", ({ action, currentTime } = {}) => {
    const room = rooms.get(socketRoom.get(socket.id));
    if (!isOwner(socket, room) || !room.media) return;
    const allowed = ["play", "pause", "seek"];
    if (!allowed.includes(action)) return;
    const time = Number.isFinite(Number(currentTime)) ? Math.max(0, Number(currentTime)) : room.playback.currentTime;
    room.playback = {
      playing: action === "play" ? true : action === "pause" ? false : room.playback.playing,
      currentTime: time,
      updatedAt: Date.now()
    };
    io.to(room.code).emit("playback:update", room.playback);
  });

  // WebRTC signaling for small rooms (mesh). A production-scale service should use an SFU.
  socket.on("voice:signal", ({ to, data } = {}) => {
    const code = socketRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room || !room.members.has(to) || !room.members.has(socket.id)) return;
    io.to(to).emit("voice:signal", { from: socket.id, data });
  });
  socket.on("voice:ready", () => {
    const code = socketRoom.get(socket.id);
    const room = rooms.get(code);
    if (!room) return;
    socket.to(code).emit("voice:peer-joined", { id: socket.id });
  });
  socket.on("disconnect", () => leaveRoom(socket));
});

app.use((err, _req, res, _next) => {
  console.error(err.message);
  res.status(400).json({ error: err.message || "Ошибка запроса." });
});

server.listen(PORT, () => console.log(`WatchTogether запущен: http://localhost:${PORT}`));
