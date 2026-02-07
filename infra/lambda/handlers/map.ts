import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { directionsRoute } from '../shared/mapbox';
import { KeyPatterns, UserProfile, Listing, Match } from '../shared/types';

const dynamodb = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

// ============================================
// Response Helpers
// ============================================

function createResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    },
    body: JSON.stringify(body),
  };
}

function createErrorResponse(
  statusCode: number,
  errorCode: string,
  message: string
): APIGatewayProxyResult {
  return createResponse(statusCode, {
    ok: false,
    error: errorCode,
    message,
  });
}

// ============================================
// GET /v1/map/match/{matchId}
// ============================================

export async function getMapPayloadMatch(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const matchId = event.pathParameters?.matchId;
    const userId = event.requestContext.authorizer?.claims.sub;

    if (!matchId) {
      return createErrorResponse(400, 'INVALID_INPUT', 'matchId required');
    }

    if (!userId) {
      return createErrorResponse(401, 'UNAUTHORIZED', 'User ID not found');
    }

    // Load match META
    const matchKeys = KeyPatterns.match(matchId);
    const matchResult = await dynamodb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: matchKeys.pk },
        sk: { S: matchKeys.sk },
      },
    }));

    if (!matchResult.Item) {
      return createErrorResponse(404, 'NOT_FOUND', 'Match not found');
    }

    const match = unmarshall(matchResult.Item) as Match;

    // Verify user is part of this match
    if (match.donorId !== userId && match.receiverId !== userId) {
      return createErrorResponse(403, 'FORBIDDEN', 'Not authorized to view this match');
    }

    // Validate match status - only ACCEPTED matches can generate routes
    if (match.status !== 'ACCEPTED') {
      return createErrorResponse(400, 'INVALID_STATUS', `Route only available for accepted matches (current: ${match.status})`);
    }

    // Check if match expired
    if (match.expiresAt && new Date(match.expiresAt) < new Date()) {
      return createErrorResponse(410, 'MATCH_EXPIRED', 'Match has expired');
    }

    // Load listing to get pickupBy and pickupLocation
    const listingResult = await dynamodb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: match.listingId },
        sk: { S: 'META' },
      },
    }));

    if (!listingResult.Item) {
      return createErrorResponse(404, 'NOT_FOUND', 'Listing not found');
    }

    const listing = unmarshall(listingResult.Item) as Listing;

    // Check listing status - don't generate routes for cancelled/completed listings
    if (listing.status === 'CANCELED') {
      return createErrorResponse(410, 'LISTING_CANCELED', 'Listing has been cancelled');
    }
    if (listing.status === 'DELIVERED') {
      return createErrorResponse(410, 'LISTING_DELIVERED', 'Listing has been delivered');
    }

    // Load donor and receiver profiles
    const donorProfileResult = await dynamodb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: `PROFILE#${match.donorId}` },
        sk: { S: 'PROFILE' },
      },
    }));

    const receiverProfileResult = await dynamodb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: `PROFILE#${match.receiverId}` },
        sk: { S: 'PROFILE' },
      },
    }));

    const donorProfile = donorProfileResult.Item ? unmarshall(donorProfileResult.Item) as UserProfile : null;
    const receiverProfile = receiverProfileResult.Item ? unmarshall(receiverProfileResult.Item) as UserProfile : null;

    // Determine locations based on pickupBy
    const pickupBy = listing.pickupBy || 'receiver';
    let fromLocation, toLocation, fromLabel, toLabel;

    if (pickupBy === 'receiver') {
      // Receiver goes to donor's location
      fromLocation = receiverProfile?.location;
      toLocation = listing.pickupLocation;
      fromLabel = receiverProfile?.name || 'Receiver';
      toLabel = donorProfile?.name || 'Pickup Location';
    } else {
      // Donor goes to receiver's location
      fromLocation = listing.pickupLocation;
      toLocation = receiverProfile?.location;
      fromLabel = donorProfile?.name || 'Donor';
      toLabel = receiverProfile?.name || 'Delivery Location';
    }

    // Check if both locations exist
    if (!fromLocation) {
      const missingParty = pickupBy === 'receiver' ? 'receiver' : 'donor';
      return createErrorResponse(400, 'MISSING_LOCATION', `${missingParty} profile needs address and location saved`);
    }

    if (!toLocation) {
      const missingParty = pickupBy === 'receiver' ? 'listing' : 'receiver';
      return createErrorResponse(400, 'MISSING_LOCATION', `${missingParty} location not available`);
    }

    // Get directions
    const route = await directionsRoute(
      { lat: fromLocation.lat, lon: fromLocation.lon },
      { lat: toLocation.lat, lon: toLocation.lon }
    );

    // Build response
    return createResponse(200, {
      ok: true,
      data: {
        pickupBy,
        from: {
          lat: fromLocation.lat,
          lon: fromLocation.lon,
          label: fromLabel,
        },
        to: {
          lat: toLocation.lat,
          lon: toLocation.lon,
          label: toLabel,
        },
        route: {
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          geometryGeoJson: route.geometryGeoJson,
        },
        instructions: {
          summaryText: `${Math.round(route.distanceMeters / 1000)} km, ${Math.round(route.durationSeconds / 60)} minutes`,
        },
      },
    });
  } catch (error) {
    console.error('Map payload error:', error);

    if (error instanceof Error && error.message.includes('No route found')) {
      return createErrorResponse(404, 'NOT_FOUND', 'No route available between locations');
    }

    return createErrorResponse(500, 'INTERNAL_ERROR', 'Failed to generate map payload');
  }
}

// ============================================
// GET /v1/map/listing/{listingId}?receiverId=optional
// ============================================

export async function getMapPayloadListing(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const listingId = event.pathParameters?.listingId;
    const receiverId = event.queryStringParameters?.receiverId;
    const userId = event.requestContext.authorizer?.claims.sub;

    if (!listingId) {
      return createErrorResponse(400, 'INVALID_INPUT', 'listingId required');
    }

    if (!userId) {
      return createErrorResponse(401, 'UNAUTHORIZED', 'User ID not found');
    }

    // Load listing
    const listingResult = await dynamodb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: listingId },
        sk: { S: 'META' },
      },
    }));

    if (!listingResult.Item) {
      return createErrorResponse(404, 'NOT_FOUND', 'Listing not found');
    }

    const listing = unmarshall(listingResult.Item) as Listing;

    // Determine receiver (from query param or current user)
    const targetReceiverId = receiverId || userId;

    // Load donor and receiver profiles
    const donorProfileResult = await dynamodb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: `PROFILE#${listing.donorId}` },
        sk: { S: 'PROFILE' },
      },
    }));

    const receiverProfileResult = await dynamodb.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: { S: `PROFILE#${targetReceiverId}` },
        sk: { S: 'PROFILE' },
      },
    }));

    const donorProfile = donorProfileResult.Item ? unmarshall(donorProfileResult.Item) as UserProfile : null;
    const receiverProfile = receiverProfileResult.Item ? unmarshall(receiverProfileResult.Item) as UserProfile : null;

    // Determine locations based on pickupBy
    const pickupBy = listing.pickupBy || 'receiver';
    let fromLocation, toLocation, fromLabel, toLabel;

    if (pickupBy === 'receiver') {
      fromLocation = receiverProfile?.location;
      toLocation = listing.pickupLocation;
      fromLabel = receiverProfile?.name || 'Receiver';
      toLabel = donorProfile?.name || 'Pickup Location';
    } else {
      fromLocation = listing.pickupLocation;
      toLocation = receiverProfile?.location;
      fromLabel = donorProfile?.name || 'Donor';
      toLabel = receiverProfile?.name || 'Delivery Location';
    }

    // Check if both locations exist
    if (!fromLocation) {
      const missingParty = pickupBy === 'receiver' ? 'receiver' : 'donor';
      return createErrorResponse(400, 'MISSING_LOCATION', `${missingParty} profile needs address and location saved`);
    }

    if (!toLocation) {
      const missingParty = pickupBy === 'receiver' ? 'listing' : 'receiver';
      return createErrorResponse(400, 'MISSING_LOCATION', `${missingParty} location not available`);
    }

    // Get directions
    const route = await directionsRoute(
      { lat: fromLocation.lat, lon: fromLocation.lon },
      { lat: toLocation.lat, lon: toLocation.lon }
    );

    // Build response
    return createResponse(200, {
      ok: true,
      data: {
        pickupBy,
        from: {
          lat: fromLocation.lat,
          lon: fromLocation.lon,
          label: fromLabel,
        },
        to: {
          lat: toLocation.lat,
          lon: toLocation.lon,
          label: toLabel,
        },
        route: {
          distanceMeters: route.distanceMeters,
          durationSeconds: route.durationSeconds,
          geometryGeoJson: route.geometryGeoJson,
        },
        instructions: {
          summaryText: `${Math.round(route.distanceMeters / 1000)} km, ${Math.round(route.durationSeconds / 60)} minutes`,
        },
      },
    });
  } catch (error) {
    console.error('Map payload error:', error);

    if (error instanceof Error && error.message.includes('No route found')) {
      return createErrorResponse(404, 'NOT_FOUND', 'No route available between locations');
    }

    return createErrorResponse(500, 'INTERNAL_ERROR', 'Failed to generate map payload');
  }
}

// ============================================
// Universal Handler (routes based on path)
// ============================================

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const path = event.path;

  if (path.includes('/map/match/')) {
    return getMapPayloadMatch(event);
  } else if (path.includes('/map/listing/')) {
    return getMapPayloadListing(event);
  } else {
    return createErrorResponse(404, 'NOT_FOUND', 'Unknown map endpoint');
  }
}
