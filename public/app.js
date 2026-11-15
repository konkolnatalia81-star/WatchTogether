const socket = io({ reconnection:true, reconnectionAttempts:Infinity, reconnectionDelay:1000, reconnectionDelayMax:8000 });
const $ = id => document.getElementById(id);
let currentRoom=null, isOwner=false, mediaElement=null, ytPlayer=null, suppressPlayerEvents=false, localStream=null;
let iceServers=[{urls:"stun:stun.l.google.com:19302"}];
const peers=new Map(), remoteAudio=new Map();
const SESSION_KEY="wt_session_v2", ROOM_KEY="wt_room_v2", NAME_KEY="wt_name_v2";
let sessionId=localStorage.getItem(SESSION_KEY);
if(!sessionId){sessionId=crypto.randomUUID();localStorage.setItem(SESSION_KEY,sessionId);}
$("nickname").value=localStorage.getItem(NAME_KEY)||"";
window.onYouTubeIframeAPIReady=()=>{if(currentRoom?.media?.type==="youtube")renderMedia(currentRoom.media,currentRoom.playback);};
function toast(msg){$("toast").textContent=msg;$("toast").classList.add("show");clearTimeout(toast.timer);toast.timer=setTimeout(()=>$("toast").classList.remove("show"),3000);}
function nickname(){const n=$("nickname").value.trim()||"Гость";localStorage.setItem(NAME_KEY,n);return n;}
function setError(v){$("homeError").textContent=v||"";}
function showHome(){$("home").classList.remove("hidden");$("roomView").classList.add("hidden");}
function showRoom(){$("home").classList.add("hidden");$("roomView").classList.remove("hidden");}
function emitReply(event,data){return new Promise(resolve=>{if(!socket.connected)return resolve({ok:false,error:"Нет соединения с сервером."});socket.timeout(12000).emit(event,data,(err,result)=>resolve(err?{ok:false,error:"Сервер не ответил."}:result));});}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function setOwnerControls(){
 $("ownerTools").classList.toggle("hidden",!isOwner);$("ownerHint").textContent=isOwner?"Ты управляешь видео":"Управляет владелец";
 ["playBtn","backBtn","forwardBtn","seekBar"].forEach(id=>$(id).disabled=!isOwner);
 $("playBtn").textContent=currentRoom?.playback?.playing?"Ⅱ":"▶";
}
function enterRoom(room){
 const changed=currentRoom?.code!==room.code;currentRoom=room;isOwner=room.ownerId===sessionId;
 $("roomTitle").textContent=room.name;$("roomCodeDisplay").textContent=room.code;
 localStorage.setItem(ROOM_KEY,JSON.stringify({code:room.code,sessionId}));
 setOwnerControls();renderParticipants(room.participants||[]);
 if(room.media)renderMedia(room.media,room.playback);else clearMedia();
 showRoom();if(changed)$("chatMessages").innerHTML='<div class="chat-empty">Сообщения появятся здесь. Напиши первым!</div>';
}
function renderParticipants(list){
 $("peopleCount").textContent=list.length;
 $("peopleList").innerHTML=list.map(p=>`<div class="person"><div class="avatar">${esc((p.name||"?").slice(0,1).toUpperCase())}</div><span class="person-name">${esc(p.name)}</span>${p.isOwner?'<span class="person-role">Владелец</span>':""}</div>`).join("");
}
function destroyYouTube(){try{ytPlayer?.destroy?.();}catch{}ytPlayer=null;}
function clearMedia(){
 $("playerStage").replaceChildren();$("playerStage").dataset.mediaUrl="";
 const empty=document.createElement("div");empty.className="empty-player";empty.innerHTML='<div class="play-orb">▶</div><h3>Что будем смотреть?</h3><p>Владелец комнаты может добавить видео с YouTube или из библиотеки.</p>';$("playerStage").append(empty);
 $("mediaTitle").textContent="Видео пока не выбрано";$("timeLabel").textContent="00:00";$("durationLabel").textContent="00:00";$("seekBar").value=0;mediaElement=null;destroyYouTube();updatePlayButton();
}
function renderMedia(media,playback){
 if(!media)return clearMedia();$("mediaTitle").textContent=media.title||"Видео";
 if($("playerStage").dataset.mediaUrl===media.url&&(mediaElement||ytPlayer)){if(playback)applyPlayback(playback);return;}
 destroyYouTube();mediaElement=null;$("playerStage").replaceChildren();$("playerStage").dataset.mediaUrl=media.url;
 if(media.type==="file"){
  const v=document.createElement("video");v.src=media.url;v.controls=false;v.playsInline=true;v.preload="metadata";
  v.addEventListener("loadedmetadata",()=>{updateProgress(0,v.duration);if(playback)applyPlayback(playback);});
  v.addEventListener("timeupdate",()=>{if(!suppressPlayerEvents)updateProgress(v.currentTime,v.duration);});
  v.addEventListener("play",()=>updatePlayButton());v.addEventListener("pause",()=>updatePlayButton());
  v.addEventListener("ended",()=>{if(isOwner)sendPlayback("pause",v.currentTime);});
  v.addEventListener("error",()=>toast("Не удалось загрузить видеофайл."));
  $("playerStage").append(v);mediaElement=v;if(playback)applyPlayback(playback);
  return;
 }
 const id=youtubeId(media.url);if(!id){toast("Некорректная ссылка YouTube.");return;}
 if(!window.YT?.Player){const wait=document.createElement("p");wait.className="empty-player";wait.textContent="Загружается YouTube…";$("playerStage").append(wait);return;}
 const mount=document.createElement("div");mount.id="youtubePlayer";$("playerStage").append(mount);
 ytPlayer=new YT.Player("youtubePlayer",{videoId:id,width:"100%",height:"100%",playerVars:{playsinline:1,rel:0,enablejsapi:1},events:{
  onReady:()=>{if(playback)applyPlayback(playback);},
  onStateChange:e=>{if(!isOwner||suppressPlayerEvents||!ytPlayer)return;if(e.data===YT.PlayerState.PLAYING)sendPlayback("play",ytPlayer.getCurrentTime());if(e.data===YT.PlayerState.PAUSED)sendPlayback("pause",ytPlayer.getCurrentTime());updatePlayButton();},
  onError:()=>toast("YouTube не разрешил воспроизвести это видео.")
 }});
}
function youtubeId(value){try{const u=new URL(value),h=u.hostname.toLowerCase();if(h==="youtu.be")return u.pathname.slice(1).split("/")[0];if(!["youtube.com","www.youtube.com","m.youtube.com"].includes(h))return null;return u.pathname==="/watch"?u.searchParams.get("v"):u.pathname.split("/")[2]||null;}catch{return null;}}
function fmt(s){if(!Number.isFinite(s))return"00:00";s=Math.max(0,Math.floor(s));const h=Math.floor(s/3600),m=Math.floor(s/60)%60,x=s%60;return h?`${h}:${String(m).padStart(2,"0")}:${String(x).padStart(2,"0")}`:`${String(m).padStart(2,"0")}:${String(x).padStart(2,"0")}`;}
function updateProgress(t,d){$("timeLabel").textContent=fmt(t);if(Number.isFinite(d)&&d>0){$("durationLabel").textContent=fmt(d);$("seekBar").max=Math.floor(d);if(document.activeElement!==$("seekBar"))$("seekBar").value=Math.min(t,d);}}
function playerTime(){return mediaElement?.currentTime??ytPlayer?.getCurrentTime?.()??currentRoom?.playback?.currentTime??0;}
function updatePlayButton(){const playing=mediaElement?!mediaElement.paused:ytPlayer?.getPlayerState?.()===1;$("playBtn").textContent=playing?"Ⅱ":"▶";$("playBtn").title=playing?"Пауза":"Воспроизвести";}
function applyPlayback(state){
 if(!state||!currentRoom)return;const target=Math.max(0,state.currentTime+(state.playing?Math.max(0,Date.now()-state.updatedAt)/1000:0));suppressPlayerEvents=true;
 if(mediaElement){const apply=()=>{if(!mediaElement)return;try{if(Math.abs(mediaElement.currentTime-target)>1.3)mediaElement.currentTime=target;if(state.playing)mediaElement.play().catch(()=>toast("Нажми воспроизведение, чтобы разрешить запуск."));else mediaElement.pause();updateProgress(target,mediaElement.duration);}catch(e){console.warn(e);}};if(mediaElement.readyState>=1)apply();else mediaElement.addEventListener("loadedmetadata",apply,{once:true});}
 else if(ytPlayer?.seekTo){try{if(Math.abs(ytPlayer.getCurrentTime()-target)>1.3)ytPlayer.seekTo(target,true);state.playing?ytPlayer.playVideo():ytPlayer.pauseVideo();}catch(e){console.warn(e);}}
 clearTimeout(applyPlayback.timer);applyPlayback.timer=setTimeout(()=>{suppressPlayerEvents=false;updatePlayButton();},800);
}
function sendPlayback(action,time=playerTime()){if(isOwner&&currentRoom?.media)socket.emit("playback:control",{action,currentTime:time});}
function renderMessage(m){
 const box=$("chatMessages");if(box.querySelector(".chat-empty"))box.replaceChildren();const el=document.createElement("div");el.className=m.system?"system-message":"message";
 if(m.system)el.textContent=m.text;else{const t=new Date(m.time);const stamp=Number.isNaN(t.getTime())?"":t.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});el.innerHTML=`<div class="message-meta"><b>${esc(m.name)}</b>${m.isOwner?'<span class="person-role">Владелец</span>':""}<time>${esc(stamp)}</time></div><p>${esc(m.text)}</p>`;}
 box.append(el);box.scrollTop=box.scrollHeight;
}
async function createRoom(){setError("");const r=await emitReply("room:create",{name:nickname(),sessionId,roomName:"Комната просмотра"});if(!r?.ok)return setError(r?.error);sessionId=r.sessionId||sessionId;localStorage.setItem(SESSION_KEY,sessionId);enterRoom(r.room);renderMessage({system:true,text:"Комната создана. Отправь друзьям код приглашения."});}
async function joinRoom(code=$("roomCode").value.trim().toUpperCase()){setError("");if(code.length!==6)return setError("Введи код из 6 символов.");const r=await emitReply("room:join",{code,name:nickname(),sessionId});if(!r?.ok)return setError(r?.error);sessionId=r.sessionId||sessionId;localStorage.setItem(SESSION_KEY,sessionId);enterRoom(r.room);}
function explicitLeave(){stopVoice();socket.emit("room:leave");currentRoom=null;isOwner=false;localStorage.removeItem(ROOM_KEY);clearMedia();showHome();}
function switchTab(tab){document.querySelectorAll(".source-tab").forEach(b=>b.classList.toggle("active",b.dataset.tab===tab));$("youtubePanel").classList.toggle("hidden",tab!=="youtube");$("filePanel").classList.toggle("hidden",tab!=="file");}
async function loadLibrary(){
 try{const r=await fetch("/api/library");const data=await r.json();const list=$("libraryList");list.replaceChildren();
  if(!data.items?.length){list.innerHTML='<p class="hint">Пока нет сохранённых видео.</p>';return;}
  data.items.forEach(item=>{const row=document.createElement("div");row.className="library-item";const info=document.createElement("div");info.className="library-info";const name=document.createElement("b");name.textContent=item.name;const meta=document.createElement("small");meta.textContent=`${(item.size/1024/1024).toFixed(1)} МБ`;info.append(name,meta);const use=document.createElement("button");use.textContent="Выбрать";use.addEventListener("click",()=>{if(!isOwner)return;socket.emit("media:set",{media:{type:"file",url:item.url,title:item.name}});});const del=document.createElement("button");del.textContent="Удалить";del.className="library-delete";del.addEventListener("click",async()=>{if(!confirm("Удалить видео из библиотеки?"))return;const response=await fetch(`/api/library/${encodeURIComponent(item.id)}`,{method:"DELETE"});if(response.ok)loadLibrary();else toast("Не удалось удалить видео.");});row.append(info,use,del);list.append(row);});
 }catch{toast("Не удалось загрузить библиотеку.");}
}
function uploadVideo(file){
 return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open("POST","/api/upload");xhr.upload.onprogress=e=>{if(e.lengthComputable){const p=Math.round(e.loaded/e.total*100);$("uploadProgress").value=p;$("uploadProgressLabel").textContent=`Загрузка: ${p}%`;}};xhr.onload=()=>{let data={};try{data=JSON.parse(xhr.responseText);}catch{};xhr.status>=200&&xhr.status<300?resolve(data):reject(new Error(data.error||"Ошибка загрузки"));};xhr.onerror=()=>reject(new Error("Ошибка сети при загрузке."));const fd=new FormData();fd.append("video",file);xhr.send(fd);});
}
async function startVoice(){
 if(!currentRoom)return;if(!navigator.mediaDevices?.getUserMedia||!window.RTCPeerConnection)return toast("Голосовая связь требует HTTPS и поддержки WebRTC.");
 try{localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});$("micBtn").classList.add("active");$("micBtn").textContent="🎙 Выключить микрофон";$("voiceStatus").textContent="Микрофон включён";socket.emit("voice:ready");currentRoom.participants.filter(p=>p.id!==sessionId).forEach(p=>makePeer(p.id,sessionId.localeCompare(p.id)<0));}
 catch(e){localStream=null;toast(e.name==="NotAllowedError"?"Разреши доступ к микрофону в настройках браузера.":"Не удалось включить микрофон.");}
}
function makePeer(id,initiator){
 if(!localStream||peers.has(id))return;const pc=new RTCPeerConnection({iceServers});peers.set(id,pc);localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
 pc.onicecandidate=e=>{if(e.candidate)socket.emit("voice:signal",{to:id,data:{candidate:e.candidate}});};
 pc.ontrack=e=>{let a=remoteAudio.get(id);if(!a){a=document.createElement("audio");a.autoplay=true;a.playsInline=true;document.body.append(a);remoteAudio.set(id,a);}a.srcObject=e.streams[0];a.play().catch(()=>{});};
 pc.onconnectionstatechange=()=>{if(["failed","closed"].includes(pc.connectionState))removePeer(id);};
 if(initiator)pc.createOffer().then(o=>pc.setLocalDescription(o)).then(()=>socket.emit("voice:signal",{to:id,data:{description:pc.localDescription}})).catch(console.warn);
}
function removePeer(id){const p=peers.get(id);if(p){p.onconnectionstatechange=null;p.close();peers.delete(id);}const a=remoteAudio.get(id);if(a){a.srcObject=null;a.remove();remoteAudio.delete(id);}}
socket.on("voice:peer-joined",({id})=>{if(localStream&&id)makePeer(id,sessionId.localeCompare(id)<0);});
socket.on("voice:peer-left",({id})=>removePeer(id));
socket.on("voice:signal",async({from,data})=>{if(!localStream||!from||!data)return;if(!peers.has(from))makePeer(from,false);const pc=peers.get(from);if(!pc)return;try{if(data.description){await pc.setRemoteDescription(data.description);if(data.description.type==="offer"){const answer=await pc.createAnswer();await pc.setLocalDescription(answer);socket.emit("voice:signal",{to:from,data:{description:pc.localDescription}});}}else if(data.candidate)await pc.addIceCandidate(data.candidate);}catch(e){console.warn(e);}});
function stopVoice(){localStream?.getTracks().forEach(t=>t.stop());localStream=null;[...peers.keys()].forEach(removePeer);$("micBtn").classList.remove("active");$("micBtn").textContent="🎙 Включить микрофон";$("voiceStatus").textContent="Микрофон выключен";}
async function toggleFullscreen(){
 const stage=$("playerStage"),target=stage.querySelector("video")||stage.querySelector("iframe")?.parentElement||stage;
 try{if(document.fullscreenElement)await document.exitFullscreen();else if(target.requestFullscreen)await target.requestFullscreen();else if(stage.webkitEnterFullscreen)stage.webkitEnterFullscreen();else toast("Полноэкранный режим не поддерживается этим браузером.");}
 catch{toast("Браузер не разрешил полноэкранный режим.");}
}
$("createBtn").addEventListener("click",createRoom);$("joinBtn").addEventListener("click",()=>joinRoom());$("roomCode").addEventListener("input",e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6));$("roomCode").addEventListener("keydown",e=>{if(e.key==="Enter")joinRoom();});
$("leaveBtn").addEventListener("click",explicitLeave);$("copyCodeBtn").addEventListener("click",async()=>{if(!currentRoom)return;try{await navigator.clipboard.writeText(currentRoom.code);toast("Код скопирован.");}catch{toast(`Код группы: ${currentRoom.code}`);}});
document.querySelectorAll(".source-tab").forEach(b=>b.addEventListener("click",()=>{switchTab(b.dataset.tab);if(b.dataset.tab==="file")loadLibrary();}));
$("addYoutubeBtn").addEventListener("click",()=>{const url=$("youtubeUrl").value.trim();if(!isOwner||!youtubeId(url))return toast("Вставь корректную ссылку YouTube.");socket.emit("media:set",{media:{type:"youtube",url,title:"YouTube-видео"}});$("youtubeUrl").value="";});
$("videoFile").addEventListener("change",async e=>{const f=e.target.files[0];if(!f)return;if(!f.type.startsWith("video/")){toast("Выбери видеофайл.");return;}if(f.size>2*1024*1024*1024){toast("Максимальный размер — 2 ГБ.");return;}$("uploadProgress").classList.remove("hidden");$("uploadProgressLabel").textContent="Подготовка…";try{const item=await uploadVideo(f);socket.emit("media:set",{media:{type:"file",url:item.url,title:item.name}});$("uploadStatus").textContent=`Сохранено в библиотеку: ${item.name}`;loadLibrary();}catch(err){$("uploadStatus").textContent=err.message;}finally{$("uploadProgress").classList.add("hidden");e.target.value="";}});
$("playBtn").addEventListener("click",()=>{if(!isOwner||!currentRoom?.media)return;const playing=mediaElement?!mediaElement.paused:ytPlayer?.getPlayerState?.()===1;sendPlayback(playing?"pause":"play",playerTime());});
$("backBtn").addEventListener("click",()=>sendPlayback("seek",Math.max(0,playerTime()-10)));$("forwardBtn").addEventListener("click",()=>sendPlayback("seek",playerTime()+10));$("seekBar").addEventListener("input",e=>updateProgress(Number(e.target.value),Number($("seekBar").max)));$("seekBar").addEventListener("change",e=>sendPlayback("seek",Number(e.target.value)));
$("chatForm").addEventListener("submit",e=>{e.preventDefault();const t=$("chatInput").value.trim();if(t&&currentRoom){socket.emit("chat:send",{text:t});$("chatInput").value="";}});
$("micBtn").addEventListener("click",()=>localStream?stopVoice():startVoice());$("fullscreenBtn").addEventListener("click",toggleFullscreen);$("fullscreenMicBtn").addEventListener("click",()=>localStream?stopVoice():startVoice());
document.addEventListener("fullscreenchange",()=>{$("fullscreenOverlay").classList.toggle("hidden",!document.fullscreenElement);});
$("fullscreenExitBtn").addEventListener("click",()=>document.exitFullscreen?.());
socket.on("room:update",room=>{if(!currentRoom||room.code!==currentRoom.code)return;const prev=currentRoom.media?.url;currentRoom=room;isOwner=room.ownerId===sessionId;setOwnerControls();renderParticipants(room.participants||[]);if(room.media&&(room.media.url!==prev))renderMedia(room.media,room.playback);else if(!room.media)clearMedia();});
socket.on("playback:update",s=>{if(currentRoom){currentRoom.playback=s;applyPlayback(s);setOwnerControls();}});
socket.on("chat:message",renderMessage);socket.on("chat:system",t=>renderMessage({system:true,text:t}));socket.on("app:error",toast);
socket.on("disconnect",()=>{if(currentRoom){toast("Соединение потеряно. Переподключаемся…");stopVoice();}});
socket.on("connect",async()=>{
 try{const r=await fetch("/api/voice-config",{cache:"no-store"});const c=await r.json();if(c.iceServers?.length)iceServers=c.iceServers;}catch{}
 if(currentRoom){const r=await emitReply("room:join",{code:currentRoom.code,name:nickname(),sessionId});if(r?.ok)enterRoom(r.room);else{toast("Не удалось восстановить комнату. Проверь, не перезапускался ли сервер.");currentRoom=null;isOwner=false;localStorage.removeItem(ROOM_KEY);clearMedia();showHome();}}
 else{let saved;try{saved=JSON.parse(localStorage.getItem(ROOM_KEY)||"null");}catch{}if(saved?.code){const r=await emitReply("room:join",{code:saved.code,name:nickname(),sessionId:saved.sessionId||sessionId});if(r?.ok)enterRoom(r.room);}}
});
setInterval(()=>{if(currentRoom?.media){if(mediaElement)updateProgress(mediaElement.currentTime,mediaElement.duration);else if(ytPlayer?.getCurrentTime)updateProgress(ytPlayer.getCurrentTime(),ytPlayer.getDuration());}},1000);
