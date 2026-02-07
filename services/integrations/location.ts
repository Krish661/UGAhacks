import {
  LocationClient,
  SearchPlaceIndexForTextCommand,
  CalculateRouteCommand,
} from '@aws-sdk/client-location';
import { config } from '../shared/config';
import { createLogger } from '../shared/logger';
import * as geo from '../domain/geohash';

const logger = createLogger('LocationService');

export interface GeocodingResult {
  coordinates: {
    lat: number;
    lon: number;
  };
  formattedAddress: string;
  confidence: number;
  provider: 'amazon_location' | 'fallback';
}

export interface RouteResult {
  distanceMiles: number;
  durationMinutes: number;
  polyline?: string;
  provider: 'amazon_location' | 'fallback';
  providerStatus: 'ok' | 'degraded';
  metadata?: Record<string, unknown>;
}

class LocationService {
  private client?: LocationClient;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      this.client = new LocationClient({
        region: config.aws.region,
        ...(config.aws.awsEndpoint && { endpoint: config.aws.awsEndpoint }),
      });
      this.initialized = true;
      logger.info('Amazon Location Service initialized');
    } catch (error) {
      logger.error('Failed to initialize Location Service', error as Error);
      this.initialized = true; // Use fallback
    }
  }

  /**
   * Geocode an address to coordinates
   */
  async geocode(address: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country?: string;
  }): Promise<GeocodingResult> {
    await this.initialize();

    const fullAddress = `${address.street}, ${address.city}, ${address.state} ${address.zipCode}, ${address.country || 'US'}`;

    if (!this.client) {
      logger.warn('Location Service not available, using fallback geocoding');
      return this.fallbackGeocode(address);
    }

    try {
      const response = await this.client.send(
        new SearchPlaceIndexForTextCommand({
          IndexName: config.location.geocoderIndex,
          Text: fullAddress,
          MaxResults: 1,
        })
      );

      const result = response.Results?.[0];

      if (!result || !result.Place?.Geometry?.Point) {
        logger.warn('No geocoding results found, using fallback', { address: fullAddress });
        return this.fallbackGeocode(address);
      }

      const [lon, lat] = result.Place.Geometry.Point;

      logger.info('Address geocoded', { address: fullAddress, lat, lon });

      return {
        coordinates: { lat, lon },
        formattedAddress: result.Place.Label || fullAddress,
        confidence: 90,
        provider: 'amazon_location',
      };
    } catch (error) {
      logger.error('Geocoding failed, using fallback', error as Error, { address: fullAddress });
      return this.fallbackGeocode(address);
    }
  }

  /**
   * Calculate route between two coordinates
   */
  async calculateRoute(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number }
  ): Promise<RouteResult> {
    await this.initialize();

    if (!this.client) {
      logger.warn('Location Service not available, using fallback routing');
      return this.fallbackRoute(origin, destination);
    }

    try {
      const response = await this.client.send(
        new CalculateRouteCommand({
          CalculatorName: config.location.routeCalculator,
          DeparturePosition: [origin.lon, origin.lat],
          DestinationPosition: [destination.lon, destination.lat],
          TravelMode: 'Car',
          DistanceUnit: 'Miles',
        })
      );

      const leg = response.Legs?.[0];

      if (!leg) {
        logger.warn('No route found, using fallback', { origin, destination });
        return this.fallbackRoute(origin, destination);
      }

      const distanceMiles = leg.Distance || 0;
      const durationMinutes = (leg.DurationSeconds || 0) / 60;

      // Extract polyline if available (usually in LineString format)
      let polyline: string | undefined;
      if (leg.Geometry?.LineString) {
        polyline = JSON.stringify(leg.Geometry.LineString);
      }

      logger.info('Route calculated', {
        origin,
        destination,
        distanceMiles,
        durationMinutes,
      });

      return {
        distanceMiles,
        durationMinutes,
        polyline,
        provider: 'amazon_location',
        providerStatus: 'ok',
        metadata: {
          startPosition: leg.StartPosition,
          endPosition: leg.EndPosition,
        },
      };
    } catch (error) {
      logger.error('Route calculation failed, using fallback', error as Error, {
        origin,
        destination,
      });
      return this.fallbackRoute(origin, destination);
    }
  }

  /**
   * Fallback geocoding using US ZIP code centroid lookup
   * (Simplified - in production, use a ZIP code database)
   */
  private fallbackGeocode(address: {
    street: string;
    city: string;
    state: string;
    zipCode: string;
    country?: string;
  }): GeocodingResult {
    // Very rough state centroid lookup (deterministic for testing)
    const stateCentroids: Record<string, { lat: number; lon: number }> = {
      AL: { lat: 32.806671, lon: -86.79113 },
      AK: { lat: 61.370716, lon: -152.404419 },
      AZ: { lat: 33.729759, lon: -111.431221 },
      CA: { lat: 36.116203, lon: -119.681564 },
      FL: { lat: 27.766279, lon: -81.686783 },
      GA: { lat: 33.040619, lon: -83.643074 },
      NY: { lat: 42.165726, lon: -74.948051 },
      TX: { lat: 31.054487, lon: -97.563461 },
      // Add more as needed
    };

    const coords = stateCentroids[address.state.toUpperCase()] || { lat: 39.8283, lon: -98.5795 }; // US center

    // Add small offset based on ZIP code for variation
    const zipOffset = parseInt(address.zipCode) % 100;
    coords.lat += (zipOffset - 50) * 0.01;
    coords.lon += (zipOffset - 50) * 0.01;

    logger.info('Using fallback geocoding', { address, coords });

    return {
      coordinates: coords,
      formattedAddress: `${address.street}, ${address.city}, ${address.state} ${address.zipCode}`,
      confidence: 50,
      provider: 'fallback',
    };
  }

  /**
   * Fallback routing using haversine distance
   */
  private fallbackRoute(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number }
  ): RouteResult {
    const distanceMiles = geo.haversineDistance(origin, destination);

    // Estimate duration: assume 45 mph average speed
    const durationMinutes = (distanceMiles / 45) * 60;

    // Generate simple straight-line polyline
    const polyline = JSON.stringify([
      [origin.lon, origin.lat],
      [destination.lon, destination.lat],
    ]);

    logger.info('Using fallback routing', {
      origin,
      destination,
      distanceMiles,
      durationMinutes,
    });

    return {
      distanceMiles,
      durationMinutes,
      polyline,
      provider: 'fallback',
      providerStatus: 'degraded',
    };
  }
}

// Singleton instance
export const locationService = new LocationService();
