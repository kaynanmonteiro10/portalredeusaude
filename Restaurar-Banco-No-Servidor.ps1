param(
    [string]$Servidor = "http://192.168.1.28:5500",
    [string]$Banco = "C:\Users\Administrativo\Documents\KAYNAN\meusarquivos\meusarquivos\Organizacao\portal.db",
    [string]$Usuario = "admin"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $Banco)) {
    throw "Banco não encontrado: $Banco"
}

$senhaSegura = Read-Host "Senha da conta administrativa" -AsSecureString
$senhaTexto = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($senhaSegura)
)

$loginBody = @{
    username = $Usuario
    password = $senhaTexto
} | ConvertTo-Json

$login = Invoke-RestMethod `
    -Uri "$Servidor/api/login" `
    -Method Post `
    -ContentType "application/json" `
    -Body $loginBody `
    -TimeoutSec 30

$cliente = [System.Net.Http.HttpClient]::new()
try {
    $cliente.Timeout = [TimeSpan]::FromMinutes(10)
    $cliente.DefaultRequestHeaders.Authorization =
        [System.Net.Http.Headers.AuthenticationHeaderValue]::new("Bearer", $login.token)

    $conteudo = [System.Net.Http.ByteArrayContent]::new([System.IO.File]::ReadAllBytes($Banco))
    $conteudo.Headers.ContentType =
        [System.Net.Http.Headers.MediaTypeHeaderValue]::new("application/octet-stream")

    $resposta = $cliente.PostAsync("$Servidor/api/admin/restore-database", $conteudo).GetAwaiter().GetResult()
    $texto = $resposta.Content.ReadAsStringAsync().GetAwaiter().GetResult()

    if (-not $resposta.IsSuccessStatusCode) {
        throw "Falha na restauração ($([int]$resposta.StatusCode)): $texto"
    }

    Write-Host "Banco restaurado com sucesso." -ForegroundColor Green
    Write-Host $texto
} finally {
    $cliente.Dispose()
}
