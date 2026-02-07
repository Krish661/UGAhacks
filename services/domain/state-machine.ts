import { StateTransitionError } from '../shared/errors';

export type EntityStatus =
  | 'posted'
  | 'matched'
  | 'scheduled'
  | 'picked_up'
  | 'delivered'
  | 'canceled'
  | 'failed'
  | 'expired'
  | 'closed';

export type EntityType = 'listing' | 'demand' | 'match' | 'task';

export interface StateTransition {
  from: EntityStatus;
  to: EntityStatus;
  allowedRoles: string[];
  requiresJustification?: boolean;
  validator?: (context: Record<string, unknown>) => Promise<void>;
}

// Define valid state transitions
const transitions: StateTransition[] = [
  // Listing/Demand lifecycle
  {
    from: 'posted',
    to: 'matched',
    allowedRoles: ['system', 'operator', 'admin'],
  },
  {
    from: 'matched',
    to: 'scheduled',
    allowedRoles: ['operator', 'admin'],
  },
  {
    from: 'scheduled',
    to: 'picked_up',
    allowedRoles: ['driver', 'operator', 'admin'],
  },
  {
    from: 'picked_up',
    to: 'delivered',
    allowedRoles: ['driver', 'operator', 'admin'],
  },

  // Cancellation paths
  {
    from: 'posted',
    to: 'canceled',
    allowedRoles: ['supplier', 'recipient', 'operator', 'admin'],
    requiresJustification: true,
  },
  {
    from: 'matched',
    to: 'canceled',
    allowedRoles: ['supplier', 'recipient', 'operator', 'admin'],
    requiresJustification: true,
  },
  {
    from: 'scheduled',
    to: 'canceled',
    allowedRoles: ['operator', 'admin'],
    requiresJustification: true,
  },
  {
    from: 'picked_up',
    to: 'canceled',
    allowedRoles: ['operator', 'admin'],
    requiresJustification: true,
  },

  // Failure paths
  {
    from: 'scheduled',
    to: 'failed',
    allowedRoles: ['driver', 'system', 'operator', 'admin'],
    requiresJustification: true,
  },
  {
    from: 'picked_up',
    to: 'failed',
    allowedRoles: ['driver', 'system', 'operator', 'admin'],
    requiresJustification: true,
  },

  // Expiration
  {
    from: 'posted',
    to: 'expired',
    allowedRoles: ['system', 'operator', 'admin'],
  },

  // Demand-specific: close
  {
    from: 'posted',
    to: 'closed',
    allowedRoles: ['recipient', 'operator', 'admin'],
  },
  {
    from: 'matched',
    to: 'closed',
    allowedRoles: ['recipient', 'operator', 'admin'],
  },

  // Match-specific transitions
  {
    from: 'posted',
    to: 'matched',
    allowedRoles: ['system', 'operator', 'admin'],
  },

  // Allow operator overrides to go backwards for recovery
  {
    from: 'scheduled',
    to: 'matched',
    allowedRoles: ['operator', 'admin'],
    requiresJustification: true,
  },
  {
    from: 'picked_up',
    to: 'scheduled',
    allowedRoles: ['operator', 'admin'],
    requiresJustification: true,
  },
];

export class StateMachine {
  /**
   * Check if a state transition is valid
   */
  canTransition(from: EntityStatus, to: EntityStatus, role: string): boolean {
    if (from === to) return false;

    const transition = transitions.find(t => t.from === from && t.to === to);
    if (!transition) return false;

    return transition.allowedRoles.includes(role) || transition.allowedRoles.includes('system');
  }

  /**
   * Get allowed target states from current state for a role
   */
  getAllowedTransitions(from: EntityStatus, role: string): EntityStatus[] {
    return transitions
      .filter(t => t.from === from && (t.allowedRoles.includes(role) || role === 'admin'))
      .map(t => t.to);
  }

  /**
   * Validate and execute a state transition
   */
  async transition(
    from: EntityStatus,
    to: EntityStatus,
    role: string,
    context: {
      justification?: string;
      entityType?: EntityType;
      [key: string]: unknown;
    }
  ): Promise<void> {
    if (from === to) {
      throw new StateTransitionError(from, to, 'Source and target states are identical');
    }

    const transition = transitions.find(t => t.from === from && t.to === to);

    if (!transition) {
      throw new StateTransitionError(from, to, 'No valid transition path exists');
    }

    if (!transition.allowedRoles.includes(role) && role !== 'admin') {
      throw new StateTransitionError(from, to, `Role '${role}' is not authorized for this transition`);
    }

    if (transition.requiresJustification && !context.justification) {
      throw new StateTransitionError(from, to, 'Justification is required for this transition');
    }

    // Run custom validator if defined
    if (transition.validator) {
      await transition.validator(context);
    }
  }

  /**
   * Check if a status is terminal (no further transitions possible)
   */
  isTerminalState(status: EntityStatus): boolean {
    const terminalStates: EntityStatus[] = ['delivered', 'canceled', 'failed', 'expired', 'closed'];
    return terminalStates.includes(status);
  }

  /**
   * Get human-readable status description
   */
  getStatusDescription(status: EntityStatus): string {
    const descriptions: Record<EntityStatus, string> = {
      posted: 'Posted and awaiting matches',
      matched: 'Matched with a counterpart',
      scheduled: 'Scheduled for delivery',
      picked_up: 'Picked up by driver',
      delivered: 'Successfully delivered',
      canceled: 'Canceled',
      failed: 'Failed to complete',
      expired: 'Expired due to time window',
      closed: 'Closed by recipient',
    };
    return descriptions[status] || status;
  }

  /**
   * Get next recommended actions for a status
   */
  getNextActions(status: EntityStatus, role: string): Array<{ action: string; targetStatus: EntityStatus }> {
    const allowedTargets = this.getAllowedTransitions(status, role);

    const actionMap: Record<EntityStatus, string> = {
      matched: 'Match with counterpart',
      scheduled: 'Schedule delivery',
      picked_up: 'Confirm pickup',
      delivered: 'Confirm delivery',
      canceled: 'Cancel',
      failed: 'Mark as failed',
      expired: 'Mark as expired',
      closed: 'Close',
      posted: 'Post', // Not typically an action
    };

    return allowedTargets.map(target => ({
      action: actionMap[target] || `Transition to ${target}`,
      targetStatus: target,
    }));
  }
}

// Singleton instance
export const stateMachine = new StateMachine();
