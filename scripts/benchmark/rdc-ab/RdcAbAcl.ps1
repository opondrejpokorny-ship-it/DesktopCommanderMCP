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

# This is a benchmark-integrity guard against ordinary concurrent writers.  It
# is not a sandbox against the trusted owner, Administrators, or SYSTEM.
function Get-RdcAbRuntimeNamespaceSealRights {
  return [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
}

function New-RdcAbRuntimeNamespaceSealRule([string]$OwnerSid) {
  $sid = [Security.Principal.SecurityIdentifier]::new($OwnerSid)
  $inherit = [Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [Security.AccessControl.InheritanceFlags]::ContainerInherit
  return [Security.AccessControl.FileSystemAccessRule]::new(
    $sid, (Get-RdcAbRuntimeNamespaceSealRights), $inherit,
    [Security.AccessControl.PropagationFlags]::None,
    [Security.AccessControl.AccessControlType]::Deny)
}

function Test-RdcAbRuntimeNamespaceSealRule($Rule, [string]$OwnerSid, [bool]$Inherited, [bool]$IsDirectory) {
  $inherit = [Security.AccessControl.InheritanceFlags]::ObjectInherit -bor [Security.AccessControl.InheritanceFlags]::ContainerInherit
  $expectedInheritance = if (-not $Inherited -or $IsDirectory) { $inherit } else { [Security.AccessControl.InheritanceFlags]::None }
  return $Rule.IdentityReference.Value.Equals($OwnerSid, [StringComparison]::OrdinalIgnoreCase) -and
    $Rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny -and
    $Rule.IsInherited -eq $Inherited -and
    $Rule.FileSystemRights -eq (Get-RdcAbRuntimeNamespaceSealRights) -and
    $Rule.InheritanceFlags -eq $expectedInheritance -and
    $Rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
}

function Install-RdcAbRuntimeNamespaceSeal([string]$Root, [string]$RuntimeRoot) {
  $ownerSid = Assert-RdcAbProtectedRootAcl $Root
  Assert-RdcAbRuntimeTreeAcl $Root $RuntimeRoot 'Runtime tree before namespace seal'
  $acl = Get-Acl -LiteralPath $RuntimeRoot
  $acl.AddAccessRule((New-RdcAbRuntimeNamespaceSealRule $ownerSid))
  ([IO.DirectoryInfo](Get-Item -LiteralPath $RuntimeRoot -Force)).SetAccessControl($acl)
  return [pscustomobject]@{ OwnerSid=$ownerSid; Rights=[int](Get-RdcAbRuntimeNamespaceSealRights) }
}

function Assert-RdcAbRuntimeNamespaceSeal([string]$Root, [string]$RuntimeRoot, [string]$OwnerSid) {
  $rootOwner = Assert-RdcAbProtectedRootAcl $Root
  if (-not $rootOwner.Equals($OwnerSid, [StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime namespace seal owner mismatch' }
  $trusted = Get-RdcAbTrustedSidSet $rootOwner
  $stack = [Collections.Generic.Stack[string]]::new()
  $stack.Push([IO.Path]::GetFullPath($RuntimeRoot))
  while ($stack.Count -gt 0) {
    $current = $stack.Pop()
    $attrs = [IO.File]::GetAttributes($current)
    if (($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Runtime namespace seal contains a reparse point: $current" }
    $acl = Get-Acl -LiteralPath $current
    if ($acl.AreAccessRulesProtected) { throw "Runtime namespace seal contains a protected descendant ACL: $current" }
    if (-not $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value.Equals($rootOwner, [StringComparison]::OrdinalIgnoreCase)) { throw "Runtime namespace seal ownership changed: $current" }
    $expectedInherited = -not $current.Equals($RuntimeRoot, [StringComparison]::OrdinalIgnoreCase)
    $isDirectory = ($attrs -band [IO.FileAttributes]::Directory) -ne 0
    $sealCount = 0
    foreach ($rule in @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))) {
      if (Test-RdcAbRuntimeNamespaceSealRule $rule $OwnerSid $expectedInherited $isDirectory) { $sealCount++; continue }
      if (-not $rule.IsInherited) { throw "Runtime namespace seal contains an unexpected explicit ACL rule: $current" }
      if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw "Runtime namespace seal contains an unexpected deny ACL rule: $current" }
      if (-not $trusted.Contains($rule.IdentityReference.Value)) { throw "Runtime namespace seal inherits an untrusted principal: $($rule.IdentityReference.Value)" }
    }
    if ($sealCount -ne 1) { throw "Runtime namespace seal is missing or duplicated: $current" }
    if (($attrs -band [IO.FileAttributes]::Directory) -ne 0) {
      foreach ($child in [IO.Directory]::GetFileSystemEntries($current)) { $stack.Push($child) }
    }
  }
}

function Remove-RdcAbRuntimeNamespaceSeal([string]$Root, [string]$RuntimeRoot, [string]$OwnerSid) {
  Assert-RdcAbRuntimeNamespaceSeal $Root $RuntimeRoot $OwnerSid
  $acl = Get-Acl -LiteralPath $RuntimeRoot
  $acl.RemoveAccessRuleSpecific((New-RdcAbRuntimeNamespaceSealRule $OwnerSid))
  ([IO.DirectoryInfo](Get-Item -LiteralPath $RuntimeRoot -Force)).SetAccessControl($acl)
  Assert-RdcAbRuntimeTreeAcl $Root $RuntimeRoot 'Runtime tree after namespace seal removal'
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
