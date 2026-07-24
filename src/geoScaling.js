import { findNearestCloudRegion, CLOUD_REGIONS } from './cloudRegions.js';
import { getValueFromObject } from '@cocreate/utils';

/**
 * Standard fallback coordinates for common region key identifiers
 */
const KNOWN_REGION_COORDINATES = {
    'us-east': { lat: 38.9489, lng: -77.4499 },
    'us-west': { lat: 45.8399, lng: -119.7006 },
    'eu-central': { lat: 50.1109, lng: 8.6821 },
    'eu-west': { lat: 51.5074, lng: -0.1278 },
    'ap-southeast': { lat: 1.3521, lng: 103.8198 },
    'ap-northeast': { lat: 35.6762, lng: 139.6503 },
    'sa-east': { lat: -23.5505, lng: -46.6333 },
    'ap-south': { lat: 19.0760, lng: 72.8777 }
};

/**
 * Calculates weighted geographic centroid (lat/lng) from active client location telemetry.
 * 
 * @param {Object} rawLocations - Map of regions or coordinates to active client counts
 * @returns {Object|null} Calculated centroid coordinates { lat, lng, totalWeight }
 */
export function calculateWeightedCentroid(rawLocations) {
    let totalWeight = 0;
    let weightedLatSum = 0;
    let weightedLngSum = 0;

    for (const [key, val] of Object.entries(rawLocations)) {
        const count = typeof val === 'number' ? val : (val.count || val.total || val.clients || 1);
        let coords = val.coords || val.coordinates;

        // Attempt coordinate resolution via dictionary or Cloud Region Registry
        if (!coords) {
            const normalizedKey = key.toLowerCase();
            if (KNOWN_REGION_COORDINATES[normalizedKey]) {
                coords = KNOWN_REGION_COORDINATES[normalizedKey];
            } else {
                const regionMatch = CLOUD_REGIONS.find(
                    r => r.region.toLowerCase() === normalizedKey || r.name.toLowerCase().includes(normalizedKey)
                );
                if (regionMatch) {
                    coords = { lat: regionMatch.lat, lng: regionMatch.lng };
                }
            }
        }

        if (coords && typeof coords.lat === 'number' && typeof coords.lng === 'number') {
            weightedLatSum += coords.lat * count;
            weightedLngSum += coords.lng * count;
            totalWeight += count;
        }
    }

    if (totalWeight === 0) return null;

    return {
        lat: weightedLatSum / totalWeight,
        lng: weightedLngSum / totalWeight,
        totalWeight
    };
}

/**
 * Aggregates client location distributions across active telemetry and server metrics,
 * determines the primary client density cluster, and matches the optimal cloud datacenter region.
 * 
 * @param {Object} telemetry - Current telemetry payload frame
 * @param {Object} autoscaleConfig - Configuration object
 * @param {Object} server - Server master instance
 * @returns {Object|null} Recommended geo target metadata
 */
export function calculateOptimalGeoLocation(telemetry, autoscaleConfig, server) {
    const isGeoScalingEnabled = getValueFromObject(autoscaleConfig, 'autoscale.geoScaling') !== false && 
                                getValueFromObject(autoscaleConfig, 'autoscale.geoScaling') !== 'false';

    if (!isGeoScalingEnabled) {
        return null;
    }

    // Extract aggregated client locations from telemetry payload or server state
    const rawLocations = telemetry?.clientLocations || 
                         telemetry?.locationAverages || 
                         server?.clientLocations || 
                         server?.clientAverageLocations || {};

    const entries = Object.entries(rawLocations);
    if (entries.length === 0) {
        console.log("[@cocreate/server-autoscaler] [GEO-SCALING] No client location data reported. Defaulting to provider default region.");
        return null;
    }

    let totalClients = 0;
    let dominantRegion = null;
    let maxCount = -1;

    // Tally client counts per region/timezone to identify the primary target cluster
    for (const [region, count] of entries) {
        const clientCount = typeof count === 'number' ? count : (count.total || count.clients || 0);
        totalClients += clientCount;

        if (clientCount > maxCount) {
            maxCount = clientCount;
            dominantRegion = region;
        }
    }

    if (!dominantRegion || totalClients === 0) {
        return null;
    }

    const densityPercentage = ((maxCount / totalClients) * 100).toFixed(1);

    // Calculate geographic centroid and lookup nearest cloud datacenter
    const centroid = calculateWeightedCentroid(rawLocations);
    let nearestCloud = null;

    if (centroid) {
        const preferredProviders = getValueFromObject(autoscaleConfig, 'autoscale.preferredProviders');
        nearestCloud = findNearestCloudRegion(centroid.lat, centroid.lng, {
            providers: Array.isArray(preferredProviders) ? preferredProviders : null
        });
    }

    console.log(`[@cocreate/server-autoscaler] [GEO-SCALING] Primary client density cluster identified: ${dominantRegion} (${maxCount}/${totalClients} clients, ${densityPercentage}% of load).`);

    if (nearestCloud) {
        console.log(`[@cocreate/server-autoscaler] [GEO-SCALING] Nearest optimal cloud datacenter matched: ${nearestCloud.provider.toUpperCase()} ${nearestCloud.region} (${nearestCloud.datacenterName}, ${nearestCloud.distanceKm} km away).`);
    }

    return {
        targetRegion: dominantRegion,
        densityPercentage: parseFloat(densityPercentage),
        primaryClientCount: maxCount,
        totalActiveClients: totalClients,
        locationBreakdown: rawLocations,
        centroid,
        nearestCloudRegion: nearestCloud,
        timestamp: Date.now()
    };
}

export default {
    calculateWeightedCentroid,
    calculateOptimalGeoLocation
};