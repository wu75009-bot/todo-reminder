param([int]$IntervalMs = 350)

# Watches the Windows clipboard and prints one JSON line per change.
# NOTE: keep this file pure ASCII. PowerShell 5.1 reads BOM-less UTF-8 as GBK,
# so any Chinese comment here would be mangled into syntax errors.

$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
try { Add-Type -AssemblyName System.Windows.Forms } catch { }
try { Add-Type -AssemblyName System.Drawing } catch { }

if (-not ("Clip32" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Clip32 {
  [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint id);
}
'@
}

function Send-Line($payload) {
  try {
    $json = $payload | ConvertTo-Json -Compress -Depth 5
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
  } catch { }
}

function Get-ForegroundName {
  try {
    $h = [Clip32]::GetForegroundWindow()
    $targetId = [uint32]0
    [void][Clip32]::GetWindowThreadProcessId($h, [ref]$targetId)
    if ($targetId -eq 0) { return "" }
    $p = Get-Process -Id $targetId -ErrorAction Stop
    return [string]$p.ProcessName
  } catch { return "" }
}

function Get-ClipText {
  try {
    $t = Get-Clipboard -Raw -Format Text -ErrorAction Stop
    if ($null -eq $t) { return "" }
    return [string]$t
  } catch { return "" }
}

function Get-ClipImage {
  try { return Get-Clipboard -Format Image -ErrorAction Stop } catch { return $null }
}

Send-Line @{ event = "ready"; interval = $IntervalMs; ps = $PSVersionTable.PSVersion.ToString() }

$last = [Clip32]::GetClipboardSequenceNumber()

while ($true) {
  Start-Sleep -Milliseconds $IntervalMs

  $seq = [Clip32]::GetClipboardSequenceNumber()
  if ($seq -eq $last) { continue }
  $last = $seq

  # 有些程序会先清空再写入，稍等一下让内容稳定下来
  Start-Sleep -Milliseconds 110

  $source = Get-ForegroundName
  $text = Get-ClipText

  if ($text.Trim().Length -gt 0) {
    Send-Line @{ event = "clip"; kind = "text"; source = $source; text = $text }
    continue
  }

  $img = Get-ClipImage
  if ($null -ne $img) {
    $path = Join-Path $env:TEMP ("todo-clip-" + [Guid]::NewGuid().ToString("N") + ".png")
    try {
      $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
      Send-Line @{ event = "clip"; kind = "image"; source = $source; path = $path }
    } catch {
      Send-Line @{ event = "error"; stage = "save-image"; message = $_.Exception.Message }
    } finally {
      try { $img.Dispose() } catch { }
    }
  }
}
