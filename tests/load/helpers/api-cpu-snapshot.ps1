# Total CPU-seconds and RSS across EVERY node process serving the API.
#
# Why this exists rather than reading /api/v1/metrics:
# with API_CLUSTER_WORKERS > 1 the OS load-balances the listening port across N
# worker processes, so a single Prometheus scrape returns whichever worker
# happened to answer — `process_cpu_seconds_total` from that scrape is ONE
# worker's CPU, not the deployment's. Comparing a 1-worker run's total against a
# 4-worker run's random sample would understate the 4-worker cost by up to 4x and
# invert the conclusion. The OS process table is the only place the true total
# exists.
#
# Usage:  powershell -File tests/load/helpers/api-cpu-snapshot.ps1 [-Label before]
param([string]$Label = 'snapshot')

# Match on the COMMAND LINE, not just the image name. `monitor.js` is itself a
# node process running for the whole window; counting it would fold the
# measurement tool's CPU into the measurement (it added ~1,400 CPU-seconds of
# unrelated accounting on the first attempt). Only `dist/src/main` — the API
# primary and, under API_CLUSTER_WORKERS>1, each forked worker, all of which
# re-enter the same entrypoint — is counted.
$api = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
       Where-Object { $_.CommandLine -match 'dist[\\/]src[\\/]main' }
if (-not $api) {
  Write-Output "$Label|0|0|0"
  exit 0
}
$ids = @($api | ForEach-Object { $_.ProcessId })
$procs = Get-Process -Id $ids -ErrorAction SilentlyContinue
$cpu = ($procs | Measure-Object -Property CPU -Sum).Sum
$rss = ($procs | Measure-Object -Property WorkingSet64 -Sum).Sum
Write-Output ("{0}|{1}|{2}|{3}" -f $Label, @($procs).Count, [math]::Round($cpu, 2), $rss)
