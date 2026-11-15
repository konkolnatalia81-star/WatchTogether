const express=require('express');
const http=require('http');
const path=require('path');
const fs=require('fs');
const crypto=require('crypto');
const multer=require('multer');
const {Server}=require('socket.io');
const {spawn}=require('child_process');

const app=express(),server=http.createServer(app);
const io=new Server(server,{maxHttpBufferSize:1e6,pingInterval:25000,pingTimeout:30000});
const PORT=Number(process.env.PORT)||3000;
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,'data');
const UPLOAD_DIR=process.env.UPLOAD_DIR||path.join(DATA_DIR,'uploads');
const CHUNK_DIR=path.join(DATA_DIR,'chunks');
const LIBRARY_FILE=path.join(DATA_DIR,'library.json');
const ROOMS_FILE=path.join(DATA_DIR,'rooms.json');
const MAX_UPLOAD=2*1024*1024*1024,CHUNK_SIZE=8*1024*1024,ROOM_CAPACITY=12,GRACE=10*60*1000;
for(const d of [DATA_DIR,UPLOAD_DIR,CHUNK_DIR,path.join(UPLOAD_DIR,'variants')])fs.mkdirSync(d,{recursive:true});
app.disable('x-powered-by');app.use(express.json({limit:'100kb'}));
app.use(express.static(path.join(__dirname,'public'),{etag:true,maxAge:'1h'}));
app.use('/uploads',express.static(UPLOAD_DIR,{acceptRanges:true,setHeaders:r=>r.setHeader('X-Content-Type-Options','nosniff')}));
const readJson=(f,def)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return def}};
let library=readJson(LIBRARY_FILE,[]);if(!Array.isArray(library))library=[];
const rooms=new Map();
function atomicSave(file,data){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2));fs.renameSync(tmp,file)}
function saveLibrary(){atomicSave(LIBRARY_FILE,library)}
function saveRooms(){atomicSave(ROOMS_FILE,[...rooms.values()].map(r=>({code:r.code,name:r.name,ownerId:r.ownerId,media:r.media,playback:r.playback,members:[...r.members.values()].map(m=>({sessionId:m.sessionId,name:m.name,disconnectedAt:m.connected?Date.now():m.disconnectedAt||Date.now()}))}))) }
for(const raw of readJson(ROOMS_FILE,[])){
 if(!raw?.code||!Array.isArray(raw.members))continue;
 const members=new Map(raw.members.map(m=>[m.sessionId,{...m,connected:false,socketId:null,expiry:null}]));
 if(members.size)rooms.set(raw.code,{...raw,members});
}
const socketsRoom=new Map(),socketsMember=new Map();
const CHARS='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function code(){for(let i=0;i<50;i++){const c=Array.from({length:6},()=>CHARS[crypto.randomInt(CHARS.length)]).join('');if(!rooms.has(c))return c}throw Error('Не удалось создать код')}
function safeName(v,max=24){return String(v||'Гость').replace(/[<>]/g,'').trim().slice(0,max)||'Гость'}
function safeSession(v){return /^[a-f0-9-]{20,80}$/i.test(String(v||''))?String(v):crypto.randomUUID()}
function publicRoom(r){return {code:r.code,name:r.name,ownerId:r.ownerId,participants:[...r.members.values()].filter(m=>m.connected).map(m=>({id:m.sessionId,name:m.name,isOwner:m.sessionId===r.ownerId,speaking:!!m.speaking})),media:r.media,playback:r.playback}}
function emitRoom(r){io.to(r.code).emit('room:update',publicRoom(r));saveRooms()}
function current(socket){const r=rooms.get(socketsRoom.get(socket.id));return {room:r,member:r?.members.get(socketsMember.get(socket.id))}}
function owner(socket,r){const sid=socketsMember.get(socket.id);return !!r&&r.ownerId===sid&&r.members.get(sid)?.connected}
function removeMember(r,sid,announce=true){const m=r?.members.get(sid);if(!m)return;clearTimeout(m.expiry);r.members.delete(sid);if(r.ownerId===sid)r.ownerId=r.members.keys().next().value||null;io.to(r.code).emit('voice:peer-left',{id:sid});if(!r.members.size)rooms.delete(r.code);else{emitRoom(r);if(announce)io.to(r.code).emit('chat:system',`${m.name} покинул(а) комнату`)}saveRooms()}
for(const r of rooms.values())for(const m of r.members.values())m.expiry=setTimeout(()=>{const latest=rooms.get(r.code),old=latest?.members.get(m.sessionId);if(old&&!old.connected)removeMember(latest,m.sessionId,false)},GRACE);
function detach(s){const c=socketsRoom.get(s.id),sid=socketsMember.get(s.id);socketsRoom.delete(s.id);socketsMember.delete(s.id);if(!c||!sid)return;const r=rooms.get(c),m=r?.members.get(sid);if(!m)return;m.connected=false;m.socketId=null;m.speaking=false;m.disconnectedAt=Date.now();s.leave(c);io.to(c).emit('voice:peer-left',{id:sid});emitRoom(r);m.expiry=setTimeout(()=>{const latest=rooms.get(c),old=latest?.members.get(sid);if(old&&!old.connected&&Date.now()-old.disconnectedAt>=GRACE)removeMember(latest,sid)},GRACE)}
function leave(s){const {room:r,member:m}=current(s);socketsRoom.delete(s.id);socketsMember.delete(s.id);if(!r||!m)return;s.leave(r.code);removeMember(r,m.sessionId)}
function isPrivateHost(host){return host==='localhost'||host.endsWith('.localhost')||host==='127.0.0.1'||host==='0.0.0.0'||host==='::1'||/^10\./.test(host)||/^192\.168\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host)}
function validHttpUrl(value){try{const u=new URL(value);return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password&&!isPrivateHost(u.hostname.toLowerCase())?u:null}catch{return null}}
function youtubeId(value){try{const u=new URL(value),h=u.hostname.toLowerCase();if(!['youtu.be','youtube.com','www.youtube.com','m.youtube.com'].includes(h))return null;const id=h==='youtu.be'?u.pathname.slice(1).split('/')[0]:u.searchParams.get('v')||u.pathname.split('/')[2];return /^[\w-]{11}$/.test(id||'')?id:null}catch{return null}}
function cleanMedia(m){if(!m||!['file','youtube','direct','external'].includes(m.type))return null;const url=String(m.url||'').trim();if(m.type==='youtube'&&!youtubeId(url))return null;if(m.type==='file'&&!/^\/uploads\/[a-f0-9-]+(?:\.[\w-]{1,12})?$/i.test(url))return null;if(['direct','external'].includes(m.type)&&!validHttpUrl(url))return null;return {type:m.type,url,title:safeName(m.title||'Видео',120),variants:m.type==='file'&&Array.isArray(m.variants)?m.variants.filter(v=>v&&['360p','480p','720p','1080p','original'].includes(v.label)&&/^\/uploads\/[\w./-]+$/.test(v.url)):[]}}
function ownerSession(session){return [...rooms.values()].some(r=>r.ownerId===session&&r.members.has(session))}
function authOwner(req,res,next){const sid=String(req.get('x-wt-session')||'');if(!safeSessionCheck(sid)||!ownerSession(sid))return res.status(403).json({error:'Только владелец комнаты может выполнять это действие.'});req.wtSession=sid;next()}
function safeSessionCheck(v){return /^[a-f0-9-]{20,80}$/i.test(v)}
function ffmpegAvailable(){return process.env.FFMPEG_PATH||'ffmpeg'}
function syncItemRooms(item){for(const r of rooms.values())if(r.media?.type==='file'&&r.media.url===item.url){r.media.variants=(item.variants||[]).filter(v=>v.status==='ready');emitRoom(r)}}
function transcode(item){const input=path.join(UPLOAD_DIR,path.basename(item.url));const ff=ffmpegAvailable();const probe=spawn(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-select_streams','v:0','-show_entries','stream=height','-of','csv=p=0',input],{stdio:['ignore','pipe','ignore']});let output='';probe.stdout.on('data',d=>output+=d);probe.on('error',()=>{item.transcodeStatus='unavailable';saveLibrary()});probe.on('close',()=>{const sourceHeight=Number.parseInt(output.trim(),10)||0;const heights=[360,480,720,1080].filter(h=>sourceHeight>=h);item.variants=[{label:'original',url:item.url,status:'ready'}];syncItemRooms(item);if(!heights.length){item.transcodeStatus='original-only';saveLibrary();return}item.transcodeStatus='processing';saveLibrary();const run=()=>{const h=heights.shift();if(!h){item.transcodeStatus='ready';saveLibrary();syncItemRooms(item);return}const outName=`${item.id}_${h}p.mp4`,out=path.join(UPLOAD_DIR,'variants',outName);const proc=spawn(ff,['-y','-i',input,'-vf',`scale=-2:${h}:force_original_aspect_ratio=decrease`,'-c:v','libx264','-preset','veryfast','-crf','24','-c:a','aac','-b:a','128k','-movflags','+faststart',out],{stdio:'ignore'});proc.on('error',()=>{item.transcodeStatus='unavailable';saveLibrary()});proc.on('close',code=>{if(code===0){item.variants.push({label:`${h}p`,url:`/uploads/variants/${outName}`,status:'ready'});saveLibrary();syncItemRooms(item)}run()})};run()})}
// Chunked/resumable upload API. Client keeps uploadId and asks the server which chunks arrived.
const uploads=new Map();
app.post('/api/upload/init',authOwner,(req,res)=>{const name=path.basename(String(req.body.name||'video')).slice(0,150),size=Number(req.body.size),type=String(req.body.type||'');if(!Number.isSafeInteger(size)||size<1||size>MAX_UPLOAD)return res.status(400).json({error:'Размер файла должен быть до 2 ГБ.'});if(!type.startsWith('video/'))return res.status(400).json({error:'Можно загружать только видео.'});const id=crypto.randomUUID();const dir=path.join(CHUNK_DIR,id);fs.mkdirSync(dir,{recursive:true});const count=Math.ceil(size/CHUNK_SIZE);const meta={id,dir,name,size,type,count,createdAt:Date.now()};fs.writeFileSync(path.join(dir,'meta.json'),JSON.stringify(meta));uploads.set(id,meta);res.json({uploadId:id,chunkSize:CHUNK_SIZE,totalChunks:count,received:[]})});
function getUpload(id){if(uploads.has(id))return uploads.get(id);if(!/^[a-f0-9-]{36}$/.test(id))return null;const dir=path.join(CHUNK_DIR,id);const meta=readJson(path.join(dir,'meta.json'),null);if(meta){uploads.set(id,meta);return meta}return null}
app.get('/api/upload/:id/status',authOwner,(req,res)=>{const u=getUpload(req.params.id);if(!u)return res.status(404).json({error:'Загрузка не найдена.'});const received=[];for(let i=0;i<u.count;i++)if(fs.existsSync(path.join(u.dir,`${i}.part`)))received.push(i);res.json({received,totalChunks:u.count,chunkSize:CHUNK_SIZE})});
app.put('/api/upload/:id/chunk/:index',authOwner,(req,res)=>{const u=getUpload(req.params.id),i=Number(req.params.index);if(!u||!Number.isInteger(i)||i<0||i>=u.count)return res.status(404).json({error:'Часть загрузки не найдена.'});let size=0;const out=fs.createWriteStream(path.join(u.dir,`${i}.part`));req.on('data',b=>{size+=b.length;if(size>CHUNK_SIZE){req.destroy();out.destroy()}});req.pipe(out);out.on('finish',()=>res.json({ok:true,index:i}));out.on('error',()=>res.status(500).json({error:'Не удалось сохранить часть файла.'}))});
app.post('/api/upload/:id/complete',authOwner,async(req,res)=>{const u=getUpload(req.params.id);if(!u)return res.status(404).json({error:'Загрузка не найдена.'});for(let i=0;i<u.count;i++)if(!fs.existsSync(path.join(u.dir,`${i}.part`)))return res.status(400).json({error:`Не хватает части ${i+1} из ${u.count}.`});const ext=path.extname(u.name).slice(0,10).replace(/[^.\w-]/g,'')||'.mp4',filename=crypto.randomBytes(16).toString('hex')+ext,filepath=path.join(UPLOAD_DIR,filename);const out=fs.createWriteStream(filepath);for(let i=0;i<u.count;i++){await new Promise((resolve,reject)=>{const s=fs.createReadStream(path.join(u.dir,`${i}.part`));s.on('error',reject);s.on('end',resolve);s.pipe(out,{end:false})})}out.end();await new Promise((resolve,reject)=>{out.on('finish',resolve);out.on('error',reject)});const item={id:crypto.randomUUID(),url:`/uploads/${filename}`,name:u.name,size:u.size,createdAt:new Date().toISOString(),variants:[],transcodeStatus:'queued'};library.unshift(item);saveLibrary();fs.rmSync(u.dir,{recursive:true,force:true});uploads.delete(u.id);transcode(item);res.status(201).json(item)});
app.get('/api/library',(_req,res)=>res.json({items:library.map(({id,url,name,size,createdAt,variants,transcodeStatus})=>({id,url,name,size,createdAt,variants:variants||[{label:'Оригинал',url}],transcodeStatus:transcodeStatus||'original-only'}))}));
app.delete('/api/library/:id',authOwner,(req,res)=>{const i=library.findIndex(x=>x.id===req.params.id);if(i<0)return res.status(404).json({error:'Видео не найдено.'});const [item]=library.splice(i,1);for(const v of [item.url,...(item.variants||[]).map(x=>x.url)]){const p=path.join(UPLOAD_DIR,path.basename(v));try{fs.unlinkSync(p)}catch{}}saveLibrary();res.json({ok:true})});

// Search the Internet Archive public movie catalogue and return browser-playable files.
app.get('/api/archive/search',async(req,res)=>{
 const raw=String(req.query.q||'').trim();
 const query=raw.replace(/[^\p{L}\p{N}\s-]/gu,' ').replace(/\s+/g,' ').slice(0,100).trim();
 if(query.length<2)return res.status(400).json({error:'Введи минимум 2 символа для поиска.'});
 const page=Math.min(20,Math.max(1,Number.parseInt(req.query.page,10)||1));
 try{
  const terms=query.split(' ').filter(Boolean).map(t=>`(title:${t} OR description:${t})`).join(' AND ');
  const params=new URLSearchParams({q:`mediatype:movies AND (${terms})`,fl:'identifier,title,year,description,creator,licenseurl,rights',rows:'12',page:String(page),output:'json',sort:'downloads desc'});
  const response=await fetch(`https://archive.org/advancedsearch.php?${params}`,{signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error('Archive search unavailable');
  const data=await response.json();
  const items=(data.response?.docs||[]).map(x=>({
   id:String(x.identifier||''),title:String(x.title||x.identifier||'Без названия').slice(0,180),
   year:String(x.year||'').slice(0,12),creator:String(x.creator||'').slice(0,120),
   description:String(x.description||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').slice(0,360),
   rights:String(x.licenseurl||x.rights||'').replace(/<[^>]*>/g,' ').slice(0,240),
   poster:`https://archive.org/services/img/${encodeURIComponent(String(x.identifier||''))}`,
   pageUrl:`https://archive.org/details/${encodeURIComponent(String(x.identifier||''))}`
  })).filter(x=>/^[a-zA-Z0-9_-]{3,80}$/.test(x.id));
  res.setHeader('Cache-Control','public,max-age=120');
  res.json({items,page,total:Number(data.response?.numFound||0)});
 }catch(e){res.status(502).json({error:e.name==='TimeoutError'?'Поиск слишком долго отвечает. Попробуй ещё раз.':'Каталог Internet Archive временно недоступен.'})}
});
app.get('/api/archive/item/:id',async(req,res)=>{
 const id=String(req.params.id||'');
 if(!/^[a-zA-Z0-9_-]{3,80}$/.test(id))return res.status(400).json({error:'Некорректный идентификатор фильма.'});
 try{
  const response=await fetch(`https://archive.org/metadata/${encodeURIComponent(id)}`,{signal:AbortSignal.timeout(12000)});
  if(!response.ok)throw Error('Metadata unavailable');
  const data=await response.json();
  const files=(Array.isArray(data.files)?data.files:[]).filter(f=>(!f.source||f.source==='original')&&/\.(mp4|m4v|webm)$/i.test(String(f.name||'')));
  files.sort((a,b)=>(/\\.mp4$/i.test(a.name)?0:/\\.webm$/i.test(a.name)?1:2)-(/\\.mp4$/i.test(b.name)?0:/\\.webm$/i.test(b.name)?1:2)||Number(b.size||0)-Number(a.size||0));
  if(!files.length)return res.status(404).json({error:'У этого фильма нет подходящего MP4/WebM для браузера. Выбери другой фильм.'});
  const file=files[0],encoded=String(file.name).split('/').map(encodeURIComponent).join('/');
  res.setHeader('Cache-Control','public,max-age=300');
  res.json({id,title:String(data.metadata?.title||id).slice(0,180),url:`https://archive.org/download/${encodeURIComponent(id)}/${encoded}`,fileName:String(file.name),rights:String(data.metadata?.licenseurl||data.metadata?.rights||'').replace(/<[^>]*>/g,' ').slice(0,300),pageUrl:`https://archive.org/details/${encodeURIComponent(id)}`});
 }catch{res.status(502).json({error:'Не удалось открыть фильм в Internet Archive. Попробуй другой.'})}
});

app.get('/api/health',(_req,res)=>res.json({ok:true,service:'WatchTogether'}));
app.get('/api/voice-config',(_req,res)=>{const iceServers=[{urls:process.env.STUN_URL||'stun:stun.l.google.com:19302'}];if(process.env.TURN_URL&&process.env.TURN_USERNAME&&process.env.TURN_CREDENTIAL)iceServers.push({urls:process.env.TURN_URL.split(',').map(x=>x.trim()).filter(Boolean),username:process.env.TURN_USERNAME,credential:process.env.TURN_CREDENTIAL});res.setHeader('Cache-Control','no-store');res.json({iceServers})});
function stopMedia(r){r.media=null;r.playback={playing:false,currentTime:0,updatedAt:Date.now()};io.to(r.code).emit('media:stopped');emitRoom(r);io.to(r.code).emit('playback:update',r.playback)}
io.on('connection',s=>{
 s.on('room:create',(p={},reply=()=>{})=>{leave(s);let c;try{c=code()}catch{return reply({ok:false,error:'Не удалось создать комнату.'})}const sid=safeSession(p.sessionId),r={code:c,name:safeName(p.roomName||'Комната просмотра',50),ownerId:sid,members:new Map(),media:null,playback:{playing:false,currentTime:0,updatedAt:Date.now()}};r.members.set(sid,{sessionId:sid,name:safeName(p.name),connected:true,socketId:s.id,speaking:false});rooms.set(c,r);s.join(c);socketsRoom.set(s.id,c);socketsMember.set(s.id,sid);saveRooms();reply({ok:true,room:publicRoom(r),sessionId:sid})});
 s.on('room:join',(p={},reply=()=>{})=>{const c=String(p.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'');if(c.length!==6)return reply({ok:false,error:'Код должен содержать 6 символов.'});const r=rooms.get(c);if(!r)return reply({ok:false,error:'Комната не найдена. Если она была создана до обновления, создай новую.'});const sid=safeSession(p.sessionId),old=r.members.get(sid);if(!old&&r.members.size>=ROOM_CAPACITY)return reply({ok:false,error:`В комнате не более ${ROOM_CAPACITY} участников.`});leave(s);if(old){clearTimeout(old.expiry);old.connected=true;old.socketId=s.id;old.name=safeName(p.name);old.disconnectedAt=null}else r.members.set(sid,{sessionId:sid,name:safeName(p.name),connected:true,socketId:s.id,speaking:false});s.join(c);socketsRoom.set(s.id,c);socketsMember.set(s.id,sid);emitRoom(r);reply({ok:true,room:publicRoom(r),sessionId:sid});if(!old)s.to(c).emit('chat:system',`${safeName(p.name)} присоединился(ась) к комнате`)});
 s.on('room:leave',()=>leave(s));
 s.on('chat:send',p=>{const {room:r,member:m}=current(s),t=String(p?.text||'').trim().slice(0,1000);if(r&&m&&t)io.to(r.code).emit('chat:message',{id:crypto.randomUUID(),name:m.name,text:t,time:new Date().toISOString(),isOwner:m.sessionId===r.ownerId})});
 s.on('media:set',p=>{const {room:r}=current(s);if(!owner(s,r))return;const m=cleanMedia(p?.media);if(!m)return s.emit('app:error','Ссылка не поддерживается или некорректна.');if(m.type==='file'){const item=library.find(x=>x.url===m.url);if(item)m.variants=(item.variants||[{label:'Оригинал',url:item.url}]).filter(v=>v.status==='ready'||!v.status)}r.media=m;r.playback={playing:false,currentTime:0,updatedAt:Date.now()};emitRoom(r);io.to(r.code).emit('playback:update',r.playback)});
 s.on('media:stop',()=>{const {room:r}=current(s);if(owner(s,r)&&r.media)stopMedia(r)});
 s.on('media:quality',p=>{const {room:r}=current(s);if(!owner(s,r)||r.media?.type!=='file')return;const url=String(p?.url||'');const allowed=(r.media.variants||[]).some(v=>v.url===url);if(!allowed)return;r.media.playUrl=url;const t=Number(p.currentTime);r.playback={playing:!!r.playback.playing,currentTime:Number.isFinite(t)?Math.max(0,t):r.playback.currentTime,updatedAt:Date.now()};emitRoom(r);io.to(r.code).emit('playback:update',r.playback)});
 s.on('media:stop-request',()=>{const {room:r,member:m}=current(s);if(!r||!m||m.sessionId===r.ownerId||!r.members.get(r.ownerId)?.connected)return;const requestId=crypto.randomUUID();io.to(r.members.get(r.ownerId).socketId).emit('media:stop-requested',{requestId,requesterId:m.sessionId,requesterName:m.name});s.emit('media:stop-request-sent',{requestId})});
 s.on('media:stop-response',p=>{const {room:r}=current(s);if(!owner(s,r)||!p?.requestId)return;if(p.accept){stopMedia(r);io.to(r.code).emit('media:stop-result',{requestId:p.requestId,accepted:true})}else{const req=[...r.members.values()].find(m=>m.connected&&m.sessionId===p.requesterId);if(req)io.to(req.socketId).emit('media:stop-result',{requestId:p.requestId,accepted:false})}});
 s.on('playback:control',p=>{const {room:r}=current(s);if(!owner(s,r)||!r.media||!['play','pause','seek'].includes(p?.action))return;const now=Date.now(),was=r.playback.playing,base=was?r.playback.currentTime+(now-r.playback.updatedAt)/1000:r.playback.currentTime,n=Number(p.currentTime),t=Number.isFinite(n)?Math.max(0,Math.min(n,7*24*3600)):base;r.playback={playing:p.action==='play'?true:p.action==='pause'?false:was,currentTime:p.action==='seek'?t:base,updatedAt:now};io.to(r.code).emit('playback:update',r.playback)});
 s.on('voice:speaking',p=>{const {room:r,member:m}=current(s);if(!r||!m)return;m.speaking=!!p?.speaking;emitRoom(r)});
 s.on('voice:signal',p=>{const {room:r,member:m}=current(s),target=r?.members.get(String(p?.to||''));if(!m||!target?.connected||!p?.data||typeof p.data!=='object')return;io.to(target.socketId).emit('voice:signal',{from:m.sessionId,data:p.data})});
 s.on('voice:ready',()=>{const {room:r,member:m}=current(s);if(!r||!m)return;r.members.forEach(x=>{if(x.connected&&x.sessionId!==m.sessionId)io.to(x.socketId).emit('voice:peer-joined',{id:m.sessionId})})});
 s.on('disconnect',()=>detach(s));
});
app.use((err,_req,res,_next)=>{console.error(err);res.status(400).json({error:err.message||'Ошибка запроса.'})});
server.listen(PORT,()=>console.log(`WatchTogether запущен на порту ${PORT}`));
