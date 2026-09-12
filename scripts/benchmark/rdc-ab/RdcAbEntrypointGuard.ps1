$ErrorActionPreference = 'Stop'

if (-not ('RdcAbNativeMethods' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class RdcAbNativeMethods {
  public const uint DUPLICATE_SAME_ACCESS = 0x00000002;
  public const uint CREATE_SUSPENDED = 0x00000004;
  public const uint CREATE_NO_WINDOW = 0x08000000;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX;
    public int dwY;
    public int dwXSize;
    public int dwYSize;
    public int dwXCountChars;
    public int dwYCountChars;
    public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFO {
    public IntPtr hProcess;
    public IntPtr hThread;
    public int dwProcessId;
    public int dwThreadId;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CreateProcessW(
    string lpApplicationName,
    StringBuilder lpCommandLine,
    IntPtr lpProcessAttributes,
    IntPtr lpThreadAttributes,
    bool bInheritHandles,
    uint dwCreationFlags,
    IntPtr lpEnvironment,
    string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo,
    out PROCESS_INFO lpProcessInformation);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool DuplicateHandle(
    IntPtr hSourceProcessHandle,
    IntPtr hSourceHandle,
    IntPtr hTargetProcessHandle,
    out IntPtr lpTargetHandle,
    uint dwDesiredAccess,
    bool bInheritHandle,
    uint dwOptions);

  [DllImport("kernel32.dll")]
  public static extern IntPtr GetCurrentProcess();

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint ResumeThread(IntPtr hThread);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseHandle(IntPtr hObject);

  public static int StartGuardedProcess(string applicationPath, string arguments, IntPtr sourceHandle) {
    if (sourceHandle == IntPtr.Zero || sourceHandle == new IntPtr(-1)) {
      throw new ArgumentException("RDC A/B entrypoint guard handle is invalid", "sourceHandle");
    }

    var startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFO processInfo;
    var commandLine = new StringBuilder("\"" + applicationPath + "\" " + arguments);
    bool created = CreateProcessW(
      applicationPath,
      commandLine,
      IntPtr.Zero,
      IntPtr.Zero,
      false,
      CREATE_SUSPENDED | CREATE_NO_WINDOW,
      IntPtr.Zero,
      null,
      ref startup,
      out processInfo);
    if (!created) {
      throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to create suspended RDC A/B guarded process");
    }

    bool resumed = false;
    try {
      IntPtr targetHandle;
      bool duplicated = DuplicateHandle(
        GetCurrentProcess(),
        sourceHandle,
        processInfo.hProcess,
        out targetHandle,
        0,
        false,
        DUPLICATE_SAME_ACCESS);
      if (!duplicated || targetHandle == IntPtr.Zero) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to transfer RDC A/B entrypoint guard to suspended process");
      }

      uint resumeResult = ResumeThread(processInfo.hThread);
      if (resumeResult == UInt32.MaxValue) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "Unable to resume RDC A/B guarded process");
      }
      resumed = true;
      return processInfo.dwProcessId;
    } finally {
      if (!resumed) {
        TerminateProcess(processInfo.hProcess, 1);
      }
      CloseHandle(processInfo.hThread);
      CloseHandle(processInfo.hProcess);
    }
  }
}
'@
}

function Open-RdcAbEntrypointGuard([Parameter(Mandatory=$true)][string]$Path) {
  if (-not [Environment]::OSVersion.Platform.Equals([PlatformID]::Win32NT)) {
    throw 'RDC A/B entrypoint guard requires Windows'
  }
  $fullPath = [IO.Path]::GetFullPath($Path)
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    throw 'RDC A/B canonical entrypoint is missing'
  }
  try {
    return [IO.File]::Open($fullPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
  } catch {
    throw "Unable to acquire exclusive RDC A/B canonical entrypoint guard: $($_.Exception.Message)"
  }
}

function Start-RdcAbGuardedProcess(
  [Parameter(Mandatory=$true)][string]$FilePath,
  [Parameter(Mandatory=$true)][string]$ArgumentLine,
  [Parameter(Mandatory=$true)][IO.FileStream]$Guard
) {
  if ($Guard.SafeFileHandle.IsInvalid -or $Guard.SafeFileHandle.IsClosed) {
    throw 'RDC A/B entrypoint guard handle is not valid'
  }
  $fullFilePath = [IO.Path]::GetFullPath($FilePath)
  if (-not (Test-Path -LiteralPath $fullFilePath -PathType Leaf)) {
    throw 'RDC A/B guarded process executable is missing'
  }
  $startedPid = [RdcAbNativeMethods]::StartGuardedProcess(
    $fullFilePath,
    $ArgumentLine,
    $Guard.SafeFileHandle.DangerousGetHandle()
  )
  try { return [Diagnostics.Process]::GetProcessById([int]$startedPid) }
  catch { throw "RDC A/B guarded process started but exact PID $startedPid could not be attached: $($_.Exception.Message)" }
}
