# 需要管理员权限执行：写 SharedInstallationPath 并安装 VS Build Tools（含 VCTools 工作负载）
#
# 用法（管理员 PowerShell）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File D:\OCS\smolensk\scripts\install-vsbt-elevated.ps1
#
# 行为：
#   1. 断言系统盘（C:）可用 ≥4GB，不足直接退出（VS 安装器自身要求 3.46GB 系统盘）
#   2. 写 SharedInstallationPath = E:\VSBuildTools\Shared
#   3. TEMP/TMP 指向 E:\temp-install（安装器解包不落 C 盘）
#   4. winget 装 Build Tools 到 E:\VSBuildTools，工作负载 VCTools --includeRecommended
#   5. 装完打印 vswhere 结果与 E:\VSBuildTools 是否生成

$ErrorActionPreference = 'Continue'
$logDir = 'E:\temp-install'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'vsbt-install.log'
Start-Transcript -Path $log -Append -Force

$sharedPath = 'E:\VSBuildTools\Shared'
$installPath = 'E:\VSBuildTools'
$minFreeGB = 4

function Get-FreeGB([string]$drive) {
    return [math]::Round((Get-PSDrive $drive).Free / 1GB, 2)
}

Write-Output '=== [0] 系统盘空间断言 ==='
$cFree = Get-FreeGB 'C'
$eFree = Get-FreeGB 'E'
Write-Output "C_free_gb=$cFree  E_free_gb=$eFree  threshold=${minFreeGB}GB"
if ($cFree -lt $minFreeGB) {
    Write-Output "ABORT: 系统盘可用 ${cFree}GB < ${minFreeGB}GB，VS 安装器要求系统盘至少 3.46GB。"
    Write-Output '请先清理 C:\Users\<用户>\AppData\Local\Temp 等安全项后重跑本脚本。'
    Stop-Transcript
    exit 2
}
Write-Output '系统盘空间满足门槛，继续。'

Write-Output '=== [1] 写 SharedInstallationPath ==='
$before = '(not set)'
try {
    $v = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\VisualStudio\Setup' -Name SharedInstallationPath -ErrorAction Stop).SharedInstallationPath
    if ($null -ne $v) { $before = $v }
} catch { }
Write-Output "before=$before"
$out = (reg add 'HKLM\SOFTWARE\Microsoft\VisualStudio\Setup' /v SharedInstallationPath /t REG_SZ /d $sharedPath /f) 2>&1 | Out-String
Write-Output "reg_add=$(($out.Trim()))"
$after = '(read failed)'
try {
    $v2 = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\VisualStudio\Setup' -Name SharedInstallationPath -ErrorAction Stop).SharedInstallationPath
    if ($null -ne $v2) { $after = $v2 }
} catch { }
Write-Output "after=$after"

Write-Output '=== [2] 安装 VS Build Tools ==='
$env:TEMP = $logDir
$env:TMP = $logDir
$sw = [Diagnostics.Stopwatch]::StartNew()
$wingetOut = (& winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
        --accept-package-agreements --accept-source-agreements --disable-interactivity `
        --override "--wait --passive --installPath $installPath --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended") 2>&1 | Out-String
$sw.Stop()
Write-Output $wingetOut
Write-Output ("winget_exit=" + $LASTEXITCODE)
Write-Output ("elapsed_s=" + [math]::Round($sw.Elapsed.TotalSeconds, 1))
Write-Output ("C_free_after=" + (Get-FreeGB 'C') + "GB  E_free_after=" + (Get-FreeGB 'E') + 'GB')

Write-Output '=== [3] 装后校验 ==='
Write-Output ("installPath_exists=" + (Test-Path $installPath))
Write-Output ("sharedPath_exists=" + (Test-Path $sharedPath))
$vswhere = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { $vswhere = Join-Path $installPath 'Installer\vswhere.exe' }
Write-Output ("vswhere=" + $vswhere + " exists=" + (Test-Path $vswhere))
if (Test-Path $vswhere) {
    Write-Output '--- vswhere (VC.Tools) ---'
    $json = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -format json -utf8) 2>&1 | Out-String
    Write-Output $json
    Write-Output '--- vswhere (all) ---'
    (& $vswhere -products '*' -format json -utf8) 2>&1 | Out-String | Write-Output
}
Write-Output '=== [4] SDK 位置 ==='
foreach ($p in @('C:\Program Files\Windows Kits\10', 'E:\Windows Kits\10')) {
    Write-Output ("$p exists=" + (Test-Path $p))
}

Stop-Transcript

if (-not (Test-Path $installPath)) {
    Write-Output 'RESULT=FAIL 安装未生成目标目录，请把上面的日志交给代理继续排查。'
    exit 3
}
Write-Output 'RESULT=OK'
exit 0
