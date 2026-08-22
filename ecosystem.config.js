// pm2 进程配置：radio-tts 广播站
// 启动: pm2 start ecosystem.config.js
module.exports = {
  apps: [{
    name: 'radio-tts',
    script: 'server.js',
    cwd: __dirname,
    autorestart: true,            // 崩溃自动重启
    max_restarts: 20,
    max_memory_restart: '500M',   // 内存超限自动重启
    env: {
      PORT: 8000,
    },
    out_file: './logs/radio-tts-out.log',
    error_file: './logs/radio-tts-error.log',
    merge_logs: true,
    time: true,                   // 日志带时间戳
  }],
};
