$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Drawing

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$assetsDirectory = Join-Path $repositoryRoot 'assets'
$outputPath = Join-Path $assetsDirectory 'icon-128.png'
$iconSizes = @(16, 32, 48, 128)
New-Item -ItemType Directory -Path $assetsDirectory -Force | Out-Null

$bitmap = [System.Drawing.Bitmap]::new(128, 128)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$ringPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(210, 52, 211, 153), [single]2)
$softPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(92, 52, 211, 153), [single]1)
$sweepPen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 110, 231, 183), [single]4)
$centerBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(255, 167, 243, 208))

try {
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.Clear([System.Drawing.Color]::FromArgb(255, 7, 20, 41))

  foreach ($radius in @(18, 36, 54)) {
    $diameter = $radius * 2
    $graphics.DrawEllipse($ringPen, 64 - $radius, 64 - $radius, $diameter, $diameter)
  }
  $graphics.DrawLine($softPen, 10, 64, 118, 64)
  $graphics.DrawLine($softPen, 64, 10, 64, 118)
  $graphics.DrawLine($sweepPen, 64, 64, 108, 34)
  $graphics.FillEllipse($centerBrush, 59, 59, 10, 10)

  $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)

  foreach ($size in $iconSizes) {
    if ($size -eq 128) {
      continue
    }

    $resized = [System.Drawing.Bitmap]::new($size, $size)
    $resizedGraphics = [System.Drawing.Graphics]::FromImage($resized)
    try {
      $resizedGraphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
      $resizedGraphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
      $resizedGraphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $resizedGraphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $resizedGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
      $resizedGraphics.DrawImage($bitmap, 0, 0, $size, $size)
      $resized.Save(
        (Join-Path $assetsDirectory "icon-$size.png"),
        [System.Drawing.Imaging.ImageFormat]::Png
      )
    } finally {
      $resizedGraphics.Dispose()
      $resized.Dispose()
    }
  }
} finally {
  $centerBrush.Dispose()
  $sweepPen.Dispose()
  $softPen.Dispose()
  $ringPen.Dispose()
  $graphics.Dispose()
  $bitmap.Dispose()
}

Write-Output "Ícones gerados em $assetsDirectory ($($iconSizes -join ', ') px)"
