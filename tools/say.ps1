param([Parameter(Mandatory = $true)][string]$Text)
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.Rate = 1
$synth.Speak($Text)
$synth.Dispose()
