$filePath = 'd:\mikhomn\genieacsasli\genieacs-main\genieacs\bin\genieacs-nbi'
$content = [System.IO.File]::ReadAllText($filePath)

$keywords = @('connectionRequest', 'ConnectionRequestURL', 'Digest', 'WWW-Authenticate', 'http.request', 'https.request')

foreach ($kw in $keywords) {
    $idx = $content.IndexOf($kw)
    if ($idx -ge 0) {
        Write-Host "=== FOUND: '$kw' at index $idx ==="
        $start = [Math]::Max(0, $idx - 100)
        $len = [Math]::Min(1500, $content.Length - $start)
        Write-Host $content.Substring($start, $len)
        Write-Host "`n---`n"
    } else {
        Write-Host "=== NOT FOUND: '$kw' ==="
    }
}
