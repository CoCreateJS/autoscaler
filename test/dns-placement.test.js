import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { getCloudProvider, getDensityTarget, selectPlacement, loadCloudProviders, loadDnsLocations } from '../src/geoScaling.js';
import { query } from '../../config/src/core.js';
import { dotNotationToObject } from '../../utils/src/modules/dotNotationToObject.js';
import { getValueFromObject } from '../../utils/src/modules/getValueFromObject.js';
import bunnySeed from '../../../CoCreate-app/src/apps/server-configs/config/dns/bunny.js';

const clients = [{ latitude: 0, longitude: 0, count: 100, continent: 'AF' }];
const instances = [{ name: 'small', vCPU: 2, memoryGb: 4, default: true }];
const cloudProviders = [
    { provider: 'aws', region: 'near-demand', lat: 0, lng: 1, instances },
    { provider: 'aws', region: 'near-dns', lat: 0, lng: 11, instances }
];
const location = (id, longitude, extra = {}) => ({ id, latitude: 0, longitude, ...extra });

for (const geoScaleByContinent of [false, true]) {
    test(`dns first changes the cloud choice (continent mode: ${geoScaleByContinent})`, () => {
        const result = getCloudProvider(clients, {
            cloudProviders, geoScaleByContinent, sheddingThreshold: 20,
            autoscaleConfig: { dns: {
                bunny: [location('far-bunny', 40), location(1, 20)],
                cloudflare: [location('far-cloudflare', 15), location('disabled', 0, { enabled: false }), location('pop-2', 10)],
                dnsimple: [location('pop-3', 30)]
            } }
        });
        assert.equal(result.targetCentroid.longitude, 0);
        assert.equal(result.dns[0].provider, 'cloudflare');
        assert.equal(result.dns[0].id, 'pop-2');
        assert.deepEqual(result.dns.map(pop => pop.provider), ['cloudflare', 'bunny', 'dnsimple']);
        assert.deepEqual(result.dns.map(pop => pop.id), ['pop-2', 1, 'pop-3']);
        assert.equal(result.nearestCloudRegion.region, 'near-dns');
        assert.equal(result.nearestCloudRegion.distanceKm, 111);
        assert.equal(result.dns[0].distanceKm, 1112);
        if (geoScaleByContinent) {
            assert.equal(result.targetContinent, 'AF');
            assert.equal(result.isSheddingTarget, true);
        }
    });
}

test('POP ordering uses exact distances even when displayed kilometres round to the same value', () => {
    const dns = { bunny: [location(1, 0.0009)], cloudflare: [location(2, 0.0001)] };
    const original = structuredClone(dns);
    const result = getCloudProvider(clients, { cloudProviders, autoscaleConfig: { dns } });
    assert.deepEqual(result.dns.map(pop => pop.provider), ['cloudflare', 'bunny']);
    assert.deepEqual(result.dns.map(pop => pop.distanceKm), [0, 0]);
    assert.deepEqual(dns, original);
});

for (const dns of [undefined, {}, { bunny: [] }, 'dns-api-id', ['dns-api-id'], {
    bunny: [
        location(1, 10, { enabled: false }),
        location(2, 10, { allowLatencyRouting: false }),
        location(3, NaN)
    ]
}]) {
    test(`no eligible dns locations preserves direct placement: ${JSON.stringify(dns)}`, () => {
        const result = getCloudProvider(clients, { cloudProviders, autoscaleConfig: { dns } });
        assert.deepEqual(result.dns, []);
        assert.equal(result.nearestCloudRegion.region, 'near-demand');
    });
}

test('a closer disabled location cannot displace an eligible dns location', () => {
    const result = getCloudProvider(clients, { cloudProviders, autoscaleConfig: { dns: {
        bunny: [location(1, 1, { allowLatencyRouting: false }), location(2, 10)]
    } } });
    assert.equal(result.dns[0].id, 2);
    assert.equal(result.nearestCloudRegion.region, 'near-dns');
});

test('the normalized Bunny catalog works with the existing demand location shape', () => {
    const result = getCloudProvider([{ latitude: 51.5073509, longitude: -0.127758299999982 }], {
        cloudProviders,
        autoscaleConfig: { dns: bunnySeed.object[0].config }
    });
    assert.equal(result.dns[0].id, 1);
    assert.equal(result.dns[0].provider, 'bunny');
    assert.equal(result.dns[0].distanceKm, 0);
});

test('scoped enabled catalogs load separately and drive placement through VM sizing', async () => {
    const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
    const extract = name => {
        const start = source.indexOf(`export async function ${name}(`);
        return source.slice(start, source.indexOf('\n/**', start)).replace('export async function', 'async function');
    };
    const requests = [];
    const records = [
        { type: 'startupscript', enabled: true, cluster: '*', config: { startupScript: 'stale global template' } },
        { type: 'clouds', enabled: true, cluster: '*', config: { aws: {
            instances, regions: cloudProviders
        } } },
        { type: 'dns', enabled: true, cluster: '*', config: { bunny: [location(1, 20)] } },
        { type: 'dns', enabled: true, cluster: 'cluster-1', config: { cloudflare: [location(2, 10)] } },
        { type: 'dns', enabled: false, config: { disabled: [location(3, 0)] } },
        { type: 'dns', enabled: true, cluster: 'other-cluster', config: { other: [location(4, 0)] } }
    ];
    const server = {
        cluster_id: 'cluster-1', organization_id: 'tenant-1', host: 'tenant.test',
        crud: { async send(request) {
            requests.push(request);
            if (request.array === 'clusters') return { object: [{
                _id: 'cluster-1', clouds: ['aws-api'], autoscaling: { enabled: true }, startupScript: 'saved cluster script'
            }] };
            if (request.array === 'apis') return { object: request.filter.query.type === 'dns'
                ? [{ _id: 'bunny-api', provider: 'bunny' }, { _id: 'cloudflare-api', provider: 'cloudflare' }]
                : [{ _id: 'aws-api', name: 'aws-account', provider: 'aws' }] };
            const filter = request.filter.query;
            const types = filter.type.$in || [filter.type];
            return { object: records.filter(record => types.includes(record.type) && record.enabled === filter.enabled) };
        } }
    };
    const context = vm.createContext({
        server, config: { get: () => undefined, query },
        dotNotationToObject, getValueFromObject, getCloudProvider, getDensityTarget, selectPlacement, loadCloudProviders, loadDnsLocations,
        allowedApis: [], autoscaleConfig: {}, clusterConfig: null, clusterHost: undefined, structuredClone,
        isAutoscalingEnabled: () => true, console: { log() {} }
    });
    vm.runInContext(`${extract('resolveClusterConfig')}\n${extract('loadAutoscaleConfig')}\n${extract('determineDeployment')}\n${extract('determineScaleOutTarget')}`, context);
    const resolved = await context.loadAutoscaleConfig();
    assert.equal(resolved.startupScript, 'saved cluster script');
    assert.deepEqual(Object.keys(resolved.dns), ['bunny', 'cloudflare']);
    const result = await context.determineScaleOutTarget(clients, []);
    assert.equal(result.dns[0].provider, 'cloudflare');
    assert.equal(result.dns[0].id, 2);
    assert.equal(result.region, 'near-dns');
    assert.equal(result.apiId, 'aws-api');
    assert.equal(result.provider, 'aws-account');
    assert.equal(result.type, 'small');
    assert.equal(result.vCPU, 2);
    assert.equal(result.memoryGb, 4);
    for (const request of requests.filter(item => item.array === 'servers_config')) {
        assert.equal(request.organization_id, 'tenant-1');
        assert.equal(request.filter.query.enabled, true);
        assert.notEqual(request.filter.query.type, 'startupscript');
        assert.equal(request.filter.query.type?.$in?.includes('startupscript') || false, false);
    }
});

for (const managed of [false, true]) {
    test(`scale-out passes the saved cluster and current deployment to the workflow (managed: ${managed})`, async () => {
        const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
        const start = source.indexOf('export async function scaleOut(');
        const implementation = source.slice(start, source.indexOf('\n/**', start)).replace('export async function', 'async function');
        const dispatchStart = source.indexOf('export async function runWorkflow(');
        const dispatch = source.slice(dispatchStart, source.indexOf('\n/**', dispatchStart)).replace('export async function', 'async function');
        const clusterConfig = { _id: 'cluster', clouds: ['cloud-api'], startupScript: 'saved',
            deployment: { cloud: 'initial-api', region: 'initial-region', type: 'initial-vm', dns: { provider: 'old', id: 'old-pop' }, stale: true } };
        const savedCluster = structuredClone(clusterConfig);
        const requests = [];
        const dns = [{ provider: 'bunny', id: 1, latitude: 51.5, longitude: -0.12, distanceKm: 12 }];
        const send = async payload => { requests.push(JSON.parse(JSON.stringify(payload))); return { data: { id: 'i-1' } }; };
        const context = vm.createContext({ clusterConfig,
            server: { organization_id: 'tenant', host: 'tenant.test',
                ...(managed ? { manager: { organization_id: 'platform', send } } : { workflow: { run: send } }) },
            determineScaleOutTarget: async () => ({ apiId: 'cloud-api', region: 'new-region', type: 'new-vm', vCPU: 2, memoryGb: 4, dns })
        });
        vm.runInContext(`${dispatch}\n${implementation}`, context);
        await context.scaleOut([], []);
        assert.equal(requests[0].method, 'workflow.createOrganizationServer');
        assert.deepEqual(requests[0].createOrganizationServer.clouds, ['cloud-api']);
        assert.equal(requests[0].createOrganizationServer.startupScript, 'saved');
        assert.equal(requests[0].createOrganizationServer.deployment.region, 'new-region');
        assert.deepEqual(requests[0].createOrganizationServer.deployment.dns, dns);
        assert.deepEqual(clusterConfig, savedCluster);
        assert.equal(requests[0].createOrganizationServer.deployment.stale, undefined);
        assert.equal(requests[0].createOrganizationServer.deployment.type, 'new-vm');
    });
}


test('density produces coordinates without consulting placement catalogs', () => {
    const density = getDensityTarget(clients, { get cloudProviders() { assert.fail('Density does not read clouds'); } });
    assert.deepEqual(density.targetCentroid, { latitude: 0, longitude: 0, totalWeight: 100 });
    assert.equal('dns' in density, false);
    assert.equal('nearestCloudRegion' in density, false);
    const origin = Object.freeze({ latitude: 0, longitude: 0 });
    const direct = selectPlacement(origin, { cloudProviders });
    assert.equal(direct.nearestCloudRegion.region, 'near-demand');
    assert.deepEqual(direct.dns, []);
});

test('an empty allowed cloud catalog cannot fall back to unrestricted providers', () => {
    const result = selectPlacement({ latitude: 0, longitude: 0 }, {
        cloudProviders: [], autoscaleConfig: { clouds: { aws: { regions: cloudProviders, instances } } }
    });
    assert.equal(result.nearestCloudRegion, null);
});
