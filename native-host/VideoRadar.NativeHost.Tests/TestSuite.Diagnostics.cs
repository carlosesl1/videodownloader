using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using VideoRadar.NativeHost.Diagnostics;

namespace VideoRadar.NativeHost.Tests;

internal static partial class TestSuite
{
    private static void DiagnosticTests()
    {
        var root = Path.Combine(Path.GetTempPath(), "video-radar-diagnostics-tests", Guid.NewGuid().ToString("N"));
        var tools = Path.Combine(root, "tools");
        var local = Path.Combine(root, "local");
        var destination = Path.Combine(root, "exports");
        Directory.CreateDirectory(tools);
        Directory.CreateDirectory(destination);
        try
        {
            var ffprobe = Path.Combine(tools, "ffprobe.exe");
            File.WriteAllBytes(ffprobe, Encoding.UTF8.GetBytes("fixture-ffprobe"));
            var service = new DiagnosticService(tools, local);
            var overlappingService = new DiagnosticService(tools, local);
            True(!service.Enabled, "Diagnostic logging was not opt-in.");
            True(!overlappingService.Enabled, "A second diagnostic host was not opt-in.");
            service.Record("download_started");
            Equal(0, service.GetSummary(destination).LogFileCount);

            service.SetEnabled(true);
            overlappingService.Record("overlapping_host_recorded");
            True(overlappingService.Enabled,
                "An overlapping host did not observe the durable opt-in.");
            service.SetEnabled(false);
            overlappingService.Record("overlapping_host_after_opt_out");
            True(!overlappingService.Enabled,
                "An overlapping host retained a stale opt-in after opt-out.");
            var diagnosticsDirectory = Path.Combine(local, "VideoRadar", "diagnostics");
            var overlappingContents = string.Concat(
                Directory.EnumerateFiles(diagnosticsDirectory, "events-*.jsonl")
                    .Select(File.ReadAllText));
            True(overlappingContents.Contains("overlapping_host_recorded", StringComparison.Ordinal),
                "The second host did not record after the durable opt-in.");
            True(!overlappingContents.Contains("overlapping_host_after_opt_out", StringComparison.Ordinal),
                "The second host continued recording after the durable opt-out.");

            service.SetEnabled(true);
            service.Record("download_started");
            service.Record("download_failed", "NETWORK_TIMEOUT");
            Throws<ArgumentException>(() => service.Record("raw URL https://private.example/video"));

            var summary = service.GetSummary(destination);
            True(summary.LoggingEnabled, "Diagnostic preference was not applied.");
            True(summary.LogFileCount is >= 1 and <= 2,
                "Overlapping hosts did not preserve a bounded set of diagnostic logs.");
            Equal(4, summary.Tools.Count);
            True(summary.Tools.Single(tool => tool.Name == "ffprobe.exe").Available,
                "The diagnostic did not detect ffprobe.");

            File.WriteAllText(
                Path.Combine(diagnosticsDirectory, "events-tampered.jsonl"),
                "{\"timestamp\":\"2026-08-12T12:00:00Z\",\"event\":\"download_started\",\"code\":\"https://private.example/video\"}\n");

            var exportPath = service.Export(destination, destination);
            True(File.Exists(exportPath), "The diagnostic archive was not created.");
            using (var archive = ZipFile.OpenRead(exportPath))
            {
                var names = archive.Entries.Select(entry => entry.FullName).ToArray();
                True(names.Contains("health.json"), "The diagnostic archive has no health report.");
                True(names.Contains("README.txt"), "The diagnostic archive has no privacy notice.");
                True(names.Any(name => name.StartsWith("logs/events-", StringComparison.Ordinal)),
                    "The diagnostic archive has no opted-in event log.");

                using var healthReader = new StreamReader(
                    archive.GetEntry("health.json")!.Open(),
                    Encoding.UTF8);
                using var health = JsonDocument.Parse(healthReader.ReadToEnd());
                var tool = health.RootElement.GetProperty("tools").EnumerateArray()
                    .Single(value => value.GetProperty("name").GetString() == "ffprobe.exe");
                var expectedHash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(ffprobe)))
                    .ToLowerInvariant();
                Equal(expectedHash, tool.GetProperty("sha256").GetString());

                foreach (var entry in archive.Entries.Where(value => value.FullName.EndsWith(".jsonl", StringComparison.Ordinal)))
                {
                    using var reader = new StreamReader(entry.Open(), Encoding.UTF8);
                    var contents = reader.ReadToEnd();
                    True(!contents.Contains("private.example", StringComparison.OrdinalIgnoreCase),
                        "A URL leaked into diagnostic logs.");
                    True(!contents.Contains("cookie", StringComparison.OrdinalIgnoreCase),
                        "A cookie marker leaked into diagnostic logs.");
                }
                var exportedLogCount = archive.Entries.Count(value =>
                    value.FullName.StartsWith("logs/events-", StringComparison.Ordinal));
                True(exportedLogCount is >= 1 and <= 8,
                    "The diagnostic archive did not preserve the bounded valid logs.");
            }

            for (var index = 0; index < 12; index++)
            {
                File.WriteAllText(
                    Path.Combine(diagnosticsDirectory, $"events-clear-{index:D2}.jsonl"),
                    "{\"timestamp\":\"2026-08-12T12:00:00Z\",\"event\":\"download_started\",\"code\":null}\n");
            }
            service.Clear();
            Equal(0, service.GetSummary(destination).LogFileCount);
            True(!Directory.EnumerateFiles(diagnosticsDirectory, "events-*.jsonl").Any(),
                "Clearing diagnostics left logs outside the eight-file summary window.");
            True(new DiagnosticService(tools, local).Enabled,
                "The opt-in diagnostic preference was not durable.");

            var failedLocal = Path.Combine(root, "failed-local");
            var failedService = new DiagnosticService(tools, failedLocal);
            var failedSettings = Path.Combine(
                failedLocal,
                "VideoRadar",
                "diagnostics",
                "settings.json");
            Directory.CreateDirectory(failedSettings);
            var persistenceFailed = false;
            try
            {
                failedService.SetEnabled(true);
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                persistenceFailed = true;
            }
            True(persistenceFailed, "A failed settings commit was reported as successful.");
            True(!failedService.Enabled,
                "A failed durable opt-in incorrectly enabled in-memory diagnostics.");
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }
}
