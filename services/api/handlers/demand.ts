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
import { createDemandRequestSchema, updateStatusRequestSchema } from '../../shared/schemas';
import { demandRepository } from '../../integrations/dynamodb';
import { auditService } from '../../integrations/audit';
import { eventService } from '../../integrations/events';
import { locationService } from '../../integrations/location';
import * as geo from '../../domain/geohash';
import { stateMachine } from '../../domain/state-machine';
import { ulid } from 'ulid';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { config } from '../../shared/config';

const sfnClient = new SFNClient({ region: config.aws.region });

export const handler = wrapHandler(async (context: HandlerContext): Promise<APIGatewayProxyResultV2> => {
  const { event } = context;
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  if (method === 'POST' && path === '/v1/demand') {
    return handleCreate(context);
  }

  if (method === 'GET' && path === '/v1/demand') {
    return handleList(context);
  }

  if (method === 'GET' && path.match(/^\/v1\/demand\/.+$/)) {
    return handleGet(context);
  }

  if (method === 'PUT' && path.match(/^\/v1\/demand\/[^\/]+$/)) {
    return handleUpdate(context);
  }

  if (method === 'POST' && path.match(/^\/v1\/demand\/.+\/close$/)) {
    return handleClose(context);
  }

  return successResponse({ error: 'Not found' }, 404);
});

async function handleCreate(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  requireRole(context, 'recipient', 'operator');

  const input = parseBody(context.event, createDemandRequestSchema);

  const geocodeResult = await locationService.geocode(input.deliveryAddress);

  const now = new Date().toISOString();
  const demand = {
    id: ulid(),
    recipientId: context.userId,
    ...input,
    deliveryCoordinates: geocodeResult.coordinates,
    geohash: geo.encode(geocodeResult.coordinates, 6),
    status: 'posted' as const,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  await demandRepository.put(demand);

  await auditService.writeEvent({
    entityType: 'DEMAND',
    entityId: demand.id,
    action: 'create',
    actor: context.userId,
    actorRole: context.roles.join(','),
    requestId: context.requestId,
    after: demand,
  });

  await eventService.publish({
    type: 'demand.created',
    entityType: 'demand',
    entityId: demand.id,
    userId: context.userId,
    timestamp: now,
    data: { demandId: demand.id, status: demand.status },
  });

  // Trigger orchestration
  if (config.stepFunctions.stateMachineArn) {
    try {
      await sfnClient.send(
        new StartExecutionCommand({
          stateMachineArn: config.stepFunctions.stateMachineArn,
          input: JSON.stringify({
            type: 'demand',
            demandId: demand.id,
            demand,
          }),
        })
      );
    } catch (error) {
      console.error('Failed to start orchestration', error);
    }
  }

  return successResponse(demand, 201);
}

async function handleList(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  const status = getQueryParam(context.event, 'status');
  const userId = getQueryParam(context.event, 'userId');

  let demands;

  if (userId) {
    if (!canAccessResource(context, userId, ['operator', 'admin'])) {
      return successResponse({ error: 'Forbidden' }, 403);
    }
    demands = await demandRepository.queryByUser(userId);
  } else if (status) {
    requireRole(context, 'operator', 'admin');
    demands = await demandRepository.queryByStatus(status);
  } else {
    demands = await demandRepository.queryByUser(context.userId);
  }

  return successResponse({ demands });
}

async function handleGet(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  const id = getPathParam(context.event, 'id');
  const demand = await demandRepository.getOrThrow(id);

  if (!canAccessResource(context, (demand as any).recipientId, ['operator', 'admin', 'driver', 'supplier'])) {
    return successResponse({ error: 'Forbidden' }, 403);
  }

  return successResponse({ demand });
}

async function handleUpdate(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  const id = getPathParam(context.event, 'id');
  const demand = await demandRepository.getOrThrow(id);

  if (!canAccessResource(context, (demand as any).recipientId, ['operator', 'admin'])) {
    return successResponse({ error: 'Forbidden' }, 403);
  }

  const updates = parseBody(context.event, createDemandRequestSchema.partial());

  let deliveryCoordinates = (demand as any).deliveryCoordinates;
  let geohash = (demand as any).geohash;

  if (updates.deliveryAddress) {
    const geocodeResult = await locationService.geocode(updates.deliveryAddress);
    deliveryCoordinates = geocodeResult.coordinates;
    geohash = geo.encode(geocodeResult.coordinates, 6);
  }

  const before = { ...demand };
  const updated = await demandRepository.updateFields(
    id,
    {
      ...updates,
      ...(deliveryCoordinates && { deliveryCoordinates }),
      ...(geohash && { geohash }),
    } as any,
    (demand as any).version
  );

  await auditService.writeEvent({
    entityType: 'DEMAND',
    entityId: id,
    action: 'update',
    actor: context.userId,
    actorRole: context.roles.join(','),
    requestId: context.requestId,
    before,
    after: updated,
  });

  await eventService.publish({
    type: 'demand.updated',
    entityType: 'demand',
    entityId: id,
    userId: context.userId,
    timestamp: new Date().toISOString(),
    data: { demandId: id },
  });

  return successResponse({ demand: updated });
}

async function handleClose(context: HandlerContext): Promise<APIGatewayProxyResultV2> {
  const id = getPathParam(context.event, 'id');
  const demand = await demandRepository.getOrThrow(id);

  if (!canAccessResource(context, (demand as any).recipientId, ['operator', 'admin'])) {
    return successResponse({ error: 'Forbidden' }, 403);
  }

  const input = parseBody(context.event, updateStatusRequestSchema);

  const currentRole = context.roles.includes('operator') || context.roles.includes('admin') ? 'operator' : 'recipient';
  await stateMachine.transition((demand as any).status, 'closed', currentRole, {
    justification: input.reason,
  });

  const before = { ...demand };
  const updated = await demandRepository.updateFields(
    id,
    {
      status: 'closed',
      closeReason: input.reason,
    } as any,
    (demand as any).version
  );

  await auditService.writeEvent({
    entityType: 'DEMAND',
    entityId: id,
    action: 'state_transition',
    actor: context.userId,
    actorRole: context.roles.join(','),
    requestId: context.requestId,
    before,
    after: updated,
    justification: input.reason,
  });

  await eventService.publish({
    type: 'demand.closed',
    entityType: 'demand',
    entityId: id,
    userId: context.userId,
    timestamp: new Date().toISOString(),
    data: { demandId: id, reason: input.reason },
  });

  return successResponse({ demand: updated });
}
