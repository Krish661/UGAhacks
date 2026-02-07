import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsClient = new SecretsManagerClient({});
const SECRET_NAME = process.env.MAPBOX_SECRET_NAME || '/swarmaid/mapbox-token';

let cachedToken: string | null = null;

// ============================================
// Mapbox Token Management
// ============================================

async function getMapboxToken(): Promise<string> {
  if (cachedToken) return cachedToken;

  try {
    const result = await secretsClient.send(new GetSecretValueCommand({
      SecretId: SECRET_NAME,
    }));
    cachedToken = result.SecretString!;
    return cachedToken;
  } catch (error) {
    console.error('Failed to retrieve Mapbox token from Secrets Manager:', {
      secretName: SECRET_NAME,
      error: error instanceof Error ? error.message : 'unknown',
    });
    throw new Error('Mapbox token unavailable');
  }
}

// ============================================
// Types
// ============================================

export interface GeocodeResult {
  lat: number;
  lon: number;
  placeName: string;
  raw: any;
}

export interface DirectionsResult {
  distanceMeters: number;
  durationSeconds: number;
  geometryGeoJson: any;
}

export interface Address {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}

// ============================================
// Geocoding API
// ============================================

/**
 * Geocode an address using Mapbox Geocoding API
 * @param address - Address object or string
 * @returns Geocoded location with coordinates
 */
export async function geocodeAddress(
  address: Address | string
): Promise<GeocodeResult> {
  const token = await getMapboxToken();

  // Build query string
  let query: string;
  if (typeof address === 'string') {
    query = encodeURIComponent(address);
  } else {
    // Build address string from components
    const parts = [
      address.street,
      address.city,
      address.state,
      address.zip,
      address.country || 'USA',
    ].filter(Boolean);
    
    if (parts.length === 0) {
      throw new Error('Invalid address: no components provided');
    }
    
    query = encodeURIComponent(parts.join(', '));
  }

  // Mapbox Geocoding API endpoint with filters for accuracy
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${query}.json?` +
    `access_token=${token}` +
    `&limit=1` +
    `&country=US` +
    `&types=place,address,postcode`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Mapbox geocoding failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;

    if (!data.features || data.features.length === 0) {
      throw new Error('No geocoding results found for address');
    }

    const feature = data.features[0];
    const [lon, lat] = feature.center; // Mapbox returns [lon, lat]

    return {
      lat,
      lon,
      placeName: feature.place_name,
      raw: feature,
    };
  } catch (error) {
    console.error('Geocoding error:', {
      query,
      error: error instanceof Error ? error.message : 'unknown',
    });
    throw error;
  }
}

// ============================================
// Directions API
// ============================================

/**
 * Get driving directions between two coordinates using Mapbox Directions API
 * @param from - Starting coordinates
 * @param to - Destination coordinates
 * @returns Route with distance, duration, and GeoJSON geometry
 */
export async function directionsRoute(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number }
): Promise<DirectionsResult> {
  const token = await getMapboxToken();

  // Mapbox Directions API endpoint (driving profile)
  // Format: /directions/v5/{profile}/{coordinates}
  // Coordinates: lon1,lat1;lon2,lat2
  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${from.lon},${from.lat};${to.lon},${to.lat}?geometries=geojson&overview=full&access_token=${token}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Mapbox directions failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;

    if (!data.routes || data.routes.length === 0) {
      throw new Error('No route found');
    }

    const route = data.routes[0];

    return {
      distanceMeters: route.distance,
      durationSeconds: route.duration,
      geometryGeoJson: route.geometry,
    };
  } catch (error) {
    console.error('Directions error:', {
      from,
      to,
      error: error instanceof Error ? error.message : 'unknown',
    });
    throw error;
  }
}

// ============================================
// Matrix API (Optional Helper)
// ============================================

/**
 * Get distances from one point to multiple destinations using Mapbox Matrix API
 * @param from - Starting coordinates
 * @param toList - List of destination coordinates
 * @returns Array of distances in meters
 */
export async function matrix(
  from: { lat: number; lon: number },
  toList: Array<{ lat: number; lon: number }>
): Promise<number[]> {
  const token = await getMapboxToken();

  // Build coordinates string: from;to1;to2;...
  const coordsStr = [from, ...toList]
    .map((coord) => `${coord.lon},${coord.lat}`)
    .join(';');

  // Mapbox Matrix API endpoint
  const url = `https://api.mapbox.com/directions-matrix/v1/mapbox/driving/${coordsStr}?sources=0&annotations=distance&access_token=${token}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Mapbox matrix failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as any;

    // Extract distances from first row (from point to all destinations)
    const distances = data.distances[0].slice(1); // Skip first element (distance to self)

    return distances;
  } catch (error) {
    console.error('Matrix API error:', {
      from,
      destinationCount: toList.length,
      error: error instanceof Error ? error.message : 'unknown',
    });
    throw error;
  }
}

// ============================================
// Haversine Distance (Fast Local Calculation)
// ============================================

/**
 * Calculate distance between two coordinates using Haversine formula
 * This is a fast local calculation without API calls
 * @param lat1 - Start latitude
 * @param lon1 - Start longitude
 * @param lat2 - End latitude
 * @param lon2 - End longitude
 * @returns Distance in meters
 */
export function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // Distance in meters
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

// ============================================
// In-Memory Cache (Per Invocation)
// ============================================

const geocodeCache = new Map<string, GeocodeResult>();

/**
 * Geocode with per-invocation caching
 * Reduces repeated API calls in the same Lambda execution
 */
export async function geocodeAddressCached(
  address: Address | string
): Promise<GeocodeResult> {
  const cacheKey = typeof address === 'string'
    ? address
    : JSON.stringify(address);

  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey)!;
  }

  const result = await geocodeAddress(address);
  geocodeCache.set(cacheKey, result);
  return result;
}
