function Parse-BsonDocument {
    param (
        [byte[]]$bytes,
        [ref]$offset
    )

    $docSize = [System.BitConverter]::ToInt32($bytes, $offset.Value)
    $startOffset = $offset.Value
    $offset.Value += 4
    
    $obj = [ordered]@{}

    while ($offset.Value -lt ($startOffset + $docSize - 1)) {
        $type = $bytes[$offset.Value]
        $offset.Value += 1

        # Read null-terminated string (key)
        $keyBytes = New-Object System.Collections.Generic.List[byte]
        while ($bytes[$offset.Value] -ne 0 -and $offset.Value -lt $bytes.Length) {
            $keyBytes.Add($bytes[$offset.Value])
            $offset.Value += 1
        }
        $offset.Value += 1 # skip null terminator
        $key = [System.Text.Encoding]::UTF8.GetString($keyBytes.ToArray())

        $val = Parse-BsonValue -bytes $bytes -offset $offset -type $type
        $obj[$key] = $val
    }

    $offset.Value += 1 # skip trailing 0x00
    return $obj
}

function Parse-BsonValue {
    param (
        [byte[]]$bytes,
        [ref]$offset,
        [byte]$type
    )

    switch ($type) {
        1 { # Double
            $val = [System.BitConverter]::ToDouble($bytes, $offset.Value)
            $offset.Value += 8
            return $val
        }
        2 { # String
            $length = [System.BitConverter]::ToInt32($bytes, $offset.Value)
            $offset.Value += 4
            $str = [System.Text.Encoding]::UTF8.GetString($bytes, $offset.Value, $length - 1)
            $offset.Value += $length
            return $str
        }
        3 { # Embedded Document
            return Parse-BsonDocument -bytes $bytes -offset $offset
        }
        4 { # Array
            $arrDoc = Parse-BsonDocument -bytes $bytes -offset $offset
            $arr = New-Object System.Collections.Generic.List[Object]
            foreach ($k in $arrDoc.Keys) {
                $arr.Add($arrDoc[$k])
            }
            return $arr
        }
        5 { # Binary
            $length = [System.BitConverter]::ToInt32($bytes, $offset.Value)
            $offset.Value += 5 # skip length (4) + subtype (1)
            $offset.Value += $length
            return "<Binary: $length bytes>"
        }
        7 { # ObjectID
            $hexList = New-Object System.Collections.Generic.List[string]
            for ($i = 0; $i -lt 12; $i++) {
                $hexList.Add($bytes[$offset.Value + $i].ToString("x2"))
            }
            $offset.Value += 12
            return ("oid:" + [string]::Concat($hexList))
        }
        8 { # Boolean
            $val = ($bytes[$offset.Value] -ne 0)
            $offset.Value += 1
            return $val
        }
        9 { # UTC DateTime
            $ms = [System.BitConverter]::ToInt64($bytes, $offset.Value)
            $offset.Value += 8
            return "<Date: $ms>"
        }
        10 { # Null
            return $null
        }
        16 { # 32-bit integer
            $val = [System.BitConverter]::ToInt32($bytes, $offset.Value)
            $offset.Value += 4
            return $val
        }
        18 { # 64-bit integer
            $val = [System.BitConverter]::ToInt64($bytes, $offset.Value)
            $offset.Value += 8
            return $val
        }
        Default {
            Write-Error "Unsupported type $type at offset $($offset.Value)"
            return $null
        }
    }
}

function Parse-BsonFile {
    param (
        [string]$Path
    )

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $offset = [ref]0
    $docs = New-Object System.Collections.Generic.List[Object]

    while ($offset.Value -lt $bytes.Length) {
        if ($bytes.Length - $offset.Value -lt 4) { break }
        $doc = Parse-BsonDocument -bytes $bytes -offset $offset
        $docs.Add($doc)
    }

    return $docs
}

$dbDir = "d:\mikhomn\genieacsasli\genieacs-main\db"
$filePath = Join-Path $dbDir "config.bson"
if (Test-Path $filePath) {
    $docs = Parse-BsonFile -Path $filePath
    foreach ($doc in $docs) {
        if ($doc._id -match "^ui\.index\.") {
            $doc | ConvertTo-Json -Depth 10 | Write-Output
        }
    }
} else {
    Write-Output "config.bson does not exist."
}
