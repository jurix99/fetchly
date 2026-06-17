# Optional build-time CA certificates

Drop one or more `*.crt` files (PEM format) here **only if you build the image
behind a TLS-intercepting proxy** (e.g. a corporate Cloudflare Gateway / Zscaler
/ Netskope). They are trusted during the build so `pip` and `pnpm` can reach
PyPI / the npm registry.

- When this folder has no `*.crt`, the build is a **no-op** here and produces a
  clean image — nothing extra is trusted. This is the normal case for a NAS or
  any network without TLS interception.
- The actual `*.crt` files are **git-ignored** (never committed); only this
  README and `.gitkeep` are tracked so the folder always exists for the build.

To export a corporate root CA on Windows (PowerShell), e.g. Cloudflare Gateway:

```powershell
$c = Get-ChildItem Cert:\LocalMachine\Root |
     Where-Object { $_.Subject -match 'Gateway CA' } | Select-Object -First 1
$b64 = [Convert]::ToBase64String($c.RawData, 'InsertLineBreaks')
"-----BEGIN CERTIFICATE-----`n$b64`n-----END CERTIFICATE-----" |
  Set-Content -Encoding ascii certs\corporate-ca.crt
```
