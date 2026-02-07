import { SurplusListing, DemandPost, MatchRecommendation, UserProfile } from '../shared/schemas';
import { config } from '../shared/config';
import { createLogger } from '../shared/logger';
import * as geo from './geohash';

const logger = createLogger('MatchingEngine');

interface MatchCandidate {
  listing: SurplusListing;
  demand: DemandPost;
  supplierProfile?: UserProfile;
  recipientProfile?: UserProfile;
}

interface ScoreBreakdown {
  distance: number;
  time: number;
  category: number;
  capacity: number;
  reliability: number;
}

interface ScoredMatch {
  listing: SurplusListing;
  demand: DemandPost;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  distanceMiles: number;
}

export class MatchingEngine {
  /**
   * Score a single match candidate
   */
  scoreMatch(candidate: MatchCandidate): ScoredMatch {
    const { listing, demand, supplierProfile, recipientProfile } = candidate;

    // Calculate distance
    let distanceMiles = 0;
    if (listing.pickupCoordinates && demand.deliveryCoordinates) {
      distanceMiles = geo.haversineDistance(
        listing.pickupCoordinates,
        demand.deliveryCoordinates
      );
    }

    // Calculate individual scores
    const distanceScore = this.calculateDistanceScore(distanceMiles);
    const timeScore = this.calculateTimeScore(listing, demand);
    const categoryScore = this.calculateCategoryScore(listing, demand);
    const capacityScore = this.calculateCapacityScore(listing, demand);
    const reliabilityScore = this.calculateReliabilityScore(supplierProfile, recipientProfile);

    // Weighted total score
    const weights = config.matching.weights;
    const totalScore =
      weights.distance * distanceScore +
      weights.time * timeScore +
      weights.category * categoryScore +
      weights.capacity * capacityScore +
      weights.reliability * reliabilityScore;

    const scoreBreakdown: ScoreBreakdown = {
      distance: distanceScore,
      time: timeScore,
      category: categoryScore,
      capacity: capacityScore,
      reliability: reliabilityScore,
    };

    logger.debug('Match scored', {
      listingId: listing.id,
      demandId: demand.id,
      score: totalScore,
      breakdown: scoreBreakdown,
    });

    return {
      listing,
      demand,
      score: Math.round(totalScore * 100) / 100,
      scoreBreakdown,
      distanceMiles,
    };
  }

  /**
   * Score multiple candidates and return top N
   */
  scoreAndRank(candidates: MatchCandidate[], topN?: number): ScoredMatch[] {
    const scored = candidates.map(c => this.scoreMatch(c));
    const sorted = scored.sort((a, b) => b.score - a.score);

    const limit = topN || config.matching.topRecommendations;
    return sorted.slice(0, limit);
  }

  /**
   * Calculate distance score (0-1, higher is better)
   */
  private calculateDistanceScore(distanceMiles: number): number {
    const maxDistance = config.matching.maxRadius;

    if (distanceMiles === 0) return 1.0;
    if (distanceMiles >= maxDistance) return 0.0;

    // Linear decay
    return 1 - distanceMiles / maxDistance;
  }

  /**
   * Calculate time window overlap score (0-1, higher is better)
   */
  private calculateTimeScore(listing: SurplusListing, demand: DemandPost): number {
    const pickupStart = new Date(listing.pickupWindow.start).getTime();
    const pickupEnd = new Date(listing.pickupWindow.end).getTime();
    const acceptStart = new Date(demand.acceptanceWindow.start).getTime();
    const acceptEnd = new Date(demand.acceptanceWindow.end).getTime();

    // Calculate overlap
    const overlapStart = Math.max(pickupStart, acceptStart);
    const overlapEnd = Math.min(pickupEnd, acceptEnd);

    if (overlapStart >= overlapEnd) {
      return 0.0; // No overlap
    }

    const overlapDuration = overlapEnd - overlapStart;
    const pickupDuration = pickupEnd - pickupStart;

    const score = overlapDuration / pickupDuration;
    return Math.min(score, 1.0);
  }

  /**
   * Calculate category match score (0-1, higher is better)
   */
  private calculateCategoryScore(listing: SurplusListing, demand: DemandPost): number {
    const listingCategory = listing.category;
    const demandCategories = demand.categories;

    // Exact match
    if (demandCategories.includes(listingCategory)) {
      return 1.0;
    }

    // Partial match (category families)
    const categoryFamilies: Record<string, string[]> = {
      food: ['perishable_food', 'non_perishable_food', 'beverages', 'water'],
      medical: ['medical_supplies', 'hygiene_products'],
      shelter: ['blankets', 'tents', 'clothing'],
      supplies: ['baby_supplies', 'pet_supplies', 'cleaning_supplies'],
    };

    for (const [family, categories] of Object.entries(categoryFamilies)) {
      if (categories.includes(listingCategory)) {
        const matchingDemandCategories = demandCategories.filter(dc => categories.includes(dc));
        if (matchingDemandCategories.length > 0) {
          return 0.7; // Partial match in same family
        }
      }
    }

    // No match
    return 0.0;
  }

  /**
   * Calculate capacity fit score (0-1, higher is better)
   */
  private calculateCapacityScore(listing: SurplusListing, demand: DemandPost): number {
    const quantity = listing.quantity;
    const capacity = demand.capacity;

    if (quantity > capacity) {
      // Over capacity is bad
      return 0.0;
    }

    const utilization = quantity / capacity;

    // Optimal utilization is 70-100%
    if (utilization >= 0.7) {
      return 1.0;
    }

    // Linear score for lower utilization
    return utilization / 0.7;
  }

  /**
   * Calculate reliability score based on past performance (0-1, higher is better)
   */
  private calculateReliabilityScore(
    supplierProfile?: UserProfile,
    recipientProfile?: UserProfile
  ): number {
    let totalReliability = 0;
    let count = 0;

    if (supplierProfile) {
      totalReliability += supplierProfile.reliabilityScore;
      count++;
    }

    if (recipientProfile) {
      totalReliability += recipientProfile.reliabilityScore;
      count++;
    }

    if (count === 0) {
      return 0.5; // Default neutral score
    }

    // Average reliability, normalized to 0-1
    return totalReliability / (count * 100);
  }

  /**
   * Filter candidates by basic criteria
   */
  filterCandidates(
    listings: SurplusListing[],
    demands: DemandPost[],
    options: {
      maxDistance?: number;
      requireCoordinates?: boolean;
    } = {}
  ): MatchCandidate[] {
    const candidates: MatchCandidate[] = [];
    const maxDistance = options.maxDistance || config.matching.maxRadius;

    for (const listing of listings) {
      // Skip if not in posted or matched status
      if (!['posted', 'matched'].includes(listing.status)) continue;

      for (const demand of demands) {
        // Skip if not in posted or matched status
        if (!['posted', 'matched'].includes(demand.status)) continue;

        // Check coordinates
        if (options.requireCoordinates) {
          if (!listing.pickupCoordinates || !demand.deliveryCoordinates) continue;
        }

        // Check distance
        if (listing.pickupCoordinates && demand.deliveryCoordinates) {
          const distance = geo.haversineDistance(
            listing.pickupCoordinates,
            demand.deliveryCoordinates
          );
          if (distance > maxDistance) continue;
        }

        candidates.push({ listing, demand });
      }
    }

    logger.info('Candidates filtered', {
      totalListings: listings.length,
      totalDemands: demands.length,
      candidates: candidates.length,
    });

    return candidates;
  }
}

// Singleton instance
export const matchingEngine = new MatchingEngine();
