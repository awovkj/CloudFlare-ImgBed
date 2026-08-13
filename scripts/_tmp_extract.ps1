$c = Get-Content 'c:\Users\31373\Downloads\CloudFlare-ImgBed\js\274.9b7364f3.js' -Raw

# beforeUpload definition
$idx = $c.IndexOf('beforeUpload(')
$cnt = 0
while ($idx -ge 0 -and $cnt -lt 4) {
  Write-Output ("--- beforeUpload @ {0} ---" -f $idx)
  Write-Output $c.Substring($idx, 600)
  Write-Output ""
  $idx = $c.IndexOf('beforeUpload(', $idx+13)
  $cnt++
}

# scheduleAutoRetry
$idx = $c.IndexOf('scheduleAutoRetry')
if ($idx -ge 0) {
  Write-Output "=== scheduleAutoRetry @ $idx ==="
  Write-Output $c.Substring($idx, 600)
}
