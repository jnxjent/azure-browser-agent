param(
  [string]$Origin = 'https://desknets.midac.jp',
  [string]$Directory = 'C:\BrowserAgent\shared\credentials'
)
# Run interactively as abaops on the TestSite VM. Never pass passwords as arguments.
$ErrorActionPreference = 'Stop'
if ($env:COMPUTERNAME -ne 'vm-abagent-t01') { throw 'This enrollment script is restricted to the TestSite VM.' }
if ($env:USERNAME -ne 'abaops') { throw 'Run as the BrowserAgent interactive user abaops.' }
$uri = [Uri]$Origin
if ($uri.Scheme -ne 'https' -or $uri.GetLeftPart([UriPartial]::Authority) -ne $Origin -or $uri.UserInfo) {throw 'An HTTPS origin without a path is required.'}
Add-Type -AssemblyName System.Security
New-Item -ItemType Directory -Force -Path $Directory | Out-Null
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true,$false)
foreach ($sid in @([Security.Principal.WindowsIdentity]::GetCurrent().User, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $Directory -AclObject $acl
function Read-Pair($label) {
  $user = Read-Host "$label user ID"
  if ([string]::IsNullOrWhiteSpace($user)) {throw 'User ID is required.'}
  $secret = Read-Host "$label password" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
  try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
    if (!$password) {throw 'Password is required.'}
    return @{username=$user;password=$password}
  } finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr);$secret.Dispose()}
}
$data = @{origin=$Origin;basic=(Read-Pair 'BASIC');app=(Read-Pair 'DeskNets')}
try {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($data | ConvertTo-Json -Compress))
  $encrypted = [Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)
  [IO.File]::WriteAllBytes((Join-Path $Directory 'desknets.bin'),$encrypted)
  Write-Host 'Encrypted credentials saved. Retry your request in TestSite.'
} finally {
  if ($bytes) {[Array]::Clear($bytes,0,$bytes.Length)}
  $data=$null
}
