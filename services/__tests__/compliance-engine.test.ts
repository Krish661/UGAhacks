import { complianceEngine } from '../domain/compliance-engine';
import { SurplusListing, DemandPost } from '../shared/schemas';

describe('ComplianceEngine', () => {
  const mockListing: Partial<SurplusListing> = {
    id: 'test-listing',
    title: 'Fresh Produce',
    category: 'perishable_food',
    quantity: 100,
    requiresRefrigeration: false,
    pickupWindow: {
      start: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      end: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    },
  };

  const mockDemand: Partial<DemandPost> = {
    id: 'test-demand',
    title: 'Need Food',
    capacity: 200,
    categories: ['perishable_food'],
  };

  describe('checkRefrigeration', () => {
    it('should pass when refrigeration not required', async () => {
      const result = await complianceEngine.evaluate(
        mockListing as SurplusListing,
        mockDemand as DemandPost,
        { distanceMiles: 10 }
      );

      const refCheck = result.checks.find(c => c.ruleId === 'REF-001');
      expect(refCheck?.passed).toBe(true);
    });

    it('should fail when refrigeration required but window too long', async () => {
      const listing = {
        ...mockListing,
        requiresRefrigeration: true,
        pickupWindow: {
          start: new Date(Date.now()).toISOString(),
          end: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(), // 5 hours
        },
        handlingRequirements: [],
      };

      const result = await complianceEngine.evaluate(
        listing as SurplusListing,
        mockDemand as DemandPost,
        { distanceMiles: 10 }
      );

      const refCheck = result.checks.find(c => c.ruleId === 'REF-001');
      expect(refCheck?.passed).toBe(false);
    });
  });

  describe('checkExpiration', () => {
    it('should fail when item already expired', async () => {
      const listing = {
        ...mockListing,
        expirationDate: new Date(Date.now() - 1000).toISOString(), // Expired
      };

      const result = await complianceEngine.evaluate(
        listing as SurplusListing,
        mockDemand as DemandPost,
        { distanceMiles: 10 }
      );

      const expCheck = result.checks.find(c => c.ruleId === 'EXP-001');
      expect(expCheck?.passed).toBe(false);
    });

    it('should pass when expiration date is far enough', async () => {
      const listing = {
        ...mockListing,
        expirationDate: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), // 2 days
      };

      const result = await complianceEngine.evaluate(
        listing as SurplusListing,
        mockDemand as DemandPost,
        { distanceMiles: 10 }
      );

      const expCheck = result.checks.find(c => c.ruleId === 'EXP-001');
      expect(expCheck?.passed).toBe(true);
    });
  });

  describe('checkQuality', () => {
    it('should fail when quality notes contain blocked keywords', async () => {
      const listing = {
        ...mockListing,
        qualityNotes: 'Some items are moldy',
      };

      const result = await complianceEngine.evaluate(
        listing as SurplusListing,
        mockDemand as DemandPost,
        { distanceMiles: 10 }
      );

      const qualCheck = result.checks.find(c => c.ruleId === 'QUAL-001');
      expect(qualCheck?.passed).toBe(false);
      expect(result.passed).toBe(false);
    });

    it('should pass when quality notes are acceptable', async () => {
      const listing = {
        ...mockListing,
        qualityNotes: 'Fresh, good condition',
      };

      const result = await complianceEngine.evaluate(
        listing as SurplusListing,
        mockDemand as DemandPost,
        { distanceMiles: 10 }
      );

      const qualCheck = result.checks.find(c => c.ruleId === 'QUAL-001');
      expect(qualCheck?.passed).toBe(true);
    });
  });

  describe('checkCapacity', () => {
    it('should fail when quantity exceeds capacity', async () => {
      const listing = {
        ...mockListing,
        quantity: 300, // Exceeds demand capacity of 200
      };

      const result = await complianceEngine.evaluate(
        listing as SurplusListing,
        mockDemand as DemandPost,
        { distanceMiles: 10 }
      );

      const capCheck = result.checks.find(c => c.ruleId === 'CAP-001');
      expect(capCheck?.passed).toBe(false);
      expect(result.passed).toBe(false);
    });

    it('should pass when quantity fits capacity', async () => {
      const listing = {
        ...mockListing,
        quantity: 150, // Within capacity
      };

      const result = await complianceEngine.evaluate(
        listing as SurplusListing,
        mockDemand as DemandPost,
        { distanceMiles: 10 }
      );

      const capCheck = result.checks.find(c => c.ruleId === 'CAP-001');
      expect(capCheck?.passed).toBe(true);
    });
  });

  describe('overall evaluation', () => {
    it('should pass when all checks pass', async () => {
      const result = await complianceEngine.evaluate(
        mockListing as SurplusListing,
        mockDemand as DemandPost,
        { distanceMiles: 10 }
      );

      expect(result.passed).toBe(true);
      expect(result.blockedBy).toBeUndefined();
    });

    it('should fail when any critical check fails', async () => {
      const listing = {
        ...mockListing,
        quantity: 300, // Exceeds capacity
      };

      const result = await complianceEngine.evaluate(
        listing as SurplusListing,
        mockDemand as DemandPost,
        { distanceMiles: 10 }
      );

      expect(result.passed).toBe(false);
      expect(result.blockedBy).toContain('CAP-001');
    });
  });
});
