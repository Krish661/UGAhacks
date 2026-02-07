import { matchingEngine } from '../domain/matching-engine';
import { SurplusListing, DemandPost } from '../shared/schemas';

describe('MatchingEngine', () => {
  const mockListing: Partial<SurplusListing> = {
    id: 'listing-1',
    category: 'perishable_food',
    quantity: 100,
    pickupCoordinates: { lat: 40.7128, lon: -74.0060 }, // NYC
    pickupWindow: {
      start: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    },
  };

  const mockDemand: Partial<DemandPost> = {
    id: 'demand-1',
    categories: ['perishable_food'],
    quantityNeeded: 150,
    capacity: 200,
    deliveryCoordinates: { lat: 40.7589, lon: -73.9851 }, // Also NYC, about 5 miles away
    acceptanceWindow: {
      start: new Date(Date.now() + 1 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    },
  };

  describe('scoreMatch', () => {
    it('should calculate a match score', () => {
      const result = matchingEngine.scoreMatch({
        listing: mockListing as SurplusListing,
        demand: mockDemand as DemandPost,
      });

      expect(result.score).toBeGreaterThan(0);
      expect(result.score).toBeLessThanOrEqual(100);
      expect(result.scoreBreakdown).toHaveProperty('distance');
      expect(result.scoreBreakdown).toHaveProperty('time');
      expect(result.scoreBreakdown).toHaveProperty('category');
      expect(result.scoreBreakdown).toHaveProperty('capacity');
      expect(result.scoreBreakdown).toHaveProperty('reliability');
    });

    it('should give high distance score for nearby locations', () => {
      const result = matchingEngine.scoreMatch({
        listing: mockListing as SurplusListing,
        demand: mockDemand as DemandPost,
      });

      expect(result.scoreBreakdown.distance).toBeGreaterThan(0.8);
      expect(result.distanceMiles).toBeLessThan(10);
    });

    it('should give high category score for exact match', () => {
      const result = matchingEngine.scoreMatch({
        listing: mockListing as SurplusListing,
        demand: mockDemand as DemandPost,
      });

      expect(result.scoreBreakdown.category).toBe(1.0);
    });

    it('should give lower category score for non-matching categories', () => {
      const demand = {
        ...mockDemand,
        categories: ['medical_supplies'],
      };

      const result = matchingEngine.scoreMatch({
        listing: mockListing as SurplusListing,
        demand: demand as DemandPost,
      });

      expect(result.scoreBreakdown.category).toBeLessThan(0.5);
    });

    it('should give high time score for overlapping windows', () => {
      const result = matchingEngine.scoreMatch({
        listing: mockListing as SurplusListing,
        demand: mockDemand as DemandPost,
      });

      expect(result.scoreBreakdown.time).toBeGreaterThan(0.5);
    });

    it('should give zero time score for non-overlapping windows', () => {
      const demand = {
        ...mockDemand,
        acceptanceWindow: {
          start: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
          end: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
        },
      };

      const result = matchingEngine.scoreMatch({
        listing: mockListing as SurplusListing,
        demand: demand as DemandPost,
      });

      expect(result.scoreBreakdown.time).toBe(0);
    });

    it('should give high capacity score for good utilization', () => {
      const result = matchingEngine.scoreMatch({
        listing: mockListing as SurplusListing,
        demand: mockDemand as DemandPost,
      });

      // 100/200 = 50% utilization, should be good
      expect(result.scoreBreakdown.capacity).toBeGreaterThan(0.5);
    });

    it('should give zero capacity score when exceeds capacity', () => {
      const listing = {
        ...mockListing,
        quantity: 300, // Exceeds demand capacity of 200
      };

      const result = matchingEngine.scoreMatch({
        listing: listing as SurplusListing,
        demand: mockDemand as DemandPost,
      });

      expect(result.scoreBreakdown.capacity).toBe(0);
    });
  });

  describe('scoreAndRank', () => {
    it('should rank multiple candidates by score', () => {
      const nearDemand = { ...mockDemand, deliveryCoordinates: { lat: 40.7128, lon: -74.0060 } }; // Same location
      const farDemand = { ...mockDemand, id: 'demand-2', deliveryCoordinates: { lat: 41.8781, lon: -87.6298 } }; // Chicago

      const results = matchingEngine.scoreAndRank([
        { listing: mockListing as SurplusListing, demand: farDemand as DemandPost },
        { listing: mockListing as SurplusListing, demand: nearDemand as DemandPost },
      ]);

      expect(results[0].demand.id).toBe('demand-1'); // Near demand should rank higher
      expect(results[0].score).toBeGreaterThan(results[1].score);
    });

    it('should limit results to topN', () => {
      const candidates = Array.from({ length: 10 }, (_, i) => ({
        listing: mockListing as SurplusListing,
        demand: { ...mockDemand, id: `demand-${i}` } as DemandPost,
      }));

      const results = matchingEngine.scoreAndRank(candidates, 3);
      expect(results.length).toBe(3);
    });
  });

  describe('filterCandidates', () => {
    it('should filter out candidates beyond max distance', () => {
      const nearDemand = mockDemand;
      const farDemand = { ...mockDemand, id: 'demand-far', deliveryCoordinates: { lat: 34.0522, lon: -118.2437 } }; // LA

      const results = matchingEngine.filterCandidates(
        [mockListing as SurplusListing],
        [nearDemand as DemandPost, farDemand as DemandPost],
        { maxDistance: 100 }
      );

      expect(results.length).toBe(1);
      expect(results[0].demand.id).toBe('demand-1');
    });

    it('should filter out non-posted items', () => {
      const listing1 = { ...mockListing, status: 'posted' as const };
      const listing2 = { ...mockListing, id: 'listing-2', status: 'canceled' as const };

      const results = matchingEngine.filterCandidates(
        [listing1 as SurplusListing, listing2 as SurplusListing],
        [mockDemand as DemandPost]
      );

      expect(results.length).toBe(1);
      expect(results[0].listing.id).toBe('listing-1');
    });
  });
});
