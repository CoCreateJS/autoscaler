import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import config from '@cocreate/config';
import { init } from '../src/index.js';

async function setup(t, { managed = false, missing = false, readError = false, location = { latitude: 0, longitude: 0 } } = {}) {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    t.mock.method(console, 'log', () => {});
    const errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    t.mock.method(config, 'get', key => key === 'manager' ? { organization_id: 'platform', enabled: true } : undefined);
    const instances = [{ name: 'small', vCPU: 2, memoryGb: 4, default: true }];
    const scopes = [];
    t.mock.method(config, 'query', async scope => {
        scopes.push(scope);
        if (scope.type === 'clouds') return { aws: { instances, regions: [
            { region: 'near-demand', lat: 0, lng: 1 }, { region: 'near-pop', lat: 0, lng: 11 }
        ] } };
        if (scope.type === 'dns') return { bunny: [{ id: 'pop', latitude: 0, longitude: 10 }] };
        return {};
    });
    const saved = { _id: 'tenant-cluster', managedOrganization: 'tenant', host: 'tenant.test', startupScript: 'saved',
        clouds: ['tenant-cloud'], vertical: { enabled: true, min: { vCPU: 2, memoryGb: 4 },
            max: { vCPU: 8, memoryGb: 16 }, maxNodesPerTier: 2 } };
    const original = structuredClone(saved), requests = [], calls = [];
    const dispatch = async payload => { calls.push(payload); return { data: { id: 'i-first', server: { _id: 'new-node' } } }; };
    const server = Object.assign(new EventEmitter(), {
        id: 'node', organization_id: managed ? 'tenant' : 'platform', host: managed ? 'tenant.test' : 'platform.test', isPrimary: true,
        ...(managed && { manager: { organization_id: 'platform', send: dispatch } }),
        workflow: { run: dispatch }, api: { send() { assert.fail('Creation uses workflow dispatch'); } },
        crud: { async send(request) {
            requests.push(request);
            if (request.array === 'servers') return { object: [] };
            if (request.array === 'organizations') return { object: [{ _id: 'tenant', location }] };
            if (request.array === 'apis') return { object: request.filter.query.type === 'dns'
                ? [{ _id: 'bunny-api', name: 'Bunny', provider: 'bunny' }]
                : [{ _id: request.filter.query._id?.$in[0] || 'tenant-cloud', name: 'aws', provider: 'aws' }] };
            assert.equal(request.array, 'clusters');
            assert.equal(request.filter.query.managedOrganization, 'tenant');
            return readError ? { error: ['unavailable'] } : { object: missing ? [] : [saved] };
        } }
    });
    const autoscaler = await init(server);
    return { server, autoscaler, saved, original, requests, calls, errors, scopes };
}

test('organizationPeers generates the first deployment from organization coordinates and target-cluster policies', async t => {
    const { server, saved, original, requests, calls, errors, scopes } = await setup(t);
    await server.listeners('organizationPeers')[0]({ organization_id: 'tenant', peers: [] });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'workflow.createOrganizationServer');
    assert.deepEqual(calls[0].createOrganizationServer, { ...original, deployment: {
        cloud: 'tenant-cloud', region: 'near-pop', type: 'small', vCPU: 2, memoryGb: 4,
        dns: [{ id: 'pop', apiId: 'bunny-api', provider: 'bunny', latitude: 0, longitude: 10, distanceKm: 1112 }],
        location: { latitude: 0, longitude: 11 }
    } });
    assert.equal(requests.find(item => item.array === 'organizations').filter.query._id, 'tenant');
    assert.ok(scopes.some(scope => scope.cluster === 'tenant-cluster' && scope.organization_id === 'platform'));
    assert.deepEqual(saved, original);
    assert.deepEqual(errors, []);
});

for (const managed of [false, true]) {
    test(`coordinate launches use isolated target-cluster settings (managed: ${managed})`, async t => {
        const { autoscaler, saved, original, calls } = await setup(t, { managed });
        await Promise.all([
            autoscaler.scaleOut(saved, [], { latitude: 0, longitude: 0 }),
            autoscaler.scaleOut({ ...saved, _id: 'second-cluster', clouds: ['other-cloud'],
                vertical: { enabled: false } }, [], { latitude: 0, longitude: 30 })
        ]);
        assert.equal(calls[0].createOrganizationServer.deployment.cloud, 'tenant-cloud');
        assert.equal(calls[1].createOrganizationServer.deployment.cloud, 'other-cloud');
        assert.equal(calls[1].createOrganizationServer._id, 'second-cluster');
        assert.notEqual(calls[0], calls[1]);
        assert.deepEqual(saved, original);
    });
}

test('nonempty peers and the local organization do not launch a first node', async t => {
    const { server, calls } = await setup(t);
    const handler = server.listeners('organizationPeers')[0];
    await handler({ organization_id: 'tenant', peers: [{ _id: 'existing' }] });
    await handler({ organization_id: 'platform', peers: [] });
    assert.deepEqual(calls, []);
});
for (const options of [{ missing: true }, { readError: true }, { location: null },
    { location: { latitude: 91, longitude: 0 } }, { location: { latitude: 0, longitude: '0' } }]) {
    test(`unavailable cluster or invalid location does not dispatch: ${JSON.stringify(options)}`, async t => {
        const { server, calls } = await setup(t, options);
        await server.listeners('organizationPeers')[0]({ organization_id: 'tenant', peers: [] });
        assert.deepEqual(calls, []);
    });
}

test('managed tenants do not handle another organization’s peer activation', async t => {
    const { server } = await setup(t, { managed: true });
    assert.equal(server.listenerCount('organizationPeers'), 0);
});
