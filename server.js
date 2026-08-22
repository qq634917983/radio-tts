// AI 广播站服务（Node.js 版）：edge-tts(微软语音) 合成，本机扬声器播放，Web 控制台管理。
// 支持多播放列表、定时播放列表/单曲。API 与数据格式兼容 Python(FastAPI) 版。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const crypto = require('crypto');
const { Speaker, sleep } = require('./lib/player');
const tts = require('./lib/tts');

const BASE = __dirname;
const CACHE = path.join(BASE, 'audio_cache');
const STATE_FILE = path.join(BASE, 'state.json');
const PORT = Number(process.env.PORT) || 8000;
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

const player = new Speaker();

const rid = () => crypto.randomBytes(4).toString('hex');
const newPlaylist = (name = '默认列表') => ({ id: rid(), name, items: [] });

// ---------------- 状态：多播放列表 ----------------

let playlists = [newPlaylist()];
let activeId = playlists[0].id;   // 控制台当前操作的列表
let playMode = 'repeat_all';      // once | repeat_all | repeat_one
let playing = false;
let nowPlaying = null;            // {list_id, list_name, idx, total, id, text}
let schedules = [];
let playGen = 0;                  // 播放循环代号，防止新旧循环并跑

const getList = (pid) => playlists.find((p) => p.id === pid);
const findItem = (itemId) => {
  for (const p of playlists) for (const it of p.items) if (it.id === itemId) return it;
  return null;
};

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    playlists, active_id: activeId, play_mode: playMode,
    volume: player.volume, schedules,
  }, null, 2));
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
      file = await tts.synth(CACHE, it.text, it.voice, it.rate || 0, it.volume || 0);
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
  for (const s of [...schedules]) {
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
    if (!schedules.some((x) => x.id === s.id) || s.enabled === false) break;
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
      if (it) {
        tts.synth(CACHE, it.text, it.voice, it.rate || 0, it.volume || 0)
          .then((file) => player.playFile(file, { id: it.id, text: it.text }))
          .catch((e) => console.error('定时播放条目失败:', e.message));
      }
      break;
    }
    case 'announce':
      if (s.text) {
        tts.synth(CACHE, s.text, s.voice || DEFAULT_VOICE, 0, 0)
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
    volume: player.volume, schedules,
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

  // ---- 播放列表 CRUD ----
  if (b === 'playlists') {
    if (method === 'POST' && !c && b) {                     // 新建列表
      const body = await readJson(req);
      const pl = newPlaylist(String(body.name || '新列表').slice(0, 100));
      playlists.push(pl);
      activeId = pl.id;
      saveState();
      return send(res, 200, { ok: true, playlists, active_id: pl.id });
    }
    if (method === 'POST' && c && d === 'activate') {       // 切换当前操作列表
      if (getList(c)) { activeId = c; saveState(); }
      return send(res, 200, { ok: true, active_id: activeId });
    }
    if (method === 'POST' && c && !d) {                     // 重命名
      const body = await readJson(req);
      const pl = getList(c);
      if (pl) pl.name = String(body.name || pl.name).slice(0, 100);
      saveState();
      return send(res, 200, { ok: true, playlists });
    }
    if (method === 'DELETE' && c && !d) {                   // 删除列表
      if (playlists.length <= 1) return send(res, 400, { ok: false, msg: '至少保留一个列表' });
      playlists = playlists.filter((p) => p.id !== c);
      if (activeId === c) activeId = playlists[0].id;
      saveState();
      return send(res, 200, { ok: true, playlists, active_id: activeId });
    }
    if (method === 'POST' && c && d === 'items' && !e) {    // 新增条目
      const pl = getList(c);
      if (pl) {
        pl.items.push(cleanItem(await readJson(req)));
        saveState();
      }
      return send(res, 200, { ok: true, state: await getState() });
    }
    if (method === 'POST' && c && d === 'items' && e) {     // 更新条目
      const pl = getList(c);
      if (pl) {
        const i = pl.items.findIndex((it) => it.id === e);
        if (i >= 0) pl.items[i] = cleanItem(await readJson(req), e);
        saveState();
      }
      return send(res, 200, { ok: true, state: await getState() });
    }
    if (method === 'DELETE' && c && d === 'items' && e) {   // 删除条目
      const pl = getList(c);
      if (pl) {
        pl.items = pl.items.filter((it) => it.id !== e);
        saveState();
      }
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && c && d === 'order') {          // 排序
      const pl = getList(c);
      if (pl) {
        const ids = await readJson(req);
        const m = new Map(pl.items.map((it) => [it.id, it]));
        pl.items = ids.map((i) => m.get(i)).filter(Boolean)
          .concat(pl.items.filter((it) => !ids.includes(it.id)));
        saveState();
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
    (async () => {                                          // 异步执行插播，播完恢复
      try {
        const file = await tts.synth(CACHE, text, u.voice || DEFAULT_VOICE, 0, 0);
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
    if (['once', 'repeat_all', 'repeat_one'].includes(c)) { playMode = c; saveState(); }
    return send(res, 200, { ok: true, play_mode: playMode });
  }
  if (method === 'POST' && b === 'volume' && c) {
    const v = await player.setVolume(parseFloat(c));
    saveState();
    return send(res, 200, { ok: true, volume: v });
  }
  if (method === 'POST' && b === 'preview' && !c) {
    const item = cleanItem(await readJson(req));
    if (!item.text) return send(res, 400, { ok: false, msg: '文字不能为空' });
    tts.synth(CACHE, item.text, item.voice, item.rate, item.volume)
      .then((file) => player.playFile(file, { text: item.text }))
      .catch((err) => console.error('试听失败:', err.message));
    return send(res, 200, { ok: true });
  }

  // ---- 定时任务 ----
  if (b === 'schedule') {
    if (method === 'POST' && !c && b) {                     // 新建任务
      schedules.push(cleanSchedule(await readJson(req)));
      saveState();
      return send(res, 200, { ok: true, schedules });
    }
    if (method === 'POST' && c && d === 'toggle') {
      const s = schedules.find((x) => x.id === c);
      if (s) s.enabled = !(s.enabled !== false);
      saveState();
      return send(res, 200, { ok: true, schedules });
    }
    if (method === 'DELETE' && c && !d) {
      schedules = schedules.filter((x) => x.id !== c);
      saveState();
      return send(res, 200, { ok: true, schedules });
    }
  }

  return send(res, 404, { ok: false, msg: 'not found' });
}

// ---------------- 启动 ----------------

function migrateOld() {
  // 旧版 state.json 只有单列表 playlist 字段，自动迁移
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (d.playlist && !d.playlists) {
      const pl = newPlaylist('默认列表');
      pl.items = d.playlist;
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        playlists: [pl], active_id: pl.id,
        play_mode: d.play_mode || 'repeat_all',
        volume: d.volume ?? 1.0,
        schedules: d.schedules || [],
      }, null, 2));
    }
  } catch (e) { console.error('迁移失败:', e.message); }
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Array.isArray(d.playlists) && d.playlists.length) playlists = d.playlists;
    activeId = d.active_id || (playlists[0] && playlists[0].id);
    if (!getList(activeId)) activeId = playlists[0].id;
    playMode = d.play_mode || 'repeat_all';
    schedules = Array.isArray(d.schedules) ? d.schedules : [];
    player.volume = typeof d.volume === 'number' ? Math.max(0, Math.min(1, d.volume)) : 1.0;
  } catch (e) { console.error('读取状态失败:', e.message); }
}

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

fs.mkdirSync(CACHE, { recursive: true });
migrateOld();
loadState();
server.listen(PORT, '0.0.0.0', async () => {
  const ip = await lanIp();
  console.log(`局域网控制台: http://${ip}:${PORT}   （手机等设备访问此地址）`);
  console.log(`本机控制台: http://127.0.0.1:${PORT}`);
});
