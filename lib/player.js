// 本机扬声器播放引擎。
// Windows 首选：常驻 PowerShell + WMPlayer.OCX 守护进程（支持暂停/实时音量）；
// 其余环境或 WMP 不可用时回退外部播放器（mpv/ffplay/afplay 等，暂停尽力而为）。
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

function findInPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const p = path.join(dir, name + ext.toLowerCase());
        try { if (fs.existsSync(p)) return { cmd: name + ext.toLowerCase(), base: name }; } catch (_) {}
      }
    }
  }
  return null;
}

/** 外部文件播放器候选（mp3）：返回 {cmd, args(file, volume)}。
 *  可用环境变量 PLAYER_CMD 覆盖（播放时末尾追加文件路径）。 */
function externalCandidate() {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const custom = (process.env.PLAYER_CMD || '').trim();
  if (custom) {
    const parts = custom.split(/\s+/);
    return { cmd: parts[0], args: (file) => parts.slice(1).concat(file), custom: true };
  }
  const names = isMac ? ['afplay'] : ['mpv', 'ffplay', 'cvlc', 'mpg123', 'play', 'gst-play-1.0'];
  const found = findInPath(isWin ? ['mpv', 'ffplay'] : names);
  if (!found) return null;
  const vol = (v) => String(Math.round(clamp01(v) * 100));
  switch (found.base) {
    case 'mpv':    return { cmd: found.cmd, args: (file, volume) => ['--no-video', '--really-quiet', '--volume', vol(volume), file] };
    case 'ffplay': return { cmd: found.cmd, args: (file, volume) => ['-nodisplay', '-autoexit', '-loglevel', 'quiet', '-volume', vol(volume), file] };
    case 'cvlc':   return { cmd: found.cmd, args: (file, volume) => ['--play-and-exit', '--volume', vol(volume), file] };
    case 'afplay': return { cmd: found.cmd, args: (file, volume) => ['-v', String(Math.round(clamp01(volume) * 255)), file] };
    case 'play':   return { cmd: found.cmd, args: (file, volume) => ['-q', '-v', String(clamp01(volume)), file] };   // sox
    default:       return { cmd: found.cmd, args: (file) => ['-q', file] };                                          // mpg123
  }
}

class Speaker {
  constructor() {
    this.current = null;        // 当前播放条目描述，供界面显示
    this.volume = 1.0;
    this.paused = false;
    this.skipDir = null;        // 'next' | 'prev'
    this._stop = false;
    this._skip = false;
    this._pausedSent = false;   // 是否已向设备发送暂停
    this._chain = Promise.resolve();
    this._daemon = null;        // { child, send(cmd), dead }
    this._daemonTried = false;
    this._ext = null;
  }

  // ---- WMPlayer 守护进程 ----

  _startDaemon() {
    if (this._daemon && !this._daemon.dead) return Promise.resolve(true);
    if (this._daemonTried && this._daemon && this._daemon.dead) return Promise.resolve(false);
    this._daemonTried = true;
    return new Promise((resolve) => {
      const script = path.join(__dirname, 'wmp-daemon.ps1');
      const child = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
        { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const pending = [];
      let settled = false;
      const timer = setTimeout(() => finish(false, new Error('守护进程启动超时')), 8000);
      const finish = (ok, err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!ok) {
          resolve(false);
          try { child.kill(); } catch (_) {}
          child.stdin.on('error', () => {});
          if (err) console.error('播放守护进程不可用:', err.message);
          return;
        }
        const d = this._daemon = {
          child,
          dead: false,
          send: (cmd) => new Promise((res, rej) => {
            if (d.dead) return rej(new Error('daemon 已退出'));
            pending.push({ res, rej });
            child.stdin.write(cmd + '\n');
          }),
        };
        child.stdin.on('error', () => {});
        child.on('exit', () => {
          d.dead = true;
          pending.forEach((p) => p.rej(new Error('daemon 已退出')));
          pending.length = 0;
        });
        readline.createInterface({ input: child.stdout }).on('line', (line) => {
          const p = pending.shift();
          if (p) p.res(line.trim());
        });
        resolve(true);
      };
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        if (settled) return;
        if (line.includes('READY')) finish(true);
        else if (line.includes('ERR')) finish(false, new Error(line.trim()));
      });
      child.on('error', (err) => finish(false, err));
      child.on('exit', () => { if (!settled) finish(false, new Error('守护进程提前退出')); });
    });
  }

  async _playDaemon(file) {
    await this._daemon.send(`vol|${Math.round(this.volume * 100)}`).catch(() => {});
    await this._daemon.send(`play|${file}`);
    let seenActive = false;
    const start = Date.now();
    while (true) {
      await sleep(150);
      if (this._stop) { await this._daemon.send('stop').catch(() => {}); return 'stopped'; }
      if (this._skip) { await this._daemon.send('stop').catch(() => {}); return 'skipped'; }
      if (this.paused !== this._pausedSent) {
        this._pausedSent = this.paused;
        await this._daemon.send(this.paused ? 'pause' : 'resume').catch(() => {});
      }
      const line = await this._daemon.send('state').catch(() => null);
      if (line === null) return 'stopped';            // 守护进程崩溃
      const st = parseInt(line.replace('STATE', '').trim(), 10);
      if (st === 3 || st === 8 || (st === 2 && seenActive)) seenActive = true;
      // 8=媒体自然结束；1=停止（播过之后出现即为结束）。从未播出且 4 秒后仍停止视为失败跳过
      if (st === 8 || (st === 1 && seenActive)) return 'done';
      if (st === 1 && Date.now() - start > 4000) return 'done';
    }
  }

  // ---- 外部播放器回退 ----

  _playExternal(file) {
    if (!this._ext) this._ext = externalCandidate();
    if (!this._ext) return Promise.reject(new Error(
      '未找到可用播放器。Linux 请安装其一: sudo apt install alsa-utils（提供 aplay，Ubuntu 桌面通常自带）' +
      '或 mpg123 / ffmpeg / mpv；也可用环境变量 PLAYER_CMD 指定命令'));
    return new Promise((resolve) => {
      const child = spawn(this._ext.cmd, this._ext.args(file, this.volume),
        { stdio: 'ignore', windowsHide: true });
      let result = null;
      const finish = (r) => { if (!result) { result = r; resolve(r); } };
      child.on('error', () => finish('stopped'));
      child.on('exit', () => finish(this._skip ? 'skipped' : this._stop ? 'stopped' : 'done'));
      const timer = setInterval(() => {
        if (this._stop || this._skip) {
          clearInterval(timer);
          try { child.kill('SIGKILL'); } catch (_) {}
          finish(this._stop ? 'stopped' : 'skipped');
        } else if (this.paused !== this._pausedSent) {
          this._pausedSent = this.paused;
          try { child.kill(this.paused ? 'SIGSTOP' : 'SIGCONT'); } catch (_) {}
        }
      }, 150);
      child.on('exit', () => clearInterval(timer));
    });
  }

  // ---- miniaudio_node 原生播放（Linux/macOS 首选；Rust+rodio，mp3 直读免装播放器） ----

  _loadMiniaudio() {
    if (this._ma === undefined) {
      try {
        const ma = require('miniaudio_node');
        ma.initializeAudio();
        this._ma = ma;
        const info = String(ma.getAudioInfo()).split('\n').slice(0, 3).join(' | ');
        console.log('miniaudio_node 就绪:', info);
      } catch (e) {
        console.error('miniaudio_node 不可用，回退外部播放器:', e.message);
        this._ma = null;
      }
    }
    return this._ma;
  }

  async _playMiniaudio(file) {
    const p = new this._ma.AudioPlayer();
    this._maPlayer = p;                      // 供实时调音量
    p.loadFile(file);
    p.setVolume(clamp01(this.volume));
    p.play();
    let seen = false;                        // 是否已进入过播放状态
    const start = Date.now();
    while (true) {
      await sleep(150);
      if (this._stop) { try { p.stop(); } catch (_) {} return 'stopped'; }
      if (this._skip) { try { p.stop(); } catch (_) {} return 'skipped'; }
      if (this.paused !== this._pausedSent) {
        this._pausedSent = this.paused;
        try { this.paused ? p.pause() : p.play(); } catch (_) {}
      }
      let playing = false;
      try { playing = p.isPlaying(); } catch (_) { return 'stopped'; }
      if (playing) { seen = true; continue; }
      // 暂停中 isPlaying 也是 false，只有非暂停时的 false 才算播完
      if (this.paused) continue;
      if (seen) return 'done';
      if (Date.now() - start > 4000) {
        console.warn('音频 4 秒未实际开始播放（疑似无可用输出设备），跳到下一条。' +
                     '若反复出现：在桌面终端运行验证，或设 PLAYER_CMD 指定播放命令');
        return 'done';
      }
    }
  }

  // ---- 对外接口 ----

  /** 播放一个文件，返回结束原因: stopped | skipped | done（调用方串行排队） */
  playFile(file, desc) {
    let resolveOuter;
    const p = new Promise((r) => (resolveOuter = r));
    this._chain = this._chain.then(async () => {
      this.current = desc;
      this.paused = false;
      this._pausedSent = false;
      this._stop = false;
      this._skip = false;
      let reason;
      try {
        if (process.platform === 'win32' && await this._startDaemon()) {
          reason = await this._playDaemon(file);          // Windows: WMPlayer 守护进程
        } else if ((this._ext || (this._ext = externalCandidate()))) {
          reason = await this._playExternal(file);        // Linux/macOS 首选：mpv 等外部播放器
        } else if (this._loadMiniaudio()) {
          reason = await this._playMiniaudio(file);       // 兜底：miniaudio_node 原生播放
        } else {
          reason = await this._playExternal(file);        // 走报错路径（含安装指引）
        }
      } catch (e) {
        console.error('播放失败:', e.message);
        reason = 'stopped';
      }
      this._maPlayer = null;
      this.current = null;
      resolveOuter(reason);
    });
    return p;
  }

  stop() { this._stop = true; this._skip = false; this.paused = false; }
  skip(dir) { this._skip = true; this._stop = false; this.paused = false; this.skipDir = dir; }
  togglePause() { this.paused = !this.paused; return this.paused; }
  async setVolume(v) {
    this.volume = clamp01(Number(v) || 0);
    if (this._daemon && !this._daemon.dead) {
      await this._daemon.send(`vol|${Math.round(this.volume * 100)}`).catch(() => {});
    }
    if (this._maPlayer) {
      try { this._maPlayer.setVolume(this.volume); } catch (_) {}
    }
    return this.volume;
  }

  async close() {
    if (this._daemon && !this._daemon.dead) {
      await this._daemon.send('quit').catch(() => {});
      setTimeout(() => { try { this._daemon.child.kill(); } catch (_) {} }, 500);
    }
  }
}

module.exports = { Speaker, sleep, clamp01, findInPath, externalCandidate };
