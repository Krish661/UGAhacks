import { DynamoDBClient, QueryCommand, BatchWriteItemCommand } from '@aws-sdk/client-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { randomUUID } from 'crypto';
import { KeyPatterns, Match } from '../shared/types';

const dynamodb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

// ============================================
// Match Scoring Algorithm
// ============================================

interface Listing {
  listingId: string;
  donorId: string;
  category: string;
  quantity: number;
  unit: string;
  pickupWindowStart: string;
  pickupWindowEnd: string;
  storageConstraint?: string;
  urgency?: string;
  status: string;
  location?: {
    lat: number;
    lon: number;
  };
}

interface Receiver {
  userId: string;
  role: string;
  email: string;
  preferences?: {
    categories?: string[];
    maxDistance?: number;
  };
  capabilities?: {
    storage?: string[];
    capacity?: number;
  };
  location?: {
    lat: number;
    lon: number;
  };
}

function calculateMatchScore(listing: Listing, receiver: Receiver): {
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];

  // 1. Category match (mandatory, 30 points)
  const receiverCategories = receiver.preferences?.categories || [];
  const categoryMatch = receiverCategories.length === 0 || receiverCategories.includes(listing.category);
  
  if (!categoryMatch) {
    return { score: 0, reasons: ['Category mismatch'] };
  }
  
  score += 30;
  reasons.push('Category match');

  // 2. Quantity fit (0-25 points)
  const receiverCapacity = receiver.capabilities?.capacity || listing.quantity;
  const quantityRatio = Math.min(receiverCapacity, listing.quantity) / listing.quantity;
  const quantityPoints = Math.round(quantityRatio * 25);
  score += quantityPoints;
  
  if (quantityPoints >= 20) {
    reasons.push('Good quantity fit');
  } else if (quantityPoints >= 10) {
    reasons.push('Partial quantity fit');
  }

  // 3. Distance (0-20 points) - stub for now
  let distancePoints = 10; // Default mid-range if no location
  
  if (listing.location && receiver.location) {
    const distance = calculateDistance(
      listing.location.lat,
      listing.location.lon,
      receiver.location.lat,
      receiver.location.lon
    );
    
    if (distance < 5) {
      distancePoints = 20;
      reasons.push('Very close distance');
    } else if (distance < 10) {
      distancePoints = 15;
      reasons.push('Close distance');
    } else if (distance < 25) {
      distancePoints = 10;
      reasons.push('Moderate distance');
    } else if (distance < 50) {
      distancePoints = 5;
      reasons.push('Far distance');
    } else {
      distancePoints = 0;
      reasons.push('Very far distance');
    }
  } else {
    reasons.push('Distance unknown');
  }
  
  score += distancePoints;

  // 4. Urgency bonus (0-15 points)
  const urgency = listing.urgency?.toUpperCase();
  if (urgency === 'CRITICAL') {
    score += 15;
    reasons.push('Critical urgency');
  } else if (urgency === 'HIGH') {
    score += 10;
    reasons.push('High urgency');
  } else if (urgency === 'MEDIUM') {
    score += 5;
    reasons.push('Medium urgency');
  }

  // 5. Storage capability match (0-10 points)
  const storageConstraint = listing.storageConstraint?.toLowerCase();
  const receiverStorage = receiver.capabilities?.storage || [];
  
  if (storageConstraint && receiverStorage.length > 0) {
    if (receiverStorage.includes(storageConstraint)) {
      score += 10;
      reasons.push('Storage capability match');
    } else {
      reasons.push('Storage capability mismatch');
    }
  } else if (!storageConstraint || storageConstraint === 'none') {
    score += 10; // No special storage needed
    reasons.push('No special storage required');
  }

  return { score: Math.min(score, 100), reasons };
}

// Haversine formula for distance calculation
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// ============================================
// Find Candidate Receivers
// ============================================

async function findCandidateReceivers(_category: string): Promise<Receiver[]> {
  // For MVP: scan all profiles with role=recipient/receiver
  // TODO: Add GSI on role for efficient querying
  
  try {
    // Query users who match the category (stub implementation)
    // In production, you'd have a GSI like: pk=ROLE#recipient, sk=USER#{userId}
    
    // For now, we'll scan (inefficient but works for small datasets)
    // This is a placeholder - in production use a proper index
    const receivers: Receiver[] = [];
    
    // Stub: Return empty for now, will be populated when profiles support preferences
    // In real implementation, you'd query a role index or category preference index
    
    return receivers;
  } catch (error) {
    console.error('Error finding receivers:', error);
    return [];
  }
}

// ============================================
// Generate Matches
// ============================================

export async function generateMatches(listingId: string): Promise<{ matchCount: number }> {
  console.log(`Generating matches for listing: ${listingId}`);

  // 1. Load listing
  const listingKey = KeyPatterns.listing(listingId);
  const listingResponse = await dynamodb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND sk = :sk',
      ExpressionAttributeValues: marshall({
        ':pk': listingKey.pk,
        ':sk': listingKey.sk,
      }),
    })
  );

  if (!listingResponse.Items || listingResponse.Items.length === 0) {
    console.log(`Listing not found: ${listingId}`);
    return { matchCount: 0 };
  }

  const listing = listingResponse.Items[0] as any;
  
  // Check status
  if (listing.status?.S !== 'POSTED') {
    console.log(`Listing ${listingId} is not POSTED (status: ${listing.status?.S})`);
    return { matchCount: 0 };
  }

  // 2. Find candidate receivers
  const receivers = await findCandidateReceivers(listing.category?.S || '');
  
  if (receivers.length === 0) {
    console.log('No candidate receivers found');
    return { matchCount: 0 };
  }

  // 3. Score and filter matches
  const matches: Match[] = [];
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours
  const ttlEpochSeconds = Math.floor(expiresAt.getTime() / 1000);

  const listingData: Listing = {
    listingId: listing.listingId?.S || listingId,
    donorId: listing.donorId?.S || '',
    category: listing.category?.S || '',
    quantity: parseInt(listing.quantity?.N || '0'),
    unit: listing.unit?.S || '',
    pickupWindowStart: listing.pickupWindowStart?.S || '',
    pickupWindowEnd: listing.pickupWindowEnd?.S || '',
    storageConstraint: listing.storageConstraint?.S,
    urgency: listing.urgency?.S,
    status: listing.status?.S || '',
  };

  for (const receiver of receivers) {
    const { score, reasons } = calculateMatchScore(listingData, receiver);

    // Only create matches with score >= 40
    if (score < 40) {
      continue;
    }

    const matchId = randomUUID();
    const match: Match = {
      matchId,
      listingId,
      donorId: listingData.donorId,
      receiverId: receiver.userId,
      score,
      reasons,
      status: 'SUGGESTED',
      suggestedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ttlEpochSeconds,
      listingSnapshot: {
        category: listingData.category,
        quantity: listingData.quantity,
        unit: listingData.unit,
        pickupWindowStart: listingData.pickupWindowStart,
        pickupWindowEnd: listingData.pickupWindowEnd,
        storageConstraint: listingData.storageConstraint,
        urgency: listingData.urgency || 'MEDIUM',
      },
    };

    matches.push(match);

    // Limit to 20 matches max
    if (matches.length >= 20) {
      break;
    }
  }

  // 4. Batch write matches (1 META + 2 index items per match)
  if (matches.length > 0) {
    const writeRequests = [];

    for (const match of matches) {
      // META item
      const metaKey = KeyPatterns.match(match.matchId);
      writeRequests.push({
        PutRequest: {
          Item: marshall({
            ...metaKey,
            ...match,
            ttl: ttlEpochSeconds,
          }),
        },
      });

      // Receiver index item
      const receiverKey = KeyPatterns.receiverMatch(
        match.receiverId,
        match.status,
        match.score,
        match.suggestedAt,
        match.matchId
      );
      writeRequests.push({
        PutRequest: {
          Item: marshall({
            ...receiverKey,
            matchId: match.matchId,
            listingId: match.listingId,
            donorId: match.donorId,
            score: match.score,
            status: match.status,
            expiresAt: match.expiresAt,
            ttl: ttlEpochSeconds,
          }),
        },
      });

      // Listing index item
      const listingIndexKey = KeyPatterns.listingMatch(
        match.listingId,
        match.status,
        match.score,
        match.suggestedAt,
        match.matchId
      );
      writeRequests.push({
        PutRequest: {
          Item: marshall({
            ...listingIndexKey,
            matchId: match.matchId,
            receiverId: match.receiverId,
            score: match.score,
            status: match.status,
            expiresAt: match.expiresAt,
            ttl: ttlEpochSeconds,
          }),
        },
      });
    }

    // Batch write in chunks of 25 (DynamoDB limit)
    for (let i = 0; i < writeRequests.length; i += 25) {
      const chunk = writeRequests.slice(i, i + 25);
      await dynamodb.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [TABLE_NAME]: chunk,
          },
        })
      );
    }

    console.log(`Generated ${matches.length} matches for listing ${listingId}`);
  } else {
    console.log('No matches met minimum score threshold (40)');
  }

  return { matchCount: matches.length };
}

// ============================================
// Lambda Handler (can be invoked by API or EventBridge)
// ============================================

export async function handler(event: any) {
  console.log('Match generation event:', JSON.stringify(event, null, 2));

  try {
    let listingId: string;

    // Handle EventBridge event (listing.posted)
    if (event.detail && event['detail-type'] === 'listing.posted') {
      listingId = event.detail.listingId;
    }
    // Handle direct invocation or API Gateway
    else if (event.listingId) {
      listingId = event.listingId;
    } else if (event.body) {
      const body = JSON.parse(event.body);
      listingId = body.listingId;
    } else {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing listingId' }),
      };
    }

    const result = await generateMatches(listingId);

    // Return API Gateway response format if needed
    if (event.requestContext) {
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          success: true,
          data: result,
        }),
      };
    }

    // Return plain result for EventBridge
    return result;
  } catch (error) {
    console.error('Error generating matches:', error);

    if (event.requestContext) {
      return {
        statusCode: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({
          error: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
      };
    }

    throw error;
  }
}
