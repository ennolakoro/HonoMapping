$filePath = 'd:\mikhomn\genieacsasli\genieacs-main\genieacs\bin\genieacs-cwmp'
$content = [System.IO.File]::ReadAllText($filePath)

$keywords = @('connectionRequestUrl', 'WWW-Authenticate', 'Digest', 'sendConnectionRequest', 'connection_request', 'ConnectionRequest')

foreach ($kw in $keywords) {
    $idx = $content.IndexOf($kw)
    if ($idx -ge 0) {
        Write-Host "=== FOUND: '$kw' at index $idx ==="
        $start = [Math]::Max(0, $idx - 200)
        $len = [Math]::Min(1200, $content.Length - $start)
        Write-Host $content.Substring($start, $len)
        Write-Host "`n"
    } else {
        Write-Host "=== NOT FOUND: '$kw' ==="
    }
}
