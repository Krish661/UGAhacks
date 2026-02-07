import { DynamoDBClient, QueryCommand, GetItemCommand, UpdateItemCommand, PutItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { KeyPatterns, Match } from '../shared/types';

const dynamodb = new DynamoDBClient({});

const TABLE_NAME = process.env.TABLE_NAME!;

// ============================================
// Helper Functions
// ============================================

function getUserIdFromEvent(event: APIGatewayProxyEvent): string {
  return event.requestContext.authorizer?.claims?.sub || '';
}

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': '*',
    },
    body: JSON.stringify(body),
  };
}

async function emitEvent(eventType: string, entityId: string, userId: string, payload: any) {
  const timestamp = new Date().toISOString();
  const eventItem = {
    pk: { S: `USER#${userId}` },
    sk: { S: `EVENT#${timestamp}#${entityId}` },
    type: { S: eventType },
    entityId: { S: entityId },
    payload: { S: JSON.stringify(payload) },
    createdAt: { S: timestamp },
    ttl: { N: String(Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60) }, // 30 days TTL
  };
  
  try {
    await dynamodb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: eventItem,
      })
    );
    console.log('Event emitted:', { eventType, entityId, userId });
  } catch (error) {
    console.error('Failed to emit event:', error);
    // Don't throw - event emission failures shouldn't block operations
  }
}

//============================================
// POST /v1/matches/{matchId}/accept
// ============================================

export async function postAcceptMatch(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const matchId = event.pathParameters?.matchId;
    const userId = getUserIdFromEvent(event);

    if (!matchId) {
      return createResponse(400, { error: 'MISSING_MATCH_ID', message: 'Match ID required' });
    }

    // 1. Get match META
    const matchKey = KeyPatterns.match(matchId);
    const matchResponse = await dynamodb.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: marshall(matchKey),
      })
    );

    if (!matchResponse.Item) {
      return createResponse(404, { error: 'NOT_FOUND', message: 'Match not found' });
    }

    const match = unmarshall(matchResponse.Item) as Match;

    // 2. Validate
    if (match.receiverId !== userId) {
      return createResponse(403, { error: 'FORBIDDEN', message: 'Not your match' });
    }

    if (match.status !== 'SUGGESTED') {
      return createResponse(409, {
        error: 'CONFLICT',
        message: `Match already ${match.status.toLowerCase()}`,
      });
    }

    const now = new Date();
    if (new Date(match.expiresAt) < now) {
      return createResponse(409, { error: 'EXPIRED', message: 'Match expired' });
    }

    // 3. Conditional update match META (prevent double-accept)
    const acceptedAt = now.toISOString();
    
    try {
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: marshall(matchKey),
          UpdateExpression: 'SET #status = :accepted, acceptedAt = :acceptedAt',
          ConditionExpression: '#status = :suggested',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: marshall({
            ':accepted': 'ACCEPTED',
            ':suggested': 'SUGGESTED',
            ':acceptedAt': acceptedAt,
          }),
        })
      );
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException') {
        return createResponse(409, {
          error: 'CONFLICT',
          message: 'Match already accepted by someone else',
        });
      }
      throw error;
    }

    // 4. Conditional update listing status
    const listingKey = KeyPatterns.listing(match.listingId);
    
    try {
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: TABLE_NAME,
          Key: marshall(listingKey),
          UpdateExpression: 'SET #status = :matched, matchedAt = :matchedAt, matchedReceiverId = :receiverId, acceptedMatchId = :matchId',
          ConditionExpression: '#status = :posted',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: marshall({
            ':matched': 'MATCHED',
            ':posted': 'POSTED',
            ':matchedAt': acceptedAt,
            ':receiverId': userId,
            ':matchId': matchId,
          }),
        })
      );
    } catch (error: any) {
      if (error.name === 'ConditionalCheckFailedException') {
        // Rollback match status
        await dynamodb.send(
          new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: marshall(matchKey),
            UpdateExpression: 'SET #status = :suggested REMOVE acceptedAt',
            ExpressionAttributeNames: {
              '#status': 'status',
            },
            ExpressionAttributeValues: marshall({
              ':suggested': 'SUGGESTED',
            }),
          })
        );

        return createResponse(409, {
          error: 'CONFLICT',
          message: 'Listing already matched by another receiver',
        });
      }
      throw error;
    }

    // 5. Update receiver index item (delete old SUGGESTED, create new ACCEPTED)
    const oldReceiverKey = KeyPatterns.receiverMatch(
      match.receiverId,
      'SUGGESTED',
      match.score,
      match.suggestedAt,
      matchId
    );
    
    await dynamodb.send(
      new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: marshall(oldReceiverKey),
      })
    );

    const newReceiverKey = KeyPatterns.receiverMatch(
      match.receiverId,
      'ACCEPTED',
      match.score,
      acceptedAt,
      matchId
    );
    
    await dynamodb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: marshall({
          ...newReceiverKey,
          matchId,
          listingId: match.listingId,
          donorId: match.donorId,
          score: match.score,
          status: 'ACCEPTED',
          expiresAt: match.expiresAt,
          acceptedAt,
        }),
      })
    );

    // 6. Update listing index item (delete old SUGGESTED, create new ACCEPTED)
    const oldListingKey = KeyPatterns.listingMatch(
      match.listingId,
      'SUGGESTED',
      match.score,
      match.suggestedAt,
      matchId
    );
    
    await dynamodb.send(
      new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: marshall(oldListingKey),
      })
    );

    const newListingKey = KeyPatterns.listingMatch(
      match.listingId,
      'ACCEPTED',
      match.score,
      acceptedAt,
      matchId
    );
    
    await dynamodb.send(
      new PutItemCommand({
        TableName: TABLE_NAME,
        Item: marshall({
          ...newListingKey,
          matchId,
          receiverId: match.receiverId,
          score: match.score,
          status: 'ACCEPTED',
          expiresAt: match.expiresAt,
          acceptedAt,
        }),
      })
    );

    // 7. Emit events
    await Promise.all([
      emitEvent('match.accepted', matchId, userId, {
        matchId,
        listingId: match.listingId,
        donorId: match.donorId,
        receiverId: userId,
      }),
      emitEvent('listing.matched', match.listingId, match.donorId, {
        listingId: match.listingId,
        matchId,
        receiverId: userId,
      }),
    ]);

    return createResponse(200, {
      success: true,
      data: {
        matchId,
        listingId: match.listingId,
        status: 'ACCEPTED',
        acceptedAt,
        message: 'Match accepted successfully',
      },
    });
  } catch (error) {
    console.error('Error accepting match:', error);
    return createResponse(500, {
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ============================================
// GET /v1/matches?status=SUGGESTED
// ============================================

export async function getMyMatches(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const userId = getUserIdFromEvent(event);
    const status = event.queryStringParameters?.status?.toUpperCase() || 'SUGGESTED';
    const limit = parseInt(event.queryStringParameters?.limit || '20');
    const minScore = parseInt(event.queryStringParameters?.minScore || '0');

    // Query receiver matches
    const response = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: marshall({
          ':pk': `RECEIVER#${userId}`,
          ':skPrefix': `MATCH#${status}#`,
        }),
        Limit: limit,
        ScanIndexForward: true, // Sort by score (inverted, so lower padded number = higher score)
      })
    );

    const matches = (response.Items || [])
      .map((item) => unmarshall(item))
      .filter((m: any) => m.score >= minScore);

    // Enrich with full match data if needed
    const enrichedMatches = await Promise.all(
      matches.map(async (indexItem: any) => {
        const matchKey = KeyPatterns.match(indexItem.matchId);
        const matchResponse = await dynamodb.send(
          new GetItemCommand({
            TableName: TABLE_NAME,
            Key: marshall(matchKey),
          })
        );

        if (matchResponse.Item) {
          return unmarshall(matchResponse.Item);
        }
        return indexItem; // Fallback to index item if META not found
      })
    );

    return createResponse(200, {
      success: true,
      data: {
        matches: enrichedMatches,
        count: enrichedMatches.length,
        hasMore: response.Items?.length === limit,
      },
    });
  } catch (error) {
    console.error('Error getting matches:', error);
    return createResponse(500, {
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ============================================
// GET /v1/listings/{listingId}/matches
// ============================================

export async function getListingMatches(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const listingId = event.pathParameters?.listingId;
    const userId = getUserIdFromEvent(event);

    if (!listingId) {
      return createResponse(400, { error: 'MISSING_LISTING_ID', message: 'Listing ID required' });
    }

    // Verify ownership
    const listingKey = KeyPatterns.listing(listingId);
    const listingResponse = await dynamodb.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: marshall(listingKey),
      })
    );

    if (!listingResponse.Item) {
      return createResponse(404, { error: 'NOT_FOUND', message: 'Listing not found' });
    }

    const listing = unmarshall(listingResponse.Item);
    
    if (listing.donorId !== userId) {
      return createResponse(403, { error: 'FORBIDDEN', message: 'Not your listing' });
    }

    // Query all matches for this listing
    const response = await dynamodb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
        ExpressionAttributeValues: marshall({
          ':pk': `LISTING#${listingId}`,
          ':skPrefix': 'MATCH#',
        }),
      })
    );

    const matches = (response.Items || []).map((item) => unmarshall(item));

    // Separate by status
    const acceptedMatch = matches.find((m: any) => m.status === 'ACCEPTED');
    const suggestedMatches = matches
      .filter((m: any) => m.status === 'SUGGESTED')
      .sort((a: any, b: any) => b.score - a.score);

    return createResponse(200, {
      success: true,
      data: {
        listingId,
        totalMatches: matches.length,
        acceptedMatch: acceptedMatch || null,
        suggestedMatches,
      },
    });
  } catch (error) {
    console.error('Error getting listing matches:', error);
    return createResponse(500, {
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

// ============================================
// Lambda Handler (Routes)
// ============================================

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  console.log('Matches handler event:', JSON.stringify(event, null, 2));

  const method = event.httpMethod;
  const path = event.resource;

  try {
    if (method === 'POST' && path === '/v1/matches/{matchId}/accept') {
      return await postAcceptMatch(event);
    } else if (method === 'GET' && path === '/v1/matches') {
      return await getMyMatches(event);
    } else if (method === 'GET' && path === '/v1/listings/{listingId}/matches') {
      return await getListingMatches(event);
    } else {
      return createResponse(404, {
        error: 'NOT_FOUND',
        message: 'Route not found',
      });
    }
  } catch (error) {
    console.error('Unhandled error:', error);
    return createResponse(500, {
      error: 'INTERNAL_ERROR',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
