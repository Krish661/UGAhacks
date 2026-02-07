import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DraftListingInputSchema, DraftListingInput, ListingSchema, Listing, AgentDraftResponse } from '../shared/types';
import { analyzeDraftListing } from '../shared/gemini-agent';
import { saveListing, getListing, getUserListings } from '../shared/repository';
import { successResponse, errorResponse, extractUserContext, parseBody, formatZodError } from '../shared/utils';
import { saveEvent } from '../shared/repository';

// ============================================
// POST /v1/listings/draft - Create Draft with Agent
// ============================================

export async function postDraftListing(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const user = extractUserContext(event);
    if (!user) {
      return errorResponse('UNAUTHORIZED', 'User context not found', 401);
    }

    const body = parseBody<DraftListingInput>(event);
    if (!body) {
      return errorResponse('BAD_REQUEST', 'Invalid request body', 400);
    }

    // Validate input with Zod
    const validated = DraftListingInputSchema.parse(body);

    // Call Gemini agent to analyze and fill gaps
    const agentResponse: AgentDraftResponse = await analyzeDraftListing(validated, user.userId);

    // Create draft listing
    const timestamp = new Date().toISOString();
    const draftListing: Listing = {
      listingId: agentResponse.listingId,
      donorId: user.userId,
      category: agentResponse.suggestedFields.category || 'other',
      description: agentResponse.suggestedFields.description || '',
      quantity: agentResponse.suggestedFields.quantity || 0,
      unit: agentResponse.suggestedFields.unit || 'items',
      pickupWindowStart: agentResponse.suggestedFields.pickupWindowStart || '',
      pickupWindowEnd: agentResponse.suggestedFields.pickupWindowEnd || '',
      urgency: agentResponse.suggestedFields.urgency || 'MEDIUM',
      expiresAt: agentResponse.suggestedFields.expiresAt,
      storageConstraint: agentResponse.suggestedFields.storageConstraint,
      pickupBy: agentResponse.suggestedFields.pickupBy || 'receiver',
      status: 'DRAFT',
      createdAt: timestamp,
      updatedAt: timestamp,
      suggestedFields: agentResponse.suggestedFields,
      missingFields: agentResponse.missingFields,
    };

    // Save draft to DynamoDB
    await saveListing(draftListing);

    // Return agent response with draft listing
    return successResponse({
      listing: draftListing,
      agentSummary: agentResponse.proposedSummary,
      missingFields: agentResponse.missingFields,
      confidence: agentResponse.confidence,
    }, 201);
  } catch (error: any) {
    console.error('Error creating draft listing:', error);
    
    if (error.name === 'ZodError') {
      return errorResponse('VALIDATION_ERROR', formatZodError(error), 400);
    }
    
    return errorResponse('INTERNAL_ERROR', 'Failed to create draft listing', 500, error.message);
  }
}

// ============================================
// POST /v1/listings/{id}/confirm - Confirm & Post Listing
// ============================================

export async function postConfirmListing(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const user = extractUserContext(event);
    if (!user) {
      return errorResponse('UNAUTHORIZED', 'User context not found', 401);
    }

    const listingId = event.pathParameters?.id;
    if (!listingId) {
      return errorResponse('BAD_REQUEST', 'Listing ID required', 400);
    }

    // Get existing draft listing
    const existing = await getListing(listingId);
    if (!existing) {
      return errorResponse('NOT_FOUND', 'Listing not found', 404);
    }

    if (existing.donorId !== user.userId) {
      return errorResponse('FORBIDDEN', 'Not authorized to modify this listing', 403);
    }

    if (existing.status !== 'DRAFT') {
      return errorResponse('BAD_REQUEST', 'Listing is not in draft status', 400);
    }

    // Parse updated fields from request body
    const body = parseBody<Partial<Listing>>(event);
    if (body) {
      // Merge updated fields
      Object.assign(existing, body);
    }

    // Validate required fields are present
    const requiredFields = ['category', 'description', 'quantity', 'unit', 'pickupWindowStart', 'pickupWindowEnd'];
    const missing = requiredFields.filter(field => !existing[field as keyof Listing]);
    
    if (missing.length > 0) {
      return errorResponse('VALIDATION_ERROR', `Missing required fields: ${missing.join(', ')}`, 400);
    }

    // Update status to POSTED
    const timestamp = new Date().toISOString();
    existing.status = 'POSTED';
    existing.confirmedAt = timestamp;
    existing.updatedAt = timestamp;

    // Validate complete listing
    const validated = ListingSchema.parse(existing);

    // Save to DynamoDB
    await saveListing(validated);

    // Emit event for receivers to see
    await saveEvent({
      eventId: `EVENT#${timestamp}#${listingId}`,
      userId: user.userId,
      entityType: 'LISTING',
      entityId: listingId,
      eventType: 'listing.posted',
      payload: {
        listingId,
        category: validated.category,
        urgency: validated.urgency,
      },
      createdAt: timestamp,
    });

    return successResponse(validated);
  } catch (error: any) {
    console.error('Error confirming listing:', error);
    
    if (error.name === 'ZodError') {
      return errorResponse('VALIDATION_ERROR', formatZodError(error), 400);
    }
    
    return errorResponse('INTERNAL_ERROR', 'Failed to confirm listing', 500, error.message);
  }
}

// ============================================
// GET /v1/listings/mine - Get User's Listings
// ============================================

export async function getMyListings(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const user = extractUserContext(event);
    if (!user) {
      return errorResponse('UNAUTHORIZED', 'User context not found', 401);
    }

    const listings = await getUserListings(user.userId);

    return successResponse({ listings, count: listings.length });
  } catch (error: any) {
    console.error('Error getting user listings:', error);
    return errorResponse('INTERNAL_ERROR', 'Failed to get listings', 500, error.message);
  }
}
