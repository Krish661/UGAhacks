import { Handler } from 'aws-lambda';
import { notificationService } from '../integrations/notifications';
import { listingRepository, demandRepository } from '../integrations/dynamodb';
import { createLogger } from '../shared/logger';

const logger = createLogger('NotificationOrchestration');

export const handler: Handler = async (event) => {
  logger.info('Notification started', { event });

  const { matches } = event;

  if (!matches || !Array.isArray(matches)) {
    logger.warn('No matches to notify', { event });
    return event;
  }

  try {
    for (const match of matches) {
      // Get listing and demand to get user IDs
      const [listing, demand] = await Promise.all([
        listingRepository.get(match.listingId),
        demandRepository.get(match.demandId),
      ]);

      if (!listing || !demand) {
        logger.warn('Listing or demand not found for match', { matchId: match.id });
        continue;
      }

      // Notify supplier
      await notificationService.send({
        userId: (listing as any).supplierId,
        type: 'match_proposed',
        title: 'New Match Found',
        message: `Your listing "${(listing as any).title}" has been matched with a recipient. Match score: ${match.score}`,
        entityType: 'match',
        entityId: match.id,
      });

      // Notify recipient
      await notificationService.send({
        userId: (demand as any).recipientId,
        type: 'match_proposed',
        title: 'New Match Found',
        message: `A supplier has items matching your need "${(demand as any).title}". Match score: ${match.score}`,
        entityType: 'match',
        entityId: match.id,
      });

      // If compliance blocked, notify compliance team
      if (match.complianceStatus === 'blocked') {
        // In production, would notify compliance@swarmaid.org or compliance user pool
        logger.info('Compliance blocked notification needed', { matchId: match.id });
      }
    }

    logger.info('Notifications sent', { matchCount: matches.length });

    return {
      ...event,
      notificationsSent: matches.length * 2,
    };
  } catch (error) {
    logger.error('Notification failed', error as Error, { event });
    return {
      ...event,
      notificationError: (error as Error).message,
    };
  }
};
