# 本机扬声器播放守护进程：宿主进程(Node)通过 stdin 发命令、读 stdout 应答。
# 用 Windows Media Player COM 组件播放，支持 播放/暂停/恢复/停止/音量/状态查询。
# 注意：WMP 的状态机依赖 STA 消息泵，等待命令期间必须持续 DoEvents，
# 否则 playState 会永远停在 Transitioning(9)。
$ErrorActionPreference = 'Stop'
try {
  [Console]::InputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}
Add-Type -AssemblyName System.Windows.Forms

$wmp = $null
try { $wmp = New-Object -ComObject 'WMPlayer.OCX.7' } catch {}
if (-not $wmp) {
  [Console]::Out.WriteLine('ERR no-wmp')
  [Console]::Out.Flush()
  exit 1
}
$wmp.settings.autoStart = $true          # 设置 URL 即自动开播，不依赖 controls.play()
$wmp.settings.volume = 100
$wmp.settings.enableErrorDialogs = $false
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

# playState: 1=已停止 2=已暂停 3=播放中 8=媒体结束 9=转换中 10=就绪
$running = $true
while ($running) {
  # 等待一行命令，期间持续泵消息驱动 WMP 状态机
  $t = [Console]::In.ReadLineAsync()
  while (-not $t.Wait(100)) { [System.Windows.Forms.Application]::DoEvents() }
  $line = $t.Result
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  $sep = $line.IndexOf('|')
  $cmd = $line
  $arg = ''
  if ($sep -ge 0) { $cmd = $line.Substring(0, $sep); $arg = $line.Substring($sep + 1) }
  switch ($cmd) {
    'play'   { $wmp.URL = $arg;                        [Console]::Out.WriteLine('OK play') }
    'stop'   { $wmp.controls.stop();                   [Console]::Out.WriteLine('OK stop') }
    'pause'  { $wmp.controls.pause();                  [Console]::Out.WriteLine('OK pause') }
    'resume' { $wmp.controls.play();                   [Console]::Out.WriteLine('OK resume') }
    'vol'    { $wmp.settings.volume = [int]$arg;       [Console]::Out.WriteLine('OK vol') }
    'state'  { [Console]::Out.WriteLine("STATE $($wmp.playState)") }
    'quit'   { $wmp.controls.stop();                   [Console]::Out.WriteLine('OK quit'); $running = $false }
    default  { [Console]::Out.WriteLine("ERR unknown $cmd") }
  }
  [Console]::Out.Flush()
  [System.Windows.Forms.Application]::DoEvents()
}
