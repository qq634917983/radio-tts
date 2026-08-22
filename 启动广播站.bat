@echo off
chcp 65001 >nul
cd /d %~dp0
rem 取局域网 IP（与服务器 lanIp 相同的 UDP 探测方式），失败则回退 127.0.0.1
for /f "delims=" %%i in ('powershell -NoProfile -Command "try{$u=New-Object System.Net.Sockets.UdpClient;$u.Connect('8.8.8.8',80);$u.Client.LocalEndPoint.Address.IPAddressToString;$u.Close()}catch{ '127.0.0.1' }"') do set LANIP=%%i
echo AI 智能广播站(Node.js)启动中... 局域网控制台 http://%LANIP%:8000
start http://%LANIP%:8000
node server.js
pause
