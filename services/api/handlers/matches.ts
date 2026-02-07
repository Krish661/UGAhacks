import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { wrapHandler, HandlerContext, successResponse, parseBody, getPathParam, getQueryParam, requireRole, canAccessResource } from '../helpers';
import { scheduleMatchRequestSchema } from '../../shared/schemas';
import { matchRepository, listingRepository, demandRepository, taskRepository, userRepository } from '../../integrations/dynamodb';
import { matchingEngine } from '../../domain/matching-engine';
import { complianceEngine } from '../../domain/compliance-engine';
import { locationService } from '../../integrations/location';
import { auditService } from '../../integrations/audit';
import { eventService } from '../../integrations/events';
import { ulid } from 'ulid';
import * as geo from '../../domain/geohash';
import { config } from '../../shared/config';

export const handler = wrapHandler(async (context: HandlerContext): Promise<APIGatewayProxyResultV2> => {
  const { event } = context;
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  if (method === 'POST' && path === '/v1/matches/recommendations') {
    return handleRecommendations(context);
  }

  if (method === 'GET' && path === '/v1/matches') {
    return handleList(context);
  }

  if (method === 'GET' && path.match(/^\/v1\/matches\/.+$/)) {
    return handleGet(context);
  }

  if (method === 'POST' && path.match(/^\/v1\/matches\/.+\/accept$/)) {
    return handleAccept(context);
  }

  if (method === 'POST' && path.match(/^\/v1\/matches\/.+\/reject$/)) {
    return handleReject(context);
  }

  if (method === 'POST' && path.match(/^\/v1\/matches\/.+\/schedule$/)) {
    return handleSchedule(context);
  }

  return successResponse({ error: 'Not found' }, 404);
});

async function handleRecommendations(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  requireRole(context, 'operator', 'admin', 'system');

  const { listingId, demandId } = parseBody(context.event, require('zod').z.object({
    listingId: require('zod').z.string().optional(),
    demandId: require('zod').z.string().optional(),
  }));

  // Find candidates
  let listings: any[] = [];
  let demands: any[] = [];

  if (listingId) {
    const listing = await listingRepository.getOrThrow(listingId);
    listings = [listing];
    // Find nearby demands
    if ((listing as any).geohash) {
      const prefixes = geo.getPrefixesForRadius((listing as any).pickupCoordinates, config.matching.maxRadius);
      for (const prefix of prefixes) {
        const nearbyDemands = await demandRepository.queryByGeo(prefix.substring(0, 4), 50);
        demands.push(...nearbyDemands);
      }
    }
  } else if (demandId) {
    const demand = await demandRepository.getOrThrow(demandId);
    demands = [demand];
    // Find nearby listings
    if ((demand as any).geohash) {
      const prefixes = geo.getPrefixesForRadius((demand as any).deliveryCoordinates, config.matching.maxRadius);
      for (const prefix of prefixes) {
        const nearbyListings = await listingRepository.queryByGeo(prefix.substring(0, 4), 50);
        listings.push(...nearbyListings);
      }
    }
  } else {
    // Background matching - get all open listings and demands
    listings = await listingRepository.queryByStatus('posted', 100);
    demands = await demandRepository.queryByStatus('posted', 100);
  }

  // Filter and score candidates
  const candidates = matchingEngine.filterCandidates(listings, demands, { requireCoordinates: true });
  const scored = matchingEngine.scoreAndRank(candidates);

  // Run compliance checks and create recommendations
  const recommendations: any[] = [];

  for (const match of scored) {
    const compliance = await complianceEngine.evaluate(match.listing, match.demand, match);
    
    const recommendation = {
      id: ulid(),
      listingId: match.listing.id,
      demandId: match.demand.id,
      score: match.score,
      scoreBreakdown: match.scoreBreakdown,
      distanceMiles: match.distanceMiles,
      status: 'pending' as const,
      complianceStatus: compliance.passed ? ('passed' as const) : ('blocked' as const),
      complianceChecks: compliance.checks,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await matchRepository.put(recommendation);
    recommendations.push(recommendation);

    await eventService.publish({
      type: 'match.proposed',
      entityType: 'match',
      entityId: recommendation.id,
      timestamp: new Date().toISOString(),
      data: { matchId: recommendation.id, listingId: match.listing.id, demandId: match.demand.id, score: match.score },
    });
  }

  return successResponse({ recommendations, count: recommendations.length });
}

async function handleList(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  const status = getQueryParam(context.event, 'status');
  const listingId = getQueryParam(context.event, 'listingId');
  const demandId = getQueryParam(context.event, 'demandId');

  let matches: any[] = [];

  if (status) {
    matches = await matchRepository.queryByStatus(status);
  } else if (listingId) {
    const listing = await listingRepository.getOrThrow(listingId);
    if (!canAccessResource(context, (listing as any).supplierId, ['operator', 'admin'])) {
      return successResponse({ error: 'Forbidden' }, 403);
    }
    // Query matches with this listingId (would need additional GSI in production)
    matches = await matchRepository.queryByStatus('pending', 100);
    matches = matches.filter((m: any) => m.listingId === listingId);
  } else if (demandId) {
    const demand = await demandRepository.getOrThrow(demandId);
    if (!canAccessResource(context, (demand as any).recipientId, ['operator', 'admin'])) {
      return successResponse({ error: 'Forbidden' }, 403);
    }
    matches = await matchRepository.queryByStatus('pending', 100);
    matches = matches.filter((m: any) => m.demandId === demandId);
  } else {
    requireRole(context, 'operator', 'admin');
    matches = await matchRepository.queryByStatus('pending');
  }

  return successResponse({ matches });
}

async function handleGet(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  const id = getPathParam(context.event, 'id');
  const match = await matchRepository.getOrThrow(id);

  return successResponse({ match });
}

async function handleAccept(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  const id = getPathParam(context.event, 'id');
  const match = await matchRepository.getOrThrow(id);

  // Check authorization - recipient accepts
  const demand = await demandRepository.getOrThrow((match as any).demandId);
  if (!canAccessResource(context, (demand as any).recipientId, ['operator', 'admin'])) {
    return successResponse({ error: 'Forbidden' }, 403);
  }

  const before = { ...match };
  const updated = await matchRepository.updateFields(
    id,
    { status: 'accepted', acceptedAt: new Date().toISOString() } as any,
    (match as any).version
  );

  await auditService.writeEvent({
    entityType: 'MATCH',
    entityId: id,
    action: 'state_transition',
    actor: context.userId,
    actorRole: context.roles.join(','),
    requestId: context.requestId,
    before,
    after: updated,
  });

  await eventService.publish({
    type: 'match.accepted',
    entityType: 'match',
    entityId: id,
    userId: context.userId,
    timestamp: new Date().toISOString(),
    data: { matchId: id },
  });

  return successResponse({ match: updated });
}

async function handleReject(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  const id = getPathParam(context.event, 'id');
  const match = await matchRepository.getOrThrow(id);

  const demand = await demandRepository.getOrThrow((match as any).demandId);
  if (!canAccessResource(context, (demand as any).recipientId, ['operator', 'admin'])) {
    return successResponse({ error: 'Forbidden' }, 403);
  }

  const { reason } = parseBody(context.event, require('zod').z.object({ reason: require('zod').z.string() }));

  const before = { ...match };
  const updated = await matchRepository.updateFields(
    id,
    { status: 'rejected', rejectedReason: reason } as any,
    (match as any).version
  );

  await auditService.writeEvent({
    entityType: 'MATCH',
    entityId: id,
    action: 'state_transition',
    actor: context.userId,
    actorRole: context.roles.join(','),
    requestId: context.requestId,
    before,
    after: updated,
    justification: reason,
  });

  await eventService.publish({
    type: 'match.rejected',
    entityType: 'match',
    entityId: id,
    userId: context.userId,
    timestamp: new Date().toISOString(),
    data: { matchId: id, reason },
  });

  return successResponse({ match: updated });
}

async function handleSchedule(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  requireRole(context, 'operator', 'admin');

  const id = getPathParam(context.event, 'id');
  const match = await matchRepository.getOrThrow(id);
  const input = parseBody(context.event, scheduleMatchRequestSchema);

  // Check idempotency
  const existingTasks = await taskRepository.queryByStatus('scheduled', 100);
  const duplicate = existingTasks.find((t: any) => t.matchId === id && t.idempotencyKey === input.idempotencyKey);
  if (duplicate) {
    return successResponse({ task: duplicate });
  }

  // Get listing and demand for route calculation
  const listing = await listingRepository.getOrThrow((match as any).listingId);
  const demand = await demandRepository.getOrThrow((match as any).demandId);

  // Calculate route
  const route = await locationService.calculateRoute(
    (listing as any).pickupCoordinates,
    (demand as any).deliveryCoordinates
  );

  // Create task
  const task = {
    id: ulid(),
    matchId: id,
    listingId: (match as any).listingId,
    demandId: (match as any).demandId,
    driverId: input.driverId,
    status: 'scheduled' as const,
    scheduledPickupTime: input.scheduledPickupTime,
    scheduledDeliveryTime: input.scheduledDeliveryTime,
    idempotencyKey: input.idempotencyKey,
    routeDistance: route.distanceMiles,
    routeDuration: route.durationMinutes,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await taskRepository.put(task);

  // Update match status
  await matchRepository.updateFields(id, { status: 'scheduled' } as any, (match as any).version);

  await auditService.writeEvent({
    entityType: 'TASK',
    entityId: task.id,
    action: 'create',
    actor: context.userId,
    actorRole: context.roles.join(','),
    requestId: context.requestId,
    after: task,
  });

  await eventService.publish({
    type: 'match.scheduled',
    entityType: 'task',
    entityId: task.id,
    userId: context.userId,
    timestamp: new Date().toISOString(),
    data: { taskId: task.id, matchId: id, driverId: input.driverId },
  });

  return successResponse({ task }, 201);
}
