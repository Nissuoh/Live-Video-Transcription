param(
  [string]$RuntimeDir = ".runtime\piper"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$runtimePath = Join-Path $root $RuntimeDir
$binPath = Join-Path $runtimePath "bin"
$voicesPath = Join-Path $runtimePath "voices"
$archivePath = Join-Path $runtimePath "piper_windows_amd64.zip"

New-Item -ItemType Directory -Force -Path $binPath, $voicesPath | Out-Null

if (-not (Test-Path $archivePath)) {
  Invoke-WebRequest `
    -Uri "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip" `
    -OutFile $archivePath
}

Expand-Archive -Path $archivePath -DestinationPath $binPath -Force

$voices = @(
  @{
    Name = "de_DE-thorsten-medium"
    BaseUrl = "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/thorsten/medium"
    Model = "de_DE-thorsten-medium.onnx"
    Config = "de_DE-thorsten-medium.onnx.json"
  },
  @{
    Name = "de_DE-eva_k-x_low"
    BaseUrl = "https://huggingface.co/rhasspy/piper-voices/resolve/main/de/de_DE/eva_k/x_low"
    Model = "de_DE-eva_k-x_low.onnx"
    Config = "de_DE-eva_k-x_low.onnx.json"
  }
)

foreach ($voice in $voices) {
  $voicePath = Join-Path $voicesPath $voice.Name
  New-Item -ItemType Directory -Force -Path $voicePath | Out-Null

  $modelPath = Join-Path $voicePath $voice.Model
  if (-not (Test-Path $modelPath)) {
    Invoke-WebRequest -Uri "$($voice.BaseUrl)/$($voice.Model)" -OutFile $modelPath
  }

  $configPath = Join-Path $voicePath $voice.Config
  if (-not (Test-Path $configPath)) {
    Invoke-WebRequest -Uri "$($voice.BaseUrl)/$($voice.Config)" -OutFile $configPath
  }
}

$piperExe = Join-Path $binPath "piper\piper.exe"
$maleModel = Join-Path $voicesPath "de_DE-thorsten-medium\de_DE-thorsten-medium.onnx"
$maleConfig = Join-Path $voicesPath "de_DE-thorsten-medium\de_DE-thorsten-medium.onnx.json"
$femaleModel = Join-Path $voicesPath "de_DE-eva_k-x_low\de_DE-eva_k-x_low.onnx"
$femaleConfig = Join-Path $voicesPath "de_DE-eva_k-x_low\de_DE-eva_k-x_low.onnx.json"

Write-Output "PIPER_EXE_PATH=$piperExe"
Write-Output "PIPER_MALE_MODEL_PATH=$maleModel"
Write-Output "PIPER_MALE_CONFIG_PATH=$maleConfig"
Write-Output "PIPER_FEMALE_MODEL_PATH=$femaleModel"
Write-Output "PIPER_FEMALE_CONFIG_PATH=$femaleConfig"
