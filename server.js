// AI 广播站服务（Node.js 版）：edge-tts(微软语音) 合成，本机扬声器播放，Web 控制台管理。
// 存储模型：每个播放列表 = playlists/ 下的一个文件夹（内含自己的 mp3 与 meta.json 定时规则）；
// 试听/插播等临时合成进 audio_cache/，超过上限（默认 300MB）自动清空。
// API 与响应格式兼容旧版（Python 版 / 单 state.json 版），旧数据自动迁移。
'use strict';
// Linux 下 SSH/pm2 启动缺少用户会话环境变量时，音频后端找不到 PipeWire/PulseAudio 套接字，
// 播放流会被立刻丢弃。必须在加载播放引擎前补上。
if (process.platform === 'linux' && !process.env.XDG_RUNTIME_DIR) {
  try {
    const fs = require('fs');
    const dir = `/run/user/${process.getuid()}`;
    if (fs.existsSync(dir)) process.env.XDG_RUNTIME_DIR = dir;
  } catch (_) {}
}
const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const crypto = require('crypto');
const { Speaker, sleep } = require('./lib/player');
const tts = require('./lib/tts');

const BASE = __dirname;
const CACHE = path.join(BASE, 'audio_cache');
const PLAYLISTS_DIR = path.join(BASE, 'playlists');
const STATE_FILE = path.join(BASE, 'state.json');
const PORT = Number(process.env.PORT) || 8000;
const CACHE_LIMIT_MB = Number(process.env.CACHE_LIMIT_MB) || 300;
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

const player = new Speaker();
const rid = () => crypto.randomBytes(4).toString('hex');

// ---------------- 状态（内存镜像，落盘见下方存储层） ----------------

let playlists = [];               // [{id, name, dir, items[], schedules[]}]
let activeId = null;              // 控制台当前操作的列表
let playMode = 'repeat_all';      // once | repeat_all | repeat_one
let playing = false;
let nowPlaying = null;            // {list_id, list_name, idx, total, id, text}
let globalSchedules = [];         // 全局规则（stop/announce）；列表规则存在各自文件夹
let playGen = 0;                  // 播放循环代号，防止新旧循环并跑

const getList = (pid) => playlists.find((p) => p.id === pid);
const findItem = (itemId) => {
  for (const p of playlists) for (const it of p.items) if (it.id === itemId) return it;
  return null;
};
const itemOwner = (itemId) => playlists.find((p) => p.items.some((it) => it.id === itemId));
const allSchedules = () => globalSchedules.concat(...playlists.map((p) => p.schedules));

// ---------------- 存储层：列表=文件夹 ----------------

/** 文件夹安全名：去非法字符，避免与现有目录重名。 */
function safeDirName(name, taken) {
  let base = String(name || '列表').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 60) || '列表';
  let dir = base;
  for (let i = 2; taken.has(dir.toLowerCase()); i++) dir = `${base}-${i}`;
  taken.add(dir.toLowerCase());
  return dir;
}

function newPlaylist(name = '默认列表') {
  const dirName = safeDirName(name, new Set(fs.existsSync(PLAYLISTS_DIR)
    ? fs.readdirSync(PLAYLISTS_DIR) : []));
  const pl = { id: rid(), name, dir: path.join(PLAYLISTS_DIR, dirName), items: [], schedules: [] };
  fs.mkdirSync(pl.dir, { recursive: true });
  persistPlaylist(pl);
  return pl;
}

function persistPlaylist(pl) {
  fs.mkdirSync(pl.dir, { recursive: true });
  fs.writeFileSync(path.join(pl.dir, 'meta.json'), JSON.stringify({
    id: pl.id, name: pl.name, items: pl.items, schedules: pl.schedules,
  }, null, 2));
}

function persistGlobal() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    active_id: activeId, play_mode: playMode,
    volume: player.volume, global_schedules: globalSchedules,
  }, null, 2));
}

/** 删除列表文件夹内已无条目引用的 mp3（内容寻址，改名/编辑后回收孤儿文件）。 */
function cleanPlaylistFiles(pl) {
  try {
    const keep = new Set(pl.items.map((it) => tts.cacheName(it.text, it.voice, it.rate || 0, it.volume || 0)));
    for (const f of fs.readdirSync(pl.dir)) {
      if (f.endsWith('.mp3') && !keep.has(f)) {
        try { fs.unlinkSync(path.join(pl.dir, f)); } catch (_) {}
      }
    }
  } catch (_) {}
}

/** 试听/插播等临时合成入口：先检查缓存体积，超限整体清空再生成。 */
async function synthToCache(text, voice, rate = 0, volume = 0) {
  enforceCacheLimit();
  return tts.synth(CACHE, text, voice, rate, volume);
}

/** 列表条目合成入口：mp3 落在列表自己的文件夹里。 */
const synthForPlaylist = (pl, it) =>
  tts.synth(pl.dir, it.text, it.voice, it.rate || 0, it.volume || 0);

function enforceCacheLimit() {
  try {
    let total = 0;
    for (const f of fs.readdirSync(CACHE)) {
      try { total += fs.statSync(path.join(CACHE, f)).size; } catch (_) {}
    }
    if (total > CACHE_LIMIT_MB * 1024 * 1024) {
      for (const f of fs.readdirSync(CACHE)) {
        try { fs.unlinkSync(path.join(CACHE, f)); } catch (_) {}
      }
      console.log(`缓存已超过 ${CACHE_LIMIT_MB}MB（${(total / 1048576).toFixed(0)}MB），已清空 audio_cache/`);
    }
  } catch (_) {}
}

// ---------------- 加载与迁移 ----------------

function loadAll() {
  fs.mkdirSync(CACHE, { recursive: true });
  fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });

  // 从 playlists/*/meta.json 装载
  for (const entry of fs.readdirSync(PLAYLISTS_DIR)) {
    const dir = path.join(PLAYLISTS_DIR, entry);
    const metaFile = path.join(dir, 'meta.json');
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(metaFile)) continue;
    try {
      const m = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      playlists.push({
        id: m.id || rid(), name: String(m.name || entry).slice(0, 100), dir,
        items: Array.isArray(m.items) ? m.items : [],
        schedules: Array.isArray(m.schedules) ? m.schedules : [],
      });
    } catch (e) { console.error(`读取列表 ${entry} 失败:`, e.message); }
  }

  // 读全局设置（兼容未迁移的旧格式）
  if (fs.existsSync(STATE_FILE)) {
    try {
      const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      playMode = d.play_mode || 'repeat_all';
      player.volume = typeof d.volume === 'number' ? Math.max(0, Math.min(1, d.volume)) : 1.0;
      globalSchedules = Array.isArray(d.global_schedules) ? d.global_schedules
        : (Array.isArray(d.schedules) ? d.schedules : []);
      // 旧格式（state.json 内嵌 playlists）且尚无文件夹列表 → 迁移到文件夹
      if (!playlists.length && Array.isArray(d.playlists) && d.playlists.length) {
        migrateEmbedded(d);
      }
    } catch (e) { console.error('读取状态失败:', e.message); }
  }

  if (!playlists.length) playlists.push(newPlaylist());
  activeId = getList(d0Active()) ? d0Active() : playlists[0].id;
  function d0Active() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).active_id; }
    catch (_) { return null; }
  }
}

/** 把旧 state.json 内嵌的 playlists+schedules 迁移为文件夹模型，并搬运已有缓存 mp3。 */
function migrateEmbedded(d) {
  const taken = new Set(fs.readdirSync(PLAYLISTS_DIR));
  const idMap = {};
  for (const old of d.playlists) {
    const dirName = safeDirName(old.name, taken);
    const pl = {
      id: old.id || rid(), name: String(old.name || dirName).slice(0, 100),
      dir: path.join(PLAYLISTS_DIR, dirName),
      items: Array.isArray(old.items) ? old.items : [],
      schedules: [],
    };
    idMap[pl.id] = pl;
    playlists.push(pl);
    // 搬运缓存里已有的条目 mp3
    fs.mkdirSync(pl.dir, { recursive: true });
    for (const it of pl.items) {
      const src = path.join(CACHE, tts.cacheName(it.text, it.voice, it.rate || 0, it.volume || 0));
      if (fs.existsSync(src)) {
        try { fs.copyFileSync(src, path.join(pl.dir, path.basename(src))); } catch (_) {}
      }
    }
    persistPlaylist(pl);
  }
  // 旧全局规则分流：指向列表的进文件夹，stop/announce 留全局
  globalSchedules = [];
  for (const s of (d.schedules || [])) {
    const owner = (s.action === 'play_list' && idMap[s.target]) || (s.action === 'play_item' && itemOwner(s.target));
    if (owner) owner.schedules.push(s);
    else globalSchedules.push(s);
  }
  playlists.forEach(persistPlaylist);
  console.log(`已迁移 ${playlists.length} 个列表到 playlists/ 文件夹模型`);
}

// ---------------- 播放循环 ----------------

async function playLoop(pl, mode, gen) {
  let idx = 0;
  while (playing && gen === playGen) {
    const items = pl.items.filter((it) => it.enabled !== false);
    if (!items.length) break;
    const n = items.length;
    if (idx >= n) {
      if (mode === 'once') break;
      idx = 0;
    }
    if (idx < 0) idx = n - 1;
    const it = items[idx];
    nowPlaying = { list_id: pl.id, list_name: pl.name, idx: idx + 1, total: n,
                   id: it.id, text: it.text };
    let file;
    try {
      file = await synthForPlaylist(pl, it);
    } catch (e) {
      console.error('合成失败:', e.message);
      await sleep(1000);
      idx += 1;
      continue;
    }
    const reason = await player.playFile(file, { id: it.id, text: it.text, list: pl.name, ...it });
    if (reason === 'stopped') break;
    const step = mode === 'repeat_one' ? 0 : 1;
    if (reason === 'skipped' && player.skipDir === 'prev') {
      idx -= (step + 1);
      player.skipDir = null;
    } else {
      idx += step;
    }
  }
  if (gen === playGen) { playing = false; nowPlaying = null; }
}

function startPlayback(pl, mode = null) {
  if (playing) return;
  playing = true;
  playGen += 1;
  const gen = playGen;
  playLoop(pl, mode || playMode, gen).catch((e) => console.error('播放循环异常:', e));
}

function stopPlayback() {
  playing = false;
  player.stop();
}

// ---------------- 定时任务 ----------------

const fired = new Map();

async function schedulerTick() {
  const now = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const hm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const weekday = (now.getDay() + 6) % 7;   // 0=周一 .. 6=周日，与前端一致
  for (const s of allSchedules()) {
    if ((s.days || []).includes(weekday) && s.time === hm && s.enabled !== false) {
      const key = `${s.id}-${now.toDateString()}-${hm}`;
      if (fired.has(key)) continue;
      fired.set(key, true);
      console.log('定时触发:', s.name);
      runScheduleRepeats(s).catch((e) => console.error('定时任务出错:', e.message));
    }
  }
  if (fired.size > 500) fired.clear();
}

async function runScheduleRepeats(s) {
  const count = Math.max(1, parseInt(s.repeat_count, 10) || 1);
  const interval = Math.max(0, parseFloat(s.interval_min) || 0);
  for (let i = 0; i < count; i++) {
    if (!allSchedules().some((x) => x.id === s.id) || s.enabled === false) break;
    try { await runScheduleOnce(s); }
    catch (e) { console.error('定时任务出错:', e.message); }
    if (i < count - 1 && interval > 0) await sleep(interval * 60 * 1000);
  }
}

async function runScheduleOnce(s) {
  switch (s.action) {
    case 'stop':
      stopPlayback();
      break;
    case 'play_list': {
      const pl = getList(s.target);
      if (pl && pl.items.length) {
        stopPlayback();
        await sleep(300);
        startPlayback(pl, s.play_mode || 'repeat_all');
      }
      break;
    }
    case 'play_item': {
      const it = findItem(s.target);
      const owner = it && itemOwner(it.id);
      if (it && owner) {
        synthForPlaylist(owner, it)
          .then((file) => player.playFile(file, { id: it.id, text: it.text }))
          .catch((e) => console.error('定时播放条目失败:', e.message));
      }
      break;
    }
    case 'announce':
      if (s.text) {
        synthToCache(s.text, s.voice || DEFAULT_VOICE, 0, 0)
          .then((file) => player.playFile(file, { text: s.text }))
          .catch((e) => console.error('定时播报失败:', e.message));
      }
      break;
  }
}

setInterval(schedulerTick, 5000);

// ---------------- 局域网地址 ----------------

let lanIpCache = null;
function lanIp() {
  if (lanIpCache) return Promise.resolve(lanIpCache);
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (ip) => { lanIpCache = ip; try { sock.close(); } catch (_) {} resolve(ip); };
    sock.on('error', () => { try { sock.close(); } catch (_) {} resolve('127.0.0.1'); });
    sock.connect(80, '8.8.8.8', () => {
      try { done(sock.address().address); } catch (_) { resolve('127.0.0.1'); }
    });
  });
}

async function getState() {
  return {
    playlists, active_id: activeId, play_mode: playMode, playing,
    paused: player.paused, current: player.current, now_playing: nowPlaying,
    volume: player.volume, schedules: allSchedules(),
    lan: `http://${await lanIp()}:${PORT}`,
  };
}

// ---------------- 音色列表（内存缓存） ----------------

let voicesCache = null;
async function getVoices() {
  if (voicesCache) return voicesCache;
  const all = await tts.listVoices();
  voicesCache = all
    .filter((v) => String(v.Locale || '').startsWith('zh-'))
    .map((v) => ({ name: v.ShortName, gender: v.Gender, locale: v.Locale }));
  return voicesCache;
}

// ---------------- HTTP 基础设施 ----------------

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (_) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

function cleanItem(d, id) {
  return {
    id: id || rid(),
    text: String(d.text || '').slice(0, 10000),
    voice: d.voice || DEFAULT_VOICE,
    rate: Math.round(Number(d.rate) || 0),
    volume: Math.round(Number(d.volume) || 0),
    enabled: d.enabled !== false,
  };
}

function cleanSchedule(d) {
  return {
    id: rid(),
    name: String(d.name || '定时任务').slice(0, 100),
    time: /^\d{1,2}:\d{2}$/.test(d.time || '') ? d.time : '08:00',
    days: Array.isArray(d.days) ? d.days.map(Number).filter((x) => x >= 0 && x <= 6) : [],
    action: ['play_list', 'play_item', 'stop', 'announce'].includes(d.action) ? d.action : 'stop',
    target: String(d.target || ''),
    play_mode: ['once', 'repeat_all', 'repeat_one'].includes(d.play_mode) ? d.play_mode : 'repeat_all',
    text: String(d.text || '').slice(0, 10000),
    voice: d.voice || DEFAULT_VOICE,
    enabled: d.enabled !== false,
    repeat_count: Math.max(1, parseInt(d.repeat_count, 10) || 1),
    interval_min: Math.max(0, parseFloat(d.interval_min) || 0),
  };
}

/** 定时规则的归属：指向列表的存进对应文件夹，stop/announce 存全局。 */
function scheduleOwner(s) {
  if (s.action === 'play_list') return getList(s.target) || null;
  if (s.action === 'play_item') return itemOwner(s.target) || null;
  return null;   // 全局
}

// ---------------- 路由 ----------------

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  const method = req.method;
  const [a, b, c, d, e] = parts;

  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(BASE, 'static', 'index.html')));
    return;
  }
  if (method === 'GET' && /^\/[\w.-]+$/.test(url.pathname)) {   // static/ 下静态文件（tailwind.js 等）
    const file = path.join(BASE, 'static', path.basename(url.pathname));
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
                      '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml' };
      res.writeHead(200, {
        'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(fs.readFileSync(file));
      return;
    }
  }
  if (!parts.length || a !== 'api') return send(res, 404, { ok: false, msg: 'not found' });

  // ---- 查询 ----
  if (method === 'GET' && b === 'state' && !c) return send(res, 200, await getState());
  if (method === 'GET' && b === 'voices' && !c) {
    try { return send(res, 200, await getVoices()); }
    catch (err) { return send(res, 502, { ok: false, msg: err.message }); }
  }

  // ---- 播放列表 CRUD（每个列表=一个文件夹） ----
  if (b === 'playlists') {
    if (method === 'POST' && !c) {                            // 新建列表 → 新建文件夹
      const body = await readJson(req);
      const pl = newPlaylist(String(body.name || '新列表').slice(0, 100));
      playlists.push(pl);
      activeId = pl.id;
      persistGlobal();
      return send(res, 200, { ok: true, playlists, active_id: pl.id });
    }
    if (method === 'POST' && c && d === 'activate') {         // 切换当前操作列表
      if (getList(c)) { activeId = c; persistGlobal(); }
      return send(res, 200, { ok: true, active_id: activeId });
    }
    if (method === 'POST' && c && !d) {                       // 重命名 → 文件夹同步改名
      const body = await readJson(req);
      const pl = getList(c);
      if (pl) {
        const newName = String(body.name || pl.name).slice(0, 100);
        if (newName !== pl.name) {
          const taken = new Set(playlists.filter((p) => p !== pl)
            .map((p) => path.basename(p.dir).toLowerCase()));
          const dirName = safeDirName(newName, taken);
          const newDir = path.join(PLAYLISTS_DIR, dirName);
          if (fs.existsSync(pl.dir)) {
            try { fs.renameSync(pl.dir, newDir); } catch (_) { fs.mkdirSync(newDir, { recursive: true }); }
          } else fs.mkdirSync(newDir, { recursive: true });
          pl.dir = newDir;
          pl.name = newName;
        }
        persistPlaylist(pl);
      }
      return send(res, 200, { ok: true, playlists });
    }
    if (method === 'DELETE' && c && !d) {                     // 删除列表 → 删除文件夹（含其定时规则）
      if (playlists.length <= 1) return send(res, 400, { ok: false, msg: '至少保留一个列表' });
      const pl = getList(c);
      playlists = playlists.filter((p) => p.id !== c);
      if (pl) { try { fs.rmSync(pl.dir, { recursive: true, force: true }); } catch (_) {} }
      if (activeId === c) activeId = playlists[0].id;
      persistGlobal();
      return send(res, 200, { ok: true, playlists, active_id: activeId });
    }
    if (method === 'POST' && c && d === 'items' && !e) {      // 新增条目
      const pl = getList(c);
      if (pl) {
        pl.items.push(cleanItem(await readJson(req)));
        persistPlaylist(pl);
        cleanPlaylistFiles(pl);
      }
      return send(res, 200, { ok: true, state: await getState() });
    }
    if (method === 'POST' && c && d === 'items' && e) {       // 更新条目
      const pl = getList(c);
      if (pl) {
        const i = pl.items.findIndex((it) => it.id === e);
        if (i >= 0) pl.items[i] = cleanItem(await readJson(req), e);
        persistPlaylist(pl);
        cleanPlaylistFiles(pl);
      }
      return send(res, 200, { ok: true, state: await getState() });
    }
    if (method === 'DELETE' && c && d === 'items' && e) {     // 删除条目
      const pl = getList(c);
      if (pl) {
        pl.items = pl.items.filter((it) => it.id !== e);
        persistPlaylist(pl);
        cleanPlaylistFiles(pl);
      }
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && c && d === 'order') {            // 排序
      const pl = getList(c);
      if (pl) {
        const ids = await readJson(req);
        const m = new Map(pl.items.map((it) => [it.id, it]));
        pl.items = ids.map((i) => m.get(i)).filter(Boolean)
          .concat(pl.items.filter((it) => !ids.includes(it.id)));
        persistPlaylist(pl);
      }
      return send(res, 200, { ok: true, state: await getState() });
    }
  }

  // ---- 播放控制 ----
  if (method === 'POST' && b === 'play' && c) {
    const pl = getList(c);
    if (pl && pl.items.length) {
      stopPlayback();
      await sleep(200);
      startPlayback(pl);
    }
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && b === 'stop' && !c) { stopPlayback(); return send(res, 200, { ok: true }); }
  if (method === 'POST' && b === 'pause' && !c) {
    const paused = player.togglePause();
    return send(res, 200, { ok: true, paused });
  }
  if (method === 'POST' && (b === 'next' || b === 'prev') && !c) {
    player.skip(b);
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && b === 'urgent' && !c) {
    const u = await readJson(req);
    const text = String(u.text || '').slice(0, 10000);
    if (!text) return send(res, 400, { ok: false, msg: '插播文字不能为空' });
    const wasPlaying = playing;
    const resumeId = nowPlaying ? nowPlaying.list_id : null;
    if (wasPlaying) { playing = false; player.stop(); await sleep(200); }
    (async () => {                                            // 异步执行插播，播完恢复
      try {
        const file = await synthToCache(text, u.voice || DEFAULT_VOICE, 0, 0);
        await player.playFile(file, { text, urgent: true });
      } catch (err) { console.error('插播失败:', err.message); }
      if (u.resume !== false && wasPlaying) {
        const pl = resumeId ? getList(resumeId) : null;
        if (pl && pl.items.length) {
          playing = false;
          await sleep(200);
          startPlayback(pl);
        }
      }
    })();
    return send(res, 200, { ok: true });
  }
  if (method === 'POST' && b === 'mode' && c) {
    if (['once', 'repeat_all', 'repeat_one'].includes(c)) { playMode = c; persistGlobal(); }
    return send(res, 200, { ok: true, play_mode: playMode });
  }
  if (method === 'POST' && b === 'volume' && c) {
    const v = await player.setVolume(parseFloat(c));
    persistGlobal();
    return send(res, 200, { ok: true, volume: v });
  }
  if (method === 'POST' && b === 'preview' && !c) {           // 试听：mp3 只进缓存目录
    const item = cleanItem(await readJson(req));
    if (!item.text) return send(res, 400, { ok: false, msg: '文字不能为空' });
    synthToCache(item.text, item.voice, item.rate, item.volume)
      .then((file) => player.playFile(file, { text: item.text }))
      .catch((err) => console.error('试听失败:', err.message));
    return send(res, 200, { ok: true });
  }

  // ---- 定时任务（列表规则存文件夹 meta.json，其余存全局） ----
  if (b === 'schedule') {
    if (method === 'POST' && !c) {                            // 新建任务
      const s = cleanSchedule(await readJson(req));
      const owner = scheduleOwner(s);
      if (owner) owner.schedules.push(s);
      else globalSchedules.push(s);
      owner ? persistPlaylist(owner) : persistGlobal();
      return send(res, 200, { ok: true, schedules: allSchedules() });
    }
    if (method === 'POST' && c && d === 'toggle') {
      const s = allSchedules().find((x) => x.id === c);
      if (s) {
        s.enabled = !(s.enabled !== false);
        const owner = scheduleOwner(s);
        owner ? persistPlaylist(owner) : persistGlobal();
      }
      return send(res, 200, { ok: true, schedules: allSchedules() });
    }
    if (method === 'DELETE' && c && !d) {
      const owner = playlists.find((p) => p.schedules.some((x) => x.id === c));
      if (owner) owner.schedules = owner.schedules.filter((x) => x.id !== c);
      else globalSchedules = globalSchedules.filter((x) => x.id !== c);
      owner ? persistPlaylist(owner) : persistGlobal();
      return send(res, 200, { ok: true, schedules: allSchedules() });
    }
  }

  return send(res, 404, { ok: false, msg: 'not found' });
}

// ---------------- 启动 ----------------

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error('请求处理出错:', e.message);
    try { send(res, 500, { ok: false, msg: e.message }); } catch (_) {}
  });
});

function shutdown() {
  console.log('正在退出…');
  stopPlayback();
  player.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

loadAll();
persistGlobal();   // 统一刷一次全局设置（含迁移后的收敛）
server.listen(PORT, '0.0.0.0', async () => {
  const ip = await lanIp();
  console.log(`局域网控制台: http://${ip}:${PORT}   （手机等设备访问此地址）`);
  console.log(`本机控制台: http://127.0.0.1:${PORT}`);
  console.log(`列表目录: ${PLAYLISTS_DIR}   缓存上限: ${CACHE_LIMIT_MB}MB`);
});
