import { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  wrapHandler,
  HandlerContext,
  successResponse,
  parseBody,
  getPathParam,
  getQueryParam,
  requireRole,
  canAccessResource,
} from '../helpers';
import { createSupplyRequestSchema, updateStatusRequestSchema } from '../../shared/schemas';
import { listingRepository } from '../../integrations/dynamodb';
import { auditService } from '../../integrations/audit';
import { eventService } from '../../integrations/events';
import { locationService } from '../../integrations/location';
import * as geo from '../../domain/geohash';
import { stateMachine } from '../../domain/state-machine';
import { ulid } from 'ulid';
import { NotFoundError } from '../../shared/errors';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { config } from '../../shared/config';

const sfnClient = new SFNClient({ region: config.aws.region });

export const handler = wrapHandler(async (context: HandlerContext): Promise<APIGatewayProxyResultV2> => {
  const { event } = context;
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  // POST /v1/supply - Create listing
  if (method === 'POST' && path === '/v1/supply') {
    return handleCreate(context);
  }

  // GET /v1/supply - List listings
  if (method === 'GET' && path === '/v1/supply') {
    return handleList(context);
  }

  // GET /v1/supply/{id} - Get listing
  if (method === 'GET' && path.match(/^\/v1\/supply\/.+$/)) {
    return handleGet(context);
  }

  // PUT /v1/supply/{id} - Update listing
  if (method === 'PUT' && path.match(/^\/v1\/supply\/[^\/]+$/)) {
    return handleUpdate(context);
  }

  // POST /v1/supply/{id}/cancel - Cancel listing
  if (method === 'POST' && path.match(/^\/v1\/supply\/.+\/cancel$/)) {
    return handleCancel(context);
  }

  return successResponse({ error: 'Not found' }, 404);
});

async function handleCreate(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  requireRole(context, 'supplier', 'operator');

  const input = parseBody(context.event, createSupplyRequestSchema);

  // Geocode pickup address
  const geocodeResult = await locationService.geocode(input.pickupAddress);

  const now = new Date().toISOString();
  const listing = {
    id: ulid(),
    supplierId: context.userId,
    supplierName: input.supplierName,
    ...input,
    pickupCoordinates: geocodeResult.coordinates,
    geohash: geo.encode(geocodeResult.coordinates, 6),
    status: 'posted' as const,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  await listingRepository.put(listing);

  // Audit
  await auditService.writeEvent({
    entityType: 'LISTING',
    entityId: listing.id,
    action: 'create',
    actor: context.userId,
    actorRole: context.roles.join(','),
    requestId: context.requestId,
    after: listing,
  });

  // Event
  await eventService.publish({
    type: 'listing.created',
    entityType: 'listing',
    entityId: listing.id,
    userId: context.userId,
    timestamp: now,
    data: { listingId: listing.id, status: listing.status },
  });

  // Trigger orchestration
  if (config.stepFunctions.stateMachineArn) {
    try {
      await sfnClient.send(
        new StartExecutionCommand({
          stateMachineArn: config.stepFunctions.stateMachineArn,
          input: JSON.stringify({
            type: 'listing',
            listingId: listing.id,
            listing,
          }),
        })
      );
    } catch (error) {
      // Don't fail the request if orchestration fails to start
      console.error('Failed to start orchestration', error);
    }
  }

  return successResponse(listing, 201);
}

async function handleList(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  const status = getQueryParam(context.event, 'status');
  const userId = getQueryParam(context.event, 'userId');

  let listings;

  if (userId) {
    // List by user - check authorization
    if (!canAccessResource(context, userId, ['operator', 'admin'])) {
      // Not authorized to view other user's listings
      return successResponse({ error: 'Forbidden' }, 403);
    }
    listings = await listingRepository.queryByUser(userId);
  } else if (status) {
    requireRole(context, 'operator', 'admin');
    listings = await listingRepository.queryByStatus(status);
  } else {
    // Own listings
    listings = await listingRepository.queryByUser(context.userId);
  }

  return successResponse({ listings });
}

async function handleGet(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  const id = getPathParam(context.event, 'id');
  const listing = await listingRepository.getOrThrow(id);

  // Check authorization
  if (!canAccessResource(context, (listing as any).supplierId, ['operator', 'admin', 'driver', 'recipient'])) {
    return successResponse({ error: 'Forbidden' }, 403);
  }

  return successResponse({ listing });
}

async function handleUpdate(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  const id = getPathParam(context.event, 'id');
  const listing = await listingRepository.getOrThrow(id);

  // Check authorization
  if (!canAccessResource(context, (listing as any).supplierId, ['operator', 'admin'])) {
    return successResponse({ error: 'Forbidden' }, 403);
  }

  const updates = parseBody(context.event, createSupplyRequestSchema.partial());

  // Re-geocode if address changed
  let pickupCoordinates = (listing as any).pickupCoordinates;
  let geohash = (listing as any).geohash;

  if (updates.pickupAddress) {
    const geocodeResult = await locationService.geocode(updates.pickupAddress);
    pickupCoordinates = geocodeResult.coordinates;
    geohash = geo.encode(geocodeResult.coordinates, 6);
  }

  const before = { ...listing };
  const updated = await listingRepository.updateFields(
    id,
    {
      ...updates,
      ...(pickupCoordinates && { pickupCoordinates }),
      ...(geohash && { geohash }),
    } as any,
    (listing as any).version
  );

  // Audit
  await auditService.writeEvent({
    entityType: 'LISTING',
    entityId: id,
    action: 'update',
    actor: context.userId,
    actorRole: context.roles.join(','),
    requestId: context.requestId,
    before,
    after: updated,
  });

  // Event
  await eventService.publish({
    type: 'listing.updated',
    entityType: 'listing',
    entityId: id,
    userId: context.userId,
    timestamp: new Date().toISOString(),
    data: { listingId: id },
  });

  return successResponse({ listing: updated });
}

async function handleCancel(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  const id = getPathParam(context.event, 'id');
  const listing = await listingRepository.getOrThrow(id);

  // Check authorization
  if (!canAccessResource(context, (listing as any).supplierId, ['operator', 'admin'])) {
    return successResponse({ error: 'Forbidden' }, 403);
  }

  const input = parseBody(context.event, updateStatusRequestSchema);

  // Validate state transition
  const currentRole = context.roles.includes('operator') || context.roles.includes('admin') ? 'operator' : 'supplier';
  await stateMachine.transition((listing as any).status, 'canceled', currentRole, {
    justification: input.reason,
  });

  const before = { ...listing };
  const updated = await listingRepository.updateFields(
    id,
    {
      status: 'canceled',
      cancellationReason: input.reason,
    } as any,
    (listing as any).version
  );

  // Audit
  await auditService.writeEvent({
    entityType: 'LISTING',
    entityId: id,
    action: 'state_transition',
    actor: context.userId,
    actorRole: context.roles.join(','),
    requestId: context.requestId,
    before,
    after: updated,
    justification: input.reason,
  });

  // Event
  await eventService.publish({
    type: 'listing.canceled',
    entityType: 'listing',
    entityId: id,
    userId: context.userId,
    timestamp: new Date().toISOString(),
    data: { listingId: id, reason: input.reason },
  });

  return successResponse({ listing: updated });
}
