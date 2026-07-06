. "d:\mikhomn\genieacsasli\genieacs-main\decode_bson.ps1"
$dbDir = "d:\mikhomn\genieacsasli\genieacs-main\db"
$files = Get-ChildItem -Path "$dbDir\*.bson"
foreach ($file in $files) {
    $jsonPath = $file.FullName -replace '\.bson$', '.json'
    Write-Output "Decoding $($file.Name) to $jsonPath..."
    try {
        $docs = Parse-BsonFile -Path $file.FullName
        $docs | ConvertTo-Json -Depth 10 | Out-File -FilePath $jsonPath -Encoding utf8
    } catch {
        Write-Error "Failed to decode $($file.Name): $_"
    }
}
