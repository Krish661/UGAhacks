import { Handler } from 'aws-lambda';
import { matchRepository } from '../integrations/dynamodb';
import { auditService } from '../integrations/audit';
import { eventService } from '../integrations/events';
import { createLogger } from '../shared/logger';

const logger = createLogger('ComplianceCheckOrchestration');

export const handler: Handler = async (event) => {
  logger.info('Compliance check started', { event });

  const { matches } = event;

  if (!matches || !Array.isArray(matches)) {
    logger.warn('No matches to check compliance', { event });
    return event;
  }

  try {
    const results: any[] = [];

    for (const match of matches) {
      // Publish compliance event
      if (match.complianceStatus === 'blocked') {
        await eventService.publish({
          type: 'compliance.blocked',
          entityType: 'match',
          entityId: match.id,
          timestamp: new Date().toISOString(),
          data: {
            matchId: match.id,
            checks: match.complianceChecks,
            blockedReasons: match.complianceChecks?.filter((c: any) => !c.passed).map((c: any) => c.message),
          },
        });
      } else {
        await eventService.publish({
          type: 'match.proposed',
          entityType: 'match',
          entityId: match.id,
          timestamp: new Date().toISOString(),
          data: {
            matchId: match.id,
            listingId: match.listingId,
            demandId: match.demandId,
            score: match.score,
          },
        });
      }

      results.push({
        matchId: match.id,
        complianceStatus: match.complianceStatus,
      });
    }

    logger.info('Compliance check completed', { results });

    return {
      ...event,
      complianceResults: results,
    };
  } catch (error) {
    logger.error('Compliance check failed', error as Error, { event });
    return {
      ...event,
      complianceError: (error as Error).message,
    };
  }
};
