# SwarmAid Mapbox Integration - Testing Guide

## 🎯 Overview

The Mapbox backend integration provides:
- **Geocoding**: Convert addresses to lat/lon coordinates
- **Profile location**: Auto-geocode user addresses when profiles are saved
- **Listing location**: Auto-populate pickup location from donor profile
- **Route mapping**: Generate driving directions with GeoJSON geometry for Leaflet rendering
- **Distance scoring**: Foundation for improving match scoring based on location

**New Endpoints:**
- `POST /v1/geocode` - Geocode addresses
- `GET /v1/map/match/{matchId}` - Get map payload for a match
- `GET /v1/map/listing/{listingId}?receiverId=optional` - Get map payload for listing

---

## 🔐 Prerequisites

### 1. Get JWT Token

```powershell
$response = aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --client-id 1n77l3lc7ju5t8h8pgkovaqq0p --auth-parameters USERNAME="your-email@domain.com",PASSWORD="YourPassword" --profile swarmaid --region us-east-1 | ConvertFrom-Json
$token = $response.AuthenticationResult.IdToken
Write-Host "Token: $($token.Substring(0,50))..."
```

### 2. Mapbox Secret

The Mapbox token is stored in AWS Secrets Manager at `/swarmaid/mapbox-token`:
- Current value: Secret token `sk.*` (managed via AWS Secrets Manager)
- Update via: `aws secretsmanager update-secret --secret-id /swarmaid/mapbox-token --secret-string "sk.YOUR_TOKEN"`

---

## 🔄 Post-Rotation Verification (sk. Token)

After rotating to a secret token (`sk.*`), verify your backend is using the new token correctly.

### Step 1: Update Secret in AWS

```powershell
# Rotate to secret token (do this once)
aws secretsmanager update-secret `
  --secret-id /swarmaid/mapbox-token `
  --secret-string "sk.YOUR_MAPBOX_SECRET_TOKEN" `
  --profile swarmaid `
  --region us-east-1
```

**Expected Response:**
```json
{
  "ARN": "arn:aws:secretsmanager:us-east-1:...:secret:/swarmaid/mapbox-token-...",
  "Name": "/swarmaid/mapbox-token",
  "VersionId": "5cc3af98-5b59-4158-8e63-7b8340b0e46a"
}
```

✅ Token is now updated in Secrets Manager!

---

### Step 2: Verify IAM Permissions

Run the verification script without a JWT token to check IAM permissions:

```powershell
cd "C:\Users\Samia Moid\Desktop\UGA Hacks 11"
.\docs\scripts\verify-backend-deps.ps1
```

**Expected Output:**
```
=== Lambda Function Discovery ===
Found: SwarmAidFoundation-GeocodeLambda534A2556-...
Found: SwarmAidFoundation-MapPayloadLambda27B2D527-...
Found: SwarmAidFoundation-ProfileLambdaE9F8A7B6-...

=== IAM Permission Summary ===
Lambda          Mapbox Token       Gemini API Key
------          ------------       --------------
Geocode         ALLOWED ✓          DENIED ✗
MapPayload      ALLOWED ✓          DENIED ✗
Profile         ALLOWED ✓          DENIED ✗
AgentMessage    DENIED ✗           ALLOWED ✓
```

**What to Look For:**
- ✅ **Geocode, MapPayload, Profile**: Should show `ALLOWED ✓` for Mapbox Token
- ✅ **AgentMessage**: Should show `DENIED ✗` for Mapbox Token (doesn't need it)
- ⚠️ If any Lambda shows `DENIED` when it should be `ALLOWED`, check CDK stack for `mapboxSecret.grantRead(...)`

---

### Step 3: Verify Runtime with New Token

Run full verification including live API tests:

```powershell
# Get fresh JWT token
$response = aws cognito-idp initiate-auth `
  --auth-flow USER_PASSWORD_AUTH `
  --client-id 1n77l3lc7ju5t8h8pgkovaqq0p `
  --auth-parameters USERNAME="your-email@example.com",PASSWORD="YourPassword" `
  --profile swarmaid --region us-east-1 | ConvertFrom-Json

$token = $response.AuthenticationResult.IdToken

# Run full verification
.\docs\scripts\verify-backend-deps.ps1 -IdToken $token
```

**Expected Success Output:**
```
=== Runtime Smoke Tests ===

Test 1: Health Check
  GET /v1/health: 200 OK ✓

Test 2: Auth Check
  GET /v1/me: 200 OK ✓
    User: 123e4567-e89b-12d3...

Test 3: Geocoding (Mapbox Secret Verification)
  POST /v1/geocode: 200 OK ✓
    Location: 33.749, -84.388
    Place: Atlanta, Fulton County, Georgia, United States
    ✓ Mapbox sk. token is working correctly!

  → Checking CloudWatch logs for secret loading...
    Recent logs from 2026/02/07/[$LATEST]abc123...:
      ✓ Mapbox token loaded: OK
    ✓ Mapbox secret loaded successfully from Secrets Manager

Test 4: Agent Message (Gemini Secret)
  POST /v1/agent/message: 200 OK ✓
    Session: abc-123-def-456...
    Role: donor
    Intent: create_listing
    Proposed Fields: category, quantity, unit
    Missing Fields: 4

=== Runtime Test Summary ===
Endpoint              Status    Code
--------              ------    ----
/v1/health           PASS      200
/v1/me               PASS      200
/v1/geocode          PASS      200
/v1/agent/message    PASS      200

All runtime tests passed! (4/4) ✓
```

---

### Troubleshooting

#### ❌ Geocoding Fails with SERVICE_UNAVAILABLE

**Error:**
```
POST /v1/geocode: Response indicated failure
  Error: SERVICE_UNAVAILABLE - Geocoding service unavailable
  → Likely cause: Mapbox token invalid or restricted
```

**Solution:**
1. Verify token in Mapbox dashboard is active
2. Check token has **Geocoding API** access enabled
3. Verify token was copied correctly (no extra spaces)
4. Test secret value:
   ```powershell
   aws secretsmanager get-secret-value --secret-id /swarmaid/mapbox-token --profile swarmaid --query SecretString --output text
   ```

---

#### ❌ IAM Permission DENIED

**Error:**
```
Lambda: Geocode
  /swarmaid/mapbox-token: DENIED ✗
```

**Solution:**
Check CDK stack has permission grant:
```typescript
// In infra/lib/swarmaid-stack.ts
mapboxSecret.grantRead(geocodeLambda);
```

Redeploy:
```powershell
cd infra
npm run deploy
```

---

#### ❌ CloudWatch Shows "Failed to retrieve token"

**Error in logs:**
```
Failed to retrieve Mapbox token from Secrets Manager
AccessDeniedException: User is not authorized to perform GetSecretValue
```

**Solution:**
Lambda role missing IAM permissions. Verify:
```powershell
# Check Lambda role
aws lambda get-function-configuration --function-name SwarmAidFoundation-GeocodeLambda... --query Role

# Check role policies
aws iam list-attached-role-policies --role-name SwarmAidFoundation-GeocodeLambda...-ServiceRole...
```

Expected: Policy allowing `secretsmanager:GetSecretValue` on `/swarmaid/mapbox-token`

---

#### ✅ Success Indicators

Your new `sk.` token is working if you see:
1. ✅ `POST /v1/geocode: 200 OK ✓`
2. ✅ `Location: 33.749, -84.388` (or similar coordinates)
3. ✅ `✓ Mapbox sk. token is working correctly!`
4. ✅ CloudWatch logs show: `Mapbox token loaded: OK` or `✓ Mapbox secret loaded successfully`
5. ✅ No errors in CloudWatch logs about token retrieval

---

## 🧪 Test Flow

### Step 1: Test Geocoding Endpoint

```powershell
# Test with structured address
$body = @{
    address = @{
        street = "1234 Main Street"
        city = "Atlanta"
        state = "GA"
        zip = "30303"
        country = "USA"
    }
} | ConvertTo-Json

$result = Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/geocode" -Headers @{ Authorization = $token; "Content-Type" = "application/json" } -Body $body

Write-Host "Location: $($result.data.location.lat), $($result.data.location.lon)"
Write-Host "Place: $($result.data.location.placeName)"
```

**Expected Response:**
```json
{
  "ok": true,
  "data": {
    "location": {
      "lat": 33.7490,
      "lon": -84.3880,
      "placeName": "1234 Main Street, Atlanta, Georgia 30303, United States"
    }
  }
}
```

---

### Step 2: Test with Free-Form Address

```powershell
# Test with addressText
$body = @{
    addressText = "University of Georgia, Athens, GA"
} | ConvertTo-Json

$result = Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/geocode" -Headers @{ Authorization = $token; "Content-Type" = "application/json" } -Body $body

Write-Host "Location: $($result.data.location.lat), $($result.data.location.lon)"
```

---

### Step 3: Save Profile with Address (Auto-Geocode)

```powershell
# Update profile with address - location will be auto-geocoded
$profileBody = @{
    name = "Test Donor"
    role = "supplier"
    phone = "(404) 555-1234"
    address = @{
        street = "200 North Ave NW"
        city = "Atlanta"
        state = "GA"
        zip = "30313"
        country = "USA"
    }
} | ConvertTo-Json

$profileResult = Invoke-RestMethod -Method Put -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/profile" -Headers @{ Authorization = $token; "Content-Type" = "application/json" } -Body $profileBody

Write-Host "Profile saved with location: $($profileResult.location.lat), $($profileResult.location.lon)"
Write-Host "Place: $($profileResult.location.placeName)"
```

**Expected Response:**
```json
{
  "userId": "user-id",
  "email": "donor@example.com",
  "role": "supplier",
  "name": "Test Donor",
  "address": {
    "street": "200 North Ave NW",
    "city": "Atlanta",
    "state": "GA",
    "zip": "30313",
    "country": "USA"
  },
  "location": {
    "lat": 33.7756,
    "lon": -84.3963,
    "placeName": "200 North Avenue Northwest, Atlanta, Georgia 30313, United States"
  },
  "createdAt": "2026-02-07T...",
  "updatedAt": "2026-02-07T..."
}
```

---

### Step 4: Get Profile to Verify Location

```powershell
$profile = Invoke-RestMethod -Method Get -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/profile" -Headers @{ Authorization = $token }

Write-Host "Stored location: $($profile.location.lat), $($profile.location.lon)"
```

---

### Step 5: Create Listing (Location Auto-Populated from Profile)

```powershell
# First turn: Start agent session
$sessionId = [guid]::NewGuid().ToString()
$body1 = @{
    message = "I have 50 pounds of fresh apples to donate"
    sessionId = $sessionId
} | ConvertTo-Json

$response1 = Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/agent/message" -Headers @{ Authorization = $token; "Content-Type" = "application/json" } -Body $body1

# Continue conversation...
$body2 = @{
    message = "pickup today 2-6pm"
    sessionId = $sessionId
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/agent/message" -Headers @{ Authorization = $token; "Content-Type" = "application/json" } -Body $body2

$body3 = @{
    message = "refrigerated"
    sessionId = $sessionId
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/agent/message" -Headers @{ Authorization = $token; "Content-Type" = "application/json" } -Body $body3

$body4 = @{
    message = "receiver picks up"
    sessionId = $sessionId
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/agent/message" -Headers @{ Authorization = $token; "Content-Type" = "application/json" } -Body $body4

# Confirm listing
$confirmBody = @{
    sessionId = $sessionId
} | ConvertTo-Json

$confirmResponse = Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/agent/confirm" -Headers @{ Authorization = $token; "Content-Type" = "application/json" } -Body $confirmBody

$listingId = $confirmResponse.data.entityId
Write-Host "Created listing: $listingId"
```

---

### Step 6: Create Receiver Profile with Different Location

```powershell
# Switch to receiver credentials
$receiverResponse = aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --client-id 1n77l3lc7ju5t8h8pgkovaqq0p --auth-parameters USERNAME="receiver@example.com",PASSWORD="Password123" --profile swarmaid --region us-east-1 | ConvertFrom-Json
$receiverToken = $receiverResponse.AuthenticationResult.IdToken

# Save receiver profile with address
$receiverProfileBody = @{
    name = "Test Receiver"
    role = "recipient"
    phone = "(706) 555-5678"
    address = @{
        street = "1000 Cedar Street"
        city = "Athens"
        state = "GA"
        zip = "30602"
        country = "USA"
    }
} | ConvertTo-Json

$receiverProfile = Invoke-RestMethod -Method Put -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/profile" -Headers @{ Authorization = $receiverToken; "Content-Type" = "application/json" } -Body $receiverProfileBody

Write-Host "Receiver location: $($receiverProfile.location.lat), $($receiverProfile.location.lon)"
```

---

### Step 7: Get Map Payload for Listing

```powershell
# Get route from receiver to donor location (pickup by receiver)
$mapPayload = Invoke-RestMethod -Method Get -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/map/listing/$listingId" -Headers @{ Authorization = $receiverToken }

Write-Host "Pickup by: $($mapPayload.data.pickupBy)"
Write-Host "From: $($mapPayload.data.from.label) @ $($mapPayload.data.from.lat), $($mapPayload.data.from.lon)"
Write-Host "To: $($mapPayload.data.to.label) @ $($mapPayload.data.to.lat), $($mapPayload.data.to.lon)"
Write-Host "Distance: $($mapPayload.data.route.distanceMeters) meters"
Write-Host "Duration: $($mapPayload.data.route.durationSeconds) seconds"
Write-Host "Summary: $($mapPayload.data.instructions.summaryText)"
```

**Expected Response:**
```json
{
  "ok": true,
  "data": {
    "pickupBy": "receiver",
    "from": {
      "lat": 33.958,
      "lon": -83.376,
      "label": "Test Receiver"
    },
    "to": {
      "lat": 33.7756,
      "lon": -84.3963,
      "label": "Test Donor"
    },
    "route": {
      "distanceMeters": 105320,
      "durationSeconds": 3845,
      "geometryGeoJson": {
        "type": "LineString",
        "coordinates": [
          [-83.376, 33.958],
          [-83.375, 33.957],
          ...
        ]
      }
    },
    "instructions": {
      "summaryText": "105 km, 64 minutes"
    }
  }
}
```

---

### Step 8: Visualize Route in Leaflet (Frontend Example)

```javascript
// Frontend code example (not implemented in backend)
const mapData = await fetch(`/v1/map/listing/${listingId}`, {
  headers: { Authorization: token }
}).then(r => r.json());

// Create Leaflet map
const map = L.map('map').setView([mapData.data.from.lat, mapData.data.from.lon], 10);

// Add Mapbox tile layer (frontend uses separate pk. token for browser)
L.tileLayer('https://api.mapbox.com/styles/v1/{id}/tiles/{z}/{x}/{y}?access_token={accessToken}', {
  accessToken: 'YOUR_MAPBOX_PUBLIC_TOKEN', // Get from Mapbox dashboard
  id: 'mapbox/streets-v11',
}).addTo(map);

// Add markers
L.marker([mapData.data.from.lat, mapData.data.from.lon])
  .bindPopup(mapData.data.from.label)
  .addTo(map);

L.marker([mapData.data.to.lat, mapData.data.to.lon])
  .bindPopup(mapData.data.to.label)
  .addTo(map);

// Draw route
L.geoJSON(mapData.data.route.geometryGeoJson, {
  style: { color: '#3887be', weight: 5 }
}).addTo(map);

// Show instructions
document.getElementById('summary').textContent = mapData.data.instructions.summaryText;
```

---

## 🔍 Verification Checklist

- [ ] POST /v1/geocode returns lat/lon for structured address
- [ ] POST /v1/geocode returns lat/lon for free-form address text
- [ ] PUT /v1/profile with address auto-geocodes and saves location
- [ ] GET /v1/profile returns saved location field
- [ ] Agent-created listings inherit pickupLocation from donor profile
- [ ] GET /v1/map/listing/{id} returns route with GeoJSON geometry
- [ ] Route geometry is valid GeoJSON LineString format
- [ ] Distance and duration are reasonable (not negative, not crazy high)
- [ ] Route respects pickupBy field (receiver→donor or donor→receiver)

---

## 🚨 Troubleshooting

### Address Not Found
```json
{
  "ok": false,
  "error": "NOT_FOUND",
  "message": "Address not found"
}
```
**Solution:** Use a valid, complete address with city and state

### Mapbox Token Unavailable
```json
{
  "ok": false,
  "error": "SERVICE_UNAVAILABLE",
  "message": "Geocoding service unavailable"
}
```
**Solution:** Check Secrets Manager secret exists and Lambda has read permission

### Missing Location
```json
{
  "ok": false,
  "error": "MISSING_LOCATION",
  "message": "receiver profile needs address and location saved"
}
```
**Solution:** Save profile with valid address first (use PUT /v1/profile)

### No Route Found
```json
{
  "ok": false,
  "error": "NOT_FOUND",
  "message": "No route available between locations"
}
```
**Solution:** Locations may be too far apart or on different continents - check coordinates

---

## 📊 Data Model

### UserProfile (Updated)
```typescript
{
  userId: string,
  email: string,
  role: "supplier" | "recipient" | ...,
  address: {
    street: string,
    city: string,
    state: string,
    zip: string,
    country: string
  },
  location?: {  // NEW - auto-filled when address saved
    lat: number,
    lon: number,
    placeName: string
  }
}
```

### Listing (Updated)
```typescript
{
  listingId: string,
  donorId: string,
  category: string,
  quantity: number,
  pickupBy: "donor" | "receiver",
  pickupLocation?: {  // NEW - auto-filled from donor profile
    lat: number,
    lon: number,
    placeName: string
  }
}
```

---

## 🔐 Security Notes

1. **Public Token (pk.)**: Currently using public token safe for browser use
   - Limited to geocoding/directions APIs
   - Has URL restrictions (map tiles only from allowed referrers)
   - Backend calls work but should switch to secret token

2. **Secret Token (sk.) - Recommended**:
   - Create in Mapbox dashboard → Access Tokens → Create token
   - Select "Secret" scope
   - Restrict to APIs: Geocoding, Directions, Matrix
   - Update secret value in AWS Secrets Manager:
     ```powershell
     aws secretsmanager update-secret --secret-id /swarmaid/mapbox-token --secret-string "sk.YOUR_SECRET_TOKEN" --profile swarmaid --region us-east-1
     ```

3. **Token Not Logged**: Mapbox token never appears in CloudWatch logs

---

## � Mapbox Wiring Verification

Before testing endpoints, verify that Lambda functions have correct IAM permissions to access the Mapbox secret.

### Automated Verification Script

**Location:** `docs/scripts/verify-backend-deps.ps1`

This PowerShell script automatically:
1. Discovers all SwarmAid Lambda functions (no manual name entry)
2. Validates IAM permissions for Secrets Manager access
3. Optionally runs runtime smoke tests against live endpoints

### Quick Start

#### Option 1: IAM Permission Check Only

```powershell
# From project root
.\docs\scripts\verify-backend-deps.ps1
```

**Expected Output:**
```
=== Lambda Function Discovery ===
Found: SwarmAidFoundation-GeocodeLambda534A2556-abc123
Found: SwarmAidFoundation-MapPayloadLambda27B2D527-def456
Found: SwarmAidFoundation-ProfileLambdaE9F8A7B6-ghi789

=== IAM Permission Summary ===
Lambda          Mapbox Token       Gemini API Key
------          ------------       --------------
Geocode         ALLOWED ✓          DENIED ✗
MapPayload      ALLOWED ✓          DENIED ✗
Profile         ALLOWED ✓          DENIED ✗
AgentMessage    DENIED ✗           ALLOWED ✓
```

**Interpretation:**
- ✅ **ALLOWED** = Lambda CAN read the secret (correct)
- ❌ **DENIED** = Lambda CANNOT read the secret (expected for unrelated secrets)

**Expected Permissions:**
- **GeocodeLambda**: Mapbox ✓, Gemini ✗
- **MapPayloadLambda**: Mapbox ✓, Gemini ✗
- **ProfileLambda**: Mapbox ✓ (for auto-geocoding), Gemini ✗
- **AgentMessageLambda**: Mapbox ✗, Gemini ✓

---

#### Option 2: IAM + Runtime Smoke Tests

```powershell
# Get JWT token first
$response = aws cognito-idp initiate-auth `
  --auth-flow USER_PASSWORD_AUTH `
  --client-id 1n77l3lc7ju5t8h8pgkovaqq0p `
  --auth-parameters USERNAME="your-email@example.com",PASSWORD="YourPassword" `
  --profile swarmaid --region us-east-1 | ConvertFrom-Json

$token = $response.AuthenticationResult.IdToken

# Run full verification with runtime tests
.\docs\scripts\verify-backend-deps.ps1 -IdToken $token
```

**Expected Output:**
```
=== Runtime Smoke Tests ===
Test 1: Health Check
  GET /v1/health: 200 OK ✓
    Response: healthy

Test 2: Auth Check
  GET /v1/me: 200 OK ✓
    User: 123e4567-e89b-12d3...

Test 3: Geocoding (Mapbox Secret)
  POST /v1/geocode: 200 OK ✓
    Location: 33.749, -84.388
    Place: Atlanta, Fulton County, Georgia, United States

Test 4: Agent Message (Gemini Secret)
  POST /v1/agent/message: 200 OK ✓
    Session: abc-123-def-456...
    Role: donor
    Intent: create_listing

=== Runtime Test Summary ===
Endpoint              Status    Code
--------              ------    ----
/v1/health           PASS      200
/v1/me               PASS      200
/v1/geocode          PASS      200
/v1/agent/message    PASS      200

All runtime tests passed! (4/4) ✓
```

---

### Script Parameters

```powershell
# Full parameter list
.\docs\scripts\verify-backend-deps.ps1 `
  -Region "us-east-1" `
  -StackPrefix "SwarmAidFoundation" `
  -Profile "swarmaid" `
  -IdToken "eyJraWQ..." `
  -BaseUrl "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod"

# Defaults:
# -Region: us-east-1
# -StackPrefix: SwarmAidFoundation
# -Profile: swarmaid
# -BaseUrl: https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod
# -IdToken: (optional, skip runtime tests if omitted)
```

---

### Troubleshooting Verification Failures

#### IAM Permission DENIED (Unexpected)

**Symptom:**
```
Lambda: Geocode
  /swarmaid/mapbox-token: DENIED ✗  <-- Should be ALLOWED
```

**Diagnosis:**
Lambda role doesn't have `secretsmanager:GetSecretValue` permission for the secret.

**Fix:**
```powershell
# Check CDK stack definition
# Ensure this line exists in infra/lib/swarmaid-stack.ts:
# mapboxSecret.grantRead(geocodeLambda);

# Redeploy
cd infra
npm run deploy
```

---

#### Runtime Test 401 Unauthorized

**Symptom:**
```
Test 2: Auth Check
  GET /v1/me: 401 Unauthorized ✗
    Token may be invalid or expired
```

**Fix:**
```powershell
# Get fresh token (tokens expire after 1 hour)
$response = aws cognito-idp initiate-auth ...
$token = $response.AuthenticationResult.IdToken

# Retry
.\docs\scripts\verify-backend-deps.ps1 -IdToken $token
```

---

#### Runtime Test Geocoding Failed

**Symptom:**
```
Test 3: Geocoding (Mapbox Secret)
  POST /v1/geocode: FAILED ✗
    Error: SERVICE_UNAVAILABLE
```

**Diagnosis:**
- Lambda can't read Mapbox secret from Secrets Manager
- Mapbox token is invalid or expired
- Mapbox API rate limit exceeded

**Fix:**
```powershell
# Verify secret exists
aws secretsmanager describe-secret `
  --secret-id /swarmaid/mapbox-token `
  --profile swarmaid --region us-east-1

# Check IAM permissions (should show ALLOWED)
.\docs\scripts\verify-backend-deps.ps1

# Check CloudWatch logs
aws logs tail /aws/lambda/SwarmAidFoundation-GeocodeLambda... --follow
```

---

### Why This Script Prevents Errors

**Problem You Encountered:**
```powershell
# You typed (bad - truncated with "..."):
aws lambda get-function-configuration --function-name "SwarmAidFoundation-Geocode..."

# Error: Lambda function not found (AWS treats "..." literally, not as wildcard)
```

**Solution:**
```powershell
# Verification script auto-discovers exact names:
$lambdaName = aws lambda list-functions --query "Functions[?contains(FunctionName, 'Geocode')].FunctionName" --output text

# Then uses exact name:
aws lambda get-function-configuration --function-name $lambdaName
```

**Benefits:**
- ✅ No typing errors (function names auto-discovered)
- ✅ No hardcoded Lambda ARNs
- ✅ No need to check console for exact names
- ✅ Works across environments (dev/staging/prod)

---

### Manual Lambda Discovery (Alternative)

If you need exact Lambda names for AWS CLI commands:

```powershell
# List all SwarmAid Lambdas with exact names
aws lambda list-functions `
  --query "Functions[?contains(FunctionName, 'SwarmAidFoundation')].FunctionName" `
  --output table `
  --profile swarmaid

# Get specific Lambda by substring
$geocodeLambda = aws lambda list-functions `
  --query "Functions[?contains(FunctionName, 'Geocode')].FunctionName" `
  --output text `
  --profile swarmaid

# Use in commands
aws lambda get-function-configuration --function-name $geocodeLambda --profile swarmaid
```

---

### Security Notes

1. **Token Never Logged**: The verification script never prints secret values
2. **IAM Simulation Only**: Permission checks use `simulate-principal-policy` (no actual API calls)
3. **Safe Runtime Tests**: Geocode test uses harmless address "Atlanta, GA"
4. **JWT Not Stored**: IdToken only used during script execution, not persisted

---

## �📈 Next Steps

### Immediate (Backend Complete, Frontend Needed):
- ✅ Geocoding endpoint working
- ✅ Profile location auto-population working
- ✅ Map payload endpoint working
- ❌ Frontend Leaflet map rendering (needs implementation)
- ❌ Frontend route visualization (needs implementation)

### Future Enhancements:
- Update deals ranking with distance scoring
- Update match generation with distance scoring  
- Add distance filter to GET /v1/deals?maxDistance=50
- Cache geocoding results in DynamoDB to reduce API calls
- Add reverse geocoding (lat/lon → address)
- Support multiple pickup locations per listing
- Add travel time to match expiration calculation

---

## API Summary

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/v1/geocode` | POST | Cognito | Geocode address to lat/lon |
| `/v1/map/listing/{id}` | GET | Cognito | Get route for listing |
| `/v1/map/match/{id}` | GET | Cognito | Get route for match |
| `/v1/profile` | PUT | Cognito | Save profile (auto-geocodes address) |
| `/v1/profile` | GET | Cognito | Get profile (includes location) |

**Mapbox backend integration complete and tested!** 🗺️
