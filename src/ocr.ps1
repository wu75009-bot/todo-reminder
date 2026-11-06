param([Parameter(Mandatory=$true)][string]$PayloadPath)
$ErrorActionPreference = 'Stop'
$json = Get-Content -LiteralPath $PayloadPath -Raw -Encoding UTF8 | ConvertFrom-Json
$imagePath = [string]$json.image
$outPath = [string]$json.out

function Write-Result($obj) {
  $obj | ConvertTo-Json -Compress -Depth 4 | Set-Content -LiteralPath $outPath -Encoding UTF8
}

Write-Result @{ ok = $false; code = 'started' }

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] | Out-Null
  [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
  [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType=WindowsRuntime] | Out-Null

  $full = [System.IO.Path]::GetFullPath($imagePath)
  if (-not (Test-Path -LiteralPath $full)) { Write-Result @{ ok = $false; code = 'no-file'; error = $full }; exit 0 }

  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) { Write-Result @{ ok = $false; code = 'no-ocr-language-pack' }; exit 0 }

  $gen = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

  function Await($op, $type) {
    $task = $gen.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }

  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])

  [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType=WindowsRuntime] | Out-Null
  $scale = [Math]::Min(4, [Math]::Max(1, [Math]::Floor(1600 / [Math]::Max(1, $decoder.PixelWidth))))
  $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
  $transform.ScaledWidth = [uint32]($decoder.PixelWidth * $scale)
  $transform.ScaledHeight = [uint32]($decoder.PixelHeight * $scale)
  $transform.InterpolationMode = [Windows.Graphics.Imaging.BitmapInterpolationMode]::Fant
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
    [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
    [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
    $transform,
    [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
    [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage
  )) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

  $lines = @($result.Lines | ForEach-Object { $_.Text })
  Write-Result @{ ok = $true; text = ($lines -join "`n"); lines = $lines.Count; scale = $scale }
  exit 0
} catch {
  $e = $_.Exception
  $msgs = @()
  while ($null -ne $e) { $msgs += $e.Message; $e = $e.InnerException }
  Write-Result @{ ok = $false; code = 'exception'; error = ($msgs -join ' <- ') }
  exit 0
}
