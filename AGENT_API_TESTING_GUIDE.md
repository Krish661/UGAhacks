# SwarmAid Conversational Agent API - Test Guide

## 🎯 Overview

The conversational agent provides an intelligent UX layer that:
- Detects user role (donor/receiver) and intent from natural language
- Fills structured fields from free-text messages  
- Asks only missing questions in a conversational flow
- Tracks session state across multiple messages
- Emits sync events when sessions update

**New Endpoints:**
- `POST /v1/agent/message` - Send conversational messages
- `POST /v1/agent/confirm` - Finalize and create entity

---

## 🔐 Prerequisites

### 1. Get JWT Token (Same as Before)

```powershell
# Sign in and get token
aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH --client-id 1n77l3lc7ju5t8h8pgkovaqq0p --auth-parameters USERNAME="donor1@test.com",PASSWORD="Test123!" --profile swarmaid --region us-east-1

# Save the IdToken
$token = "YOUR_ID_TOKEN_HERE"
```

---

## 🤖 Conversational Agent Flow

### Example 1: Donor Creates Listing (Multi-Turn Conversation)

#### Turn 1: Initial Message (Intent Detection)

```powershell
$token = "YOUR_ID_TOKEN_HERE"
$body = @{
    message = "I have 50 pounds of fresh apples to donate"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/agent/message" -Headers @{ Authorization = $token ; "Content-Type" = "application/json" } -Body $body
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "abc-123-def-456",
    "role": "donor",
    "intent": "create_listing",
    "message": "Great! I see you have produce to donate. When can someone start picking this up?",
    "proposedFields": {
      "category": "produce",
      "description": "fresh apples",
      "quantity": 50,
      "unit": "lbs"
    },
    "missingFields": [
      "pickupWindowStart",
      "pickupWindowEnd",
      "storageConstraint",
      "pickupBy"
    ],
    "nextQuestion": {
      "field": "pickupWindowStart",
      "prompt": "When can someone start picking this up? (provide date and time)",
      "fieldType": "datetime"
    },
    "summaryCard": {
      "title": "Food Donation Listing",
      "fields": [
        { "label": "Food Category", "value": "produce", "confirmed": true },
        { "label": "Description", "value": "(pending)", "confirmed": false },
        { "label": "Quantity", "value": "50", "confirmed": true },
        { "label": "Unit", "value": "lbs", "confirmed": true },
        { "label": "Pickup Window Start", "value": "(pending)", "confirmed": false }
      ],
      "progress": 50
    },
    "isComplete": false
  }
}
```

**What Happened:**
1. Gemini detected "donate" → role = donor
2. Gemini extracted category=produce, quantity=50, unit=lbs
3. Agent determined what's missing (pickup times, storage, etc.)
4. Agent asks for the first missing field

---

#### Turn 2: Answer the Question

```powershell
$sessionId = "abc-123-def-456"  # From previous response
$body = @{
    message = "pickup available today from 2pm to 6pm"
    sessionId = $sessionId
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/agent/message" -Headers @{ Authorization = $token ; "Content-Type" = "application/json" } -Body $body
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "abc-123-def-456",
    "role": "donor",
    "intent": "create_listing",
    "message": "Perfect. Does this food need to stay refrigerated, or is it shelf-stable?",
    "proposedFields": {
      "category": "produce",
      "quantity": 50,
      "unit": "lbs",
      "pickupWindowStart": "2026-02-07T14:00:00Z",
      "pickupWindowEnd": "2026-02-07T18:00:00Z"
    },
    "missingFields": [
      "storageConstraint",
      "pickupBy"
    ],
    "nextQuestion": {
      "field": "storageConstraint",
      "prompt": "Does this food require refrigeration or special storage?",
      "choices": ["none", "refrigerated", "frozen", "hot"],
      "fieldType": "choice"
    },
    "summaryCard": {
      "progress": 75
    },
    "isComplete": false
  }
}
```

**What Happened:**
1. Gemini extracted pickup times from natural language
2. Agent updated session with new fields
3. Agent asks next missing question (storage)

---

#### Turn 3: Final Question

```powershell
$body = @{
    message = "refrigerated"
    sessionId = $sessionId
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/agent/message" -Headers @{ Authorization = $token ; "Content-Type" = "application/json" } -Body $body
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "abc-123-def-456",
    "role": "donor",
    "intent": "create_listing",
    "message": "Got it. Will you deliver, or should the receiver pick it up?",
    "proposedFields": {
      "storageConstraint": "refrigerated"
    },
    "missingFields": ["pickupBy"],
    "nextQuestion": {
      "field": "pickupBy",
      "prompt": "Will you deliver, or should the receiver pick it up?",
      "choices": ["donor", "receiver"],
      "fieldType": "choice"
    },
    "summaryCard": {
      "progress": 87
    },
    "isComplete": false
  }
}
```

---

#### Turn 4: Complete Collection

```powershell
$body = @{
    message = "receiver should pick it up"
    sessionId = $sessionId
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/agent/message" -Headers @{ Authorization = $token ; "Content-Type" = "application/json" } -Body $body
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "abc-123-def-456",
    "message": "Great! I have all the information I need. Ready to confirm?",
    "proposedFields": {
      "pickupBy": "receiver"
    },
    "missingFields": [],
    "isComplete": true,
    "summaryCard": {
      "progress": 100
    }
  }
}
```

---

#### Turn 5: Confirm and Create Listing

```powershell
$body = @{
    sessionId = $sessionId
    finalEdits = @{
        urgency = "HIGH"  # Optional: add any last-minute fields
    }
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/agent/confirm" -Headers @{ Authorization = $token ; "Content-Type" = "application/json" } -Body $body
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "entityId": "LISTING#1737122400000-abc12345",
    "entityType": "listing",
    "status": "POSTED",
    "summary": "50 lbs of produce posted successfully"
  }
}
```

**What Happened:**
1. Agent validated all required fields are present
2. Created listing directly as POSTED (skipped DRAFT since agent validated)
3. Emitted `listing.posted` event
4. Listing now visible in `/v1/deals`

---

### Example 2: One-Shot Message (All Info Provided)

If user provides everything in one message, agent creates session and goes straight to confirmation:

```powershell
$body = @{
    message = "I want to donate 20 meals of prepared food, pickup available tomorrow 3-5pm, needs to be refrigerated, receiver should pick up"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/agent/message" -Headers @{ Authorization = $token ; "Content-Type" = "application/json" } -Body $body
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "new-session-id",
    "role": "donor",
    "intent": "create_listing",
    "message": "Great! I have all the information I need. Ready to confirm?",
    "proposedFields": {
      "category": "prepared-meals",
      "quantity": 20,
      "unit": "meals",
      "pickupWindowStart": "2026-02-08T15:00:00Z",
      "pickupWindowEnd": "2026-02-08T17:00:00Z",
      "storageConstraint": "refrigerated",
      "pickupBy": "receiver"
    },
    "missingFields": [],
    "isComplete": true,
    "summaryCard": {
      "progress": 100
    }
  }
}
```

Then immediately confirm:

```powershell
Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/agent/confirm" -Headers @{ Authorization = $token ; "Content-Type" = "application/json" } -Body (@{ sessionId = "new-session-id" } | ConvertTo-Json)
```

---

### Example 3: Receiver Requests Food

```powershell
$body = @{
    message = "I need 100 lbs of produce for our food bank"
} | ConvertTo-Json

Invoke-RestMethod -Method Post -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/agent/message" -Headers @{ Authorization = $token ; "Content-Type" = "application/json" } -Body $body
```

**Expected Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "receiver-session-123",
    "role": "receiver",
    "intent": "create_request",
    "message": "I understand you need produce. What unit of measurement - pounds, kilograms, or something else?",
    "proposedFields": {
      "category": "produce",
      "quantity": 100
    },
    "missingFields": ["unit"],
    "nextQuestion": {
      "field": "unit",
      "prompt": "What unit of measurement?",
      "choices": ["lbs", "kg", "meals", "servings", "boxes", "items"],
      "fieldType": "choice"
    },
    "isComplete": false
  }
}
```

Continue conversation to collect missing fields, then confirm to create request.

---

## 🧪 Advanced Testing Scenarios

### Test Gemini Fallback

Disconnect from internet or rate-limit Gemini, agent should still work with deterministic parsing:

```powershell
$body = @{
    message = "donating 10 lbs apples"
} | ConvertTo-Json

# Even if Gemini fails, should extract: category=produce, quantity=10, unit=lbs
```

---

### Test Session Resumption

Send messages without sessionId - agent resumes incomplete session:

```powershell
# First message creates session
Invoke-RestMethod ... -Body (@{ message = "I have food" } | ConvertTo-Json)

# Second message (no sessionId) finds and resumes
Invoke-RestMethod ... -Body (@{ message = "50 lbs" } | ConvertTo-Json)
```

---

### Test Event Sync

After agent updates session, check events feed:

```powershell
Invoke-RestMethod -Method Get -Uri "https://cd2xwzhrxi.execute-api.us-east-1.amazonaws.com/prod/v1/events" -Headers @{ Authorization = $token }
```

Should see:
```json
{
  "events": [
    {
      "eventType": "agent.session_updated",
      "entityId": "session-id",
      "payload": {
        "intent": "create_listing",
        "progress": 75
      }
    }
  ]
}
```

---

## 🎨 Frontend Integration Guide

### Chat UI Flow

```typescript
const [messages, setMessages] = useState([]);
const [sessionId, setSessionId] = useState(null);
const [summaryCard, setSummaryCard] = useState(null);

async function sendMessage(userMessage) {
  // Add user message to chat
  setMessages([...messages, { role: 'user', text: userMessage }]);

  // Call agent
  const response = await fetch('/v1/agent/message', {
    method: 'POST',
    headers: { 
      'Authorization': token,
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({
      message: userMessage,
      sessionId: sessionId
    })
  });

  const data = await response.json();

  // Update state
  setSessionId(data.sessionId);
  setSummaryCard(data.summaryCard);

  // Add agent response to chat
  setMessages([
    ...messages,
    { role: 'user', text: userMessage },
    { role: 'agent', text: data.message }
  ]);

  // If complete, show confirm button
  if (data.isComplete) {
    showConfirmButton();
  }
}

async function confirmListing() {
  const response = await fetch('/v1/agent/confirm', {
    method: 'POST',
    headers: { 
      'Authorization': token,
      'Content-Type': 'application/json' 
    },
    body: JSON.stringify({ sessionId })
  });

  const data = await response.json();
  showSuccess(`${data.summary} - ID: ${data.entityId}`);
}
```

### Summary Card Component

```jsx
<SummaryCard>
  <ProgressBar progress={summaryCard.progress} />
  <Title>{summaryCard.title}</Title>
  {summaryCard.fields.map(field => (
    <Field key={field.label}>
      <Label>{field.label}</Label>
      <Value confirmed={field.confirmed}>{field.value}</Value>
    </Field>
  ))}
</SummaryCard>
```

---

## 🚀 Key Features Demonstrated

### 1. **Intent Detection**
- "I have food to donate" → donor + create_listing
- "I need produce" → receiver + create_request
- "Show me deals" → receiver + browse_deals

### 2. **Field Extraction**
- Natural language → structured fields
- Gemini parses dates, quantities, categories
- Fallback to regex if Gemini fails

### 3. **Smart Questions**
- Asks only missing fields
- Never asks the same field twice
- Conversational prompts from Gemini

### 4. **Session State**
- Persists across messages
- Can resume incomplete sessions
- Tracks conversation history

### 5. **Event Sync**
- Sessions emit events
- Confirmed listings emit events
- Dashboards stay synced

---

## 📊 Comparison: Old vs New Flow

### Old Flow (Manual Form)
1. User fills category dropdown → submit
2. User fills quantity field → submit
3. User fills pickup times → submit  
4. User fills storage → submit
5. **Total: 4 clicks, 10+ fields**

### New Flow (Conversational)
1. User: "50 lbs apples, pickup today 2-6pm, refrigerated"
2. Agent: "Will you deliver, or should receiver pick up?"
3. User: "receiver picks up"
4. Agent: "Ready to confirm?"
5. **Total: 3 messages, agent fills 8 fields automatically**

---

## 🔍 Troubleshooting

### Session Not Found
```json
{
  "error": "NOT_FOUND",
  "message": "Session not found"
}
```
**Solution:** sessionId expired or invalid, start new conversation

### Incomplete Data
```json
{
  "error": "INCOMPLETE_DATA",
  "message": "Missing required fields: pickupWindowStart, pickupWindowEnd"
}
```
**Solution:** Send more messages to fill gaps before calling /confirm

### Gemini Timeout
Agent has 60-second timeout, falls back to deterministic parsing if Gemini is slow

---

## 📈 Next Enhancements (Not Implemented Yet)

- ❌ Multi-turn clarification (e.g., "apples or oranges?")
- ❌ Image upload for food photos
- ❌ Voice input transcription
- ❌ Location autocomplete
- ❌ Calendar integration for pickup times
- ❌ Suggested edits from compliance

**But your conversational agent MVP is complete!** 🎉

---

## API Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/v1/agent/message` | POST | Send conversational message |
| `/v1/agent/confirm` | POST | Finalize and create entity |
| `/v1/events` | GET | Check for session updates |

**Agent UX is live and ready for frontend integration!** 🚀
