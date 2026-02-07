import { ComplianceError } from '../shared/errors';
import { SurplusListing, DemandPost, MatchRecommendation } from '../shared/schemas';
import { config } from '../shared/config';
import { createLogger } from '../shared/logger';

const logger = createLogger('ComplianceEngine');

export interface ComplianceCheckResult {
  ruleId: string;
  ruleName: string;
  passed: boolean;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export interface ComplianceEvaluation {
  passed: boolean;
  checks: ComplianceCheckResult[];
  blockedBy?: string[];
  ruleVersion: string;
}

export class ComplianceEngine {
  private readonly ruleVersion = '1.0.0';

  /**
   * Run all compliance checks on a match
   */
  async evaluate(
    listing: SurplusListing,
    demand: DemandPost,
    match: Partial<MatchRecommendation>
  ): Promise<ComplianceEvaluation> {
    const checks: ComplianceCheckResult[] = [];

    // Run all rules
    checks.push(this.checkRefrigeration(listing));
    checks.push(this.checkExpiration(listing));
    checks.push(this.checkQuality(listing));
    checks.push(this.checkPickupWindow(listing));
    checks.push(this.checkCapacity(listing, demand));
    checks.push(this.checkDistance(match));

    // Determine overall pass/fail
    const errors = checks.filter(c => c.severity === 'error' && !c.passed);
    const passed = errors.length === 0;

    const result: ComplianceEvaluation = {
      passed,
      checks,
      ruleVersion: this.ruleVersion,
    };

    if (!passed) {
      result.blockedBy = errors.map(e => e.ruleId);
    }

    logger.info('Compliance evaluation completed', {
      listingId: listing.id,
      demandId: demand.id,
      passed,
      blockedBy: result.blockedBy,
    });

    return result;
  }

  /**
   * Rule: Check refrigeration requirements vs pickup window
   */
  private checkRefrigeration(listing: SurplusListing): ComplianceCheckResult {
    const ruleId = 'REF-001';
    const ruleName = 'Refrigeration Requirement Check';

    if (!listing.requiresRefrigeration) {
      return {
        ruleId,
        ruleName,
        passed: true,
        severity: 'info',
        message: 'No refrigeration required',
      };
    }

    const pickupStart = new Date(listing.pickupWindow.start);
    const pickupEnd = new Date(listing.pickupWindow.end);
    const windowHours = (pickupEnd.getTime() - pickupStart.getTime()) / (1000 * 60 * 60);

    const maxWindow = config.compliance.maxRefrigerationWindow;

    if (windowHours > maxWindow) {
      return {
        ruleId,
        ruleName,
        passed: false,
        severity: 'error',
        message: `Pickup window (${windowHours.toFixed(1)}h) exceeds max for refrigerated items (${maxWindow}h)`,
      };
    }

    // Check if handling plan mentions refrigeration
    const hasRefrigerationPlan = listing.handlingRequirements.some(req =>
      /refrigerat|cold|chill|freeze/i.test(req)
    );

    if (!hasRefrigerationPlan) {
      return {
        ruleId,
        ruleName,
        passed: false,
        severity: 'error',
        message: 'Refrigeration required but no handling plan specified',
      };
    }

    return {
      ruleId,
      ruleName,
      passed: true,
      severity: 'info',
      message: 'Refrigeration requirements met',
    };
  }

  /**
   * Rule: Check expiration date
   */
  private checkExpiration(listing: SurplusListing): ComplianceCheckResult {
    const ruleId = 'EXP-001';
    const ruleName = 'Expiration Date Check';

    if (!listing.expirationDate) {
      return {
        ruleId,
        ruleName,
        passed: true,
        severity: 'info',
        message: 'No expiration date specified',
      };
    }

    const now = new Date();
    const expiration = new Date(listing.expirationDate);
    const minBuffer = config.compliance.minExpirationBuffer;
    const minExpirationTime = new Date(now.getTime() + minBuffer * 60 * 60 * 1000);

    if (expiration < now) {
      return {
        ruleId,
        ruleName,
        passed: false,
        severity: 'error',
        message: 'Item has already expired',
      };
    }

    if (expiration < minExpirationTime) {
      return {
        ruleId,
        ruleName,
        passed: false,
        severity: 'error',
        message: `Item expires too soon (less than ${minBuffer}h buffer)`,
      };
    }

    return {
      ruleId,
      ruleName,
      passed: true,
      severity: 'info',
      message: 'Expiration date acceptable',
    };
  }

  /**
   * Rule: Check quality notes for blocked keywords
   */
  private checkQuality(listing: SurplusListing): ComplianceCheckResult {
    const ruleId = 'QUAL-001';
    const ruleName = 'Quality Notes Check';

    if (!listing.qualityNotes) {
      return {
        ruleId,
        ruleName,
        passed: true,
        severity: 'info',
        message: 'No quality concerns noted',
      };
    }

    const notes = listing.qualityNotes.toLowerCase();
    const blockedKeywords = config.compliance.blockedKeywords;

    const foundKeywords = blockedKeywords.filter(keyword => notes.includes(keyword.toLowerCase()));

    if (foundKeywords.length > 0) {
      return {
        ruleId,
        ruleName,
        passed: false,
        severity: 'error',
        message: `Quality notes contain blocked keywords: ${foundKeywords.join(', ')}`,
      };
    }

    return {
      ruleId,
      ruleName,
      passed: true,
      severity: 'info',
      message: 'Quality notes acceptable',
    };
  }

  /**
   * Rule: Check if pickup window has lapsed
   */
  private checkPickupWindow(listing: SurplusListing): ComplianceCheckResult {
    const ruleId = 'TIME-001';
    const ruleName = 'Pickup Window Check';

    const now = new Date();
    const pickupStart = new Date(listing.pickupWindow.start);

    if (pickupStart < now) {
      return {
        ruleId,
        ruleName,
        passed: false,
        severity: 'error',
        message: 'Pickup window has already started or passed',
      };
    }

    return {
      ruleId,
      ruleName,
      passed: true,
      severity: 'info',
      message: 'Pickup window is valid',
    };
  }

  /**
   * Rule: Check if quantity fits recipient capacity
   */
  private checkCapacity(listing: SurplusListing, demand: DemandPost): ComplianceCheckResult {
    const ruleId = 'CAP-001';
    const ruleName = 'Capacity Check';

    if (listing.quantity > demand.capacity) {
      return {
        ruleId,
        ruleName,
        passed: false,
        severity: 'error',
        message: `Quantity (${listing.quantity}) exceeds recipient capacity (${demand.capacity})`,
      };
    }

    const utilizationPercent = (listing.quantity / demand.capacity) * 100;

    if (utilizationPercent < 20) {
      return {
        ruleId,
        ruleName,
        passed: true,
        severity: 'warning',
        message: `Low capacity utilization (${utilizationPercent.toFixed(0)}%)`,
      };
    }

    return {
      ruleId,
      ruleName,
      passed: true,
      severity: 'info',
      message: `Capacity utilization: ${utilizationPercent.toFixed(0)}%`,
    };
  }

  /**
   * Rule: Check distance
   */
  private checkDistance(match: Partial<MatchRecommendation>): ComplianceCheckResult {
    const ruleId = 'DIST-001';
    const ruleName = 'Distance Check';

    if (!match.distanceMiles) {
      return {
        ruleId,
        ruleName,
        passed: true,
        severity: 'info',
        message: 'Distance not yet calculated',
      };
    }

    const maxDistance = config.compliance.maxDistance;

    if (match.distanceMiles > maxDistance) {
      return {
        ruleId,
        ruleName,
        passed: true,
        severity: 'warning',
        message: `Distance (${match.distanceMiles.toFixed(1)} mi) exceeds recommended max (${maxDistance} mi)`,
      };
    }

    return {
      ruleId,
      ruleName,
      passed: true,
      severity: 'info',
      message: `Distance: ${match.distanceMiles.toFixed(1)} miles`,
    };
  }

  /**
   * Manual compliance override
   */
  approveOverride(
    evaluation: ComplianceEvaluation,
    approverId: string,
    justification: string
  ): ComplianceEvaluation {
    logger.warn('Compliance override approved', {
      approverId,
      justification,
      blockedRules: evaluation.blockedBy,
    });

    return {
      ...evaluation,
      passed: true,
      checks: evaluation.checks.map(check => ({
        ...check,
        message: check.passed ? check.message : `${check.message} (overridden: ${justification})`,
      })),
    };
  }
}

// Singleton instance
export const complianceEngine = new ComplianceEngine();
