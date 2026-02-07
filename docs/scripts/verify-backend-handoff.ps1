<#
.SYNOPSIS
Backend handoff verification script - generates evidence for frontend team readiness

.DESCRIPTION
Tests three critical backend behaviors:
1. Distance-based deals ranking
2. Event feed after match acceptance
3. Map endpoint status guards

.PARAMETER BaseUrl
API Gateway base URL (default: https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod)

.PARAMETER ReceiverToken
JWT token for receiver account

.PARAMETER DonorToken
JWT token for donor account (optional - for two-party event verification)

.EXAMPLE
.\verify-backend-handoff.ps1 -ReceiverToken $token
#>

param(
    [string]$BaseUrl = "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod",
    [Parameter(Mandatory=$true)]
    [string]$ReceiverToken,
    [string]$DonorToken = ""
)

$ErrorActionPreference = "Continue"

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "BACKEND HANDOFF VERIFICATION" -ForegroundColor Cyan
Write-Host "========================================`n" -ForegroundColor Cyan

$headers = @{
    "Authorization" = "Bearer $ReceiverToken"
    "Content-Type" = "application/json"
}

# ============================================
# TEST 1: Distance-Based Deals Ranking
# ============================================

Write-Host "[TEST 1] Distance-Based Deals Ranking" -ForegroundColor Yellow
Write-Host "-------------------------------------" -ForegroundColor Yellow

try {
    $deals = Invoke-RestMethod -Method Get `
        -Uri "$BaseUrl/v1/deals" `
        -Headers $headers
    
    Write-Host "✓ GET /v1/deals succeeded" -ForegroundColor Green
    Write-Host "`nTop 3 deals:" -ForegroundColor White
    
    $topDeals = $deals.deals | Select-Object -First 3
    foreach ($deal in $topDeals) {
        Write-Host "`n  Listing: $($deal.listingId)" -ForegroundColor Cyan
        Write-Host "  Score: $($deal.score)" -ForegroundColor White
        Write-Host "  Reasons:" -ForegroundColor White
        foreach ($reason in $deal.reasons) {
            Write-Host "    - $reason" -ForegroundColor Gray
        }
        
        # Check for distance in reasons
        $hasDistance = $deal.reasons | Where-Object { $_ -match '\d+.*km' }
        if ($hasDistance) {
            Write-Host "  ✓ Distance scoring active" -ForegroundColor Green
        } else {
            Write-Host "  ⚠ No distance found (profile or listing missing location?)" -ForegroundColor Yellow
        }
    }
    
    Write-Host "`n📋 EVIDENCE 1 (Paste for reviewer):" -ForegroundColor Magenta
    Write-Host "```json" -ForegroundColor Gray
    $deals.deals | Select-Object -First 3 | ConvertTo-Json -Depth 10
    Write-Host "```" -ForegroundColor Gray
    
} catch {
    Write-Host "✗ GET /v1/deals failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Response: $($_.ErrorDetails.Message)" -ForegroundColor Red
}

# ============================================
# TEST 2: Event Feed After Match Accept
# ============================================

Write-Host "`n`n[TEST 2] Event Feed Synchronization" -ForegroundColor Yellow
Write-Host "-------------------------------------" -ForegroundColor Yellow

try {
    $events = Invoke-RestMethod -Method Get `
        -Uri "$BaseUrl/v1/events?since=0&limit=20" `
        -Headers $headers
    
    Write-Host "✓ GET /v1/events succeeded" -ForegroundColor Green
    Write-Host "Event count: $($events.count)" -ForegroundColor White
    
    if ($events.events -and $events.events.Count -gt 0) {
        Write-Host "`nRecent events:" -ForegroundColor White
        $events.events | Select-Object -First 5 | ForEach-Object {
            Write-Host "  - $($_.type) at $($_.createdAt)" -ForegroundColor Gray
        }
        
        # Check for match.accepted events
        $matchAccepted = $events.events | Where-Object { $_.type -eq 'match.accepted' }
        if ($matchAccepted) {
            Write-Host "`n  ✓ Found match.accepted event(s)" -ForegroundColor Green
        } else {
            Write-Host "`n  ⚠ No match.accepted events (accept a match to test)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  No events found (create listings/matches to populate)" -ForegroundColor Yellow
    }
    
    Write-Host "`n📋 EVIDENCE 2 (Paste for reviewer):" -ForegroundColor Magenta
    Write-Host "```json" -ForegroundColor Gray
    $events | ConvertTo-Json -Depth 10
    Write-Host "```" -ForegroundColor Gray
    
} catch {
    Write-Host "✗ GET /v1/events failed: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Response: $($_.ErrorDetails.Message)" -ForegroundColor Red
}

# ============================================
# TEST 3: Map Endpoint Status Guards
# ============================================

Write-Host "`n`n[TEST 3] Map Endpoint Status Guards" -ForegroundColor Yellow
Write-Host "-------------------------------------" -ForegroundColor Yellow
Write-Host "Need a match ID to test. If you have one, enter it now." -ForegroundColor White
Write-Host "Otherwise, press Enter to skip this test." -ForegroundColor White
$matchId = Read-Host "Match ID"

if ($matchId -and $matchId -ne "") {
    Write-Host "Testing /v1/map/match/$matchId..." -ForegroundColor White
    
    # Test map endpoint
    try {
        $mapResponse = Invoke-RestMethod -Method Get `
            -Uri "$BaseUrl/v1/map/match/$matchId" `
            -Headers $headers
        
        Write-Host "✓ Status: 200 OK - Route generated" -ForegroundColor Green
        Write-Host "  Match must be ACCEPTED" -ForegroundColor Gray
        Write-Host "  Distance: $([math]::Round($mapResponse.data.route.distanceMeters / 1000, 1)) km" -ForegroundColor White
        Write-Host "  Duration: $([math]::Round($mapResponse.data.route.durationSeconds / 60)) minutes" -ForegroundColor White
        
        Write-Host "`n📋 EVIDENCE 3 (Paste for reviewer):" -ForegroundColor Magenta
        Write-Host "Status: 200 OK (ACCEPTED match)" -ForegroundColor Gray
        
    } catch {
        $statusCode = $_.Exception.Response.StatusCode.value__
        $errorBody = $_.ErrorDetails.Message | ConvertFrom-Json
        
        Write-Host "Status: $statusCode $($_.Exception.Response.StatusDescription)" -ForegroundColor Yellow
        Write-Host "Error code: $($errorBody.error)" -ForegroundColor White
        Write-Host "Message: $($errorBody.message)" -ForegroundColor White
        
        # Verify expected status codes
        $expectedCodes = @(400, 410)
        if ($expectedCodes -contains $statusCode) {
            Write-Host "✓ Status guard working correctly" -ForegroundColor Green
            
            if ($errorBody.error -eq 'INVALID_STATUS') {
                Write-Host "  Match not ACCEPTED yet" -ForegroundColor Gray
            } elseif ($errorBody.error -eq 'MATCH_EXPIRED') {
                Write-Host "  Match expired" -ForegroundColor Gray
            } elseif ($errorBody.error -eq 'LISTING_CANCELLED') {
                Write-Host "  Listing was cancelled" -ForegroundColor Gray
            } elseif ($errorBody.error -eq 'LISTING_COMPLETED') {
                Write-Host "  Listing was completed" -ForegroundColor Gray
            }
        } else {
            Write-Host "⚠ Unexpected status code: $statusCode" -ForegroundColor Yellow
        }
        
        Write-Host "`n📋 EVIDENCE 3 (Paste for reviewer):" -ForegroundColor Magenta
        Write-Host "Status: $statusCode - $($errorBody.error)" -ForegroundColor Gray
    }
} else {
    Write-Host "⊘ Skipped - no match ID provided" -ForegroundColor Gray
    Write-Host "`n📋 EVIDENCE 3 (Paste for reviewer):" -ForegroundColor Magenta
    Write-Host "Not tested - need to create match first" -ForegroundColor Gray
}

# ============================================
# SUMMARY
# ============================================

Write-Host "`n`n========================================" -ForegroundColor Cyan
Write-Host "VERIFICATION COMPLETE" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Write-Host "`nNext steps for frontend handoff:" -ForegroundColor Yellow
Write-Host "1. Copy the three EVIDENCE blocks above" -ForegroundColor White
Write-Host "2. Verify distance scoring shows km in reasons" -ForegroundColor White
Write-Host "3. Verify events include match.accepted type" -ForegroundColor White
Write-Host "4. Verify map endpoint returns appropriate status codes" -ForegroundColor White

Write-Host "`n✓ Backend is ready if all three tests show expected behavior`n" -ForegroundColor Green
