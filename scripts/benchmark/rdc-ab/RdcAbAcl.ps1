$ErrorActionPreference = 'Stop'

function Assert-RdcAbAclCapableVolume([string]$Path) {
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'RDC A/B ACL boundary requires Windows' }
  $full = [IO.Path]::GetFullPath($Path)
  $driveRoot = [IO.Path]::GetPathRoot($full)
  if (-not $driveRoot) { throw 'RDC A/B ACL boundary requires a local drive path' }
  if ($full.StartsWith('\\')) { throw 'RDC A/B ACL boundary requires a local fixed drive path' }
  $drive = [IO.DriveInfo]::new($driveRoot)
  if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'RDC A/B ACL boundary requires a local fixed drive' }
  if (-not $drive.DriveFormat.Equals('NTFS', [StringComparison]::OrdinalIgnoreCase)) {
    throw "RDC A/B ACL boundary requires NTFS; found $($drive.DriveFormat)"
  }
}

function Get-RdcAbAclOwnerSid([string]$Path) {
  $acl = Get-Acl -LiteralPath $Path
  return $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
}

function Get-RdcAbTrustedSidSet([string]$OwnerSid) {
  $set = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  [void]$set.Add($OwnerSid)
  [void]$set.Add('S-1-5-18')
  [void]$set.Add('S-1-5-32-544')
  return $set
}

function Assert-RdcAbProtectedRootAcl([string]$Path) {
  Assert-RdcAbAclCapableVolume $Path
  $attrs = [IO.File]::GetAttributes($Path)
  if (($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'RDC A/B benchmark root must not be a reparse point' }
  $acl = Get-Acl -LiteralPath $Path
  if (-not $acl.AreAccessRulesProtected) { throw 'RDC A/B benchmark root ACL must be protected from inheritance' }
  $ownerSid = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if (-not $ownerSid.Equals($currentSid, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'RDC A/B benchmark root owner must equal the current process user'
  }
  $trusted = Get-RdcAbTrustedSidSet $ownerSid
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  foreach ($rule in $rules) {
    $sid = $rule.IdentityReference.Value
    if ($rule.IsInherited) { throw 'RDC A/B benchmark root ACL must not contain inherited rules' }
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
      throw 'RDC A/B benchmark root ACL must not contain deny rules'
    }
    if (-not $trusted.Contains($sid)) { throw "RDC A/B benchmark root ACL grants an untrusted principal: $sid" }
    if (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl) {
      throw "RDC A/B trusted root principal lacks FullControl: $sid"
    }
    $requiredInheritance = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    if (($rule.InheritanceFlags -band $requiredInheritance) -ne $requiredInheritance -or
        $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
      throw "RDC A/B trusted root ACL rule does not propagate safely: $sid"
    }
    [void]$seen.Add($sid)
  }
  foreach ($sid in $trusted) {
    if (-not $seen.Contains($sid)) { throw "RDC A/B benchmark root ACL is missing trusted principal: $sid" }
  }
  return $ownerSid
}

function Assert-RdcAbInheritedChildAcl([string]$Root, [string]$Path, [string]$Label) {
  $ownerSid = Assert-RdcAbProtectedRootAcl $Root
  $trusted = Get-RdcAbTrustedSidSet $ownerSid
  $acl = Get-Acl -LiteralPath $Path
  if ($acl.AreAccessRulesProtected) { throw "$Label ACL must inherit from the protected benchmark root" }
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  foreach ($rule in $rules) {
    if (-not $rule.IsInherited) { throw "$Label ACL contains an explicit rule" }
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
      throw "$Label ACL contains a deny rule"
    }
    if (-not $trusted.Contains($rule.IdentityReference.Value)) {
      throw "$Label ACL inherits an untrusted principal: $($rule.IdentityReference.Value)"
    }
  }
}

function Assert-RdcAbRuntimeTreeAcl([string]$Root, [string]$RuntimeRoot, [string]$Label) {
  $rootOwner = Assert-RdcAbProtectedRootAcl $Root
  $trusted = Get-RdcAbTrustedSidSet $rootOwner
  $stack = New-Object 'System.Collections.Generic.Stack[string]'
  $stack.Push([IO.Path]::GetFullPath($RuntimeRoot))
  while ($stack.Count -gt 0) {
    $current = $stack.Pop()
    $attributes = [IO.File]::GetAttributes($current)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Label contains a reparse point: $current"
    }
    $acl = Get-Acl -LiteralPath $current
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if (-not $owner.Equals($rootOwner, [StringComparison]::OrdinalIgnoreCase)) {
      throw "$Label contains an object not owned by the benchmark owner: $current"
    }
    if ($acl.AreAccessRulesProtected) { throw "$Label contains a protected descendant ACL: $current" }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    foreach ($rule in $rules) {
      if (-not $rule.IsInherited) { throw "$Label contains an explicit descendant ACL rule: $current" }
      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
        throw "$Label contains a deny descendant ACL rule: $current"
      }
      if (-not $trusted.Contains($rule.IdentityReference.Value)) {
        throw "$Label contains an untrusted descendant ACL principal: $($rule.IdentityReference.Value)"
      }
    }
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
      foreach ($child in [IO.Directory]::GetFileSystemEntries($current)) { $stack.Push($child) }
    }
  }
}

function Set-RdcAbProtectedRootAcl([string]$Path) {
  Assert-RdcAbAclCapableVolume $Path
  $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($null -eq $currentSid) { throw 'Unable to resolve benchmark ACL owner SID' }
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetOwner($currentSid)
  $acl.SetAccessRuleProtection($true, $false)
  $inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($sidText in @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique) {
    $sid = New-Object Security.Principal.SecurityIdentifier($sidText)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule(
      $sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit,
      [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($rule)
  }
  ([IO.DirectoryInfo](Get-Item -LiteralPath $Path -Force)).SetAccessControl($acl)
  foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {
    & icacls.exe $child.FullName /reset /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Unable to reset inherited ACLs beneath benchmark root: $($child.FullName)" }
  }
  [void](Assert-RdcAbProtectedRootAcl $Path)
  foreach ($child in Get-ChildItem -LiteralPath $Path -Force) {
    Assert-RdcAbInheritedChildAcl $Path $child.FullName "Benchmark child '$($child.Name)'"
  }
}
