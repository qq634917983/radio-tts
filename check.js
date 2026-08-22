// 配置自检：验证播放引擎配置是否就绪。
//   node check.js          —— 无声检查（二进制/输出格式/会话环境）
//   node check.js --play   —— 额外真实播放一段音频（低音量）验证端到端
'use strict';
if (process.platform === 'linux' && !process.env.XDG_RUNTIME_DIR) {
  try {
    const fs = require('fs');
    const dir = `/run/user/${process.getuid()}`;
    if (fs.existsSync(dir)) process.env.XDG_RUNTIME_DIR = dir;
  } catch (_) {}
}
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ok = (msg) => console.log('  ✓', msg);
const bad = (msg) => console.log('  ✗', msg);
let failures = 0;

console.log('== radio-tts 配置自检 ==\n');

// 1. ffmpeg-static 二进制
console.log('[1] ffmpeg-static 二进制');
let ffmpeg = null;
try { ffmpeg = require('ffmpeg-static'); } catch (_) {}
if (ffmpeg && fs.existsSync(ffmpeg)) {
  ok(`已安装: ${ffmpeg}`);
  try {
    const ver = execFileSync(ffmpeg, ['-version']).toString().split('\n')[0];
    ok(`版本: ${ver}`);
  } catch (e) { bad('无法执行: ' + e.message); failures++; }
} else {
  bad('未找到二进制 → 重新执行 npm install（国内可加 FFMPEG_BINARIES_URL 镜像，见 README）');
  failures++;
}

// 2. 平台播放引擎
console.log('\n[2] 播放引擎');
if (process.platform === 'win32') {
  ok('Windows: 使用系统 WMPlayer 组件（无需 ffmpeg 发声，ffmpeg 仅备用）');
} else if (process.platform === 'darwin') {
  ok('macOS: 使用系统 afplay');
} else if (ffmpeg) {
  try {
    const formats = execFileSync(ffmpeg, ['-formats'], { encoding: 'utf8' });
    const hasPulse = /^ .E pulse\b/m.test(formats) || / pulse /m.test(formats);
    const hasAlsa = /^ .E alsa\b/m.test(formats) || / alsa /m.test(formats);
    if (hasPulse) ok('支持 pulse 输出（首选）');
    else { bad('不支持 pulse 输出'); failures++; }
    if (hasAlsa) ok('支持 alsa 输出（回退）');
    else console.log('  - 不支持 alsa 输出（仅有 pulse 也可用）');
  } catch (e) { bad('无法查询输出格式: ' + e.message); failures++; }
  if (process.env.XDG_RUNTIME_DIR) {
    const sock = path.join(process.env.XDG_RUNTIME_DIR);
    ok(`XDG_RUNTIME_DIR = ${sock}（能找到 PipeWire/PulseAudio 会话）`);
  } else {
    bad('XDG_RUNTIME_DIR 未设置且 /run/user/<uid> 不存在 → 后台进程可能发不出声');
    failures++;
  }
}

// 3. 依赖完整性
console.log('\n[3] 依赖');
for (const dep of ['ws']) {
  try { require.resolve(dep); ok(dep + ' 就绪'); }
  catch (_) { bad(dep + ' 缺失 → npm install'); failures++; }
}

// 4. 端到端播放验证
if (process.argv.includes('--play')) {
  console.log('\n[4] 端到端播放（低音量，应能听到"音频通道测试"）');
  (async () => {
    const { Speaker } = require('./lib/player');
    const tts = require('./lib/tts');
    try {
      const sp = new Speaker();
      await sp.setVolume(0.15);
      const file = await tts.synth(path.join(__dirname, 'audio_cache'), '音频通道测试。', 'zh-CN-XiaoxiaoNeural');
      const reason = await sp.playFile(file, { text: '自检' });
      await sp.close();
      if (reason === 'done') ok(`播放完成（结束原因: done）`);
      else { bad(`播放提前结束（原因: ${reason}）→ 查看上方日志`); failures++; }
    } catch (e) { bad('播放失败: ' + e.message); failures++; }
    finish();
  })();
} else {
  console.log('\n（加 --play 参数可真实播放一段音频做端到端验证）');
  finish();
}

function finish() {
  console.log('\n== 结果: ' + (failures ? `发现 ${failures} 个问题` : '全部通过 ✓') + ' ==');
  process.exit(failures ? 1 : 0);
}
