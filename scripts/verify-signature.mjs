import { execFileSync } from 'node:child_process';
import { windowsPowerShell, windowsPowerShellEnv } from '../desktop/windows-save.cjs';

export function requirePublisherFingerprint(value) {
  if (!/^[0-9a-f]{64}$/i.test(value ?? '')) throw new Error('Set BUOYANCY_SIGNER_SHA256 to the expected signing certificate SHA-256');
  return value.toUpperCase();
}

export function verifySignature(file, expected) {
  expected = requirePublisherFingerprint(expected);
  const script = `
    $ErrorActionPreference = 'Stop'
    $signature = Get-AuthenticodeSignature -LiteralPath $env:BUOYANCY_SIGNED_FILE
    if ($signature.Status -ne 'Valid' -or !$signature.SignerCertificate) { exit 3 }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { [BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.RawData)).Replace('-', '') }
    finally { $sha.Dispose() }
  `;
  let actual;
  try {
    actual = execFileSync(windowsPowerShell(), ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64')], {
      encoding: 'ascii', windowsHide: true, env: windowsPowerShellEnv({ BUOYANCY_SIGNED_FILE: file }),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { throw new Error('The Windows executable has no trusted Authenticode signature'); }
  if (actual !== expected) throw new Error('The Windows executable signer does not match the expected certificate');
}
