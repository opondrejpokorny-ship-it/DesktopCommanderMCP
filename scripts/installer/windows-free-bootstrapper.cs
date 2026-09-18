using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text;
using System.Windows.Forms;

[assembly: AssemblyTitle("Desktop Commander Free Setup")]
[assembly: AssemblyProduct("Desktop Commander Free")]
[assembly: AssemblyDescription("User-level bootstrapper for Desktop Commander Free")]
[assembly: AssemblyCompany("Desktop Commander contributors")]
[assembly: AssemblyCopyright("MIT-licensed Desktop Commander distribution")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

internal static class Program
{
    private const string RuntimeResource = "DesktopCommander.RuntimeZip";
    private const string InstallResource = "DesktopCommander.InstallPs1";
    private const string ManifestResource = "DesktopCommander.PayloadManifest";

    [STAThread]
    private static int Main(string[] args)
    {
        bool quiet = string.Equals(
            Environment.GetEnvironmentVariable("DC_INSTALL_QUIET"),
            "1",
            StringComparison.Ordinal
        );

        string tempRoot = Path.Combine(
            Path.GetTempPath(),
            "DesktopCommanderFreeSetup-" +
            Process.GetCurrentProcess().Id.ToString() + "-" +
            Guid.NewGuid().ToString("N")
        );

        try
        {
            Directory.CreateDirectory(tempRoot);
            ExtractResource(RuntimeResource, Path.Combine(tempRoot, "runtime.zip"));
            ExtractResource(InstallResource, Path.Combine(tempRoot, "install.ps1"));
            ExtractResource(ManifestResource, Path.Combine(tempRoot, "payload-manifest.json"));

            string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
            string powershell = Path.Combine(
                windows,
                "System32",
                "WindowsPowerShell",
                "v1.0",
                "powershell.exe"
            );
            if (!File.Exists(powershell))
            {
                throw new FileNotFoundException("Windows PowerShell was not found.", powershell);
            }

            string installScript = Path.Combine(tempRoot, "install.ps1");
            ProcessStartInfo startInfo = new ProcessStartInfo();
            startInfo.FileName = powershell;
            startInfo.Arguments =
                "-NoLogo -NoProfile -ExecutionPolicy Bypass -File " +
                QuoteArgument(installScript);
            startInfo.WorkingDirectory = tempRoot;
            startInfo.UseShellExecute = false;
            startInfo.CreateNoWindow = true;
            startInfo.RedirectStandardOutput = true;
            startInfo.RedirectStandardError = true;

            using (Process child = Process.Start(startInfo))
            {
                if (child == null)
                {
                    throw new InvalidOperationException("Failed to start Desktop Commander installer.");
                }
                string stdout = child.StandardOutput.ReadToEnd();
                string stderr = child.StandardError.ReadToEnd();
                child.WaitForExit();

                string logPath = Path.Combine(
                    Path.GetTempPath(),
                    "DesktopCommanderFreeSetup-last.log"
                );
                File.WriteAllText(
                    logPath,
                    stdout + Environment.NewLine + stderr,
                    new UTF8Encoding(false)
                );

                if (child.ExitCode != 0)
                {
                    if (!quiet)
                    {
                        MessageBox.Show(
                            "Desktop Commander Free installation failed.\n\n" +
                            "See: " + logPath,
                            "Desktop Commander Free Setup",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Error
                        );
                    }
                    return child.ExitCode == 0 ? 1 : child.ExitCode;
                }
            }

            return 0;
        }
        catch (Exception error)
        {
            string logPath = Path.Combine(
                Path.GetTempPath(),
                "DesktopCommanderFreeSetup-last.log"
            );
            try
            {
                File.WriteAllText(logPath, error.ToString(), new UTF8Encoding(false));
            }
            catch
            {
            }

            if (!quiet)
            {
                MessageBox.Show(
                    "Desktop Commander Free installation failed.\n\n" +
                    error.Message + "\n\nSee: " + logPath,
                    "Desktop Commander Free Setup",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
            return 1;
        }
        finally
        {
            try
            {
                if (Directory.Exists(tempRoot))
                {
                    Directory.Delete(tempRoot, true);
                }
            }
            catch
            {
            }
        }
    }

    private static string QuoteArgument(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static void ExtractResource(string resourceName, string destination)
    {
        Assembly assembly = Assembly.GetExecutingAssembly();
        using (Stream input = assembly.GetManifestResourceStream(resourceName))
        {
            if (input == null)
            {
                throw new InvalidOperationException(
                    "Installer resource is missing: " + resourceName
                );
            }
            using (FileStream output = new FileStream(
                destination,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None
            ))
            {
                input.CopyTo(output);
            }
        }
    }
}
