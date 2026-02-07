<#
.SYNOPSIS
    Verifies SwarmAid backend Lambda IAM permissions and optionally runs runtime smoke tests.

.DESCRIPTION
    Automatically discovers Lambda functions by stack prefix, validates IAM permissions
    for accessing Secrets Manager secrets (Mapbox token and Gemini API key), and optionally
    runs runtime smoke tests against live API endpoints.

.PARAMETER Region
    AWS region where resources are deployed. Default: us-east-1

.PARAMETER StackPrefix
    CloudFormation stack name prefix for Lambda discovery. Default: SwarmAidFoundation

.PARAMETER Profile
    AWS CLI profile to use. Default: swarmaid

.PARAMETER IdToken
    Optional JWT IdToken from Cognito. If provided, runs runtime smoke tests.

.PARAMETER BaseUrl
    API Gateway base URL for runtime tests. 
    Default: https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod

.EXAMPLE
    .\verify-backend-deps.ps1
    Runs IAM permission checks only

.EXAMPLE
    .\verify-backend-deps.ps1 -IdToken "eyJraWQ..."
    Runs IAM checks + runtime smoke tests

.EXAMPLE
    .\verify-backend-deps.ps1 -Region us-west-2 -StackPrefix MyStack
    Runs checks against custom region/stack

.NOTES
    Author: SwarmAid Team
    Purpose: Prevent Lambda name truncation errors and validate secret access
#>

param(
    [string]$Region = "us-east-1",
    [string]$StackPrefix = "SwarmAidFoundation",
    [string]$Profile = "swarmaid",
    [string]$IdToken = "",
    [string]$BaseUrl = "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod"
)

$ErrorActionPreference = "Stop"

# Color output helpers
function Write-Success { param([string]$Message) Write-Host $Message -ForegroundColor Green }
function Write-Info { param([string]$Message) Write-Host $Message -ForegroundColor Cyan }
function Write-Warning { param([string]$Message) Write-Host $Message -ForegroundColor Yellow }
function Write-Failure { param([string]$Message) Write-Host $Message -ForegroundColor Red }

Write-Info "`n=== SwarmAid Backend Verification Script ==="
Write-Info "Region: $Region"
Write-Info "Stack Prefix: $StackPrefix"
Write-Info "Profile: $Profile`n"

# ============================================================================
# STEP 1: Discover Lambda Functions
# ============================================================================

Write-Info "=== Step 1: Lambda Function Discovery ==="

try {
    $allFunctions = aws lambda list-functions `
        --region $Region `
        --profile $Profile `
        --query "Functions[?contains(FunctionName, '$StackPrefix')].FunctionName" `
        --output json | ConvertFrom-Json

    if ($allFunctions.Count -eq 0) {
        Write-Failure "No Lambda functions found with prefix '$StackPrefix'"
        exit 1
    }

    Write-Success "Found $($allFunctions.Count) Lambda function(s) with prefix '$StackPrefix'"
}
catch {
    Write-Failure "Failed to list Lambda functions: $_"
    exit 1
}

# Discover specific Lambdas by substring match
$lambdaMap = @{}

foreach ($fn in $allFunctions) {
    if ($fn -match "Geocode") {
        $lambdaMap["Geocode"] = $fn
        Write-Info "  [Geocode] $fn"
    }
    elseif ($fn -match "MapPayload" -or ($fn -match "Map" -and $fn -notmatch "Geocode")) {
        $lambdaMap["MapPayload"] = $fn
        Write-Info "  [Map] $fn"
    }
    elseif ($fn -match "Agent" -and $fn -notmatch "Message|Confirm") {
        $lambdaMap["Agent"] = $fn
        Write-Info "  [Agent] $fn"
    }
    elseif ($fn -match "AgentMessage") {
        $lambdaMap["AgentMessage"] = $fn
        Write-Info "  [AgentMessage] $fn"
    }
    elseif ($fn -match "Matches" -and $fn -notmatch "Generation") {
        $lambdaMap["Matches"] = $fn
        Write-Info "  [Matches] $fn"
    }
    elseif ($fn -match "MatchGeneration" -or $fn -match "match-generation") {
        $lambdaMap["MatchGeneration"] = $fn
        Write-Info "  [MatchGeneration] $fn"
    }
    elseif ($fn -match "Profile") {
        $lambdaMap["Profile"] = $fn
        Write-Info "  [Profile] $fn"
    }
}

if ($lambdaMap.Count -eq 0) {
    Write-Failure "No recognizable Lambda functions found (Geocode, Map, Agent, etc.)"
    exit 1
}

# ============================================================================
# STEP 2: Fetch Secret ARNs
# ============================================================================

Write-Info "`n=== Step 2: Fetch Secret ARNs ==="

$secrets = @{
    "mapbox" = "/swarmaid/mapbox-token"
    "gemini" = "/swarmaid/gemini-api-key"
}

$secretArns = @{}

foreach ($key in $secrets.Keys) {
    $secretName = $secrets[$key]
    try {
        $secretArn = aws secretsmanager describe-secret `
            --secret-id $secretName `
            --region $Region `
            --profile $Profile `
            --query "ARN" `
            --output text

        if ($secretArn) {
            $secretArns[$key] = $secretArn
            Write-Success "  [$key] $secretArn"
        }
        else {
            Write-Warning "  [$key] Secret '$secretName' not found"
        }
    }
    catch {
        Write-Warning "  [$key] Failed to fetch secret '$secretName': $_"
    }
}

if ($secretArns.Count -eq 0) {
    Write-Failure "No secrets found. Cannot proceed with IAM validation."
    exit 1
}

# ============================================================================
# STEP 3: IAM Permission Verification
# ============================================================================

Write-Info "`n=== Step 3: IAM Permission Verification ==="

$iamResults = @()

foreach ($lambdaKey in $lambdaMap.Keys) {
    $functionName = $lambdaMap[$lambdaKey]
    
    Write-Info "`n--- Lambda: $lambdaKey ($functionName) ---"
    
    # Fetch execution role ARN
    try {
        $roleArn = aws lambda get-function-configuration `
            --function-name $functionName `
            --region $Region `
            --profile $Profile `
            --query "Role" `
            --output text

        if (-not $roleArn) {
            Write-Failure "  Failed to fetch role ARN"
            continue
        }

        Write-Info "  Role: $roleArn"
    }
    catch {
        Write-Failure "  Failed to get function config: $_"
        continue
    }

    # Test access to each secret
    $lambdaPermissions = @{
        "Lambda" = $lambdaKey
        "FunctionName" = $functionName
        "Role" = $roleArn
    }

    foreach ($secretKey in $secretArns.Keys) {
        $secretArn = $secretArns[$secretKey]
        $secretName = $secrets[$secretKey]

        try {
            $simulation = aws iam simulate-principal-policy `
                --policy-source-arn $roleArn `
                --action-names "secretsmanager:GetSecretValue" `
                --resource-arns $secretArn `
                --region $Region `
                --profile $Profile `
                --output json | ConvertFrom-Json

            $decision = $simulation.EvaluationResults[0].EvalDecision

            if ($decision -eq "allowed") {
                Write-Success "  [$secretName] ALLOWED ✓"
                $lambdaPermissions[$secretKey] = "ALLOWED"
            }
            else {
                Write-Failure "  [$secretName] DENIED ✗ ($decision)"
                $lambdaPermissions[$secretKey] = "DENIED"
            }
        }
        catch {
            Write-Failure "  [$secretName] ERROR: $_"
            $lambdaPermissions[$secretKey] = "ERROR"
        }
    }

    $iamResults += [PSCustomObject]$lambdaPermissions
}

# ============================================================================
# STEP 4: Summary Table
# ============================================================================

Write-Info "`n=== Step 4: IAM Permission Summary ==="
Write-Host ""

$iamResults | Format-Table -Property Lambda, @{
    Label = "Mapbox Token"
    Expression = { 
        if ($_.mapbox -eq "ALLOWED") { "$($_.mapbox) ✓" }
        elseif ($_.mapbox -eq "DENIED") { "$($_.mapbox) ✗" }
        else { $_.mapbox }
    }
}, @{
    Label = "Gemini API Key"
    Expression = { 
        if ($_.gemini -eq "ALLOWED") { "$($_.gemini) ✓" }
        elseif ($_.gemini -eq "DENIED") { "$($_.gemini) ✗" }
        else { $_.gemini }
    }
} -AutoSize

# ============================================================================
# STEP 5: Runtime Smoke Tests (Optional)
# ============================================================================

if ($IdToken) {
    Write-Info "`n=== Step 5: Runtime Smoke Tests ==="
    Write-Warning "JWT Token provided - running live API tests (secrets will NOT be logged)`n"

    $testResults = @()
    $headers = @{
        "Content-Type" = "application/json"
    }
    $authHeaders = @{
        "Authorization" = $IdToken
        "Content-Type" = "application/json"
    }

    # Test 1: Health Check (public endpoint)
    Write-Info "Test 1: Health Check"
    try {
        $response = Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/health" -Headers $headers -ErrorAction Stop
        Write-Success "  GET /v1/health: 200 OK ✓"
        Write-Info "    Response: $($response.status)"
        $testResults += [PSCustomObject]@{ Endpoint = "/v1/health"; Status = "PASS"; Code = "200" }
    }
    catch {
        Write-Failure "  GET /v1/health: FAILED ✗"
        Write-Failure "    Error: $($_.Exception.Message)"
        $testResults += [PSCustomObject]@{ Endpoint = "/v1/health"; Status = "FAIL"; Code = "N/A" }
    }

    # Test 2: User Info (protected endpoint)
    Write-Info "`nTest 2: Auth Check"
    try {
        $response = Invoke-RestMethod -Method Get -Uri "$BaseUrl/v1/me" -Headers $authHeaders -ErrorAction Stop
        Write-Success "  GET /v1/me: 200 OK ✓"
        Write-Info "    User: $($response.sub.Substring(0, [Math]::Min(20, $response.sub.Length)))..."
        $testResults += [PSCustomObject]@{ Endpoint = "/v1/me"; Status = "PASS"; Code = "200" }
    }
    catch {
        if ($_.Exception.Response.StatusCode -eq 401) {
            Write-Failure "  GET /v1/me: 401 Unauthorized ✗"
            Write-Failure "    Token may be invalid or expired"
        }
        else {
            Write-Failure "  GET /v1/me: FAILED ✗"
            Write-Failure "    Error: $($_.Exception.Message)"
        }
        $testResults += [PSCustomObject]@{ Endpoint = "/v1/me"; Status = "FAIL"; Code = "401" }
    }

    # Test 3: Geocoding (Mapbox secret required)
    Write-Info "`nTest 3: Geocoding (Mapbox Secret Verification)"
    $geocodeLambdaName = $null
    $geocodeSuccess = $false
    
    try {
        $body = @{
            addressText = "Atlanta, GA"
        } | ConvertTo-Json

        $response = Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/geocode" -Headers $authHeaders -Body $body -ErrorAction Stop
        
        if ($response.ok -eq $true) {
            Write-Success "  POST /v1/geocode: 200 OK ✓"
            Write-Info "    Location: $($response.data.location.lat), $($response.data.location.lon)"
            Write-Info "    Place: $($response.data.location.placeName.Substring(0, [Math]::Min(50, $response.data.location.placeName.Length)))..."
            Write-Success "    ✓ Mapbox sk. token is working correctly!"
            $testResults += [PSCustomObject]@{ Endpoint = "/v1/geocode"; Status = "PASS"; Code = "200" }
            $geocodeSuccess = $true
        }
        else {
            Write-Failure "  POST /v1/geocode: Response indicated failure"
            Write-Failure "    Error: $($response.error) - $($response.message)"
            
            # Troubleshooting guidance
            if ($response.error -eq "SERVICE_UNAVAILABLE") {
                Write-Warning "    → Likely cause: Mapbox token invalid or restricted"
                Write-Warning "    → Check: Token has Geocoding API access enabled"
                Write-Warning "    → Verify secret value: aws secretsmanager get-secret-value --secret-id /swarmaid/mapbox-token --profile $Profile"
            }
            elseif ($response.error -eq "INTERNAL_ERROR") {
                Write-Warning "    → Likely cause: Lambda can't read Secrets Manager"
                Write-Warning "    → Check IAM permissions above (should show ALLOWED)"
                Write-Warning "    → Verify: mapboxSecret.grantRead(geocodeLambda) in CDK stack"
            }
            
            $testResults += [PSCustomObject]@{ Endpoint = "/v1/geocode"; Status = "FAIL"; Code = "200" }
        }
    }
    catch {
        $statusCode = $null
        $errorBody = $null
        
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
            try {
                $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
                $errorBody = $reader.ReadToEnd() | ConvertFrom-Json
                $reader.Close()
            }
            catch {
                $errorBody = $null
            }
        }
        
        Write-Failure "  POST /v1/geocode: FAILED ✗"
        Write-Failure "    HTTP Status: $statusCode"
        Write-Failure "    Error: $($_.Exception.Message)"
        
        # Detailed troubleshooting
        if ($statusCode -eq 401) {
            Write-Warning "    → Likely cause: JWT token expired or invalid"
            Write-Warning "    → Solution: Refresh Cognito token and retry"
        }
        elseif ($statusCode -eq 403) {
            Write-Warning "    → Likely cause: Mapbox token invalid or rate limited"
            Write-Warning "    → Check Mapbox dashboard for token status"
        }
        elseif ($statusCode -eq 500 -or $statusCode -eq 502) {
            Write-Warning "    → Likely cause: Lambda execution error"
            Write-Warning "    → Check CloudWatch logs below for details"
        }
        
        if ($errorBody) {
            Write-Failure "    Response: $($errorBody | ConvertTo-Json -Compress)"
        }
        
        $testResults += [PSCustomObject]@{ Endpoint = "/v1/geocode"; Status = "FAIL"; Code = $statusCode }
    }
    
    # CloudWatch Logs Verification (if geocode test ran)
    if ($lambdaMap.ContainsKey("Geocode")) {
        $geocodeLambdaName = $lambdaMap["Geocode"]
        Write-Info "`n  → Checking CloudWatch logs for secret loading..."
        
        try {
            # Get log group name
            $logGroup = "/aws/lambda/$geocodeLambdaName"
            
            # Get latest log stream
            $latestStream = aws logs describe-log-streams `
                --log-group-name $logGroup `
                --order-by LastEventTime `
                --descending `
                --limit 1 `
                --region $Region `
                --profile $Profile `
                --query "logStreams[0].logStreamName" `
                --output text 2>$null
            
            if ($latestStream -and $latestStream -ne "None") {
                # Get recent log events
                $logEvents = aws logs get-log-events `
                    --log-group-name $logGroup `
                    --log-stream-name $latestStream `
                    --limit 20 `
                    --region $Region `
                    --profile $Profile `
                    --query "events[*].message" `
                    --output json 2>$null | ConvertFrom-Json
                
                if ($logEvents) {
                    Write-Info "    Recent logs from $($latestStream.Substring(0, [Math]::Min(40, $latestStream.Length)))...:"
                    
                    $secretLoadSuccess = $false
                    $secretLoadFail = $false
                    
                    foreach ($log in $logEvents | Select-Object -Last 20) {
                        # Redact any potential token values
                        $safeLog = $log -replace 'pk\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[REDACTED_PK_TOKEN]'
                        $safeLog = $safeLog -replace 'sk\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '[REDACTED_SK_TOKEN]'
                        $safeLog = $safeLog -replace '"SecretString"\s*:\s*"[^"]+"', '"SecretString":"[REDACTED]"'
                        
                        # Check for key indicators
                        if ($safeLog -match "Mapbox token loaded|token loaded: OK") {
                            $secretLoadSuccess = $true
                            Write-Success "      ✓ $safeLog"
                        }
                        elseif ($safeLog -match "Failed to retrieve.*token|Mapbox token unavailable|AccessDenied") {
                            $secretLoadFail = $true
                            Write-Failure "      ✗ $safeLog"
                        }
                        elseif ($safeLog -match "ERROR|Error|error" -and $safeLog -notmatch "errorType.*Success") {
                            Write-Warning "      ⚠ $($safeLog.Substring(0, [Math]::Min(120, $safeLog.Length)))"
                        }
                        else {
                            # Only show relevant logs
                            if ($safeLog -match "geocod|mapbox|secret|token" -and $safeLog.Length -lt 200) {
                                Write-Host "        $($safeLog.Substring(0, [Math]::Min(120, $safeLog.Length)))" -ForegroundColor Gray
                            }
                        }
                    }
                    
                    # Summary
                    if ($secretLoadSuccess) {
                        Write-Success "    ✓ Mapbox secret loaded successfully from Secrets Manager"
                    }
                    elseif ($secretLoadFail) {
                        Write-Failure "    ✗ Lambda failed to load Mapbox secret"
                        Write-Warning "    → Check IAM permission: mapboxSecret.grantRead(geocodeLambda)"
                        Write-Warning "    → Verify secret exists: aws secretsmanager describe-secret --secret-id /swarmaid/mapbox-token"
                    }
                    elseif ($geocodeSuccess) {
                        Write-Info "    ✓ No errors in logs (token loaded successfully)"
                    }
                }
                else {
                    Write-Warning "    No recent log events found"
                }
            }
            else {
                Write-Warning "    No log streams found (Lambda may not have been invoked recently)"
            }
        }
        catch {
            Write-Warning "    Could not fetch CloudWatch logs: $($_.Exception.Message)"
            Write-Info "    (This is optional - main test result is what matters)"
        }
    }

    # Test 4: Agent Message (Gemini secret required)
    Write-Info "`nTest 4: Agent Message (Gemini Secret)"
    try {
        $body = @{
            message = "I have 20 lbs of carrots to donate today from 3pm to 6pm"
        } | ConvertTo-Json

        $response = Invoke-RestMethod -Method Post -Uri "$BaseUrl/v1/agent/message" -Headers $authHeaders -Body $body -ErrorAction Stop
        
        if ($response.success -eq $true) {
            Write-Success "  POST /v1/agent/message: 200 OK ✓"
            Write-Info "    Session: $($response.data.sessionId.Substring(0, [Math]::Min(20, $response.data.sessionId.Length)))..."
            Write-Info "    Role: $($response.data.role)"
            Write-Info "    Intent: $($response.data.intent)"
            
            if ($response.data.proposedFields) {
                $proposedKeys = ($response.data.proposedFields.PSObject.Properties | ForEach-Object { $_.Name }) -join ", "
                Write-Info "    Proposed Fields: $proposedKeys"
            }
            
            if ($response.data.missingFields) {
                Write-Info "    Missing Fields: $($response.data.missingFields.Count)"
            }
            
            $testResults += [PSCustomObject]@{ Endpoint = "/v1/agent/message"; Status = "PASS"; Code = "200" }
        }
        else {
            Write-Failure "  POST /v1/agent/message: Response indicated failure"
            $testResults += [PSCustomObject]@{ Endpoint = "/v1/agent/message"; Status = "FAIL"; Code = "200" }
        }
    }
    catch {
        $statusCode = $null
        if ($_.Exception.Response) {
            $statusCode = [int]$_.Exception.Response.StatusCode
        }
        
        Write-Failure "  POST /v1/agent/message: FAILED ✗"
        Write-Failure "    HTTP Status: $statusCode"
        Write-Failure "    Error: $($_.Exception.Message)"
        
        if ($statusCode -eq 401) {
            Write-Warning "    → Likely cause: JWT token expired or invalid"
            Write-Warning "    → Solution: Refresh Cognito token and retry"
        }
        elseif ($statusCode -eq 500) {
            Write-Warning "    → Likely cause: Gemini API error or Lambda execution issue"
            Write-Warning "    → Check: Gemini API key validity in Secrets Manager"
        }
        
        if ($_.ErrorDetails) {
            Write-Failure "    Details: $($_.ErrorDetails.Message)"
        }
        $testResults += [PSCustomObject]@{ Endpoint = "/v1/agent/message"; Status = "FAIL"; Code = $statusCode }
    }

    # Summary
    Write-Info "`n=== Runtime Test Summary ==="
    Write-Host ""
    $testResults | Format-Table -Property Endpoint, Status, Code -AutoSize

    $passCount = ($testResults | Where-Object { $_.Status -eq "PASS" }).Count
    $totalCount = $testResults.Count

    Write-Host ""
    if ($passCount -eq $totalCount) {
        Write-Success "All runtime tests passed! ($passCount/$totalCount) ✓"
    }
    else {
        Write-Warning "Some runtime tests failed ($passCount/$totalCount passed)"
    }
}
else {
    Write-Info "`n=== Step 5: Runtime Smoke Tests ==="
    Write-Info "Skipped (no -IdToken provided)"
    Write-Info "To run runtime tests, provide a valid JWT token:"
    Write-Info '  .\verify-backend-deps.ps1 -IdToken "eyJraWQ..."'
}

# ============================================================================
# Final Summary
# ============================================================================

Write-Info "`n=== Verification Complete ==="

$allowedCount = ($iamResults | ForEach-Object { 
    $result = $_
    $secrets.Keys | Where-Object { $result.$_ -eq "ALLOWED" } 
}).Count

$totalChecks = $iamResults.Count * $secrets.Count

Write-Host ""
Write-Info "IAM Permissions: $allowedCount/$totalChecks checks passed"

if ($IdToken) {
    $passCount = ($testResults | Where-Object { $_.Status -eq "PASS" }).Count
    $totalTests = $testResults.Count
    Write-Info "Runtime Tests: $passCount/$totalTests tests passed"
}

Write-Host ""
Write-Success "Verification script completed successfully!`n"
