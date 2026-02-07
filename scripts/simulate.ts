#!/usr/bin/env ts-node
/**
 * Simulation script to generate driver location updates and status transitions
 * Usage: ts-node scripts/simulate.ts [--duration=60] [--interval=5]
 */
import { ulid } from 'ulid';
import { matchRepository, taskRepository, userRepository } from '../services/integrations/dynamodb';
import { auditService } from '../services/integrations/audit';
import { logger } from '../services/shared/logger';
import { DeliveryTask, MatchRecommendation } from '../services/shared/schemas';

interface SimulationConfig {
  durationMinutes: number; // How long to run simulation
  updateIntervalSeconds: number; // How often to update locations
  driverId: string;
}

const DEFAULT_CONFIG: SimulationConfig = {
  durationMinutes: 60,
  updateIntervalSeconds: 10,
  driverId: 'driver-001',
};

// Simulate a delivery route (SF to Oakland)
const ROUTE_WAYPOINTS = [
  { lat: 37.7749, lon: -122.4194 }, // Start: SF Market St
  { lat: 37.7849, lon: -122.4094 }, // Moving northeast
  { lat: 37.7949, lon: -122.3994 }, // Approaching Bay Bridge
  { lat: 37.8049, lon: -122.3894 }, // On Bay Bridge
  { lat: 37.8149, lon: -122.3794 }, // Crossing bridge
  { lat: 37.8249, lon: -122.3694 }, // Entering Oakland
  { lat: 37.8149, lon: -122.2894 }, // Moving toward destination
  { lat: 37.8044, lon: -122.2712 }, // Destination: Oakland Aid St
];

function parseArgs(): SimulationConfig {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_CONFIG };

  for (const arg of args) {
    if (arg.startsWith('--duration=')) {
      config.durationMinutes = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--interval=')) {
      config.updateIntervalSeconds = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--driver=')) {
      config.driverId = arg.split('=')[1];
    }
  }

  return config;
}

async function findActiveTask(driverId: string): Promise<DeliveryTask | null> {
  const tasks = await taskRepository.queryByUser(driverId, 'driver');
  const activeTask = tasks.find(
    (t) => t.status === 'assigned' || t.status === 'in_progress'
  );
  return activeTask || null;
}

async function updateTaskStatus(
  task: DeliveryTask,
  newStatus: DeliveryTask['status'],
  driverId: string
): Promise<void> {
  const updatedTask = await taskRepository.updateFields(task.id, {
    status: newStatus,
    updatedAt: new Date().toISOString(),
  });

  await auditService.logStateChange({
    entityType: 'task',
    entityId: task.id,
    fromState: task.status,
    toState: newStatus,
    actorId: driverId,
    actorRole: 'driver',
  });

  logger.info(
    { taskId: task.id, fromStatus: task.status, toStatus: newStatus },
    'Task status updated'
  );
}

async function updateDriverLocation(
  taskId: string,
  location: { lat: number; lon: number },
  driverId: string
): Promise<void> {
  const locationUpdate = {
    taskId,
    driverId,
    location,
    timestamp: new Date().toISOString(),
    heading: 0,
    speed: 0,
  };

  // In production, this would update task.currentLocation and push to a location tracking service
  await taskRepository.updateFields(taskId, {
    currentLocation: location,
    lastLocationUpdate: locationUpdate.timestamp,
  });

  logger.info({ taskId, location }, 'Location updated');
}

async function simulateDelivery(config: SimulationConfig): Promise<void> {
  logger.info(config, 'Starting delivery simulation');

  // Find active task for driver
  let task = await findActiveTask(config.driverId);

  if (!task) {
    logger.warn(
      { driverId: config.driverId },
      'No active task found for driver. Please assign a task first.'
    );
    return;
  }

  logger.info({ taskId: task.id, matchId: task.matchId }, 'Found active task');

  // Confirm pickup if task is still assigned
  if (task.status === 'assigned') {
    await updateTaskStatus(task, 'in_progress', config.driverId);
    task = (await taskRepository.get(task.id))!;
  }

  const startTime = Date.now();
  const endTime = startTime + config.durationMinutes * 60 * 1000;
  const totalUpdates = Math.floor(
    (config.durationMinutes * 60) / config.updateIntervalSeconds
  );

  let updateCount = 0;

  while (Date.now() < endTime) {
    updateCount++;

    // Calculate progress (0-1)
    const progress = updateCount / totalUpdates;

    // Interpolate location along route
    const waypointIndex = Math.floor(progress * (ROUTE_WAYPOINTS.length - 1));
    const nextWaypointIndex = Math.min(
      waypointIndex + 1,
      ROUTE_WAYPOINTS.length - 1
    );
    const waypointProgress = (progress * (ROUTE_WAYPOINTS.length - 1)) % 1;

    const currentWaypoint = ROUTE_WAYPOINTS[waypointIndex];
    const nextWaypoint = ROUTE_WAYPOINTS[nextWaypointIndex];

    const interpolatedLocation = {
      lat:
        currentWaypoint.lat +
        (nextWaypoint.lat - currentWaypoint.lat) * waypointProgress,
      lon:
        currentWaypoint.lon +
        (nextWaypoint.lon - currentWaypoint.lon) * waypointProgress,
    };

    await updateDriverLocation(
      task.id,
      interpolatedLocation,
      config.driverId
    );

    // Check for status transitions
    if (progress > 0.5 && task.status === 'in_progress') {
      // Simulate pickup at 50% progress
      logger.info('Simulating pickup confirmation...');
      await updateTaskStatus(task, 'in_progress', config.driverId);
      task = (await taskRepository.get(task.id))!;
    }

    if (progress >= 0.95 && task.status === 'in_progress') {
      // Simulate delivery at 95% progress
      logger.info('Simulating delivery confirmation...');
      await updateTaskStatus(task, 'completed', config.driverId);
      task = (await taskRepository.get(task.id))!;
      logger.info('✅ Delivery completed!');
      break;
    }

    logger.info(
      {
        progress: `${(progress * 100).toFixed(1)}%`,
        location: {
          lat: interpolatedLocation.lat.toFixed(4),
          lon: interpolatedLocation.lon.toFixed(4),
        },
        status: task.status,
      },
      `Update ${updateCount}/${totalUpdates}`
    );

    // Wait for next update
    await new Promise((resolve) =>
      setTimeout(resolve, config.updateIntervalSeconds * 1000)
    );
  }

  logger.info('✅ Simulation completed');
}

async function main() {
  const config = parseArgs();

  logger.info('SwarmAid Delivery Simulator');
  logger.info('============================');

  try {
    await simulateDelivery(config);
  } catch (error) {
    logger.error({ error }, 'Simulation failed');
    process.exit(1);
  }
}

main();
