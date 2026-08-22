# AI 智能广播站（Node.js 版）

基于微软 Edge-TTS 的局域网广播系统：服务端在本机扬声器播放音频，任意设备通过网页控制台远程管理。
是 Python(FastAPI + sounddevice) 版 `AI_radio` 的 Node.js 复刻，**API 与 `state.json` 数据格式完全兼容**，
可直接把旧版 `state.json` 拷到本目录无缝迁移。

## 功能

- **TTS 语音合成**：自实现 edge-tts 协议（WebSocket，含 Sec-MS-GEC 令牌 / 时钟偏移自校正），多种中文音色、语速可调，mp3 自动磁盘缓存（sha1 命名，跨进程稳定）
- **本机播放**：Windows 用系统自带 WMPlayer 组件（暂停 + 实时音量）；Linux/macOS 用 ffmpeg-static（npm 自动下载二进制，**无需 apt 安装任何播放器**，pulse → alsa 自动回退）
- **多播放列表**：创建 / 重命名 / 删除列表，条目拖拽排序（手机端 ↑↓ 按钮）、启用停用、试听
- **播放控制**：播放 / 暂停 / 停止 / 上一条 / 下一条，列表循环、单曲循环、播放一遍，音量调节
- **紧急插播**：随时打断当前播放插播一段文字，播完自动恢复原列表
- **定时任务**：按星期 + 时刻触发（播放列表 / 单条 / 停止 / 播报文字），支持执行次数与间隔重复、启用开关
- **局域网访问**：控制台显示局域网地址，手机等设备可直接打开
- **前端**：单文件 HTML + Tailwind CSS（本地文件 `static/tailwind.js`，无 CDN、无构建步骤、离线可用）

## 使用

要求 Node.js ≥ 18（建议 20+）。依赖：`ws`、`ffmpeg-static`（安装时自动下载对应平台的 ffmpeg 二进制）。

```bash
npm install     # 首次；ffmpeg 二进制由 npm 自动下载
npm start       # 启动，默认端口 8000
```

国内网络 ffmpeg 二进制下载慢时，用镜像源安装：

```bash
FFMPEG_BINARIES_URL=https://registry.npmmirror.com/-/binary/ffmpeg-static npm install
```

或双击 `启动广播站.bat`（自动探测局域网 IP 并打开 `http://<局域网IP>:8000`）。

服务监听 `0.0.0.0`（同时覆盖局域网与本机），控制台页面上也显示当前局域网地址，手机等设备直接访问即可。
已配置 Windows 防火墙入站规则「AI Radio Node (8000)」（TCP 8000 允许）；若换端口部署，需以管理员执行：

```bat
netsh advfirewall firewall add rule name="AI Radio Node (8100)" dir=in action=allow protocol=TCP localport=8100
```

- 端口被占用或想换端口：`set PORT=8100 && node server.js`（Linux/macOS：`PORT=8100 npm start`）
- 播放列表与定时任务持久化在 `state.json`（已加入 .gitignore）
- 唯一需要联网的功能是 TTS 合成（Edge-TTS 免费接口），已合成的条目缓存于 `audio_cache/`，离线可播；页面与样式完全本地化

## pm2 部署（可选）

```bash
pm2 start ecosystem.config.js
pm2 logs ai-radio-node
```

## 播放引擎

| 平台 | 引擎 | 说明 |
| --- | --- | --- |
| Windows | WMPlayer.OCX 守护进程 | 系统自带；暂停、实时音量 |
| Linux | ffmpeg-static | npm 自带二进制；`-f pulse` 优先，失败自动切 `-f alsa` |
| macOS | afplay | 系统自带 |

Linux 播放参数：`ffmpeg -re -i <mp3> -vn -af volume=<0-1> -f pulse default`；暂停/恢复用信号实现；
音量在每条开播时生效。服务启动时会自动补 `XDG_RUNTIME_DIR=/run/user/<uid>`，让 pm2/SSH
启动的进程也能找到 PipeWire/PulseAudio。

环境变量（均可选）：

| 变量 | 作用 |
| --- | --- |
| `FFMPEG_AUDIO_OUT` | `pulse` / `alsa` 强制输出；`null` 为静音解码（诊断用） |
| `FFMPEG_PATH` | 指定 ffmpeg 可执行文件路径 |
| `PLAYER_CMD` | 完整替换播放命令（播放时在末尾追加音频文件路径），如 `mpv --no-video` |
| `PORT` | 服务端口（默认 8000） |

### Linux 无声音排查

1. 日志报「ffmpeg 不可用」→ 重新 `npm install`（确认 `node_modules/ffmpeg-static/ffmpeg` 存在）
2. 日志报「pulse/alsa 均失败」→ `FFMPEG_AUDIO_OUT=alsa npm start` 试 ALSA 直通；
   桌面终端运行 `pactl info` 确认音频服务在跑
3. pm2 环境怀疑过期：改过环境变量后**重建**进程 `pm2 delete ai-radio-node && pm2 start ecosystem.config.js`
   （仅 restart 不刷新 pm2 注入的环境）

## 结构

```
server.js               # HTTP 服务：API 路由、播放循环、定时调度、状态持久化
lib/tts.js              # edge-tts 协议客户端（合成 + 音色列表 + 磁盘缓存）
lib/player.js           # 播放引擎：Windows WMPlayer 守护进程 + ffmpeg-static（Linux/macOS）
lib/wmp-daemon.ps1      # Windows 播放守护进程（stdin 命令 → WMP COM 控制）
static/index.html       # 网页控制台（单文件前端，Tailwind CSS）
static/tailwind.js      # Tailwind v4 浏览器版（本地文件，来自 npm 包 @tailwindcss/browser）
state.json              # 运行数据（自动生成，兼容 Python 版）
audio_cache/            # mp3 合成缓存（自动生成）
ecosystem.config.js     # pm2 进程配置
启动广播站.bat           # Windows 一键启动
```

## API 一览（与 Python 版一致）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/state` | 全量状态（列表/播放/定时/音量/局域网地址） |
| GET | `/api/voices` | 中文音色列表 |
| POST | `/api/playlists`、`/api/playlists/{pid}`、`/api/playlists/{pid}/activate` | 新建 / 重命名 / 切换列表 |
| DELETE | `/api/playlists/{pid}` | 删除列表（至少保留一个） |
| POST | `/api/playlists/{pid}/items`、`.../items/{iid}`、`.../order` | 条目增改 / 排序 |
| DELETE | `/api/playlists/{pid}/items/{iid}` | 删除条目 |
| POST | `/api/play/{pid}`、`/api/stop`、`/api/pause`、`/api/next`、`/api/prev` | 播放控制 |
| POST | `/api/urgent` | 紧急插播（播完恢复） |
| POST | `/api/mode/{mode}`、`/api/volume/{vol}`、`/api/preview` | 模式 / 音量 / 试听 |
| POST/DELETE | `/api/schedule`、`/api/schedule/{sid}/toggle`、`/api/schedule/{sid}` | 定时任务管理 |
