const socket = io();
const $ = id => document.getElementById(id);
let currentRoom = null;
let isOwner = false;
let mediaElement = null;
let ytPlayer = null;
let ytReady = false;
let suppressPlayerEvents = false;
let localStream = null;
const peers = new Map();
const remoteAudio = new Map();
let playbackTimer = null;

window.onYouTubeIframeAPIReady = () => { ytReady = true; };

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  setTimeout(() => $("toast").classList.remove("show"), 2500);
}
function setError(message) { $("homeError").textContent = message || ""; }
function nickname() { return $("nickname").value.trim() || "Гость"; }
function showHome() { $("home").classList.remove("hidden"); $("roomView").classList.add("hidden"); }
function showRoom() { $("home").classList.add("hidden"); $("roomView").classList.remove("hidden"); }
function emitWithReply(event, data) {
  return new Promise(resolve => socket.emit(event, data, resolve));
}
function escapeText(text) {
  return String(text).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function enterRoom(room) {
  currentRoom = room;
  isOwner = room.ownerId === socket.id;
  $("roomTitle").textContent = room.name;
  $("roomCodeDisplay").textContent = room.code;
  $("ownerTools").classList.toggle("hidden", !isOwner);
  $("ownerHint").textContent = isOwner ? "Ты управляешь видео" : "Управляет владелец";
  $("playBtn").disabled = !isOwner;
  $("backBtn").disabled = !isOwner;
  $("forwardBtn").disabled = !isOwner;
  $("seekBar").disabled = !isOwner;
  renderParticipants(room.participants);
  if (room.media) renderMedia(room.media, room.playback);
  else clearMedia();
  showRoom();
}
function renderParticipants(list) {
  $("peopleCount").textContent = list.length;
  $("peopleList").innerHTML = list.map(p => `<div class="person"><div class="avatar">${escapeText((p.name||"?").slice(0,1).toUpperCase())}</div><span class="person-name">${escapeText(p.name)}</span>${p.isOwner?'<span class="person-role">♛ Владелец</span>':''}</div>`).join("");
}
function clearMedia() {
  $("playerStage").innerHTML = '<div class="empty-player"><div class="play-orb">▶</div><h3>Что будем смотреть?</h3><p>Владелец комнаты может добавить видео с устройства или YouTube.</p></div>';
  $("mediaTitle").textContent = "Видео пока не выбрано";
  $("timeLabel").textContent = "00:00"; $("durationLabel").textContent = "00:00";
  $("seekBar").value = 0;
  mediaElement = null;
  if (ytPlayer && ytPlayer.destroy) { try { ytPlayer.destroy(); } catch {} ytPlayer = null; }
}
function renderMedia(media, playback) {
  const oldKey = currentRoom?.media?.url;
  $("mediaTitle").textContent = media.title || "Видео";
  if (oldKey === media.url && mediaElement) { applyPlayback(playback); return; }
  if (ytPlayer && ytPlayer.destroy) { try { ytPlayer.destroy(); } catch {} ytPlayer = null; }
  $("playerStage").innerHTML = "";
  mediaElement = null;
  if (media.type === "file") {
    const video = document.createElement("video");
    video.src = media.url; video.controls = false; video.playsInline = true; video.preload = "metadata";
    video.addEventListener("loadedmetadata", () => { $("durationLabel").textContent = fmt(video.duration); });
    video.addEventListener("timeupdate", () => {
      if (!suppressPlayerEvents) updateProgress(video.currentTime, video.duration);
    });
    video.addEventListener("ended", () => { if (isOwner) sendPlayback("pause", video.currentTime); });
    $("playerStage").appendChild(video);
    mediaElement = video;
    applyPlayback(playback);
  } else {
    const id = youtubeId(media.url);
    if (!id) { $("playerStage").textContent = "Не удалось распознать ссылку YouTube."; return; }
    const mount = document.createElement("div"); mount.id = "youtubePlayer"; $("playerStage").appendChild(mount);
    const create = () => {
      if (!window.YT || !YT.Player) return setTimeout(create, 250);
      ytPlayer = new YT.Player("youtubePlayer", {
        videoId: id, width: "100%", height: "100%",
        playerVars: { playsinline: 1, rel: 0 },
        events: { onReady: () => applyPlayback(playback), onStateChange: e => {
          if (!isOwner || suppressPlayerEvents) return;
          if (e.data === 1) sendPlayback("play", ytPlayer.getCurrentTime());
          if (e.data === 2) sendPlayback("pause", ytPlayer.getCurrentTime());
        }}
      });
    };
    create();
  }
}
function youtubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0];
    if (u.hostname.includes("youtube.com")) {
      if (u.pathname === "/watch") return u.searchParams.get("v");
      const parts = u.pathname.split("/");
      return parts[2] || null;
    }
  } catch {}
  return null;
}
function fmt(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s/60)).padStart(2,"0")}:${String(s%60).padStart(2,"0")}`;
}
function updateProgress(time, duration) {
  $("timeLabel").textContent = fmt(time);
  if (Number.isFinite(duration) && duration > 0) {
    $("durationLabel").textContent = fmt(duration);
    $("seekBar").max = Math.floor(duration);
    $("seekBar").value = Math.min(time, duration);
  }
}
function playerTime() {
  if (mediaElement) return mediaElement.currentTime || 0;
  if (ytPlayer && ytPlayer.getCurrentTime) return ytPlayer.getCurrentTime() || 0;
  return currentRoom?.playback?.currentTime || 0;
}
function applyPlayback(state) {
  if (!state) return;
  const elapsed = state.playing ? (Date.now() - state.updatedAt) / 1000 : 0;
  const target = Math.max(0, state.currentTime + elapsed);
  suppressPlayerEvents = true;
  if (mediaElement) {
    try {
      mediaElement.currentTime = target;
      if (state.playing) mediaElement.play().catch(() => {});
      else mediaElement.pause();
      updateProgress(target, mediaElement.duration);
    } catch {}
  } else if (ytPlayer && ytPlayer.seekTo) {
    try {
      ytPlayer.seekTo(target, true);
      if (state.playing) ytPlayer.playVideo(); else ytPlayer.pauseVideo();
    } catch {}
  }
  setTimeout(() => suppressPlayerEvents = false, 500);
}
function sendPlayback(action, time) {
  if (!isOwner) return;
  socket.emit("playback:control", { action, currentTime: time ?? playerTime() });
}
function switchTab(tab) {
  document.querySelectorAll(".source-tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $("youtubePanel").classList.toggle("hidden", tab !== "youtube");
  $("filePanel").classList.toggle("hidden", tab !== "file");
}
function appendMessage(m) {
  const box = $("chatMessages");
  if (box.querySelector(".chat-empty")) box.innerHTML = "";
  const el = document.createElement("div");
  el.className = m.system ? "system-message" : "message";
  if (m.system) el.textContent = m.text;
  else el.innerHTML = `<div class="message-meta"><b>${escapeText(m.name)}</b>${m.isOwner?'<span class="person-role">Владелец</span>':''}<time>${new Date(m.time).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}</time></div><p>${escapeText(m.text)}</p>`;
  box.appendChild(el); box.scrollTop = box.scrollHeight;
}
async function createRoom() {
  setError("");
  const result = await emitWithReply("room:create", { name: nickname(), roomName: "Комната просмотра" });
  if (!result?.ok) return setError(result?.error || "Не удалось создать комнату.");
  enterRoom(result.room);
  appendMessage({system:true,text:"Комната создана. Отправь друзьям код приглашения."});
}
async function joinRoom() {
  setError("");
  const code = $("roomCode").value.trim().toUpperCase();
  if (code.length !== 6) return setError("Введи код из 6 символов.");
  const result = await emitWithReply("room:join", { code, name: nickname() });
  if (!result?.ok) return setError(result?.error || "Не удалось войти.");
  enterRoom(result.room);
  appendMessage({system:true,text:"Ты присоединился(ась) к комнате."});
}
function leaveRoom() {
  stopVoice();
  socket.emit("room:leave");
  currentRoom = null; isOwner = false;
  clearMedia(); $("chatMessages").innerHTML = '<div class="chat-empty">Сообщения появятся здесь. Напиши первым!</div>';
  showHome();
}
function startVoice() {
  if (!currentRoom) return;
  navigator.mediaDevices?.getUserMedia({audio:true}).then(stream => {
    localStream = stream;
    $("micBtn").classList.add("active");
    $("micBtn").textContent = "🎙 Выключить микрофон";
    $("voiceStatus").textContent = "Микрофон включён";
    socket.emit("voice:ready");
    currentRoom.participants.filter(p => p.id !== socket.id).forEach(p => makePeer(p.id, true));
  }).catch(() => toast("Не удалось включить микрофон. Проверь разрешение браузера и HTTPS."));
}
function makePeer(id, initiator) {
  if (!localStream || peers.has(id)) return;
  // Native WebRTC: peer connections are signaled through Socket.IO.
  const pc = new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  peers.set(id, pc);
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  pc.onicecandidate = e => { if (e.candidate) socket.emit("voice:signal",{to:id,data:{candidate:e.candidate}}); };
  pc.ontrack = e => {
    let audio = remoteAudio.get(id);
    if (!audio) { audio = document.createElement("audio"); audio.autoplay = true; audio.playsInline = true; document.body.appendChild(audio); remoteAudio.set(id,audio); }
    audio.srcObject = e.streams[0];
  };
  if (initiator) pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => socket.emit("voice:signal",{to:id,data:{description:pc.localDescription}})).catch(console.error);
}
socket.on("voice:peer-joined", ({id}) => makePeer(id, false));
socket.on("voice:signal", async ({from,data}) => {
  if (!localStream) return;
  let pc = peers.get(from);
  if (!pc) makePeer(from, false), pc = peers.get(from);
  if (!pc) return;
  try {
    if (data.description) {
      await pc.setRemoteDescription(data.description);
      if (data.description.type === "offer") {
        const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
        socket.emit("voice:signal",{to:from,data:{description:pc.localDescription}});
      }
    } else if (data.candidate) await pc.addIceCandidate(data.candidate);
  } catch(e) { console.warn("Voice signaling:",e); }
});
function stopVoice() {
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = null;
  peers.forEach(pc => pc.close()); peers.clear();
  remoteAudio.forEach(a => { a.srcObject = null; a.remove(); }); remoteAudio.clear();
  $("micBtn").classList.remove("active"); $("micBtn").textContent = "🎙 Включить микрофон";
  $("voiceStatus").textContent = "Микрофон выключен";
}
$("createBtn").addEventListener("click", createRoom);
$("joinBtn").addEventListener("click", joinRoom);
$("roomCode").addEventListener("input", e => e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,""));
$("roomCode").addEventListener("keydown", e => { if(e.key==="Enter") joinRoom(); });
$("leaveBtn").addEventListener("click", leaveRoom);
$("copyCodeBtn").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(currentRoom.code); toast("Код скопирован!"); }
  catch { toast("Код группы: " + currentRoom.code); }
});
document.querySelectorAll(".source-tab").forEach(b => b.addEventListener("click", () => switchTab(b.dataset.tab)));
$("addYoutubeBtn").addEventListener("click", () => {
  const url = $("youtubeUrl").value.trim();
  if (!youtubeId(url)) return toast("Вставь корректную ссылку на YouTube.");
  socket.emit("media:set",{media:{type:"youtube",url,title:"YouTube-видео"}});
  $("youtubeUrl").value = "";
});
$("videoFile").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  $("uploadStatus").textContent = "Загружаю файл...";
  const data = new FormData(); data.append("video",file);
  try {
    const response = await fetch("/api/upload",{method:"POST",body:data});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Ошибка загрузки");
    socket.emit("media:set",{media:{type:"file",url:result.url,title:result.name}});
    $("uploadStatus").textContent = "Файл загружен: " + result.name;
  } catch(err) { $("uploadStatus").textContent = err.message; }
  e.target.value = "";
});
$("playBtn").addEventListener("click", () => {
  if (!isOwner) return;
  if (mediaElement) sendPlayback(mediaElement.paused ? "play" : "pause", mediaElement.currentTime);
  else if (ytPlayer) {
    const state = ytPlayer.getPlayerState();
    sendPlayback(state === 1 ? "pause" : "play", ytPlayer.getCurrentTime());
  }
});
$("backBtn").addEventListener("click", () => sendPlayback("seek",Math.max(0,playerTime()-10)));
$("forwardBtn").addEventListener("click", () => sendPlayback("seek",playerTime()+10));
$("seekBar").addEventListener("change", e => sendPlayback("seek",Number(e.target.value)));
$("chatForm").addEventListener("submit", e => {
  e.preventDefault(); const text = $("chatInput").value.trim(); if (!text) return;
  socket.emit("chat:send",{text}); $("chatInput").value = "";
});
$("micBtn").addEventListener("click", () => localStream ? stopVoice() : startVoice());
socket.on("room:update", room => {
  if (!currentRoom || room.code !== currentRoom.code) return;
  const previousMediaUrl = currentRoom.media?.url;
  currentRoom = room; isOwner = room.ownerId === socket.id;
  $("ownerTools").classList.toggle("hidden",!isOwner);
  $("ownerHint").textContent = isOwner ? "Ты управляешь видео" : "Управляет владелец";
  $("playBtn").disabled = !isOwner; $("backBtn").disabled = !isOwner; $("forwardBtn").disabled = !isOwner; $("seekBar").disabled = !isOwner;
  renderParticipants(room.participants);
  if (room.media && room.media.url !== previousMediaUrl) renderMedia(room.media,room.playback);
  else if (!room.media) clearMedia();
});
socket.on("playback:update", state => {
  if (!currentRoom) return;
  currentRoom.playback = state; applyPlayback(state);
});
socket.on("chat:message", m => appendMessage(m));
socket.on("chat:system", text => appendMessage({system:true,text}));
socket.on("connect", () => {});
socket.on("disconnect", () => { if (currentRoom) toast("Соединение потеряно. Переподключаемся..."); });
setInterval(() => {
  if (!currentRoom || !currentRoom.media) return;
  if (mediaElement && !mediaElement.paused) updateProgress(mediaElement.currentTime,mediaElement.duration);
  else if (ytPlayer && ytPlayer.getCurrentTime) updateProgress(ytPlayer.getCurrentTime(),ytPlayer.getDuration());
},1000);
