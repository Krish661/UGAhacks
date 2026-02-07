# SwarmAid MVP Backend - API Test Guide

## 🎉 Deployment Summary

**Status:** ✅ Successfully Deployed  
**API Base URL:** `https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/`  
**Region:** us-east-1  
**Stack:** SwarmAidFoundation  

### Deployed Lambda Functions
1. **ProfileLambda** - User profile management (PUT, GET)
2. **DraftListingLambda** - AI-assisted draft listing creation (POST)
3. **ConfirmListingLambda** - Confirm and post listings (POST)
4. **MyListingsLambda** - Get user's listings (GET)
5. **DealsLambda** - Browse ranked available deals (GET)
6. **EventsLambda** - Poll for status update events (GET)
7. **ProfileGetLambda** - Dedicated GET profile handler

---

## Authentication Setup

All MVP endpoints (except `/v1/health`) require Cognito authentication. You need a JWT ID token.

### 1. Create a Test User

```powershell
aws cognito-idp sign-up --client-id 1n77l3lc7ju5t8h8pgkovaqq0p --username "donor1@test.com" --password "Test123!" --user-attributes Name=email,Value="donor1@test.com" --profile swarmaid --region us-east-1
```

### 2. Confirm the User (Admin)

```powershell
aws cognito-idp admin-confirm-sign-up --user-pool-id us-east-1_5J0IIOQe8 --username "donor1@test.com" --profile swarmaid --region us-east-1
```

### 3. Add User to Supplier Group

```powershell
aws cognito-idp admin-add-user-to-group --user-pool-id us-east-1_5J0IIOQe8 --username "donor1@test.com" --group-name "supplier" --profile swarmaid --region us-east-1
```

### 4. Sign In and Get JWT Token

```powershell
aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --client-id 1n77l3lc7ju5t8h8pgkovaqq0p --auth-parameters USERNAME="donor1@test.com",PASSWORD="Test123!" --profile swarmaid --region us-east-1
```

**Save the `IdToken` from the response - you'll use it in all requests below.**

---

## API Endpoints & Testing

### 🏥 1. Health Check (Public)

**Endpoint:** `GET /v1/health`  
**Auth:** None

```powershell
Invoke-RestMethod -Method Get -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/health"
```

**Expected Response:**
```json
{
  "ok": true,
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

---

### 👤 2. Get Current User Info (Protected)

**Endpoint:** `GET /v1/me`  
**Auth:** Required

```powershell
$token = "YOUR_ID_TOKEN_HERE"
Invoke-RestMethod -Method Get -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/me" -Headers @{ Authorization = $token }
```

---

### 📝 3. Save User Profile

**Endpoint:** `PUT /v1/profile`  
**Auth:** Required

```powershell
$token = "YOUR_ID_TOKEN_HERE"
$profileBody = @{
    name = "John Doe"
    phone = "555-0123"
    address = @{
        street = "123 Main St"
        city = "Atlanta"
        state = "GA"
        zip = "30301"
        country = "USA"
    }
} | ConvertTo-Json

Invoke-RestMethod -Method Put -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/profile" -Headers @{ Authorization = $token ; "Content-Type" = "application/json" } -Body $profileBody
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "userId": "abc123...",
    "email": "donor1@test.com",
    "role": "supplier",
    "name": "John Doe",
    "phone": "555-0123",
    "address": { ... },
    "createdAt": "2024-01-15T10:30:00.000Z",
    "updatedAt": "2024-01-15T10:30:00.000Z"
  }
}
```

---

### 🤖 4. Create Draft Listing with AI Agent

**Endpoint:** `POST /v1/listings/draft`  
**Auth:** Required

This endpoint uses Gemini AI to parse free-text descriptions and suggest structured fields.

#### Example 1: Free Text Only

```powershell
$token = "YOUR_ID_TOKEN_HERE"
$draftBody = @{
    freeText = "I have 50 pounds of fresh apples from my orchard. Need pickup today before 6pm. They're refrigerated."
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/listings/draft" -Headers @{ Authorization = $token ; "Content-Type" = "application/json" } -Body $draftBody
```

#### Example 2: Partial Fields + Free Text

```powershell
$token = "YOUR_ID_TOKEN_HERE"
$draftBody = @{
    freeText = "Leftover pizza from office party"
    category = "prepared-meals"
    quantity = 10
    unit = "boxes"
    urgency = "HIGH"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/listings/draft" -Headers @{ Authorization = $token ; "Content-Type" = "application/json" } -Body $draftBody
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "listing": {
      "listingId": "LISTING#...",
      "donorId": "abc123...",
      "category": "produce",
      "description": "Fresh apples from local orchard",
      "quantity": 50,
      "unit": "lbs",
      "status": "DRAFT",
      "suggestedFields": { ... },
      "missingFields": []
    },
    "agentSummary": "50 lbs of fresh apples available for pickup today",
    "missingFields": [],
    "confidence": 85
  }
}
```

---

### ✅ 5. Confirm and Post Listing

**Endpoint:** `POST /v1/listings/{listingId}/confirm`  
**Auth:** Required

After creating a draft, review the AI suggestions and confirm to post publicly.

```powershell
$token = "YOUR_ID_TOKEN_HERE"
$listingId = "LISTING#1737122400000-abc12345"  # From draft response

# Optional: update any fields before confirming
$confirmBody = @{
    pickupWindowStart = "2024-01-15T14:00:00Z"
    pickupWindowEnd = "2024-01-15T18:00:00Z"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/listings/$listingId/confirm" -Headers @{ Authorization = $token ; "Content-Type" = "application/json" } -Body $confirmBody
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "listingId": "LISTING#...",
    "status": "POSTED",
    "confirmedAt": "2024-01-15T10:35:00.000Z"
  }
}
```

---

### 📋 6. Get My Listings

**Endpoint:** `GET /v1/listings/mine`  
**Auth:** Required

Retrieve all listings created by the authenticated user.

```powershell
$token = "YOUR_ID_TOKEN_HERE"
Invoke-RestMethod -Method Get -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/listings/mine" -Headers @{ Authorization = $token }
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "listings": [
      {
        "listingId": "LISTING#...",
        "category": "produce",
        "description": "Fresh apples",
        "quantity": 50,
        "unit": "lbs",
        "status": "POSTED"
      }
    ],
    "count": 1
  }
}
```

---

### 🎁 7. Browse Deals (Ranked Recommendations)

**Endpoint:** `GET /v1/deals`  
**Auth:** Required

For receivers: Browse available listings ranked by urgency, recency, and relevance.

#### Get All Deals

```powershell
$token = "YOUR_ID_TOKEN_HERE"
Invoke-RestMethod -Method Get -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/deals" -Headers @{ Authorization = $token }
```

#### Filter by Category

```powershell
$token = "YOUR_ID_TOKEN_HERE"
Invoke-RestMethod -Method Get -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/deals?category=produce&limit=20" -Headers @{ Authorization = $token }
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "deals": [
      {
        "listingId": "LISTING#...",
        "category": "produce",
        "description": "Fresh apples",
        "quantity": 50,
        "unit": "lbs",
        "urgency": "HIGH",
        "score": 85,
        "reasons": ["High urgency", "Recently posted", "Pickup window open now"]
      }
    ],
    "count": 1
  }
}
```

---

### 📡 8. Poll for Events (Status Sync)

**Endpoint:** `GET /v1/events`  
**Auth:** Required

Poll for status updates about listings, matches, and other entities.

#### Get Recent Events

```powershell
$token = "YOUR_ID_TOKEN_HERE"
Invoke-RestMethod -Method Get -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/events" -Headers @{ Authorization = $token }
```

#### Poll for New Events Since Last Check

```powershell
$token = "YOUR_ID_TOKEN_HERE"
$since = "2024-01-15T10:30:00.000Z"
Invoke-RestMethod -Method Get -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/events?since=$since&limit=50" -Headers @{ Authorization = $token }
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "events": [
      {
        "eventId": "EVENT#...",
        "userId": "abc123...",
        "entityType": "LISTING",
        "entityId": "LISTING#...",
        "eventType": "listing.posted",
        "payload": {
          "listingId": "LISTING#...",
          "category": "produce",
          "urgency": "HIGH"
        },
        "createdAt": "2024-01-15T10:35:00.000Z"
      }
    ],
    "count": 1,
    "polledAt": "2024-01-15T10:40:00.000Z"
  }
}
```

---

## Testing Workflow

### Complete Donor Flow

1. **Sign up and authenticate** → Get JWT token
2. **Save profile** → `PUT /v1/profile`
3. **Create draft listing** → `POST /v1/listings/draft` (with free text)
4. **Review AI suggestions** → Check `missingFields` in response
5. **Confirm listing** → `POST /v1/listings/{id}/confirm`
6. **Check my listings** → `GET /v1/listings/mine`

### Complete Receiver Flow

1. **Sign up and authenticate** → Get JWT token (use `recipient` group)
2. **Save profile** → `PUT /v1/profile`
3. **Browse deals** → `GET /v1/deals?category=produce`
4. **Poll for updates** → `GET /v1/events` (every 30 seconds)

---

## Troubleshooting

### Common Issues

1. **401 Unauthorized**: JWT token expired or invalid
   - Solution: Re-authenticate with `aws cognito-idp initiate-auth`

2. **400 Validation Error**: Missing required fields
   - Solution: Check `missingFields` in draft response

3. **500 Internal Error**: Check Lambda logs
   ```powershell
   aws logs tail "/aws/lambda/SwarmAidFoundation-DraftListingLambda..." --follow --profile swarmaid
   ```

4. **Gemini AI timeout**: Draft listing takes >60 seconds
   - Solution: Retry request or fallback to manual entry

---

## Architecture Summary

### Single-Table DynamoDB Design

- `PROFILE#{userId}` / `PROFILE` → User profiles
- `LISTING#{listingId}` / `META` → Listing metadata
- `USER#{userId}` / `LISTING#{listingId}` → User's listings index
- `CATEGORY#{category}` / `LISTING#{listingId}` → Category index for deals
- `USER#{userId}` / `EVENT#{timestamp}` → User event log

### AI Agent Flow

1. User submits free text + optional structured fields
2. Gemini API parses text → suggests category, quantity, urgency, etc.
3. Agent returns confidence score + missing fields
4. User fills gaps → confirms → listing posted

### Ranking Algorithm (Deals)

- **Urgency**: CRITICAL +30, HIGH +20, MEDIUM +10
- **Recency**: <2hrs +15, <24hrs +5
- **Pickup Window**: Starting soon +20, Open now +25
- **Category Match**: Matches user's needs +25
- **Location**: Nearby +10 (placeholder for future)

---

## Next Steps

1. ✅ MVP backend fully deployed
2. 🔜 Test all endpoints with real data
3. 🔜 Add frontend (React/Flutter)
4. 🔜 Implement matching engine (auto-match listings to needs)
5. 🔜 Add driver assignment logic
6. 🔜 Integrate push notifications
7. 🔜 Add geolocation filtering

---

## Resources

- **API Gateway Console**: https://console.aws.amazon.com/apigateway/home?region=us-east-1#/apis/cd2xwzhrxi
- **Cognito Console**: https://console.aws.amazon.com/cognito/v2/idp/user-pools/us-east-1_5J0IIOQe8
- **DynamoDB Console**: https://console.aws.amazon.com/dynamodbv2/home?region=us-east-1
- **Lambda Console**: https://console.aws.amazon.com/lambda/home?region=us-east-1

---

**Questions/Issues?** Check CloudWatch logs or DynamoDB directly for debugging.
