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

/** 外部播放器候选：返回 [命令, 参数...] */
function externalCandidate() {
  const isWin = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const names = isMac ? ['afplay'] : ['mpv', 'ffplay', 'cvlc', 'mpg123'];
  const found = findInPath(isWin ? ['mpv', 'ffplay'] : names);
  if (!found) return null;
  const vol = (v) => String(Math.round(clamp01(v) * 100));
  return {
    cmd: found.cmd,
    args: (file, volume) => {
      switch (found.base) {
        case 'mpv':    return ['--no-video', '--really-quiet', '--volume', vol(volume), file];
        case 'ffplay': return ['-nodisplay', '-autoexit', '-loglevel', 'quiet', '-volume', vol(volume), file];
        case 'cvlc':   return ['--play-and-exit', '--volume', vol(volume), file];
        case 'afplay': return ['-v', String(Math.round(clamp01(volume) * 255)), file];
        default:       return ['-q', file];                    // mpg123
      }
    },
  };
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
    if (!this._ext) return Promise.reject(new Error('未找到可用播放器（mpv/ffplay/afplay）'));
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
        const ok = process.platform === 'win32' ? await this._startDaemon() : false;
        reason = ok ? await this._playDaemon(file) : await this._playExternal(file);
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
    if (this._daemon && !this._daemon.dead) {
      await this._daemon.send(`vol|${Math.round(this.volume * 100)}`).catch(() => {});
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

module.exports = { Speaker, sleep, clamp01 };
