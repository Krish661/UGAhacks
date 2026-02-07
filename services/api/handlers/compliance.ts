import { APIGatewayProxyResultV2 } from 'aws-lambda';
import { wrapHandler, HandlerContext, successResponse, requireRole, getQueryParam, parseBody, getPathParam } from '../helpers';
import { matchRepository, complianceCheckRepository } from '../../integrations/dynamodb';
import { auditService } from '../../integrations/audit';
import { eventService } from '../../integrations/events';
import { ulid } from 'ulid';

export const handler = wrapHandler(async (context: HandlerContext): Promise<APIGatewayProxyResultV2> => {
  requireRole(context, 'compliance', 'operator', 'admin');

  const { event } = context;
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  if (method === 'GET' && path === '/v1/compliance/queue') {
    const matches = await matchRepository.queryByStatus('pending', 100);
    const blocked = matches.filter((m: any) => m.complianceStatus === 'blocked');
    return successResponse({ queue: blocked, count: blocked.length });
  }

  if (method === 'POST' && path.match(/^\/v1\/compliance\/.+\/approve$/)) {
    const matchId = getPathParam(context.event, 'matchId');
    const match = await matchRepository.getOrThrow(matchId);
    const { justification } = parseBody(context.event, require('zod').z.object({ justification: require('zod').z.string() }));

    const before = { ...match };
    const updated = await matchRepository.updateFields(matchId, { complianceStatus: 'passed' } as any, (match as any).version);

    await auditService.writeEvent({
      entityType: 'MATCH',
      entityId: matchId,
      action: 'compliance_decision',
      actor: context.userId,
      actorRole: context.roles.join(','),
      requestId: context.requestId,
      before,
      after: updated,
      justification,
    });

    await eventService.publish({
      type: 'compliance.approved',
      entityType: 'match',
      entityId: matchId,
      userId: context.userId,
      timestamp: new Date().toISOString(),
      data: { matchId, justification },
    });

    return successResponse({ match: updated });
  }

  if (method === 'POST' && path.match(/^\/v1\/compliance\/.+\/block$/)) {
    const matchId = getPathParam(context.event, 'matchId');
    const match = await matchRepository.getOrThrow(matchId);
    const { reason } = parseBody(context.event, require('zod').z.object({ reason: require('zod').z.string() }));

    const before = { ...match };
    const updated = await matchRepository.updateFields(matchId, { status: 'compliance_blocked', complianceStatus: 'blocked' } as any, (match as any).version);

    await auditService.writeEvent({
      entityType: 'MATCH',
      entityId: matchId,
      action: 'compliance_decision',
      actor: context.userId,
      actorRole: context.roles.join(','),
      requestId: context.requestId,
      before,
      after: updated,
      justification: reason,
    });

    await eventService.publish({
      type: 'compliance.blocked',
      entityType: 'match',
      entityId: matchId,
      userId: context.userId,
      timestamp: new Date().toISOString(),
      data: { matchId, reason },
    });

    return successResponse({ match: updated });
  }

  return successResponse({ error: 'Not found' }, 404);
});
