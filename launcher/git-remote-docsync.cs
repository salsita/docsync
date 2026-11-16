// Git for Windows cannot reliably run npm's extensionless shell shim as a
// remote helper (#12). This small AnyCPU launcher replaces that shim during a
// global install and hands its inherited protocol pipes to Node unchanged.
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

internal static class GitRemoteDocsync
{
    private static int Main(string[] args)
    {
        try
        {
            // Assembly.Location may retain the image's original `.exe` path
            // after npm copies it over an extensionless shim. The process
            // image is the installed PATH entry and therefore the right base.
            string executable = Process.GetCurrentProcess().MainModule.FileName;
            string directory = Path.GetDirectoryName(executable);
            string entry = Environment.GetEnvironmentVariable("DOCSYNC_HELPER_ENTRY");
            if (String.IsNullOrEmpty(entry))
            {
                entry = Path.Combine(
                    directory,
                    "node_modules",
                    "@salsita",
                    "docsync",
                    "dist",
                    "remote-helper.js"
                );
            }

            string localNode = Path.Combine(directory, "node.exe");
            string node = File.Exists(localNode) ? localNode : "node";
            var command = new StringBuilder(Quote(entry));
            foreach (string argument in args)
            {
                command.Append(' ').Append(Quote(argument));
            }

            var start = new ProcessStartInfo(node, command.ToString());
            start.UseShellExecute = false;
            // An intermediate process that merely inherits Git's pipes can
            // inherit Git's other end of stdin too. The helper then waits for
            // EOF on a pipe it unknowingly holds open itself. Give Node fresh
            // child-only handles and relay all three streams instead (#12).
            start.RedirectStandardInput = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            using (Process child = Process.Start(start))
            {
                Thread output = Relay(child.StandardOutput.BaseStream, Console.OpenStandardOutput());
                Thread error = Relay(child.StandardError.BaseStream, Console.OpenStandardError());
                using (Stream input = Console.OpenStandardInput())
                using (Stream childInput = child.StandardInput.BaseStream)
                {
                    Pump(input, childInput);
                }
                child.WaitForExit();
                output.Join();
                error.Join();
                return child.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("docsync: could not start the remote helper: " + error.Message);
            return 1;
        }
    }

    private static Thread Relay(Stream input, Stream output)
    {
        var thread = new Thread(() =>
        {
            Pump(input, output);
        });
        thread.Start();
        return thread;
    }

    private static void Pump(Stream input, Stream output)
    {
        var buffer = new byte[8192];
        int read;
        while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
        {
            output.Write(buffer, 0, read);
            // Remote-helper replies are small and conversational: Git cannot
            // send the next request until it sees this one (#12).
            output.Flush();
        }
    }

    // ProcessStartInfo on .NET Framework takes one command-line string. This
    // is the inverse of CommandLineToArgvW, including trailing backslashes.
    private static string Quote(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
        {
            return argument;
        }

        var quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                slashes++;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', slashes * 2 + 1).Append(character);
                slashes = 0;
                continue;
            }
            quoted.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        return quoted.Append('\\', slashes * 2).Append('"').ToString();
    }
}
