import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  AgentMessageRequestSchema,
  AgentConfirmRequestSchema,
  AgentMessageResponse,
  AgentConfirmResponse,
  AgentSession,
} from '../shared/agent-types';
import {
  saveAgentSession,
  getAgentSession,
  getLatestSession,
} from '../shared/agent-repository';
import {
  detectIntent,
  extractFields,
  determineNextQuestion,
  generateResponse,
  updateSessionFields,
  generateSummaryCard,
} from '../shared/agent-logic';
import { saveListing, saveEvent } from '../shared/repository';
import { Listing } from '../shared/types';
import { successResponse, errorResponse, extractUserContext, parseBody, formatZodError } from '../shared/utils';

// ============================================
// POST /v1/agent/message - Conversational Interaction
// ============================================

export async function postAgentMessage(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const user = extractUserContext(event);
    if (!user) {
      return errorResponse('UNAUTHORIZED', 'User context not found', 401);
    }

    const body = parseBody<any>(event);
    if (!body) {
      return errorResponse('BAD_REQUEST', 'Invalid request body', 400);
    }

    // Validate input
    const validated = AgentMessageRequestSchema.parse(body);
    const { message, sessionId } = validated;

    // Get or create session
    let session: AgentSession | null = null;

    if (sessionId) {
      // Resume existing session
      session = await getAgentSession(user.userId, sessionId);
      if (!session) {
        return errorResponse('NOT_FOUND', 'Session not found', 404);
      }
    } else {
      // Check for recent session
      const latestSession = await getLatestSession(user.userId);
      if (latestSession && latestSession.missingFields.length > 0) {
        // Resume incomplete session
        session = latestSession;
      }
    }

    if (!session) {
      // Create new session - detect intent first
      const detected = await detectIntent(message);

      session = {
        sessionId: uuidv4(),
        userId: user.userId,
        role: detected.role,
        intent: detected.intent,
        collectedFields: detected.extractedFields,
        missingFields: [],
        askedFields: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        conversationHistory: [{
          timestamp: new Date().toISOString(),
          userMessage: message,
          agentResponse: '', // Will fill after generating response
        }],
      };

      // Update session with initial fields
      session = updateSessionFields(session, detected.extractedFields);
    } else {
      // Extract fields from message based on missing fields
      const extracted = await extractFields(message, session.missingFields);

      // Update session with newly extracted fields
      session = updateSessionFields(session, extracted.extractedFields);

      // Add to conversation history
      if (!session.conversationHistory) {
        session.conversationHistory = [];
      }
      session.conversationHistory.push({
        timestamp: new Date().toISOString(),
        userMessage: message,
        agentResponse: '', // Will fill after generating response
      });
    }

    // Determine next question
    const nextQuestion = determineNextQuestion(session);
    
    // Mark field as asked if we're about to ask it
    if (nextQuestion && !session.askedFields.includes(nextQuestion.field)) {
      session.askedFields.push(nextQuestion.field);
      session.lastQuestion = nextQuestion.prompt;
    }

    // Generate conversational response
    const agentMessage = await generateResponse(session, nextQuestion);

    // Update conversation history with agent response
    if (session.conversationHistory && session.conversationHistory.length > 0) {
      session.conversationHistory[session.conversationHistory.length - 1].agentResponse = agentMessage;
    }

    // Generate summary card
    const summaryCard = generateSummaryCard(session);

    // Save session
    await saveAgentSession(session);

    // Emit event
    await saveEvent({
      eventId: `EVENT#${new Date().toISOString()}#${session.sessionId}`,
      userId: user.userId,
      entityType: 'PROFILE', // Using existing enum
      entityId: session.sessionId,
      eventType: 'agent.session_updated',
      payload: {
        sessionId: session.sessionId,
        intent: session.intent,
        progress: summaryCard.progress,
      },
      createdAt: new Date().toISOString(),
    });

    // Build response
    const response: AgentMessageResponse = {
      sessionId: session.sessionId,
      role: session.role,
      intent: session.intent,
      message: agentMessage,
      proposedFields: session.collectedFields,
      missingFields: session.missingFields,
      nextQuestion: nextQuestion || undefined,
      summaryCard,
      isComplete: session.missingFields.length === 0,
    };

    return successResponse(response);
  } catch (error: any) {
    console.error('Error in agent message handler:', error);
    
    if (error.name === 'ZodError') {
      return errorResponse('VALIDATION_ERROR', formatZodError(error), 400);
    }
    
    return errorResponse('INTERNAL_ERROR', 'Failed to process message', 500, error.message);
  }
}

// ============================================
// POST /v1/agent/confirm - Finalize and Create Entity
// ============================================

export async function postAgentConfirm(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    const user = extractUserContext(event);
    if (!user) {
      return errorResponse('UNAUTHORIZED', 'User context not found', 401);
    }

    const body = parseBody<any>(event);
    if (!body) {
      return errorResponse('BAD_REQUEST', 'Invalid request body', 400);
    }

    // Validate input
    const validated = AgentConfirmRequestSchema.parse(body);
    const { sessionId, finalEdits } = validated;

    // Get session
    const session = await getAgentSession(user.userId, sessionId);
    if (!session) {
      return errorResponse('NOT_FOUND', 'Session not found', 404);
    }

    // Apply final edits
    if (finalEdits) {
      session.collectedFields = { ...session.collectedFields, ...finalEdits };
    }

    // Check if all required fields are present
    if (session.missingFields.length > 0) {
      return errorResponse(
        'INCOMPLETE_DATA',
        `Missing required fields: ${session.missingFields.join(', ')}`,
        400
      );
    }

    let response: AgentConfirmResponse;

    // Create appropriate entity based on intent
    if (session.intent === 'create_listing') {
      // Create listing
      const listingId = `LISTING#${Date.now()}-${user.userId.substring(0, 8)}`;
      const timestamp = new Date().toISOString();

      const listing: Listing = {
        listingId,
        donorId: user.userId,
        category: session.collectedFields.category || 'other',
        description: session.collectedFields.description || '',
        quantity: session.collectedFields.quantity || 0,
        unit: session.collectedFields.unit || 'items',
        pickupWindowStart: session.collectedFields.pickupWindowStart || '',
        pickupWindowEnd: session.collectedFields.pickupWindowEnd || '',
        urgency: session.collectedFields.urgency || 'MEDIUM',
        storageConstraint: session.collectedFields.storageConstraint,
        pickupBy: session.collectedFields.pickupBy || 'receiver',
        status: 'POSTED', // Go straight to POSTED since agent validated everything
        createdAt: timestamp,
        updatedAt: timestamp,
        confirmedAt: timestamp,
      };

      // Save listing
      await saveListing(listing);

      // Update session with draft ID
      session.draftListingId = listingId;
      await saveAgentSession(session);

      // Emit event
      await saveEvent({
        eventId: `EVENT#${timestamp}#${listingId}`,
        userId: user.userId,
        entityType: 'LISTING',
        entityId: listingId,
        eventType: 'listing.posted',
        payload: {
          listingId,
          category: listing.category,
          urgency: listing.urgency,
          source: 'agent',
        },
        createdAt: timestamp,
      });

      response = {
        entityId: listingId,
        entityType: 'listing',
        status: 'POSTED',
        summary: `${listing.quantity} ${listing.unit} of ${listing.category} posted successfully`,
      };
    } else if (session.intent === 'create_request') {
      // Create receiver request (simplified for MVP)
      const requestId = `REQUEST#${Date.now()}-${user.userId.substring(0, 8)}`;
      const timestamp = new Date().toISOString();

      // For MVP, just emit event - full request implementation can come later
      await saveEvent({
        eventId: `EVENT#${timestamp}#${requestId}`,
        userId: user.userId,
        entityType: 'REQUEST',
        entityId: requestId,
        eventType: 'request.created',
        payload: {
          requestId,
          category: session.collectedFields.category,
          quantity: session.collectedFields.quantity,
          source: 'agent',
        },
        createdAt: timestamp,
      });

      response = {
        entityId: requestId,
        entityType: 'request',
        status: 'ACTIVE',
        summary: `Request for ${session.collectedFields.quantity} ${session.collectedFields.unit} of ${session.collectedFields.category} created`,
      };
    } else if (session.intent === 'accept_match') {
      // Accept a suggested match
      const matchId = session.collectedFields.matchId;
      
      if (!matchId) {
        return errorResponse('MISSING_MATCH_ID', 'Match ID required to accept', 400);
      }
      
      // Call the match acceptance endpoint
      const TABLE_NAME = process.env.TABLE_NAME!;
      const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
      const { KeyPatterns } = require('../shared/types');
      const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
      
      const dynamodb = new DynamoDBClient({});
      
      try {
        // Get match
        const matchKey = KeyPatterns.match(matchId);
        const matchResponse = await dynamodb.send(
          new GetItemCommand({
            TableName: TABLE_NAME,
            Key: marshall(matchKey),
          })
        );
        
        if (!matchResponse.Item) {
          return errorResponse('NOT_FOUND', 'Match not found', 404);
        }
        
        const match = unmarshall(matchResponse.Item);
        
        if (match.receiverId !== user.userId) {
          return errorResponse('FORBIDDEN', 'Not your match', 403);
        }
        
        if (match.status !== 'SUGGESTED') {
          return errorResponse('CONFLICT', `Match already ${match.status.toLowerCase()}`, 409);
        }
        
        // Update match status
        const acceptedAt = new Date().toISOString();
        await dynamodb.send(
          new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: marshall(matchKey),
            UpdateExpression: 'SET #status = :accepted, acceptedAt = :acceptedAt',
            ConditionExpression: '#status = :suggested',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: marshall({
              ':accepted': 'ACCEPTED',
              ':suggested': 'SUGGESTED',
              ':acceptedAt': acceptedAt,
            }),
          })
        );
        
        response = {
          entityId: matchId,
          entityType: 'listing',
          status: 'ACCEPTED',
          summary: 'Match accepted successfully! Check the map for pickup details.',
        };
      } catch (error: any) {
        if (error.name === 'ConditionalCheckFailedException') {
          return errorResponse('CONFLICT', 'Match already accepted by someone else', 409);
        }
        throw error;
      }
    } else if (session.intent === 'cancel_listing') {
      // Cancel a donor listing
      const listingId = session.collectedFields.listingId;
      const reason = session.collectedFields.reason || 'User requested cancellation';
      
      if (!listingId) {
        return errorResponse('MISSING_LISTING_ID', 'Listing ID required to cancel', 400);
      }
      
      const TABLE_NAME = process.env.TABLE_NAME!;
      const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
      const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
      
      const dynamodb = new DynamoDBClient({});
      
      try {
        // Get listing
        const listingResponse = await dynamodb.send(
          new GetItemCommand({
            TableName: TABLE_NAME,
            Key: marshall({ pk: listingId, sk: 'META' }),
          })
        );
        
        if (!listingResponse.Item) {
          return errorResponse('NOT_FOUND', 'Listing not found', 404);
        }
        
        const listing = unmarshall(listingResponse.Item);
        
        if (listing.donorId !== user.userId) {
          return errorResponse('FORBIDDEN', 'Not your listing', 403);
        }
        
        // Update listing status
        await dynamodb.send(
          new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: marshall({ pk: listingId, sk: 'META' }),
            UpdateExpression: 'SET #status = :cancelled, cancellationReason = :reason, updatedAt = :now',
            ExpressionAttributeNames: { '#status': 'status' },
            ExpressionAttributeValues: marshall({
              ':cancelled': 'CANCELLED',
              ':reason': reason,
              ':now': new Date().toISOString(),
            }),
          })
        );
        
        response = {
          entityId: listingId,
          entityType: 'listing',
          status: 'CANCELLED',
          summary: `Listing cancelled: ${reason}`,
        };
      } catch (error: any) {
        console.error('Failed to cancel listing:', error);
        return errorResponse('INTERNAL_ERROR', 'Failed to cancel listing', 500, error.message);
      }
    } else if (session.intent === 'browse_deals') {
      // Query was completed through conversation
      response = {
        entityId: sessionId,
        entityType: 'query',
        status: 'COMPLETED',
        summary: 'Browse deals query completed - check /v1/deals endpoint',
      };
    } else {
      return errorResponse(
        'UNSUPPORTED_INTENT',
        `Cannot confirm intent: ${session.intent}`,
        400
      );
    }

    return successResponse(response);
  } catch (error: any) {
    console.error('Error in agent confirm handler:', error);
    
    if (error.name === 'ZodError') {
      return errorResponse('VALIDATION_ERROR', formatZodError(error), 400);
    }
    
    return errorResponse('INTERNAL_ERROR', 'Failed to confirm', 500, error.message);
  }
}
