/* WatchTogether upgrades — add <script src="/upgrades.js"></script> after /app.js */
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const stage = $("playerStage");
  if (!stage) return;

  // Keep videos fully visible, including portrait/TikTok format.
  const style = document.createElement("style");
  style.textContent = `
    #playerStage { position:relative; aspect-ratio:16/9; min-height:220px; max-height:78vh; }
    #playerStage video { width:100%; height:100%; object-fit:contain !important; background:#000; }
    #playerStage.is-portrait { aspect-ratio:9/16; width:min(100%,420px); margin-inline:auto; max-height:78vh; }
    #playerStage.is-landscape { aspect-ratio:16/9; width:100%; }
    #wtOverlay { position:absolute; z-index:5; top:10px; right:10px; display:flex; gap:7px; }
    #wtOverlay button { border:1px solid #ffffff40; border-radius:9px; padding:9px 12px; color:white; background:#101827dd; font-weight:700; }
    #wtLibrary { margin-top:12px; display:grid; gap:8px; }
    #wtLibrary select { width:100%; min-height:40px; padding:8px; border-radius:8px; }
    #wtLibrary small { color:#9aa8bf; }
    #playBtn { min-width:48px; }
    @media(max-width:600px) { #playerStage.is-portrait { width:min(100%,360px); } }
  `;
  document.head.appendChild(style);

  const overlay = document.createElement("div");
  overlay.id = "wtOverlay";
  overlay.innerHTML = '<button type="button" id="wtFull">⛶ На весь экран</button><button type="button" id="wtMic">🎙 Микрофон</button>';
  stage.appendChild(overlay);

  const fullBtn = $("wtFull");
  const micBtn = $("wtMic");
  fullBtn.addEventListener("click", async () => {
    try {
      if (!document.fullscreenElement) await stage.requestFullscreen();
      else await document.exitFullscreen();
    } catch { alert("Полноэкранный режим недоступен в этом браузере."); }
  });
  document.addEventListener("fullscreenchange", () => {
    fullBtn.textContent = document.fullscreenElement ? "⤢ Свернуть" : "⛶ На весь экран";
  });
  micBtn.addEventListener("click", () => {
    const original = $("micBtn");
    if (original) original.click();
    setTimeout(syncMicLabel, 100);
  });
  function syncMicLabel() {
    const original = $("micBtn");
    const active = !!original?.classList.contains("active");
    micBtn.textContent = active ? "🎙 Выключить микрофон" : "🎙 Включить микрофон";
  }
  $("micBtn")?.addEventListener("click", () => setTimeout(syncMicLabel, 100));

  // Determine orientation from the loaded local video metadata.
  const observer = new MutationObserver(() => {
    const video = stage.querySelector("video");
    if (!video || video.dataset.wtOrientationBound) return;
    video.dataset.wtOrientationBound = "1";
    const setOrientation = () => {
      if (!video.videoWidth || !video.videoHeight) return;
      stage.classList.toggle("is-portrait", video.videoHeight > video.videoWidth);
      stage.classList.toggle("is-landscape", video.videoWidth >= video.videoHeight);
    };
    video.addEventListener("loadedmetadata", setOrientation);
    if (video.readyState >= 1) setOrientation();
    video.addEventListener("play", () => updatePlayButton(video));
    video.addEventListener("pause", () => updatePlayButton(video));
    updatePlayButton(video);
  });
  observer.observe(stage, { childList: true, subtree: true });

  function updatePlayButton(video) {
    const button = $("playBtn");
    if (!button) return;
    button.textContent = video && !video.paused ? "Ⅱ" : "▶";
    button.title = video && !video.paused ? "Пауза" : "Воспроизвести";
  }

  // Remember the last room code so a refresh/reopen can attempt to rejoin.
  const roomInput = $("roomCode");
  const nickInput = $("nickname");
  const joinButton = $("joinBtn");
  const createButton = $("createBtn");
  const KEY = "wt:last-room";
  const NAME = "wt:nickname";
  if (nickInput) {
    nickInput.value = localStorage.getItem(NAME) || nickInput.value;
    nickInput.addEventListener("change", () => localStorage.setItem(NAME, nickInput.value));
  }
  joinButton?.addEventListener("click", () => {
    const code = (roomInput?.value || "").trim().toUpperCase();
    if (code.length === 6) localStorage.setItem(KEY, code);
  });
  createButton?.addEventListener("click", () => {
    // room code is stored after the app renders it below
    setTimeout(() => {
      const code = $("roomCodeDisplay")?.textContent?.trim();
      if (code && code.length === 6) localStorage.setItem(KEY, code);
    }, 500);
  });
  $("leaveBtn")?.addEventListener("click", () => localStorage.removeItem(KEY));

  // On a fresh page load, automatically attempt to rejoin the last room.
  const savedCode = localStorage.getItem(KEY);
  if (savedCode && roomInput && joinButton) {
    roomInput.value = savedCode;
    const tryJoin = () => {
      if ($("home") && !$("home").classList.contains("hidden")) joinButton.click();
    };
    window.addEventListener("load", () => setTimeout(tryJoin, 900), { once: true });
    // Also catch Socket.IO reconnects handled by the existing app.
    setTimeout(tryJoin, 1400);
  }

  // Keep the upload library in the browser so a previously uploaded file can
  // be selected again without uploading it a second time.
  const filePanel = $("filePanel");
  const fileInput = $("videoFile");
  if (filePanel && fileInput && ! $("wtLibrary")) {
    const box = document.createElement("div");
    box.id = "wtLibrary";
    box.innerHTML = '<small>Моя библиотека (файлы, загруженные ранее на этот сервер)</small><select id="wtSavedVideos"><option value="">Выбери сохранённое видео…</option></select><button type="button" id="wtUseSaved" class="secondary-btn">Использовать выбранное</button>';
    filePanel.appendChild(box);
    const select = $("wtSavedVideos");
    const savedKey = "wt:video-library";
    const readLibrary = () => {
      try { return JSON.parse(localStorage.getItem(savedKey) || "[]"); }
      catch { return []; }
    };
    const saveLibrary = list => localStorage.setItem(savedKey, JSON.stringify(list.slice(-30)));
    const refresh = () => {
      const list = readLibrary();
      select.innerHTML = '<option value="">Выбери сохранённое видео…</option>';
      list.forEach((item, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = item.name;
        select.appendChild(option);
      });
    };
    refresh();
    $("wtUseSaved").addEventListener("click", () => {
      const item = readLibrary()[Number(select.value)];
      if (!item || !window.socket) return;
      // Existing app's socket is lexical, so use the page's media control through
      // the exposed button hook below when available.
      if (typeof window.wtSetMedia === "function") window.wtSetMedia(item);
      else alert("Для повторного выбора добавь маленький обработчик в app.js (инструкция в README).");
    });
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const originalText = $("uploadStatus")?.textContent || "";
      const watch = new MutationObserver(() => {
        const text = $("uploadStatus")?.textContent || "";
        if (text !== originalText && /Файл загружен:/.test(text)) {
          const title = text.replace("Файл загружен:", "").trim();
          const video = stage.querySelector("video");
          const url = video?.currentSrc || video?.src;
          if (url) {
            const list = readLibrary().filter(item => item.url !== url);
            list.push({ name: title || file.name, url, type: "file" });
            saveLibrary(list);
            refresh();
          }
          watch.disconnect();
        }
      });
      watch.observe($("uploadStatus"), { childList: true, characterData: true, subtree: true });
    });
  }

  // Update room code storage when the room code display changes.
  const codeDisplay = $("roomCodeDisplay");
  if (codeDisplay) new MutationObserver(() => {
    const code = codeDisplay.textContent.trim();
    if (/^[A-Z0-9]{6}$/.test(code)) localStorage.setItem(KEY, code);
  }).observe(codeDisplay, { childList: true, characterData: true, subtree: true });
})();
