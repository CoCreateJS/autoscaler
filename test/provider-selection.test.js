import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import config from '@cocreate/config';
import { init, resolveClusterConfig, determineDeployment } from '../src/index.js';

const instances = [{ name: 'small', vCPU: 2, memoryGb: 4, default: true }];
const catalogs = {
    clouds: {
        aws: { instances, regions: [{ region: 'aws-region', lat: 0, lng: 1 }] },
        gcp: { instances, regions: [{ region: 'gcp-region', lat: 0, lng: 11 }] }
    },
    dns: {
        bunny: [{ id: 'bunny-pop', latitude: 0, longitude: 10 }],
        cloudflare: [{ id: 'cf-pop', latitude: 0, longitude: 1 }],
        unconnected: [{ id: 'unconnected-pop', latitude: 0, longitude: 0 }]
    }
};
const apis = [
    { _id: 'aws-api', name: 'aws', provider: 'aws', type: 'cloud', enabled: true },
    { _id: 'gcp-api', name: 'gcp', provider: 'gcp', type: 'cloud', enabled: true },
    { _id: 'disabled-cloud', provider: 'aws', type: 'cloud', enabled: false },
    { _id: 'bunny-api', provider: 'bunny', type: 'dns', enabled: true, apiKey: 'test-secret' },
    { _id: 'cf-api', provider: 'cloudflare', type: 'dns', enabled: true },
    { _id: 'disabled-route', provider: 'bunny', type: 'dns', enabled: false }
];
async function setup(t, { records = apis, apiError = false } = {}) {
    t.mock.timers.enable({ apis: ['setInterval'] });
    t.mock.method(console, 'log', () => {});
    t.mock.method(config, 'get', () => undefined);
    t.mock.method(config, 'query', async ({ type }) => structuredClone(catalogs[type] || {}));
    const requests = [];
    await init(Object.assign(new EventEmitter(), {
        organization_id: 'platform', host: 'platform.test',
        crud: { async send(request) {
            requests.push(request);
            if (apiError) return { error: ['unavailable'] };
            const query = request.filter.query;
            return { object: records.filter(api => api.type === query.type && api.enabled === true &&
                (!query._id || query._id.$in.includes(api._id))) };
        } }
    }));
    return requests;
}

for (const selection of [undefined, '', []]) {
    test(`empty cloud and dns selections use all enabled connections: ${JSON.stringify(selection)}`, async t => {
        const requests = await setup(t);
        const cluster = { _id: 'cluster', clouds: selection, dns: selection };
        const original = structuredClone(cluster);
        const resolved = await resolveClusterConfig(cluster);
        assert.deepEqual(resolved.allowedApis.map(api => api._id), ['aws-api', 'gcp-api']);
        const target = await determineDeployment({ latitude: 0, longitude: 0 }, [], resolved);
        assert.equal(target.apiId, 'aws-api');
        assert.deepEqual(target.dns.map(pop => pop.apiId), ['cf-api', 'bunny-api']);
        assert.ok(!JSON.stringify(target).includes('test-secret'));
        assert.deepEqual(cluster, original);
        for (const request of requests) {
            assert.equal(request.organization_id, 'platform');
            assert.equal(request.filter.query.enabled, true);
            assert.equal(request.filter.limit, 0);
            assert.equal(request.filter.query._id, undefined);
        }
    });
}
for (const asString of [false, true]) {
    test(`nonempty selections restrict both connections (single string: ${asString})`, async t => {
        await setup(t);
        const resolved = await resolveClusterConfig({ _id: 'cluster',
            clouds: asString ? 'gcp-api' : ['gcp-api'], dns: asString ? 'bunny-api' : ['bunny-api'] });
        const target = await determineDeployment({ latitude: 0, longitude: 0 }, [], resolved);
        assert.equal(target.apiId, 'gcp-api');
        assert.equal(target.region, 'gcp-region');
        assert.deepEqual(target.dns.map(pop => pop.apiId), ['bunny-api']);
    });
}
for (const dns of [['missing'], ['disabled-route'], ['aws-api']]) {
    test(`an unusable dns whitelist fails instead of broadening: ${dns}`, async t => {
        await setup(t);
        await assert.rejects(resolveClusterConfig({ _id: 'cluster', dns }), /No eligible DNS/);
    });
}
for (const clouds of [['missing'], ['disabled-cloud'], ['cf-api']]) {
    test(`an unusable cloud whitelist fails instead of broadening: ${clouds}`, async t => {
        await setup(t);
        const resolved = await resolveClusterConfig({ _id: 'cluster', clouds });
        await assert.rejects(determineDeployment({ latitude: 0, longitude: 0 }, [], resolved), /enabled cloud APIs/);
    });
}

test('no enabled dns connections gives direct cloud placement', async t => {
    await setup(t, { records: apis.filter(api => api.type === 'cloud') });
    const resolved = await resolveClusterConfig({ _id: 'cluster', clouds: [], dns: [] });
    const target = await determineDeployment({ latitude: 0, longitude: 0 }, [], resolved);
    assert.deepEqual(target.dns, []);
    assert.equal(target.apiId, 'aws-api');
});

test('two dns connections to one provider retain their separate API identities', async t => {
    await setup(t, { records: [...apis, { _id: 'bunny-two', provider: 'bunny', type: 'dns', enabled: true }] });
    const resolved = await resolveClusterConfig({ _id: 'cluster', dns: ['bunny-api', 'bunny-two'] });
    const target = await determineDeployment({ latitude: 0, longitude: 0 }, [], resolved);
    assert.deepEqual(target.dns.map(pop => pop.apiId), ['bunny-api', 'bunny-two']);
    assert.deepEqual(target.dns.map(pop => pop.id), ['bunny-pop', 'bunny-pop']);
});

test('API read errors stop resolution rather than looking like an unrestricted empty list', async t => {
    await assert.rejects(setup(t, { apiError: true }), /Unable to read cluster/);
});
