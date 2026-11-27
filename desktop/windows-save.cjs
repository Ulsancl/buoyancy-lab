const { spawn } = require('node:child_process');
const path = require('node:path');

// Windows PowerShell ships with Windows. File.Replace uses ReplaceFileW and
// refuses a metadata/ACL merge failure. The stage ACL is set at creation time.
const saveScript = String.raw`
$ErrorActionPreference = 'Stop'
$inputRecord = [Console]::In.ReadToEnd() | ConvertFrom-Json
$target = [string]$inputRecord.target
$parent = [IO.Path]::GetDirectoryName($target)
$stage = [IO.Path]::Combine($parent, '.buoyancy-save-' + [Guid]::NewGuid().ToString('N'))
$temporary = [IO.Path]::Combine($stage, 'project.tmp')
$reparsePoint = [IO.FileAttributes]::ReparsePoint
function Assert-RealDirectory([string]$directory) {
    while ($directory) {
        if ([IO.File]::GetAttributes($directory) -band $reparsePoint) { throw 'Invalid save directory' }
        $directory = [IO.Path]::GetDirectoryName($directory)
    }
}
$owned = $false
try {
    Assert-RealDirectory $parent
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
        $user, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'))
    if ([IO.Directory]::Exists($stage) -or [IO.File]::Exists($stage)) { throw 'Save staging name already exists' }
    [IO.Directory]::CreateDirectory($stage, $acl) | Out-Null
    $owned = $true
    $stream = [IO.FileStream]::new($temporary, 'CreateNew', 'Write', 'None')
    try {
        $bytes = [Convert]::FromBase64String($inputRecord.contents)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
    $delays = @(25, 50, 100, 200, 400)
    for ($attempt = 0; ; $attempt++) {
        Assert-RealDirectory $stage
        $attributes = $null
        try { $attributes = [IO.File]::GetAttributes($target) }
        catch [IO.FileNotFoundException] {}
        if ($null -ne $attributes -and ($attributes -band ($reparsePoint -bor [IO.FileAttributes]::Directory))) {
            throw 'Invalid save destination'
        }
        try {
            if ($null -eq $attributes) { [IO.File]::Move($temporary, $target) }
            else { [IO.File]::Replace($temporary, $target, [NullString]::Value, $false) }
            break
        } catch {
            $code = $_.Exception.GetBaseException().HResult -band 65535
            if ($attempt -ge $delays.Length -or $code -notin @(5, 32, 33)) { throw }
            Start-Sleep -Milliseconds $delays[$attempt]
        }
    }
} finally {
    if ($owned) {
        Assert-RealDirectory $stage
        [IO.File]::Delete($temporary)
        [IO.Directory]::Delete($stage)
    }
}
`;

function windowsPowerShell() {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('Windows SystemRoot is unavailable');
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function windowsWriteProject(target, contents) {
  const command = Buffer.from(saveScript, 'utf16le').toString('base64');
  // Base64 encodes the wire bytes so PowerShell's console encoding cannot
  // reinterpret a Unicode project or path. The fixed command reads only data.
  const payload = JSON.stringify({
    target,
    contents: Buffer.from(contents, 'utf8').toString('base64'),
  }).replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(windowsPowerShell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
      windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', reject);
    child.stdin.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('실험 파일을 저장할 수 없습니다. 폴더와 파일의 권한을 확인해 주세요.'));
    });
    child.stdin.end(payload);
  });
}

module.exports = { windowsPowerShell, windowsWriteProject };
