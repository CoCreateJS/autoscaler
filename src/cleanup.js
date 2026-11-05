const failed = result => !result || result.success === false ||
    (Array.isArray(result.error) ? result.error.length : result.error);

/** Delete selected server inventory copies without revisiting the termination outcome. */
export async function deleteServer(server, serverId, {
    scopes = [{ organization_id: server.organization_id, host: server.host }],
    notifyManager = true
} = {}) {
    let result;
    for (const scope of scopes) {
        result = await server.crud.send({
            method: 'object.delete', array: 'servers', object: [{ _id: serverId }], ...scope
        });
        if (failed(result)) throw new Error(`Unable to delete server inventory ${serverId}.`);
    }
    if (notifyManager && server.manager?.organization_id) {
        const mirrored = await server.manager.send({
            method: 'object.delete', array: 'servers', object: { _id: serverId }
        });
        if (failed(mirrored)) throw new Error(`Unable to delete managed server inventory ${serverId}.`);
    }
    return result;
}

/** Collect only this cluster's committed retirements; failed records remain for investigation. */
export async function collectTerminatingServers(server) {
    if (!server.cluster_id) throw new Error('Server inventory cleanup requires a cluster ID.');
    const response = await server.crud.send({
        method: 'object.read', array: 'servers',
        filter: { query: { cluster_id: server.cluster_id, 'master.status': 'terminating' }, limit: 0 },
        organization_id: server.organization_id, host: server.host
    });
    if (failed(response) || !Array.isArray(response.object)) {
        throw new Error('Unable to read terminating server inventory.');
    }
    for (const record of response.object) {
        try { await deleteServer(server, record._id); }
        catch (error) {
            console.error('[@cocreate/autoscaler] Server inventory cleanup failed:', {
                server_id: record._id, cluster_id: server.cluster_id, error: error.message
            });
        }
    }
}

/** The first sweep runs ten minutes after initialization, not during startup. */
export function startServerCleanup(server) {
    const timer = setInterval(() => {
        collectTerminatingServers(server).catch(error => {
            console.error('[@cocreate/autoscaler] Terminating server sweep failed:', error.message);
        });
    }, 10 * 60 * 1000);
    timer.unref?.();
    return timer;
}
