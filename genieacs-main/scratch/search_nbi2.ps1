$filePath = 'd:\mikhomn\genieacsasli\genieacs-main\genieacs\bin\genieacs-nbi'
$content = [System.IO.File]::ReadAllText($filePath)

# Ambil 4000 karakter setelah ConnectionRequestURL (index 73296)
$start = 73296
$len = [Math]::Min(4000, $content.Length - $start)
Write-Host "=== NBI: ConnectionRequestURL section ==="
Write-Host $content.Substring($start, $len)
Write-Host "`n---`n"

# Ambil context Digest Auth builder (index 54075 - 200 karakter sebelumnya)
$start2 = [Math]::Max(0, 54075 - 500)
$len2 = [Math]::Min(2500, $content.Length - $start2)
Write-Host "=== NBI: Digest Auth builder section ==="
Write-Host $content.Substring($start2, $len2)
