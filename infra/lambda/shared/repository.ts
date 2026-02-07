import { DynamoDBClient, PutItemCommand, GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { KeyPatterns, UserProfile, Listing, NeedRequest, Match, Event } from './types';

const client = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

// ============================================
// User Profile Operations
// ============================================

export async function saveUserProfile(profile: UserProfile): Promise<void> {
  const keys = KeyPatterns.profile(profile.userId);
  const item = {
    ...keys,
    ...profile,
    entityType: 'PROFILE',
  };

  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshall(item, { removeUndefinedValues: true }),
  }));
}

export async function getUserProfile(userId: string): Promise<UserProfile | null> {
  const keys = KeyPatterns.profile(userId);
  
  const result = await client.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: marshall(keys),
  }));

  if (!result.Item) return null;
  return unmarshall(result.Item) as UserProfile;
}

// ============================================
// Listing Operations
// ============================================

export async function saveListing(listing: Listing): Promise<void> {
  const timestamp = new Date().toISOString();
  listing.updatedAt = timestamp;

  // Store listing metadata
  const metaKeys = KeyPatterns.listing(listing.listingId);
  const metaItem = {
    ...metaKeys,
    ...listing,
    entityType: 'LISTING',
  };

  // Store user-listing reference
  const userKeys = KeyPatterns.userListing(listing.donorId, listing.listingId);
  const userItem = {
    ...userKeys,
    listingId: listing.listingId,
    status: listing.status,
    createdAt: listing.createdAt,
    updatedAt: timestamp,
    entityType: 'USER_LISTING',
  };

  // Store category index for posted listings
  const categoryKeys = KeyPatterns.categoryListing(listing.category, listing.listingId);
  const categoryItem = {
    ...categoryKeys,
    listingId: listing.listingId,
    donorId: listing.donorId,
    status: listing.status,
    urgency: listing.urgency,
    createdAt: listing.createdAt,
    entityType: 'CATEGORY_LISTING',
  };

  // Write all three items (in production, use TransactWriteItems)
  await Promise.all([
    client.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(metaItem, { removeUndefinedValues: true }),
    })),
    client.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(userItem, { removeUndefinedValues: true }),
    })),
    listing.status === 'POSTED' ? client.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(categoryItem, { removeUndefinedValues: true }),
    })) : Promise.resolve(),
  ]);
}

export async function getListing(listingId: string): Promise<Listing | null> {
  const keys = KeyPatterns.listing(listingId);
  
  const result = await client.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: marshall(keys),
  }));

  if (!result.Item) return null;
  return unmarshall(result.Item) as Listing;
}

export async function getUserListings(userId: string): Promise<Listing[]> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    ExpressionAttributeValues: marshall({
      ':pk': `USER#${userId}`,
      ':sk': 'LISTING#',
    }),
  }));

  if (!result.Items || result.Items.length === 0) return [];

  // Fetch full listing details for each
  const listingIds = result.Items.map(item => unmarshall(item).listingId as string);
  const listings = await Promise.all(listingIds.map(id => getListing(id)));
  
  return listings.filter(l => l !== null) as Listing[];
}

export async function getPostedListingsByCategory(category: string, limit = 50): Promise<Listing[]> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    ExpressionAttributeValues: marshall({
      ':pk': `CATEGORY#${category}`,
      ':sk': 'LISTING#',
    }),
    Limit: limit,
    ScanIndexForward: false, // Most recent first
  }));

  if (!result.Items || result.Items.length === 0) return [];

  const listingIds = result.Items.map(item => unmarshall(item).listingId as string);
  const listings = await Promise.all(listingIds.map(id => getListing(id)));
  
  return listings.filter(l => l !== null && l.status === 'POSTED') as Listing[];
}

// ============================================
// Need Request Operations
// ============================================

export async function saveNeedRequest(request: NeedRequest): Promise<void> {
  const metaKeys = KeyPatterns.request(request.requestId);
  const metaItem = {
    ...metaKeys,
    ...request,
    entityType: 'REQUEST',
  };

  const userKeys = KeyPatterns.userRequest(request.receiverId, request.requestId);
  const userItem = {
    ...userKeys,
    requestId: request.requestId,
    category: request.category,
    status: request.status,
    createdAt: request.createdAt,
    entityType: 'USER_REQUEST',
  };

  await Promise.all([
    client.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(metaItem, { removeUndefinedValues: true }),
    })),
    client.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(userItem, { removeUndefinedValues: true }),
    })),
  ]);
}

export async function getNeedRequest(requestId: string): Promise<NeedRequest | null> {
  const keys = KeyPatterns.request(requestId);
  
  const result = await client.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: marshall(keys),
  }));

  if (!result.Item) return null;
  return unmarshall(result.Item) as NeedRequest;
}

export async function getUserNeedRequests(userId: string): Promise<NeedRequest[]> {
  const result = await client.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    ExpressionAttributeValues: marshall({
      ':pk': `USER#${userId}`,
      ':sk': 'REQUEST#',
    }),
  }));

  if (!result.Items || result.Items.length === 0) return [];

  const requestIds = result.Items.map(item => unmarshall(item).requestId as string);
  const requests = await Promise.all(requestIds.map(id => getNeedRequest(id)));
  
  return requests.filter(r => r !== null) as NeedRequest[];
}

// ============================================
// Match Operations
// ============================================

export async function saveMatch(match: Match): Promise<void> {
  const keys = KeyPatterns.match(match.matchId);
  const item = {
    ...keys,
    ...match,
    entityType: 'MATCH',
  };

  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshall(item, { removeUndefinedValues: true }),
  }));
}

export async function getMatch(matchId: string): Promise<Match | null> {
  const keys = KeyPatterns.match(matchId);
  
  const result = await client.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: marshall(keys),
  }));

  if (!result.Item) return null;
  return unmarshall(result.Item) as Match;
}

// ============================================
// Event Operations
// ============================================

export async function saveEvent(event: Event): Promise<void> {
  const keys = KeyPatterns.userEvent(event.userId, event.createdAt);
  const item = {
    ...keys,
    ...event,
    entityType: 'EVENT',
  };

  await client.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshall(item, { removeUndefinedValues: true }),
  }));
}

export async function getUserEvents(userId: string, since?: string, limit = 100): Promise<Event[]> {
  const keyCondition = since 
    ? 'pk = :pk AND sk > :since'
    : 'pk = :pk AND begins_with(sk, :sk)';
  
  const expressionValues = since
    ? { ':pk': `USER#${userId}`, ':since': `EVENT#${since}` }
    : { ':pk': `USER#${userId}`, ':sk': 'EVENT#' };

  const result = await client.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: keyCondition,
    ExpressionAttributeValues: marshall(expressionValues),
    Limit: limit,
    ScanIndexForward: false, // Most recent first
  }));

  if (!result.Items || result.Items.length === 0) return [];
  return result.Items.map(item => unmarshall(item) as Event);
}
