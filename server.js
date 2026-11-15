const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6, pingInterval: 25000, pingTimeout: 30000 });
const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, "uploads");
const LIBRARY_FILE = path.join(DATA_DIR, "library.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const ROOM_CAPACITY = 12;
const RECONNECT_GRACE_MS = 2 * 60 * 1000;
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

app.disable("x-powered-by");
app.use(express.static(PUBLIC_DIR, { etag: true, maxAge: "1h" }));
app.use("/uploads", express.static(UPLOAD_DIR, { acceptRanges: true, fallthrough: false, setHeaders(res) { res.setHeader("X-Content-Type-Options", "nosniff"); } }));

let library = [];
try { library = JSON.parse(fs.readFileSync(LIBRARY_FILE, "utf8")); if (!Array.isArray(library)) library = []; } catch { library = []; }
function saveLibrary() {
  const temp = LIBRARY_FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(library, null, 2));
  fs.renameSync(temp, LIBRARY_FILE);
}
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12).replace(/[^.\w-]/g, "");
    cb(null, crypto.randomBytes(16).toString("hex") + ext);
  }
});
const upload = multer({
  storage, limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => /^video\/[\w.+-]+$/i.test(file.mimetype) ? cb(null, true) : cb(new Error("Можно загружать только видеофайлы."))
});
const rooms = new Map();
const socketRoom = new Map();
const socketMember = new Map();
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function makeCode() {
  for (let i = 0; i < 30; i++) {
    const code = Array.from({length: 6}, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join("");
    if (!rooms.has(code)) return code;
  }
  throw new Error("Не удалось создать код комнаты.");
}
function cleanName(v) { return String(v || "Гость").replace(/[<>]/g, "").trim().slice(0, 24) || "Гость"; }
function cleanRoomName(v) { return String(v || "Комната просмотра").replace(/[<>]/g, "").trim().slice(0, 50) || "Комната просмотра"; }
function cleanSession(v) { return /^[a-f0-9-]{20,80}$/i.test(String(v || "")) ? String(v) : null; }
function publicRoom(room) {
  return {
    code: room.code, name: room.name, ownerId: room.ownerId,
    participants: [...room.members.values()].filter(m => m.connected).map(m => ({ id: m.sessionId, name: m.name, isOwner: m.sessionId === room.ownerId })),
    media: room.media, playback: room.playback
  };
}
function emitRoom(room) { io.to(room.code).emit("room:update", publicRoom(room)); }
function detachSocket(socket) {
  const code = socketRoom.get(socket.id);
  const sessionId = socketMember.get(socket.id);
  socketRoom.delete(socket.id); socketMember.delete(socket.id);
  if (!code || !sessionId) return;
  const room = rooms.get(code); if (!room) return;
  const member = room.members.get(sessionId); if (!member) return;
  member.connected = false; member.socketId = null; member.disconnectedAt = Date.now();
  socket.leave(code);
  socket.to(code).emit("voice:peer-left", { id: sessionId });
  emitRoom(room);
  member.expiry = setTimeout(() => {
    const latest = rooms.get(code);
    const old = latest?.members.get(sessionId);
    if (!latest || !old || old.connected || Date.now() - old.disconnectedAt < RECONNECT_GRACE_MS) return;
    latest.members.delete(sessionId);
    if (latest.ownerId === sessionId) latest.ownerId = latest.members.keys().next().value || null;
    if (!latest.members.size) rooms.delete(code);
    else { emitRoom(latest); io.to(code).emit("chat:system", `${old.name} покинул(а) комнату`); }
  }, RECONNECT_GRACE_MS);
}
function leaveRoom(socket) {
  const code = socketRoom.get(socket.id), sessionId = socketMember.get(socket.id);
  if (!code || !sessionId) return;
  const room = rooms.get(code), member = room?.members.get(sessionId);
  socketRoom.delete(socket.id); socketMember.delete(socket.id); socket.leave(code);
  if (!room || !member) return;
  clearTimeout(member.expiry);
  room.members.delete(sessionId);
  if (room.ownerId === sessionId) room.ownerId = room.members.keys().next().value || null;
  socket.to(code).emit("voice:peer-left", { id: sessionId });
  if (!room.members.size) rooms.delete(code);
  else { emitRoom(room); socket.to(code).emit("chat:system", `${member.name} покинул(а) комнату`); }
}
function isOwner(socket, room) {
  const sid = socketMember.get(socket.id);
  return Boolean(room && sid && room.ownerId === sid && room.members.get(sid)?.connected);
}
function validYoutubeUrl(value) {
  try {
    const u = new URL(value), h = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || !["youtu.be","youtube.com","www.youtube.com","m.youtube.com"].includes(h)) return false;
    const id = h === "youtu.be" ? u.pathname.slice(1).split("/")[0] : u.searchParams.get("v") || u.pathname.split("/")[2];
    return /^[\w-]{11}$/.test(id || "");
  } catch { return false; }
}
function cleanMedia(m) {
  if (!m || !["file","youtube"].includes(m.type)) return null;
  const url = String(m.url || "").trim();
  if (m.type === "youtube" && !validYoutubeUrl(url)) return null;
  if (m.type === "file" && !/^\/uploads\/[a-f0-9]{32}(?:\.[\w-]{1,12})?$/i.test(url)) return null;
  return { type: m.type, url, title: String(m.title || "Видео").replace(/[<>]/g, "").slice(0, 120) || "Видео" };
}
function memberFor(socket) {
  const room = rooms.get(socketRoom.get(socket.id));
  return room?.members.get(socketMember.get(socket.id));
}
app.post("/api/upload", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).json({error:"Файл не получен."});
  const item = { id: crypto.randomUUID(), url: `/uploads/${req.file.filename}`, name: path.basename(req.file.originalname).slice(0,120), size: req.file.size, createdAt: new Date().toISOString() };
  library.unshift(item); saveLibrary();
  res.status(201).json(item);
});
app.get("/api/library", (_req,res) => res.json({ items: library.map(({id,url,name,size,createdAt}) => ({id,url,name,size,createdAt})) }));
app.delete("/api/library/:id", (req,res) => {
  const index = library.findIndex(item => item.id === req.params.id);
  if (index < 0) return res.status(404).json({error:"Видео не найдено."});
  const [item] = library.splice(index,1);
  const filename = path.basename(item.url);
  try { fs.unlinkSync(path.join(UPLOAD_DIR, filename)); } catch {}
  saveLibrary(); res.json({ok:true});
});
app.get("/api/health", (_req,res) => res.json({ok:true,service:"WatchTogether"}));
app.get("/api/voice-config", (_req,res) => {
  const iceServers = [{urls: process.env.STUN_URL || "stun:stun.l.google.com:19302"}];
  if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) iceServers.push({urls:process.env.TURN_URL.split(",").map(x=>x.trim()).filter(Boolean),username:process.env.TURN_USERNAME,credential:process.env.TURN_CREDENTIAL});
  res.setHeader("Cache-Control","no-store"); res.json({iceServers});
});
io.on("connection", socket => {
  socket.on("room:create", (p={}, reply=()=>{}) => {
    leaveRoom(socket);
    let code; try { code=makeCode(); } catch { return reply({ok:false,error:"Не удалось создать комнату."}); }
    const sid = cleanSession(p.sessionId) || crypto.randomUUID();
    const room = {code,name:cleanRoomName(p.roomName),ownerId:sid,members:new Map(),media:null,playback:{playing:false,currentTime:0,updatedAt:Date.now()}};
    room.members.set(sid,{sessionId:sid,name:cleanName(p.name),connected:true,socketId:socket.id});
    rooms.set(code,room); socket.join(code); socketRoom.set(socket.id,code); socketMember.set(socket.id,sid);
    reply({ok:true,room:publicRoom(room),sessionId:sid});
  });
  socket.on("room:join", (p={}, reply=()=>{}) => {
    const code=String(p.code||"").toUpperCase().replace(/[^A-Z0-9]/g,"");
    if (code.length!==6) return reply({ok:false,error:"Код должен содержать 6 символов."});
    const room=rooms.get(code); if(!room) return reply({ok:false,error:"Группа не найдена. Возможно, сервер перезапустился."});
    const sid=cleanSession(p.sessionId)||crypto.randomUUID();
    const existing=room.members.get(sid);
    if (!existing && room.members.size>=ROOM_CAPACITY) return reply({ok:false,error:`В комнате не более ${ROOM_CAPACITY} участников.`});
    leaveRoom(socket);
    if(existing) { clearTimeout(existing.expiry); existing.connected=true; existing.socketId=socket.id; existing.name=cleanName(p.name)||existing.name; existing.disconnectedAt=null; }
    else room.members.set(sid,{sessionId:sid,name:cleanName(p.name),connected:true,socketId:socket.id});
    socket.join(code); socketRoom.set(socket.id,code); socketMember.set(socket.id,sid);
    reply({ok:true,room:publicRoom(room),sessionId:sid}); emitRoom(room);
    if(!existing) socket.to(code).emit("chat:system",`${cleanName(p.name)} присоединился(ась) к комнате`);
  });
  socket.on("room:leave",()=>leaveRoom(socket));
  socket.on("chat:send",p=>{
    const room=rooms.get(socketRoom.get(socket.id)), member=memberFor(socket), text=String(p.text||"").trim().slice(0,1000);
    if(!room||!member||!text)return;
    io.to(room.code).emit("chat:message",{id:crypto.randomUUID(),name:member.name,text,time:new Date().toISOString(),isOwner:member.sessionId===room.ownerId});
  });
  socket.on("media:set",p=>{
    const room=rooms.get(socketRoom.get(socket.id)); if(!isOwner(socket,room))return;
    const media=cleanMedia(p.media); if(!media)return socket.emit("app:error","Ссылка на видео недействительна.");
    room.media=media; room.playback={playing:false,currentTime:0,updatedAt:Date.now()}; emitRoom(room); io.to(room.code).emit("playback:update",room.playback);
  });
  socket.on("playback:control",p=>{
    const room=rooms.get(socketRoom.get(socket.id)); if(!isOwner(socket,room)||!room.media)return;
    if(!["play","pause","seek"].includes(p.action))return;
    const now=Date.now(), was=room.playback.playing;
    const base=was?room.playback.currentTime+(now-room.playback.updatedAt)/1000:room.playback.currentTime;
    const requested=Number(p.currentTime);
    const time=Number.isFinite(requested)?Math.min(Math.max(0,requested),7*24*3600):base;
    room.playback={playing:p.action==="play"?true:p.action==="pause"?false:was,currentTime:p.action==="seek"?time:base,updatedAt:now};
    io.to(room.code).emit("playback:update",room.playback);
  });
  socket.on("voice:signal",p=>{
    const room=rooms.get(socketRoom.get(socket.id)), sid=socketMember.get(socket.id), target=String(p.to||"");
    const recipient=room?.members.get(target);
    if(!room?.members.get(sid)?.connected||!recipient?.connected||!p.data||typeof p.data!=="object")return;
    io.to(recipient.socketId).emit("voice:signal",{from:sid,data:p.data});
  });
  socket.on("voice:ready",()=>{
    const room=rooms.get(socketRoom.get(socket.id)), sid=socketMember.get(socket.id);
    if(!room?.members.get(sid)?.connected)return;
    room.members.forEach(m=>{if(m.connected&&m.sessionId!==sid)io.to(m.socketId).emit("voice:peer-joined",{id:sid});});
  });
  socket.on("disconnect",()=>detachSocket(socket));
});
app.use((err,_req,res,_next)=>{
  console.error(err.message);
  if(err instanceof multer.MulterError && err.code==="LIMIT_FILE_SIZE")return res.status(413).json({error:"Файл превышает лимит 2 ГБ."});
  res.status(400).json({error:err.message||"Ошибка запроса."});
});
server.listen(PORT,()=>console.log(`WatchTogether запущен на порту ${PORT}`));
