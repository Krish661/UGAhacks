import { Handler } from 'aws-lambda';
import { geminiService } from '../integrations/gemini';
import { listingRepository } from '../integrations/dynamodb';
import { auditService } from '../integrations/audit';
import { createLogger } from '../shared/logger';

const logger = createLogger('EnrichmentOrchestration');

export const handler: Handler = async (event) => {
  logger.info('Enrichment started', { event });

  const { type, listingId, listing } = event;

  if (type !== 'listing' || !listingId) {
    logger.warn('Invalid input for enrichment', { event });
    return event; // Pass through
  }

  try {
    const currentListing = listing || await listingRepository.get(listingId);

    if (!currentListing) {
      throw new Error(`Listing ${listingId} not found`);
    }

    // Enrich with Gemini
    const enrichment = await geminiService.enrichListing({
      title: currentListing.title,
      description: currentListing.description,
      category: currentListing.category,
      qualityNotes: currentListing.qualityNotes,
    });

    // Update listing with enrichment
    await listingRepository.updateFields(listingId, {
      enrichmentStatus: enrichment.status,
      aiRiskScore: enrichment.riskScore,
      aiFlags: enrichment.riskFlags,
      handlingRequirements: [
        ...(currentListing.handlingRequirements || []),
        ...(enrichment.handlingRequirements || []),
      ],
    } as any, currentListing.version);

    await auditService.writeEvent({
      entityType: 'LISTING',
      entityId: listingId,
      action: 'update',
      actor: 'system',
      actorRole: 'system',
      requestId: 'enrichment-orchestration',
      metadata: { enrichment },
    });

    logger.info('Enrichment completed', { listingId, enrichment });

    return {
      ...event,
      enrichment,
      listing: {
        ...currentListing,
        enrichmentStatus: enrichment.status,
        aiRiskScore: enrichment.riskScore,
        aiFlags: enrichment.riskFlags,
      },
    };
  } catch (error) {
    logger.error('Enrichment failed', error as Error, { listingId });
    return {
      ...event,
      enrichmentError: (error as Error).message,
    };
  }
};
