import { stateMachine } from '../domain/state-machine';
import { StateTransitionError } from '../shared/errors';

describe('StateMachine', () => {
  describe('canTransition', () => {
    it('should allow valid transitions for correct roles', () => {
      expect(stateMachine.canTransition('posted', 'matched', 'system')).toBe(true);
      expect(stateMachine.canTransition('matched', 'scheduled', 'operator')).toBe(true);
      expect(stateMachine.canTransition('scheduled', 'picked_up', 'driver')).toBe(true);
      expect(stateMachine.canTransition('picked_up', 'delivered', 'driver')).toBe(true);
    });

    it('should reject invalid transitions', () => {
      expect(stateMachine.canTransition('posted', 'delivered', 'system')).toBe(false);
      expect(stateMachine.canTransition('delivered', 'posted', 'operator')).toBe(false);
    });

    it('should reject transitions for unauthorized roles', () => {
      expect(stateMachine.canTransition('scheduled', 'picked_up', 'supplier')).toBe(false);
      expect(stateMachine.canTransition('posted', 'matched', 'recipient')).toBe(false);
    });

    it('should reject same-state transitions', () => {
      expect(stateMachine.canTransition('posted', 'posted', 'system')).toBe(false);
    });
  });

  describe('transition', () => {
    it('should execute valid transition', async () => {
      await expect(
        stateMachine.transition('posted', 'matched', 'system', {})
      ).resolves.not.toThrow();
    });

    it('should throw error for invalid transition', async () => {
      await expect(
        stateMachine.transition('posted', 'delivered', 'system', {})
      ).rejects.toThrow(StateTransitionError);
    });

    it('should throw error for unauthorized role', async () => {
      await expect(
        stateMachine.transition('posted', 'matched', 'supplier', {})
      ).rejects.toThrow(StateTransitionError);
    });

    it('should require justification when needed', async () => {
      await expect(
        stateMachine.transition('posted', 'canceled', 'supplier', {})
      ).rejects.toThrow('Justification is required');

      await expect(
        stateMachine.transition('posted', 'canceled', 'supplier', {
          justification: 'No longer needed',
        })
      ).resolves.not.toThrow();
    });

    it('should allow admin to override', async () => {
      await expect(
        stateMachine.transition('scheduled', 'matched', 'admin', {
          justification: 'Reset for reassignment',
        })
      ).resolves.not.toThrow();
    });
  });

  describe('getAllowedTransitions', () => {
    it('should return correct allowed transitions for role', () => {
      const operatorTransitions = stateMachine.getAllowedTransitions('matched', 'operator');
      expect(operatorTransitions).toContain('scheduled');
      expect(operatorTransitions).toContain('canceled');

      const driverTransitions = stateMachine.getAllowedTransitions('scheduled', 'driver');
      expect(driverTransitions).toContain('picked_up');
      expect(driverTransitions).toContain('failed');
    });

    it('should return empty array for roles with no allowed transitions', () => {
      const supplierTransitions = stateMachine.getAllowedTransitions('scheduled', 'supplier');
      expect(supplierTransitions).toEqual([]);
    });
  });

  describe('isTerminalState', () => {
    it('should identify terminal states', () => {
      expect(stateMachine.isTerminalState('delivered')).toBe(true);
      expect(stateMachine.isTerminalState('canceled')).toBe(true);
      expect(stateMachine.isTerminalState('failed')).toBe(true);
      expect(stateMachine.isTerminalState('expired')).toBe(true);
      expect(stateMachine.isTerminalState('closed')).toBe(true);
    });

    it('should identify non-terminal states', () => {
      expect(stateMachine.isTerminalState('posted')).toBe(false);
      expect(stateMachine.isTerminalState('matched')).toBe(false);
      expect(stateMachine.isTerminalState('scheduled')).toBe(false);
      expect(stateMachine.isTerminalState('picked_up')).toBe(false);
    });
  });

  describe('getNextActions', () => {
    it('should return appropriate actions for state and role', () => {
      const actions = stateMachine.getNextActions('scheduled', 'driver');
      
      const actionNames = actions.map(a => a.action);
      expect(actionNames).toContain('Confirm pickup');
      expect(actionNames).toContain('Mark as failed');
    });

    it('should return empty actions for roles with no permissions', () => {
      const actions = stateMachine.getNextActions('scheduled', 'supplier');
      expect(actions).toEqual([]);
    });
  });
});
