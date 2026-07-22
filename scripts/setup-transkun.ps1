param(
  [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot "tmp"
$venvPath = Join-Path $runtimeRoot ".venv-transkun"
$packagePath = Join-Path $runtimeRoot "transkun-extracted"
$downloadPath = Join-Path $runtimeRoot "transkun-download"

function Test-PythonVersion([string]$Executable, [string[]]$PrefixArgs) {
  try {
    $version = & $Executable @PrefixArgs -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"
    return $LASTEXITCODE -eq 0 -and $version -match '^3\.(10|11|12)$'
  } catch {
    return $false
  }
}

$pythonExecutable = ""
$pythonPrefix = @()
if ($Python) {
  if (-not (Test-PythonVersion $Python @())) {
    throw "The selected Python must be version 3.10, 3.11, or 3.12."
  }
  $pythonExecutable = $Python
} elseif ($env:SCORECRAFT_PYTHON -and (Test-PythonVersion $env:SCORECRAFT_PYTHON @())) {
  $pythonExecutable = $env:SCORECRAFT_PYTHON
} elseif (Get-Command py -ErrorAction SilentlyContinue) {
  foreach ($version in @("-3.12", "-3.11", "-3.10")) {
    if (Test-PythonVersion "py" @($version)) {
      $pythonExecutable = "py"
      $pythonPrefix = @($version)
      break
    }
  }
}
$codexPython = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
if (-not $pythonExecutable -and (Test-Path $codexPython) -and (Test-PythonVersion $codexPython @())) {
  $pythonExecutable = $codexPython
}
if (-not $pythonExecutable -and (Get-Command python -ErrorAction SilentlyContinue) -and (Test-PythonVersion "python" @())) {
  $pythonExecutable = "python"
}
if (-not $pythonExecutable) {
  throw "ScoreCraft needs Python 3.10-3.12 for Transkun. Install Python 3.11, then run this command again."
}

New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
Write-Host "Creating the isolated ScoreCraft piano runtime..."
& $pythonExecutable @pythonPrefix -m venv $venvPath
$venvPython = Join-Path $venvPath "Scripts\python.exe"

& $venvPython -m pip install --upgrade "pip<26" "setuptools<79"
& $venvPython -m pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu
& $venvPython -m pip install pretty-midi==0.2.11 scipy mir-eval pydub==0.25.1 soxr moduleconf

Remove-Item -Recurse -Force $downloadPath -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $packagePath -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $downloadPath | Out-Null
New-Item -ItemType Directory -Force -Path $packagePath | Out-Null
& $venvPython -m pip download transkun==2.0.1 --no-deps --dest $downloadPath
$wheel = Get-ChildItem -Path $downloadPath -Filter "transkun-2.0.1-*.whl" | Select-Object -First 1
if (-not $wheel) { throw "The Transkun model package could not be downloaded." }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::ExtractToDirectory($wheel.FullName, $packagePath)

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
  Write-Warning "FFmpeg is not on PATH. MP3/M4A decoding needs FFmpeg before ScoreCraft can transcribe."
}

& $venvPython -c "import torch, pretty_midi, pydub, soxr, moduleconf; print('Transkun runtime ready with PyTorch', torch.__version__)"
Write-Host "Done. Restart npm run dev, then transcribe the piano recording again."
