const socket = io({ reconnection: true, reconnectionAttempts: Infinity, transports: ["polling", "websocket"] });
const $ = (id) => document.getElementById(id);

let currentRoom = null;
let isOwner = false;
let mediaElement = null;
let ytPlayer = null;
let suppressPlayerEvents = false;
let localStream = null;
let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
const peers = new Map();
const remoteAudio = new Map();
let syncTimeout = null;
let library = [];
let sessionId = localStorage.getItem("watchTogetherSessionId") || cryptoRandomId();

const STORAGE_CODE_KEY = "watchTogetherRoomCode";
const STORAGE_SESSION_KEY = "watchTogetherSessionId";
const FEELING = { room: null };

window.onYouTubeIframeAPIReady = () => {
  if (currentRoom?.media?.type === "youtube") renderMedia(currentRoom.media, currentRoom.playback);
};

function cryptoRandomId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function ensureSessionId() {
  if (!sessionId) {
    sessionId = cryptoRandomId();
    localStorage.setItem(STORAGE_SESSION_KEY, sessionId);
  }
  return sessionId;
}

function rememberRoom(code) {
  if (!code) return;
  localStorage.setItem(STORAGE_CODE_KEY, code);
  localStorage.setItem(STORAGE_SESSION_KEY, ensureSessionId());
}

function clearRoomMemory() {
  localStorage.removeItem(STORAGE_CODE_KEY);
}

function toast(message) {
  const toastEl = $("toast");
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastEl.classList.remove("show"), 3000);
}

function setError(message) {
  $("homeError").textContent = message || "";
}

function nickname() {
  return $("nickname").value.trim() || "Гость";
}

function showHome() {
  $("home").classList.remove("hidden");
  $("roomView").classList.add("hidden");
}

function showRoom() {
  $("home").classList.add("hidden");
  $("roomView").classList.remove("hidden");
}

function emitWithReply(event, data) {
  return new Promise((resolve) => {
    if (!socket.connected) return resolve({ ok: false, error: "Нет соединения с сервером." });
    socket.timeout(8000).emit(event, data, (error, result) => resolve(error ? { ok: false, error: "Сервер не ответил. Попробуй ещё раз." } : result));
  });
}

function escapeText(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function setOwnerControls() {
  $("ownerTools").classList.toggle("hidden", !isOwner);
  $("ownerHint").textContent = isOwner ? "Ты управляешь видео" : "Управляет владелец";
  ["playBtn", "backBtn", "forwardBtn", "seekBar"].forEach((id) => {
    const element = $(id);
    if (element) element.disabled = !isOwner;
  });
  updatePlaybackButton();
}

function setMicButtonState(active) {
  $("micBtn")?.classList.toggle("active", active);
  $("fullscreenMicBtn")?.classList.toggle("active", active);
  $("micBtn").textContent = active ? "🎙 Выключить микрофон" : "🎙 Включить микрофон";
  $("voiceStatus").textContent = active ? "Микрофон включён" : "Микрофон выключен";
}

function updatePlaybackButton() {
  const state = currentRoom?.playback;
  const label = state?.playing ? "❚❚" : "▶";
  $("playBtn").textContent = label;
  $("playBtn").title = state?.playing ? "Пауза" : "Воспроизведение";
}

function enterRoom(room) {
  const changedRoom = currentRoom?.code !== room.code;
  currentRoom = room;
  isOwner = room.ownerId === socket.id;
  $("roomTitle").textContent = room.name;
  $("roomCodeDisplay").textContent = room.code;
  rememberRoom(room.code);
  setOwnerControls();
  renderParticipants(room.participants || []);
  if (room.media) renderMedia(room.media, room.playback);
  else clearMedia();
  showRoom();
  if (changedRoom) $("chatMessages").innerHTML = '<div class="chat-empty">Сообщения появятся здесь. Напиши первым!</div>';
}

function renderParticipants(list) {
  $("peopleCount").textContent = list.length;
  $("peopleList").innerHTML = list.map((person) => {
    const firstLetter = escapeText((person.name || "?").slice(0, 1).toUpperCase());
    const role = person.isOwner ? '<span class="person-role">Владелец</span>' : "";
    const status = person.offline ? '<span class="person-role" style="background:rgba(255,120,133,0.12);color:#ff9ea8;">offline</span>' : "";
    return `
      <div class="person">
        <div class="avatar">${firstLetter}</div>
        <span class="person-name">${escapeText(person.name || "Гость")}</span>
        ${role}${status}
      </div>`;
  }).join("");
}

function clearMedia() {
  $("playerStage").replaceChildren();
  $("playerStage").dataset.mediaUrl = "";
  $("playerStage").classList.remove("video-vertical", "video-square", "video-horizontal");
  $("playerStage").innerHTML = `
    <div class="empty-player">
      <div class="play-orb">▶</div>
      <h3>Что будем смотреть?</h3>
      <p>Владелец комнаты может добавить видео с YouTube или файла.</p>
    </div>
  `;
  $("mediaTitle").textContent = "Видео пока не выбрано";
  $("timeLabel").textContent = "00:00";
  $("durationLabel").textContent = "00:00";
  $("seekBar").value = 0;
  mediaElement = null;
  destroyYouTube();
}

function destroyYouTube() {
  if (ytPlayer?.destroy) {
    try { ytPlayer.destroy(); } catch (error) { console.warn("YT destroy failed", error); }
  }
  ytPlayer = null;
}

function setStageRatioFromVideo(video) {
  if (!video || !video.videoWidth || !video.videoHeight) return;
  const ratio = video.videoWidth / video.videoHeight;
  const stage = $("playerStage");
  stage.classList.remove("video-vertical", "video-square", "video-horizontal");
  if (ratio < 0.9) stage.classList.add("video-vertical");
  else if (ratio >= 0.9 && ratio <= 1.2) stage.classList.add("video-square");
  else stage.classList.add("video-horizontal");
}

function renderMedia(media, playback) {
  if (!media) return clearMedia();
  $("mediaTitle").textContent = media.title || "Видео";

  const currentUrl = $("playerStage").dataset.mediaUrl;
  if (currentUrl === media.url && (mediaElement || ytPlayer)) {
    if (playback) applyPlayback(playback);
    return;
  }

  destroyYouTube();
  mediaElement = null;
  $("playerStage").replaceChildren();
  $("playerStage").dataset.mediaUrl = media.url;
  $("playerStage").classList.remove("video-vertical", "video-square", "video-horizontal");

  if (media.type === "file") {
    const video = document.createElement("video");
    video.src = media.url;
    video.controls = false;
    video.playsInline = true;
    video.preload = "metadata";
    video.autoplay = false;
    video.muted = false;
    video.addEventListener("loadedmetadata", () => {
      setStageRatioFromVideo(video);
      $("durationLabel").textContent = fmt(video.duration);
      if (playback) applyPlayback(playback);
    });
    video.addEventListener("timeupdate", () => {
      if (!suppressPlayerEvents) updateProgress(video.currentTime, video.duration);
    });
    video.addEventListener("ended", () => {
      if (isOwner) sendPlayback("pause", video.currentTime);
    });
    video.addEventListener("error", () => toast("Не удалось загрузить видеофайл."));
    $("playerStage").appendChild(video);
    mediaElement = video;
    if (playback) applyPlayback(playback);
    return;
  }

  const id = youtubeId(media.url);
  if (!id) {
    $("playerStage").innerHTML = '<div class="empty-player"><p>Не удалось распознать ссылку YouTube.</p></div>';
    return;
  }

  if (!window.YT?.Player) {
    $("playerStage").innerHTML = '<div class="empty-player"><p>Загружается плеер YouTube…</p></div>';
    return;
  }

  const mount = document.createElement("div");
  mount.id = "youtubePlayer";
  mount.className = "youtube-wrap";
  $("playerStage").appendChild(mount);
  $("playerStage").classList.add("video-horizontal");

  ytPlayer = new YT.Player("youtubePlayer", {
    videoId: id,
    width: "100%",
    height: "100%",
    playerVars: { playsinline: 1, rel: 0, enablejsapi: 1 },
    events: {
      onReady: () => {
        if (playback) applyPlayback(playback);
      },
      onStateChange: (event) => {
        if (!isOwner || suppressPlayerEvents || !ytPlayer) return;
        if (event.data === YT.PlayerState.PLAYING) sendPlayback("play", ytPlayer.getCurrentTime());
        if (event.data === YT.PlayerState.PAUSED) sendPlayback("pause", ytPlayer.getCurrentTime());
      },
      onError: () => toast("YouTube не разрешил воспроизвести это видео.")
    }
  });
}

function youtubeId(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host === "youtu.be") return url.pathname.slice(1).split("/")[0] || null;
    if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) return null;
    if (url.pathname === "/watch") return url.searchParams.get("v");
    return url.pathname.split("/")[2] || null;
  } catch {
    return null;
  }
}

function fmt(seconds) {
  if (!Number.isFinite(seconds)) return "00:00";
  const value = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(value / 3600);
  const mins = Math.floor(value / 60) % 60;
  const secs = value % 60;
  return hours ? `${hours}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function updateProgress(time, duration) {
  $("timeLabel").textContent = fmt(time);
  if (Number.isFinite(duration) && duration > 0) {
    $("durationLabel").textContent = fmt(duration);
    $("seekBar").max = Math.floor(duration);
    if (document.activeElement !== $("seekBar")) $("seekBar").value = Math.min(time, duration);
  }
}

function playerTime() {
  if (mediaElement) return mediaElement.currentTime || 0;
  if (ytPlayer?.getCurrentTime) return ytPlayer.getCurrentTime() || 0;
  return currentRoom?.playback?.currentTime || 0;
}

function applyPlayback(state) {
  if (!state || !currentRoom) return;

  const elapsed = state.playing ? Math.max(0, Date.now() - state.updatedAt) / 1000 : 0;
  const target = Math.max(0, state.currentTime + elapsed);
  suppressPlayerEvents = true;
  clearTimeout(syncTimeout);

  if (mediaElement) {
    const sync = () => {
      if (!mediaElement) return;
      try {
        if (!Number.isFinite(mediaElement.currentTime) || Math.abs(mediaElement.currentTime - target) > 1.25) mediaElement.currentTime = target;
        if (state.playing) mediaElement.play().catch(() => toast("Нажми «Воспроизвести» на устройстве, чтобы разрешить звук."));
        else mediaElement.pause();
        updateProgress(target, mediaElement.duration);
      } catch (error) {
        console.warn("Playback sync failed", error);
      }
    };
    if (mediaElement.readyState >= 1) sync();
    else mediaElement.addEventListener("loadedmetadata", sync, { once: true });
  } else if (ytPlayer?.seekTo) {
    try {
      const current = ytPlayer.getCurrentTime?.() || 0;
      if (Math.abs(current - target) > 1.25) ytPlayer.seekTo(target, true);
      if (state.playing) ytPlayer.playVideo(); else ytPlayer.pauseVideo();
    } catch (error) {
      console.warn("YouTube sync failed", error);
    }
  }

  syncTimeout = setTimeout(() => { suppressPlayerEvents = false; }, 700);
  updatePlaybackButton();
}

function sendPlayback(action, time = playerTime()) {
  if (isOwner && currentRoom?.media) socket.emit("playback:control", { action, currentTime: time });
}

function switchTab(tab) {
  document.querySelectorAll(".source-tab").forEach((button) => button.classList.toggle("active", button.dataset.tab === tab));
  $("youtubePanel").classList.toggle("hidden", tab !== "youtube");
  $("filePanel").classList.toggle("hidden", tab !== "file");
}

function appendMessage(message) {
  const box = $("chatMessages");
  if (box.querySelector(".chat-empty")) box.replaceChildren();

  const element = document.createElement("div");
  element.className = message.system ? "system-message" : "message";

  if (message.system) {
    element.textContent = message.text;
  } else {
    const time = new Date(message.time);
    const timeText = Number.isNaN(time.getTime()) ? "" : time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    element.innerHTML = `
      <div class="message-meta">
        <b>${escapeText(message.name)}</b>
        ${message.isOwner ? '<span class="person-role">Владелец</span>' : ""}
        <time>${escapeText(timeText)}</time>
      </div>
      <p>${escapeText(message.text)}</p>
    `;
  }

  box.appendChild(element);
  box.scrollTop = box.scrollHeight;
}

async function createRoom() {
  setError("");
  const result = await emitWithReply("room:create", { name: nickname(), roomName: "Комната просмотра", sessionId: ensureSessionId() });
  if (!result?.ok) return setError(result?.error || "Не удалось создать комнату.");
  enterRoom(result.room);
  appendMessage({ system: true, text: "Комната создана. Отправь друзьям код приглашения." });
}

async function joinRoom() {
  setError("");
  const code = $("roomCode").value.trim().toUpperCase();
  if (code.length !== 6) return setError("Введи код из 6 символов.");
  const result = await emitWithReply("room:join", { code, name: nickname(), sessionId: ensureSessionId() });
  if (!result?.ok) return setError(result?.error || "Не удалось войти.");
  enterRoom(result.room);
  appendMessage({ system: true, text: "Ты присоединился(ась) к комнате." });
}

function leaveRoom(shouldExplicit = false) {
  stopVoice();
  socket.emit("room:leave", { explicit: shouldExplicit, sessionId: ensureSessionId() });
  if (shouldExplicit) {
    clearRoomMemory();
    localStorage.removeItem(STORAGE_SESSION_KEY);
  }

  currentRoom = null;
  isOwner = false;
  clearMedia();
  $("chatMessages").innerHTML = '<div class="chat-empty">Сообщения появятся здесь. Напиши первым!</div>';
  showHome();
}

async function startVoice() {
  if (!currentRoom) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return toast("Голосовой чат требует браузер с WebRTC и HTTPS (или localhost).");

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    setMicButtonState(true);
    socket.emit("voice:ready");
    currentRoom.participants.filter((person) => person.id !== socket.id).forEach((person) => makePeer(person.id, socket.id.localeCompare(person.id) < 0));
  } catch (error) {
    localStream = null;
    toast(error.name === "NotAllowedError" ? "Разреши доступ к микрофону в браузере." : "Не удалось включить микрофон. Проверь устройство.");
  }
}

function makePeer(id, initiator) {
  if (!localStream || peers.has(id)) return;
  const pc = new RTCPeerConnection({ iceServers });
  peers.set(id, pc);
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) socket.emit("voice:signal", { to: id, data: { candidate: event.candidate } });
  };

  pc.ontrack = (event) => {
    let audio = remoteAudio.get(id);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.dataset.peer = id;
      document.body.appendChild(audio);
      remoteAudio.set(id, audio);
    }
    audio.srcObject = event.streams[0];
    audio.play().catch(() => toast("Нажми на странице, чтобы включить входящий звук."));
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed"].includes(pc.connectionState)) removePeer(id);
  };

  if (initiator) {
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => socket.emit("voice:signal", { to: id, data: { description: pc.localDescription } }))
      .catch((error) => console.warn("Voice offer failed", error));
  }
}

function removePeer(id) {
  const pc = peers.get(id);
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.close();
    peers.delete(id);
  }
  const audio = remoteAudio.get(id);
  if (audio) {
    audio.srcObject = null;
    audio.remove();
    remoteAudio.delete(id);
  }
}

function stopVoice() {
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  [...peers.keys()].forEach(removePeer);
  setMicButtonState(false);
}

socket.on("voice:peer-joined", ({ id }) => {
  if (localStream && id) makePeer(id, socket.id.localeCompare(id) < 0);
});

socket.on("voice:peer-left", ({ id }) => removePeer(id));

socket.on("voice:signal", async ({ from, data }) => {
  if (!localStream || !from || !data) return;
  if (!peers.has(from)) makePeer(from, false);
  const pc = peers.get(from);
  if (!pc) return;
  try {
    if (data.description) {
      await pc.setRemoteDescription(data.description);
      if (data.description.type === "offer") {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("voice:signal", { to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  } catch (error) {
    console.warn("Voice signaling failed", error);
  }
});

function toggleFullscreen() {
  const stage = $("playerStage");
  if (!document.fullscreenElement) {
    if (stage.requestFullscreen) stage.requestFullscreen();
    else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
  } else if (document.exitFullscreen) {
    document.exitFullscreen();
  }
}

document.addEventListener("fullscreenchange", () => {
  const stage = $("playerStage");
  const isFullscreen = Boolean(document.fullscreenElement);
  stage.classList.toggle("is-fullscreen", isFullscreen);
  $("fullscreenBtn").textContent = isFullscreen ? "⤡" : "⤢";
  $("playerFullscreenBtn").textContent = isFullscreen ? "⤡" : "⤢";
  $("fullscreenMicBtn").title = isFullscreen ? "Микрофон в полном экране" : "Микрофон в полном экране";
});

function renderLibrary() {
  if (!library.length) {
    $("libraryList").innerHTML = '<div class="chat-empty">Нет загруженных видео. Сначала добавь их в библиотеку.</div>';
    return;
  }

  $("libraryList").innerHTML = library.map((item) => {
    const type = item.mime || item.type || "video";
    const size = item.size ? `${(item.size / 1024 / 1024).toFixed(2)} MB` : "Неизвестно";
    return `
      <div class="library-item">
        <div class="library-item-meta">
          <span class="library-item-title">${escapeText(item.title || "Видео")}</span>
          <span class="library-item-detail">${escapeText(type)} · ${escapeText(size)}</span>
        </div>
        <div class="library-actions">
          <button class="library-btn select-video" data-id="${item.id}">Выбрать</button>
          <button class="library-btn library-danger delete-video" data-id="${item.id}">Удалить</button>
        </div>
      </div>
    `;
  }).join("");
}

async function loadLibrary() {
  try {
    const response = await fetch("/api/library", { cache: "no-store" });
    const payload = await response.json();
    library = Array.isArray(payload.items) ? payload.items : [];
    renderLibrary();
  } catch (error) {
    console.warn("Library load failed", error);
    library = [];
    renderLibrary();
  }
}

async function removeLibraryItem(id) {
  try {
    const response = await fetch(`/api/library/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Не удалось удалить видео");
    library = library.filter((item) => item.id !== id);
    renderLibrary();
    toast("Видео удалено из библиотеки");
  } catch (error) {
    toast(error.message || "Не удалось удалить видео");
  }
}

async function selectLibraryItem(id) {
  const item = library.find((entry) => entry.id === id);
  if (!item) return;
  socket.emit("media:set", { media: { type: "file", id: item.id, url: item.url, title: item.title } });
  toast(`Выбрано: ${item.title}`);
}

async function uploadVideo(file) {
  if (!file) return;
  if (!file.type.startsWith("video/")) {
    toast("Выбери видеофайл.");
    $("videoFile").value = "";
    return;
  }
  if (file.size > 500 * 1024 * 1024) {
    toast("Размер файла не должен превышать 500 МБ.");
    $("videoFile").value = "";
    return;
  }

  const form = new FormData();
  form.append("video", file);
  $("uploadStatus").textContent = "Загружаю файл… 0%";

  try {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const progress = Math.round((event.loaded / event.total) * 100);
      $("uploadStatus").textContent = `Загружаю файл… ${progress}%`;
    };

    const result = await new Promise((resolve, reject) => {
      xhr.onload = () => {
        try {
          const payload = JSON.parse(xhr.responseText || "{}");
          if (xhr.status >= 200 && xhr.status < 300) resolve(payload);
          else reject(new Error(payload.error || "Ошибка загрузки"));
        } catch {
          reject(new Error("Ошибка загрузки"));
        }
      };
      xhr.onerror = () => reject(new Error("Ошибка запроса загрузки"));
      xhr.send(form);
    });

    library.unshift({
      id: result.id,
      title: result.name,
      url: result.url,
      type: result.mime,
      size: result.size,
      mime: result.mime
    });
    renderLibrary();
    socket.emit("media:set", { media: { type: "file", id: result.id, url: result.url, title: result.name } });
    $("uploadStatus").textContent = `Файл загружен: ${result.name}`;
    toast("Видео загружено и доступно всем участникам.");
  } catch (error) {
    $("uploadStatus").textContent = error.message || "Ошибка загрузки";
    toast(error.message || "Ошибка загрузки");
  }

  $("videoFile").value = "";
}

$("createBtn").addEventListener("click", createRoom);
$("joinBtn").addEventListener("click", joinRoom);
$("roomCode").addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
});
$("roomCode").addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinRoom();
});
$("leaveBtn").addEventListener("click", () => leaveRoom(true));
$("copyCodeBtn").addEventListener("click", async () => {
  if (!currentRoom) return;
  try {
    await navigator.clipboard.writeText(currentRoom.code);
    toast("Код скопирован!");
  } catch {
    toast(`Код группы: ${currentRoom.code}`);
  }
});

document.querySelectorAll(".source-tab").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
$("addYoutubeBtn").addEventListener("click", () => {
  const url = $("youtubeUrl").value.trim();
  if (!isOwner || !youtubeId(url)) return toast("Вставь корректную ссылку на YouTube.");
  socket.emit("media:set", { media: { type: "youtube", url, title: "YouTube-видео" } });
  $("youtubeUrl").value = "";
});
$("youtubeUrl").addEventListener("keydown", (event) => {
  if (event.key === "Enter") $("addYoutubeBtn").click();
});
$("videoFile").addEventListener("change", (event) => uploadVideo(event.target.files[0]));
$("refreshLibraryBtn").addEventListener("click", loadLibrary);

$("libraryList").addEventListener("click", (event) => {
  const target = event.target.closest(".select-video");
  if (target) selectLibraryItem(target.dataset.id);

  const removeTarget = event.target.closest(".delete-video");
  if (removeTarget) removeLibraryItem(removeTarget.dataset.id);
});

$("playBtn").addEventListener("click", () => {
  if (!isOwner || !currentRoom?.media) return;
  if (mediaElement) sendPlayback(mediaElement.paused ? "play" : "pause", mediaElement.currentTime);
  else if (ytPlayer?.getPlayerState) sendPlayback(ytPlayer.getPlayerState() === YT.PlayerState.PLAYING ? "pause" : "play", ytPlayer.getCurrentTime());
});

$("backBtn").addEventListener("click", () => sendPlayback("seek", Math.max(0, playerTime() - 10)));
$("forwardBtn").addEventListener("click", () => sendPlayback("seek", playerTime() + 10));
$("seekBar").addEventListener("input", (event) => {
  if (isOwner) sendPlayback("seek", Number(event.target.value));
});
$("chatForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text || !currentRoom) return;
  socket.emit("chat:send", { text });
  $("chatInput").value = "";
});
$("micBtn").addEventListener("click", () => localStream ? stopVoice() : startVoice());
$("fullscreenMicBtn").addEventListener("click", () => localStream ? stopVoice() : startVoice());
$("fullscreenBtn").addEventListener("click", toggleFullscreen);
$("playerFullscreenBtn").addEventListener("click", toggleFullscreen);

socket.on("room:update", (room) => {
  if (!currentRoom || room.code !== currentRoom.code) return;
  const priorUrl = currentRoom.media?.url;
  const priorOwner = isOwner;
  currentRoom = room;
  isOwner = room.ownerId === socket.id;
  setOwnerControls();
  renderParticipants(room.participants || []);
  if (room.media && (room.media.url !== priorUrl || priorOwner !== isOwner)) renderMedia(room.media, room.playback);
  else if (!room.media) clearMedia();
});

socket.on("playback:update", (state) => {
  if (!currentRoom) return;
  currentRoom.playback = state;
  applyPlayback(state);
  updatePlaybackButton();
});

socket.on("chat:message", appendMessage);
socket.on("chat:system", (text) => appendMessage({ system: true, text }));
socket.on("app:error", toast);

socket.on("disconnect", () => {
  if (currentRoom) {
    toast("Соединение потеряно. Переподключаемся…");
    stopVoice();
  }
});

socket.on("connect", async () => {
  try {
    const response = await fetch("/api/voice-config", { cache: "no-store" });
    const config = await response.json();
    if (Array.isArray(config.iceServers) && config.iceServers.length) iceServers = config.iceServers;
  } catch {
    // STUN fallback remains available.
  }

  const savedCode = localStorage.getItem(STORAGE_CODE_KEY);
  const savedSession = localStorage.getItem(STORAGE_SESSION_KEY) || ensureSessionId();
  if (savedCode && savedSession) {
    const result = await emitWithReply("room:join", { code: savedCode, name: nickname(), sessionId: savedSession });
    if (result?.ok) enterRoom(result.room);
    else {
      localStorage.removeItem(STORAGE_CODE_KEY);
      localStorage.removeItem(STORAGE_SESSION_KEY);
      currentRoom = null;
      showHome();
    }
  }
});

setInterval(() => {
  if (!currentRoom?.media) return;
  if (mediaElement) updateProgress(mediaElement.currentTime, mediaElement.duration);
  else if (ytPlayer?.getCurrentTime) updateProgress(ytPlayer.getCurrentTime(), ytPlayer.getDuration());
}, 1000);

if (localStorage.getItem(STORAGE_SESSION_KEY)) {
  sessionId = localStorage.getItem(STORAGE_SESSION_KEY);
}

loadLibrary();
setMicButtonState(false);
updatePlaybackButton();
showHome();

if (!localStorage.getItem(STORAGE_SESSION_KEY)) {
  localStorage.setItem(STORAGE_SESSION_KEY, sessionId);
}

window.addEventListener("beforeunload", () => {
  if (currentRoom && !document.visibilityState) {
    rememberRoom(currentRoom.code);
  }
});
