// 本机扬声器播放引擎。
// Windows：常驻 PowerShell + WMPlayer.OCX 守护进程（系统自带；暂停、实时音量）。
// Linux/macOS：直接调用系统播放器（Ubuntu 桌面自带 pw-play/paplay；或 mpv 等）；
//              都没有时兜底 ffmpeg-static 解码 → 管道 → aplay。
// 逃生口：PLAYER_CMD 指定完整播放命令；FFMPEG_PATH 换 ffmpeg 路径。
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** 在 PATH 里找可执行文件，返回名字或 null。 */
function findInPath(names) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const name of names) {
    for (const dir of dirs) {
      for (const ext of exts) {
        try { if (fs.existsSync(path.join(dir, name + ext.toLowerCase()))) return name; } catch (_) {}
      }
    }
  }
  return null;
}

/** 系统播放器候选列表（按优先级）。返回 [{cmd, args(file,vol)}]，只含 PATH 里存在的。 */
function systemPlayers() {
  const candidates = process.platform === 'darwin' ? [
    ['afplay', (file, v) => ['-v', String(Math.round(clamp01(v) * 255)), file]],
  ] : [
    ['pw-play', (file, v) => ['--volume', clamp01(v).toFixed(2), file]],                  // PipeWire 自带
    ['paplay',  (file, v) => ['--volume', String(Math.round(clamp01(v) * 65536)), file]], // Pulse 自带
    ['mpv',     (file, v) => ['--no-video', '--really-quiet', '--volume', String(Math.round(clamp01(v) * 100)), file]],
    ['mpg123',  (file) => ['-q', file]],
    ['ffplay',  (file, v) => ['-nodisplay', '-autoexit', '-loglevel', 'quiet',
                              '-volume', String(Math.round(clamp01(v) * 100)), file]],
  ];
  return candidates.filter(([name]) => findInPath([name]))
                   .map(([cmd, args]) => ({ cmd, args }));
}

class Speaker {
  constructor() {
    this.current = null;        // 当前播放条目描述，供界面显示
    this.volume = 1.0;
    this.paused = false;
    this.skipDir = null;        // 'next' | 'prev'
    this._stop = false;
    this._skip = false;
    this._pausedSent = false;   // 是否已向播放进程发送暂停
    this._chain = Promise.resolve();
    this._daemon = null;        // WMPlayer 守护进程 { child, send(cmd), dead }
    this._daemonTried = false;
    this._ffExe = undefined;    // ffmpeg 路径缓存
    this._sysList = undefined;  // 系统播放器候选（探测一次）
    this._sysIdx = 0;           // 上次成功的候选序号
  }

  // ================= Windows：WMPlayer 守护进程 =================

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

  // playState: 1=已停止 2=已暂停 3=播放中 8=媒体结束 9=转换中 10=就绪
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

  // ================= Linux/macOS：ffmpeg-static =================

  _ffmpegExe() {
    if (this._ffExe === undefined) {
      this._ffExe = process.env.FFMPEG_PATH ||
        (() => { try { return require('ffmpeg-static') || null; } catch (_) { return null; } })();
    }
    return this._ffExe;
  }

  // ---- ffmpeg 解码 → 管道 → aplay 发声（无系统播放器时的兜底） ----
  // 静态版 ffmpeg 无法使用系统 ALSA 动态插件（PipeWire 桥），直连 -f alsa 常失败；
  // 系统自带的 aplay 是动态链接、能正确路由到 PipeWire/PulseAudio。

  async _playPipeAplay(file) {
    const exe = this._ffmpegExe();
    const aplay = findInPath(['aplay']);
    if (!exe || !aplay) return 'no-pipe';
    const AR = '44100', CH = '2';
    const ff = spawn(exe,
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-re', '-i', file, '-vn',
       '-af', `volume=${clamp01(this.volume).toFixed(3)}`,
       '-f', 's16le', '-ar', AR, '-ac', CH, '-'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const ap = spawn(aplay,
      ['-q', '-t', 'raw', '-f', 'S16_LE', '-r', AR, '-c', CH],
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
    ff.stderr.on('data', (c) => { if (String(c).trim()) console.error('ffmpeg:', String(c).trim()); });
    ap.stderr.on('data', (c) => { if (String(c).trim()) console.error('aplay:', String(c).trim()); });
    ap.stdin.on('error', () => {});
    ff.stdout.pipe(ap.stdin);
    const both = Promise.all([
      new Promise((res) => ff.on('close', (c) => res(c))),
      new Promise((res) => ap.on('close', (c) => res(c))),
    ]);
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (this._stop || this._skip) {
        try { ff.kill('SIGKILL'); } catch (_) {}
        try { ap.kill('SIGKILL'); } catch (_) {}
      } else if (this.paused !== this._pausedSent) {
        this._pausedSent = this.paused;
        for (const p of [ff, ap]) {
          try { p.kill(this.paused ? 'SIGSTOP' : 'SIGCONT'); } catch (_) {}
        }
      }
    }, 150);
    const [ffCode] = await both;
    clearInterval(timer);
    if (this._stop) return 'stopped';
    if (this._skip) return 'skipped';
    if (ffCode === 0) return 'done';
    // aplay 打不开设备会立即退出（ffmpeg 还在写 → EPIPE）:视为坏路径交回调用方换方案
    if (Date.now() - t0 < 3000) return 'bad-pipe';
    return 'done';
  }

  /** 运行一个播放进程直到结束。multiSink 时把“快速失败+设备错误”识别为 bad-sink。 */
  _runProcess(exe, args, multiSink) {
    return new Promise((resolve) => {
      const child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let stderr = '';
      let settled = false;
      child.stderr.on('data', (c) => { stderr += c.toString(); });
      child.stdin && child.stdin.on('error', () => {});
      const t0 = Date.now();
      const finish = (r) => { if (!settled) { settled = true; clearInterval(timer); resolve(r); } };
      const timer = setInterval(() => {
        if (this._stop) { try { child.kill('SIGKILL'); } catch (_) {} finish('stopped'); }
        else if (this._skip) { try { child.kill('SIGKILL'); } catch (_) {} finish('skipped'); }
        else if (this.paused !== this._pausedSent) {
          this._pausedSent = this.paused;
          try { child.kill(this.paused ? 'SIGSTOP' : 'SIGCONT'); } catch (_) {}
        }
      }, 150);
      child.on('error', () => finish(multiSink ? 'bad-sink' : 'stopped'));
      child.on('close', (code) => {
        if (settled) return;
        this._lastStderr = stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300);
        if (code === 0) return finish('done');
        const fast = Date.now() - t0 < 3000;
        const deviceErr = /pulse|alsa|cannot open|no such|connection|device/i.test(stderr);
        finish(multiSink && fast && deviceErr ? 'bad-sink' : 'stopped');
      });
    });
  }

  // ================= 对外接口 =================

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
        const custom = (process.env.PLAYER_CMD || '').trim();
        if (process.platform === 'win32' && await this._startDaemon()) {
          reason = await this._playDaemon(file);                    // Windows: WMPlayer
        } else if (custom) {
          const parts = custom.split(/\s+/);
          reason = await this._runProcess(parts[0], parts.slice(1).concat(file), false);
        } else {
          // Linux/macOS: 依次尝试系统播放器，谁真正能播用谁（失败的会打出其报错）
          if (this._sysList === undefined) this._sysList = systemPlayers();
          const list = this._sysList.slice(this._sysIdx || 0)
            .concat(this._sysList.slice(0, this._sysIdx || 0));     // 从上次成功的开始
          for (let i = 0; i < list.length && reason === undefined; i++) {
            const r = await this._runProcess(list[i].cmd, list[i].args(file, this.volume), false);
            if (r === 'done' || this._stop || this._skip) {
              reason = r;
              this._sysIdx = (this._sysIdx || 0) + i;               // 记住赢家
              break;
            }
            console.error(`播放器 ${list[i].cmd} 失败(${r})` +
              (this._lastStderr ? `: ${this._lastStderr}` : '') + '，尝试下一个');
          }
          if (reason === undefined) {
            reason = await this._playPipeAplay(file);               // 兜底: ffmpeg 解码 → aplay
            if (reason === 'no-pipe' || reason === 'bad-pipe') {
              throw new Error('所有播放器均失败。建议桌面终端运行 npm run check -- --play 定位，' +
                              '或 sudo apt install mpv，或用 PLAYER_CMD 指定命令');
            }
          }
        }
      } catch (e) {
        console.error('播放失败:', e.message);
        reason = 'stopped';
      }
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
    if (this._daemon && !this._daemon.dead) {                       // WMPlayer 支持实时音量
      await this._daemon.send(`vol|${Math.round(this.volume * 100)}`).catch(() => {});
    }
    return this.volume;                                             // ffmpeg 路径下一条生效
  }

  async close() {
    if (this._daemon && !this._daemon.dead) {
      await this._daemon.send('quit').catch(() => {});
      setTimeout(() => { try { this._daemon.child.kill(); } catch (_) {} }, 500);
    }
  }
}

module.exports = { Speaker, sleep, clamp01, findInPath, systemPlayers };
