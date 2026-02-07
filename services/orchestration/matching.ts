import { Handler } from 'aws-lambda';
import { listingRepository, demandRepository, matchRepository, routePlanRepository, userRepository } from '../integrations/dynamodb';
import { matchingEngine } from '../domain/matching-engine';
import { complianceEngine } from '../domain/compliance-engine';
import { locationService } from '../integrations/location';
import { auditService } from '../integrations/audit';
import { createLogger } from '../shared/logger';
import { ulid } from 'ulid';
import * as geo from '../domain/geohash';
import { config } from '../shared/config';

const logger = createLogger('MatchingOrchestration');

export const handler: Handler = async (event) => {
  logger.info('Matching started', { event });

  const { type, listingId, demandId, listing, demand } = event;

  try {
    let listings: any[] = [];
    let demands: any[] = [];

    if (type === 'listing' && listingId) {
      const currentListing = listing || await listingRepository.get(listingId);
      if (!currentListing) throw new Error(`Listing ${listingId} not found`);
      
      listings = [currentListing];

      // Find nearby demands
      if (currentListing.geohash) {
        const prefixes = geo.getPrefixesForRadius(currentListing.pickupCoordinates, config.matching.maxRadius);
        for (const prefix of prefixes.slice(0, 3)) { // Limit to 3 prefixes
          const nearby = await demandRepository.queryByGeo(prefix.substring(0, 4), 50);
          demands.push(...nearby.filter((d: any) => d.status === 'posted'));
        }
      }
    } else if (type === 'demand' && demandId) {
      const currentDemand = demand || await demandRepository.get(demandId);
      if (!currentDemand) throw new Error(`Demand ${demandId} not found`);
      
      demands = [currentDemand];

      // Find nearby listings
      if (currentDemand.geohash) {
        const prefixes = geo.getPrefixesForRadius(currentDemand.deliveryCoordinates, config.matching.maxRadius);
        for (const prefix of prefixes.slice(0, 3)) {
          const nearby = await listingRepository.queryByGeo(prefix.substring(0, 4), 50);
          listings.push(...nearby.filter((l: any) => l.status === 'posted'));
        }
      }
    } else {
      logger.warn('Invalid input for matching', { event });
      return event;
    }

    // Remove duplicates
    demands = Array.from(new Map(demands.map((d: any) => [d.id, d])).values());
    listings = Array.from(new Map(listings.map((l: any) => [l.id, l])).values());

    logger.info('Candidates found', { listings: listings.length, demands: demands.length });

    // Filter and score
    const candidates = matchingEngine.filterCandidates(listings, demands, { requireCoordinates: true });
    const scored = matchingEngine.scoreAndRank(candidates);

    const matches: any[] = [];

    for (const match of scored) {
      // Run compliance
      const compliance = await complianceEngine.evaluate(match.listing, match.demand, match);

      // Calculate route
      const route = await locationService.calculateRoute(
        match.listing.pickupCoordinates,
        match.demand.deliveryCoordinates
      );

      // Save route plan
      const routePlan = {
        id: ulid(),
        matchId: '', // Will be set after match is created
        pickupCoordinates: match.listing.pickupCoordinates,
        deliveryCoordinates: match.demand.deliveryCoordinates,
        distanceMiles: route.distanceMiles,
        durationMinutes: route.durationMinutes,
        polyline: route.polyline,
        provider: route.provider,
        providerStatus: route.providerStatus,
        metadata: route.metadata,
        createdAt: new Date().toISOString(),
      };

      // Create match recommendation
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
        routePlanId: routePlan.id,
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      routePlan.matchId = recommendation.id;

      await routePlanRepository.put(routePlan);
      await matchRepository.put(recommendation);

      await auditService.writeEvent({
        entityType: 'MATCH',
        entityId: recommendation.id,
        action: 'create',
        actor: 'system',
        actorRole: 'system',
        requestId: 'matching-orchestration',
        after: recommendation,
      });

      matches.push(recommendation);
    }

    logger.info('Matching completed', { matchesCreated: matches.length });

    return {
      ...event,
      matches,
      matchCount: matches.length,
    };
  } catch (error) {
    logger.error('Matching failed', error as Error, { event });
    return {
      ...event,
      matchingError: (error as Error).message,
    };
  }
};
