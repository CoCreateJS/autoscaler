import getCloudProvider from './geoScaling.js';

/**
 * Mock dataset of active client connections with geographic telemetry
 * (50% Northern Europe, 25% Northern Africa, 25% Middle East).
 */
export const MOCK_CLIENTS = [
    // Northern Europe Cluster (50% total load)
    {
        clientInfo: {
            latitude: 59.3293,
            longitude: 18.0686,
            countryCode: 'SE',
            timezone: 'Europe/Stockholm'
        },
        count: 20
    },
    {
        clientInfo: {
            latitude: 50.1109,
            longitude: 8.6821,
            countryCode: 'DE',
            timezone: 'Europe/Berlin'
        },
        count: 15
    },
    {
        clientInfo: {
            latitude: 51.5074,
            longitude: -0.1278,
            countryCode: 'GB',
            timezone: 'Europe/London'
        },
        count: 15
    },

    // Northern Africa Cluster (25% total load)
    {
        clientInfo: {
            latitude: 30.0444,
            longitude: 31.2357,
            countryCode: 'EG',
            timezone: 'Africa/Cairo'
        },
        count: 15
    },
    {
        clientInfo: {
            latitude: 33.5731,
            longitude: -7.5898,
            countryCode: 'MA',
            timezone: 'Africa/Casablanca'
        },
        count: 10
    },

    // Middle East Cluster (25% total load)
    {
        clientInfo: {
            latitude: 25.2048,
            longitude: 55.2708,
            countryCode: 'AE',
            timezone: 'Asia/Dubai'
        },
        count: 15
    },
    {
        clientInfo: {
            latitude: 24.7136,
            longitude: 46.6753,
            countryCode: 'SA',
            timezone: 'Asia/Riyadh'
        },
        count: 10
    }
];

/**
 * Immediate Execution Function (Runs on script load)
 * Evaluates strict continent isolation vs multi-region EMEA aggregation.
 */
function runGeoScalingTest() {
    console.log("==================================================");
    console.log("[GeoScaling Test] Scenario: 50% Northern Europe | 25% North Africa | 25% Middle East");
    console.log("==================================================");

    // Test 1: Strict continent isolation (dominant cluster only)
    console.log("\n--- TEST 1: Strict Continent Isolation (dominantClusterOnly: true) ---");
    const strictResult = getCloudProvider(MOCK_CLIENTS, { dominantClusterOnly: true });

    if (strictResult && strictResult.nearestCloudRegion) {
        console.log(`- Dominant Continent: ${strictResult.dominantContinent} (${strictResult.dominantPercentage}% of load)`);
        console.log(`- Matched Datacenter: ${strictResult.nearestCloudRegion.provider.toUpperCase()} ${strictResult.nearestCloudRegion.region} (${strictResult.nearestCloudRegion.datacenterName})`);
        console.log(`- Regional Centroid Coords: (${strictResult.regionalCentroid.lat.toFixed(4)}, ${strictResult.regionalCentroid.lng.toFixed(4)})`);
    }

    // Test 2: Combined Macro-Region / Centroid (EMEA unified cluster)
    console.log("\n--- TEST 2: Combined EMEA / Inter-continental Centroid (dominantClusterOnly: false) ---");
    const combinedResult = getCloudProvider(MOCK_CLIENTS, { dominantClusterOnly: false });

    if (combinedResult && combinedResult.nearestCloudRegion) {
        console.log(`- Global EMEA Centroid Coords: (${combinedResult.globalCentroid.lat.toFixed(4)}, ${combinedResult.globalCentroid.lng.toFixed(4)})`);
        console.log(`- Matched Datacenter: ${combinedResult.nearestCloudRegion.provider.toUpperCase()} ${combinedResult.nearestCloudRegion.region} (${combinedResult.nearestCloudRegion.datacenterName})`);
        console.log(`- Balanced Centroid Distance: ${combinedResult.nearestCloudRegion.distanceKm} km`);
    }

    return { strictResult, combinedResult };
}

// Execute on script load
const autoRunResult = runGeoScalingTest();

export default autoRunResult;