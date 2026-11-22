Add-Type -AssemblyName System.Speech

# Pick English recognizer if available, otherwise default
$recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
$enRecognizer = $recognizers | Where-Object { $_.Culture.Name -like 'en-*' } | Select-Object -First 1

if ($enRecognizer) {
    $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($enRecognizer.Culture)
    [Console]::Error.WriteLine("Using recognizer: $($enRecognizer.Culture.Name)")
} else {
    $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    [Console]::Error.WriteLine("Warning: No English recognizer installed, using system default. Install via Settings > Time & Language > Language > English > Speech.")
}

$grammar = New-Object System.Speech.Recognition.DictationGrammar
$rec.LoadGrammar($grammar)
$rec.SetInputToDefaultAudioDevice()

Register-ObjectEvent -InputObject $rec -EventName SpeechRecognized -Action {
    $text = $Event.SourceEventArgs.Result.Text
    if ($text.Trim() -ne '') {
        [Console]::WriteLine($text)
        [Console]::Out.Flush()
    }
} | Out-Null

$rec.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)

while ($true) { Start-Sleep -Milliseconds 100 }
