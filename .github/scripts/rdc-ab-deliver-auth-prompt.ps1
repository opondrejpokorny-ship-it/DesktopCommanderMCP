$ErrorActionPreference='Stop'
$wrapper = Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'cmd.exe' -and [string]$_.CommandLine -match 'rdc-ab-start-1f9c8c4\.cmd'
} | Select-Object -First 1
if(-not $wrapper){ Write-Host 'AUTH_PROMPT_DELIVERED=False reason=wrapper-not-found'; exit 0 }

$source = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class RdcAbConsoleReader {
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X; public short Y; public COORD(short x, short y){ X=x; Y=y; } }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct INFO { public COORD Size; public COORD Cursor; public ushort Attr; public SMALL_RECT Window; public COORD Max; }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr CreateFile(string n,uint a,uint s,IntPtr sec,uint c,uint f,IntPtr t);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetConsoleScreenBufferInfo(IntPtr h, out INFO i);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool ReadConsoleOutputCharacter(IntPtr h,StringBuilder b,uint n,COORD p,out uint r);
}
'@
$helper=Join-Path $env:RUNNER_TEMP 'rdc-ab-console-reader-child.ps1'
$body=@'
param([int]$TargetPid)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition $env:RDC_AB_CONSOLE_SOURCE
[RdcAbConsoleReader]::FreeConsole() | Out-Null
if(-not [RdcAbConsoleReader]::AttachConsole([uint32]$TargetPid)){ Write-Output 'status=no-console'; exit 2 }
$readAccess=[Convert]::ToUInt32('80000000',16)
$h=[RdcAbConsoleReader]::CreateFile('CONOUT$',$readAccess,[uint32]3,[IntPtr]::Zero,[uint32]3,[uint32]0,[IntPtr]::Zero)
if($h -eq [IntPtr](-1)){ Write-Output 'status=no-conout'; exit 3 }
$i=New-Object RdcAbConsoleReader+INFO
if(-not [RdcAbConsoleReader]::GetConsoleScreenBufferInfo($h,[ref]$i)){ Write-Output 'status=no-buffer'; exit 3 }
$len=[int]$i.Size.X * [int]$i.Size.Y
$sb=New-Object Text.StringBuilder $len
$read=[uint32]0
if(-not [RdcAbConsoleReader]::ReadConsoleOutputCharacter($h,$sb,[uint32]$len,[RdcAbConsoleReader+COORD]::new(0,0),[ref]$read)){ Write-Output 'status=read-failed'; exit 3 }
$text=$sb.ToString()
$uriMatch=[regex]::Match($text,'https://[^\s]+desktopcommander[^\s]*',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
if(-not $uriMatch.Success){
  $uriMatch=[regex]::Match($text,'Open this URL in your browser:\s*(https://[^\s]+)',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
$codeMatch=[regex]::Match($text,'Enter this code when prompted:\s*([A-Z0-9-]{4,24})',[Text.RegularExpressions.RegexOptions]::IgnoreCase)
$waiting=$text -match 'Waiting for authorization'
if(-not $uriMatch.Success -or -not $codeMatch.Success){
  Write-Output "status=prompt-not-found waiting=$waiting uri=$($uriMatch.Success) code=$($codeMatch.Success)"
  exit 4
}
$message="Desktop Commander authorization required for PART 3.`r`nOpen: $($uriMatch.Value)`r`nCode: $($codeMatch.Groups[1].Value)`r`nApprove this current device authorization to continue the benchmark."
& msg.exe 1 $message *> $null
Write-Output 'status=delivered'
exit 0
'@
$env:RDC_AB_CONSOLE_SOURCE=$source
Set-Content -LiteralPath $helper -Value $body -Encoding UTF8
$out=Join-Path $env:RUNNER_TEMP 'rdc-ab-console-reader.out'
$err=Join-Path $env:RUNNER_TEMP 'rdc-ab-console-reader.err'
$p=Start-Process powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$helper,'-TargetPid',[string]$wrapper.ProcessId) -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
$status=if(Test-Path $out){(Get-Content -Raw -LiteralPath $out).Trim()}else{''}
$errorText=if(Test-Path $err){(Get-Content -Raw -LiteralPath $err).Trim()}else{''}
Remove-Item -LiteralPath $helper,$out,$err -Force -ErrorAction SilentlyContinue
Remove-Item Env:RDC_AB_CONSOLE_SOURCE -ErrorAction SilentlyContinue
if($p.ExitCode -eq 0){ Write-Host 'AUTH_PROMPT_DELIVERED=True'; exit 0 }
Write-Host "AUTH_PROMPT_DELIVERED=False helperExit=$($p.ExitCode) helperStatus=$status"
if($errorText){ Write-Host "AUTH_PROMPT_HELPER_ERROR=$($errorText -replace '[\r\n]+',' ')" }
exit 0
