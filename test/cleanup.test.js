import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import config from '@cocreate/config';
import { EventEmitter } from 'node:events';
import { deleteServer, collectTerminatingServers } from '../src/cleanup.js';
import { init } from '../src/index.js';

function setup(managed = false) {
    const calls = [];
    const records = new Map([
        ['terminating', { _id: 'terminating', cluster_id: 'cluster', master: { status: 'terminating' } }],
        ['failed', { _id: 'failed', cluster_id: 'cluster', master: { status: 'failed' } }],
        ['running', { _id: 'running', cluster_id: 'cluster', master: { status: 'running' } }],
        ['provisioning', { _id: 'provisioning', cluster_id: 'cluster', master: { status: 'provisioning' } }],
        ['other', { _id: 'other', cluster_id: 'other-cluster', master: { status: 'terminating' } }]
    ]);
    const server = {
        mesh: new EventEmitter(),
        id: 'running', cluster_id: 'cluster', organization_id: 'tenant', host: 'tenant.test', on() {},
        crud: { send: async request => {
            calls.push(request);
            if (request.array === 'clusters') return { object: [{ _id: 'cluster', clouds: [] }] };
            if (request.method === 'object.read') {
                const query = request.filter.query;
                return { object: [...records.values()].filter(record => query._id ? record._id === query._id :
                    record.cluster_id === query.cluster_id && record.master.status === query['master.status']) };
            }
            const deleted = request.object.flatMap(({ _id }) => {
                const record = records.get(_id);
                records.delete(_id);
                return record ? [record] : [];
            });
            return { object: deleted };
        } }
    };
    const mirrors = [];
    if (managed) server.manager = {
        organization_id: 'platform', send: async request => { mirrors.push(request); return { object: [] }; }
    };
    return { server, records, calls, mirrors };
}

test('sweep deletes only its own terminating inventory and does not reread each server', async () => {
    const { server, records, calls } = setup();
    await collectTerminatingServers(server);
    assert.deepEqual([...records.keys()], ['failed', 'running', 'provisioning', 'other']);
    assert.deepEqual(calls.map(call => call.method), ['object.read', 'object.delete']);
    assert.deepEqual(calls[0].filter.query, { cluster_id: 'cluster', 'master.status': 'terminating' });
    assert.equal(calls[1].organization_id, 'tenant');
});

test('managed local deletion also asks Manager to delete its copy; duplicate deletes succeed', async () => {
    const { server, calls, mirrors } = setup(true);
    await deleteServer(server, 'terminating');
    await deleteServer(server, 'terminating');
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => call.method === 'object.delete'));
    assert.deepEqual(mirrors, Array(2).fill({
        method: 'object.delete', array: 'servers', object: { _id: 'terminating' }
    }));
});

test('parent cleanup deletes tenant before platform, with no status read or mirror loop', async () => {
    const { server, calls, mirrors } = setup(true);
    await deleteServer(server, 'terminating', {
        scopes: [{ organization_id: 'tenant', host: 'tenant.test' }, { organization_id: 'platform', host: 'platform.test' }],
        notifyManager: false
    });
    assert.deepEqual(calls.map(call => call.organization_id), ['tenant', 'platform']);
    assert.ok(calls.every(call => call.method === 'object.delete'));
    assert.deepEqual(mirrors, []);
});

test('an actual tenant deletion failure keeps the platform copy available', async () => {
    const { server } = setup();
    const calls = [];
    server.crud.send = async request => { calls.push(request); return { error: ['Unavailable'] }; };
    await assert.rejects(deleteServer(server, 'terminating', {
        scopes: [{ organization_id: 'tenant' }, { organization_id: 'platform' }], notifyManager: false
    }), /Unable to delete/);
    assert.equal(calls.length, 1);
});

test('AutoScaler init schedules the first sweep at ten minutes and repeats, even with scaling disabled', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    t.mock.method(config, 'get', async () => undefined);
    t.mock.method(config, 'query', async () => undefined);
    const { server, calls, records } = setup();
    const autoscaler = await init(server);
    const sweeps = () => calls.filter(call => call.filter?.query['master.status'] === 'terminating');
    assert.equal(typeof autoscaler.deleteServer, 'function');
    assert.equal(sweeps().length, 0);
    t.mock.timers.tick(599999);
    await setImmediate();
    assert.equal(sweeps().length, 0);
    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal(sweeps().length, 1);
    assert.equal(records.has('terminating'), false);
    t.mock.timers.tick(600000);
    await setImmediate();
    assert.equal(sweeps().length, 2);
    assert.equal(records.has('failed'), true);
});

test('sweep reports deletion failures and continues collecting other records', async t => {
    const { server } = setup();
    const logs = [], deleted = [];
    t.mock.method(console, 'error', (...args) => logs.push(args));
    server.crud.send = async request => {
        if (request.method === 'object.read') return { object: [{ _id: 'bad' }, { _id: 'good' }] };
        deleted.push(request.object[0]._id);
        return request.object[0]._id === 'bad' ? { error: ['Unavailable'] } : { object: [] };
    };
    await collectTerminatingServers(server);
    assert.deepEqual(deleted, ['bad', 'good']);
    assert.equal(logs.length, 1);
});
