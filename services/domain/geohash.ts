import * as geohash from 'ngeohash';

export interface Coordinates {
  lat: number;
  lon: number;
}

/**
 * Encode coordinates to geohash
 */
export function encode(coords: Coordinates, precision: number = 6): string {
  return geohash.encode(coords.lat, coords.lon, precision);
}

/**
 * Decode geohash to coordinates
 */
export function decode(hash: string): Coordinates {
  const decoded = geohash.decode(hash);
  return {
    lat: decoded.latitude,
    lon: decoded.longitude,
  };
}

/**
 * Get geohash prefixes for a given radius
 * Returns array of prefixes that cover the area
 */
export function getPrefixesForRadius(coords: Coordinates, radiusMiles: number): string[] {
  // Rough approximation: 1 mile ≈ 1.6 km
  const radiusKm = radiusMiles * 1.6;

  // Geohash precision to km mapping (approximate)
  // precision 4: ±20km, precision 5: ±2.4km, precision 6: ±0.61km
  let precision = 6;
  if (radiusKm > 20) precision = 4;
  else if (radiusKm > 10) precision = 5;

  const centerHash = encode(coords, precision);

  // Get neighbors to cover the area
  const neighbors = geohash.neighbors(centerHash);
  const prefixes = [centerHash, ...Object.values(neighbors)];

  return prefixes;
}

/**
 * Calculate haversine distance between two coordinates in miles
 */
export function haversineDistance(coord1: Coordinates, coord2: Coordinates): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = toRadians(coord2.lat - coord1.lat);
  const dLon = toRadians(coord2.lon - coord1.lon);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(coord1.lat)) *
      Math.cos(toRadians(coord2.lat)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);

  const c = 2 * Math.asin(Math.sqrt(a));
  return R * c;
}

function toRadians(degrees: number): number {
  return degrees * (Math.PI / 180);
}

/**
 * Check if a point is within a radius of another point
 */
export function isWithinRadius(
  center: Coordinates,
  point: Coordinates,
  radiusMiles: number
): boolean {
  const distance = haversineDistance(center, point);
  return distance <= radiusMiles;
}
