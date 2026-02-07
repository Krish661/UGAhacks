# SwarmAid Matching System Architecture

## 🎯 Design Philosophy: Hybrid Matching

**Proactive + Consensual**

1. **System generates** potential matches automatically when listings are posted
2. **Receivers see** ranked matches in their personalized feed
3. **Receivers accept** to claim (first-come-first-served with idempotency)
4. **Status transitions** track lifecycle

---

## 📊 Data Model (Single-Table Design)

### Match Entity

```typescript
{
  // Primary key
  pk: "MATCH#{matchId}",           // UUID for this specific match
  sk: "METADATA",
  
  // GSI1: Listing → all its matches
  gsi1pk: "LISTING#{listingId}",
  gsi1sk: "MATCH#{score}#{matchId}",  // Score-sorted matches
  
  // GSI2: Receiver → their matches
  gsi2pk: "RECEIVER#{receiverId}",
  gsi2sk: "MATCH#{status}#{score}#{matchId}",  // Status+score sorted
  
  // Core fields
  matchId: string,
  listingId: string,
  donorId: string,
  receiverId: string,
  
  // Matching metadata
  score: number,                    // 0-100 match quality score
  matchReason: {
    categoryMatch: boolean,
    quantityFit: number,            // 0-100 how well quantities align
    distanceKm: number,
    urgencyBonus: number
  },
  
  // Status lifecycle
  status: "SUGGESTED" | "ACCEPTED" | "EXPIRED" | "WITHDRAWN",
  suggestedAt: string,              // ISO timestamp when created
  acceptedAt?: string,              // ISO timestamp when receiver accepted
  expiresAt: string,                // Auto-expire after 24h if not accepted
  
  // Snapshot of listing at match time (for display)
  listingSnapshot: {
    category: string,
    quantity: number,
    unit: string,
    pickupWindowStart: string,
    pickupWindowEnd: string,
    storageConstraint: string,
    urgency: string
  }
}
```

### Query Patterns

**1. Get all matches for a listing (for donor to see interest)**
```typescript
GSI1: 
  gsi1pk = "LISTING#{listingId}"
  gsi1sk begins_with "MATCH#"
// Returns matches sorted by score (best first)
```

**2. Get receiver's pending matches (their personalized feed)**
```typescript
GSI2:
  gsi2pk = "RECEIVER#{receiverId}"
  gsi2sk begins_with "MATCH#SUGGESTED#"
// Returns only suggested matches, sorted by score
```

**3. Get receiver's accepted matches (their active deals)**
```typescript
GSI2:
  gsi2pk = "RECEIVER#{receiverId}"
  gsi2sk begins_with "MATCH#ACCEPTED#"
```

---

## 🔄 Match Lifecycle

```
listing.posted event
       ↓
Match Generation Lambda
       ↓
Query receivers (category + location)
       ↓
Score each potential match
       ↓
Create MATCH records (status=SUGGESTED)
       ↓
Emit match.suggested events
       ↓
Receiver sees in feed
       ↓
Receiver clicks "Accept"
       ↓
POST /v1/matches/{matchId}/accept
       ↓
Conditional update (prevent double-accept)
       ↓
Update listing.status = MATCHED
       ↓
Expire other SUGGESTED matches for this listing
       ↓
Emit match.accepted event
```

---

## 🧮 Scoring Algorithm

```typescript
function calculateMatchScore(listing, receiver): number {
  let score = 0;
  
  // Category match (mandatory)
  if (listing.category === receiver.preferences.categories[]) {
    score += 30;  // Base match
  } else {
    return 0;     // No match if category mismatch
  }
  
  // Quantity fit (0-25 points)
  const quantityRatio = Math.min(receiver.capacity, listing.quantity) / listing.quantity;
  score += quantityRatio * 25;
  
  // Distance (0-20 points)
  const distance = calculateDistance(listing.location, receiver.location);
  if (distance < 5) score += 20;
  else if (distance < 10) score += 15;
  else if (distance < 25) score += 10;
  else if (distance < 50) score += 5;
  // else 0 points
  
  // Urgency bonus (0-15 points)
  if (listing.urgency === "CRITICAL") score += 15;
  else if (listing.urgency === "HIGH") score += 10;
  else if (listing.urgency === "MEDIUM") score += 5;
  
  // Storage capability match (0-10 points)
  if (receiver.capabilities.storage.includes(listing.storageConstraint)) {
    score += 10;
  }
  
  return Math.min(score, 100);
}
```

**Score Ranges:**
- **80-100**: Excellent match (same category, close distance, urgent)
- **60-79**: Good match (category match, reasonable distance)
- **40-59**: Fair match (category match, distant or low capacity)
- **0-39**: Poor match (usually filtered out, don't create)

---

## 🏗️ Implementation Components

### 1. Match Generation Lambda

**Trigger:** EventBridge rule on `listing.posted` event
**Handler:** `services/orchestration/match-generation.ts`

```typescript
export async function generateMatches(event: ListingPostedEvent) {
  const { listingId, listing } = event.detail;
  
  // Query potential receivers
  const receivers = await queryReceiversByCategory(listing.category);
  
  const matches = [];
  
  for (const receiver of receivers) {
    // Calculate score
    const score = calculateMatchScore(listing, receiver);
    
    // Only create match if score >= 40
    if (score < 40) continue;
    
    // Create match record
    const match = {
      pk: `MATCH#${uuid()}`,
      sk: "METADATA",
      gsi1pk: `LISTING#${listingId}`,
      gsi1sk: `MATCH#${String(100 - score).padStart(3, '0')}#${uuid()}`, // Inverse for sorting
      gsi2pk: `RECEIVER#${receiver.userId}`,
      gsi2sk: `MATCH#SUGGESTED#${String(100 - score).padStart(3, '0')}#${uuid()}`,
      matchId: uuid(),
      listingId,
      donorId: listing.donorId,
      receiverId: receiver.userId,
      score,
      status: "SUGGESTED",
      suggestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
      listingSnapshot: {
        category: listing.category,
        quantity: listing.quantity,
        unit: listing.unit,
        pickupWindowStart: listing.pickupWindowStart,
        pickupWindowEnd: listing.pickupWindowEnd,
        storageConstraint: listing.storageConstraint,
        urgency: listing.urgency
      },
      matchReason: {
        categoryMatch: true,
        quantityFit: calculateQuantityFit(listing, receiver),
        distanceKm: calculateDistance(listing, receiver),
        urgencyBonus: getUrgencyBonus(listing.urgency)
      }
    };
    
    matches.push(match);
  }
  
  // Batch write matches
  await batchWriteMatches(matches);
  
  // Emit match.suggested events (one per receiver)
  for (const match of matches) {
    await emitEvent({
      eventType: "match.suggested",
      entityId: match.matchId,
      userId: match.receiverId,
      payload: {
        matchId: match.matchId,
        listingId: match.listingId,
        score: match.score
      }
    });
  }
  
  console.log(`Generated ${matches.length} matches for listing ${listingId}`);
}
```

---

### 2. Match Accept Endpoint

**Endpoint:** `POST /v1/matches/{matchId}/accept`
**Handler:** `services/api/handlers/matches.ts`

```typescript
export async function acceptMatch(matchId: string, userId: string) {
  // 1. Get match record
  const match = await getMatch(matchId);
  
  // 2. Validate
  if (!match) throw new NotFoundError("Match not found");
  if (match.receiverId !== userId) throw new ForbiddenError("Not your match");
  if (match.status !== "SUGGESTED") {
    throw new ConflictError(`Match already ${match.status.toLowerCase()}`);
  }
  if (new Date(match.expiresAt) < new Date()) {
    throw new ConflictError("Match expired");
  }
  
  // 3. Conditional update (prevent double-accept)
  try {
    await updateMatch({
      matchId,
      updates: {
        status: "ACCEPTED",
        acceptedAt: new Date().toISOString(),
        gsi2sk: match.gsi2sk.replace("SUGGESTED", "ACCEPTED") // Update sort key
      },
      condition: "status = :suggested",
      conditionValues: { ":suggested": "SUGGESTED" }
    });
  } catch (error) {
    if (error.code === "ConditionalCheckFailedException") {
      throw new ConflictError("Match already accepted by someone else");
    }
    throw error;
  }
  
  // 4. Update listing status
  await updateListing(match.listingId, {
    status: "MATCHED",
    matchedAt: new Date().toISOString(),
    matchedReceiverId: userId
  });
  
  // 5. Expire all other SUGGESTED matches for this listing
  await expireOtherMatches(match.listingId, matchId);
  
  // 6. Emit events
  await emitEvent({
    eventType: "match.accepted",
    entityId: matchId,
    userId: userId,
    payload: {
      matchId,
      listingId: match.listingId,
      donorId: match.donorId,
      receiverId: userId
    }
  });
  
  await emitEvent({
    eventType: "listing.matched",
    entityId: match.listingId,
    userId: match.donorId,
    payload: {
      listingId: match.listingId,
      matchId,
      receiverId: userId
    }
  });
  
  return {
    matchId,
    listingId: match.listingId,
    status: "ACCEPTED",
    message: "Match accepted successfully"
  };
}
```

---

### 3. Receiver Match Feed Endpoint

**Endpoint:** `GET /v1/matches`
**Query Params:**
- `status=SUGGESTED` (default) or `ACCEPTED`
- `limit=20` (pagination)
- `minScore=40` (filter low-quality matches)

```typescript
export async function getMyMatches(userId: string, filters: MatchFilters) {
  const { status = "SUGGESTED", limit = 20, minScore = 0 } = filters;
  
  const matches = await queryMatchesByReceiver({
    receiverId: userId,
    status,
    limit
  });
  
  // Filter by score if needed
  const filtered = matches.filter(m => m.score >= minScore);
  
  // Enrich with current listing data (in case it changed)
  const enriched = await enrichMatchesWithListings(filtered);
  
  return {
    matches: enriched,
    hasMore: matches.length === limit
  };
}
```

---

### 4. Donor Match Interest Endpoint

**Endpoint:** `GET /v1/listings/{listingId}/matches`

Shows donor who's interested in their listing:

```typescript
export async function getListingMatches(listingId: string, userId: string) {
  // Verify ownership
  const listing = await getListing(listingId);
  if (listing.donorId !== userId) {
    throw new ForbiddenError("Not your listing");
  }
  
  const matches = await queryMatchesByListing(listingId);
  
  return {
    listingId,
    totalMatches: matches.length,
    acceptedMatch: matches.find(m => m.status === "ACCEPTED"),
    suggestedMatches: matches
      .filter(m => m.status === "SUGGESTED")
      .sort((a, b) => b.score - a.score) // Best matches first
  };
}
```

---

## 🔒 Race Condition Handling

### Problem: Two receivers accept simultaneously

**Solution: DynamoDB Conditional Update**

```typescript
// This operation is atomic
await dynamodb.update({
  Key: { pk: matchPk, sk: "METADATA" },
  UpdateExpression: "SET #status = :accepted, acceptedAt = :now",
  ConditionExpression: "#status = :suggested", // Only update if still SUGGESTED
  ExpressionAttributeNames: { "#status": "status" },
  ExpressionAttributeValues: {
    ":accepted": "ACCEPTED",
    ":suggested": "SUGGESTED",
    ":now": new Date().toISOString()
  }
});
```

**If condition fails:** Second receiver gets `ConflictError`, shows UI message "This match was just accepted by someone else."

---

## 📈 Match Expiration Strategy

### Option 1: TTL-based (Simple)
- Set DynamoDB TTL on `expiresAt` field
- Match records automatically deleted after 24h
- **Downside:** No custom logic on expiration

### Option 2: Scheduled Lambda (Flexible)
- EventBridge cron: Every 5 minutes
- Query all matches where `status = SUGGESTED AND expiresAt < now`
- Update status to `EXPIRED`
- **Advantage:** Can emit events, run cleanup logic

**Recommendation:** Option 2 for now (more control), switch to TTL later if needed.

---

## 🎨 Frontend Integration

### Receiver's Match Feed (Home Screen)

```typescript
const { data } = await fetch("/v1/matches?status=SUGGESTED&minScore=60");

// Show cards
data.matches.map(match => (
  <MatchCard key={match.matchId}>
    <Score>{match.score}% match</Score>
    <Category>{match.listingSnapshot.category}</Category>
    <Quantity>{match.listingSnapshot.quantity} {match.listingSnapshot.unit}</Quantity>
    <Distance>{match.matchReason.distanceKm} km away</Distance>
    <Urgency>{match.listingSnapshot.urgency}</Urgency>
    <Button onClick={() => acceptMatch(match.matchId)}>Accept Match</Button>
  </MatchCard>
));
```

### Donor's Interest View

```typescript
const { data } = await fetch(`/v1/listings/${listingId}/matches`);

<div>
  <h2>{data.totalMatches} receivers interested</h2>
  {data.acceptedMatch ? (
    <Alert>✅ Accepted by {data.acceptedMatch.receiverId}</Alert>
  ) : (
    <List>
      {data.suggestedMatches.map(match => (
        <ListItem key={match.matchId}>
          Score: {match.score}, Suggested: {match.suggestedAt}
        </ListItem>
      ))}
    </List>
  )}
</div>
```

---

## 🚦 Next Steps

1. ✅ **Data model designed** (this document)
2. ⏳ **Implement match generation Lambda**
3. ⏳ **Implement match accept endpoint**
4. ⏳ **Add match query endpoints**
5. ⏳ **Add EventBridge rules**
6. ⏳ **Test race conditions**
7. ⏳ **Add match expiration cleanup**

---

## 📊 Monitoring & Metrics

**Key metrics to track:**
- Match generation rate (matches/listing)
- Match acceptance rate (accepts/suggestions)
- Time to accept (suggestedAt → acceptedAt)
- Match score distribution
- Expired match rate (indicates poor matching)

**CloudWatch Alarms:**
- Alert if match generation fails for >5 consecutive listings
- Alert if acceptance rate drops <20% (suggests poor matching quality)

---

## 🔮 Future Enhancements

1. **Machine learning scoring** (learn from acceptance patterns)
2. **Time-based scoring** (prefer matches within pickup window)
3. **Historical performance** (receivers with good pickup history rank higher)
4. **Multi-listing matching** (bundle small donations)
5. **Negative feedback** (receiver can decline and say why)
6. **Donor preference** (donor can pre-approve receiver types)

**Your matching system is now event-driven, scalable, and UX-optimized!** 🎯
