# CoCreate Server Autoscaler

A decentralized, self-healing, and autonomous cluster lifecycle manager designed for high-performance multi-tenant ecosystems. Driven directly by real-time telemetry metrics, this module orchestrates vertical and horizontal scaling across top cloud providers using a peer-to-peer, masterless replication model.

---

## Documentation

For advanced cloud provider configurations, identity IAM role policies, and threshold triggers, refer to the [CoCreate Server Autoscaler Documentation](https://cocreatejs.com/docs/autoscaler).

## Table of Contents

* [The Masterless Replicating Node Architecture](#the-masterless-replicating-node-architecture)
* [Why CoCreate Server Autoscaler?](#why-cocreate-autoscaler)
* [Vertical & Horizontal Multi-Cloud Adaptability](#vertical--horizontal-multi-cloud-adaptability)
* [Self-Healing & Telemetry-Driven Lifecycle](#self-healing--telemetry-driven-lifecycle)
* [Cooperative Draining & Scale-Down Sequence](#cooperative-draining--scale-down-sequence)
* [Configuration](#configuration)
* [Installation](#installation)
* [Announcements](#announcements)
* [Roadmap](#roadmap)
* [How to Contribute](#how-to-contribute)
* [About](#about)

---

## The Masterless Replicating Node Architecture

Traditional autoscaling relies on a centralized coordinator or a dedicated third-party master server (like a Kubernetes Control Plane or a custom Orchestrator VM) to monitor worker health and issue creation commands. If that master node crashes, the entire cluster's scaling capabilities freeze.

`@cocreate/autoscaler` implements a **Decentralized, Peer-to-Peer (P2P) Replication Model**:

* **Every Node is Both Master and Worker:** There are no specialized roles. Each node independently monitors its own resource limits, registers its state within the shared platform database, and monitors peer health via the `@cocreate/server-mesh` Control Plane.
* **Autonomous Self-Replication:** If a node detects cluster-wide saturation or localized system boundaries, it doesn't wait for a central master to act. It directly contacts your cloud provider's API to clone its own VM image, dynamically spawning an exact sibling node to scale out immediately:

$$\text{Resource Boundary Tripped} \implies \text{Node } A \xrightarrow{\text{Direct Cloud API Call}} \text{Clone VM Image} \implies \text{Spawn Sibling Node } B$$

* **Zero Single Point of Failure (SPOF):** If any node drops offline or crashes, surviving peer nodes detect the loss of its keep-alive heartbeat on the mesh control plane and dynamically adjust scaling priorities.

---

## Why CoCreate Server Autoscaler?

Unlike standard cloud-native autoscaling groups (like AWS ASGs) that only monitor generic hypervisor metrics like raw CPU and ignore application-level boundaries, `@cocreate/autoscaler` is tightly integrated with the CoCreate core.

It understands **Multi-Tenant Boundaries** and **WebSocket Connection States**. It makes scaling decisions based on real-time transaction lag, active user session counts, and memory footprints rather than inaccurate system-level averages.

---

## Vertical & Horizontal Multi-Cloud Adaptability

The autoscaler features a robust, pluggable **Cloud Adapter Plane** that supports standard vertical and horizontal orchestrations across all major cloud hosting platforms (AWS, Google Cloud, Azure, DigitalOcean, and Vultr).

### 1. Horizontal Scaling (Scale In / Scale Out)

* Spawns identical replica instances (cloned VM images or container instances) to distribute multi-tenant WebSocket connections across more physical servers.
* Automatically registers new nodes with the `@cocreate/server-mesh` peer list upon boot.

### 2. Vertical Scaling (Scale Up / Scale Down)

* For cloud providers that support hot-swapping virtual resources, the autoscaler can programmatically upgrade instance tiers (increasing CPU/RAM limits) on-the-fly.
* If a hot-swap is not supported, it performs a seamless rolling vertical upgrade: it spawns a larger tier node, drains the smaller node, and terminates the old instance.

---

## Self-Healing & Telemetry-Driven Lifecycle

The autoscaler connects directly to the local `@cocreate/telemetry` Data Engine pipeline. It processes system telemetry metrics to continuously calculate a weighted saturation index:

$$\text{Saturation Index} = \alpha \cdot \text{V8 CPU Lag} + \beta \cdot \text{RAM Utilization} + \gamma \cdot \text{Socket Density}$$

* **Self-Healing Interventions:** If the Saturation Index exceeds your configured safety threshold for a sustained period, the autoscaler initiates scaling protocols.
* **Dead-Node Pruning:** When a peer server drops offline without a clean exit (e.g., hardware failure or kernel panic), the active nodes wait for a stagger delay before pruning the dead node's records from the database registry and redistributing tenant dns channels.

---

## Cooperative Draining & Scale-Down Sequence

To prevent cutting off active user sessions during a scale-down event, the autoscaler uses a secure, decoupled **Cooperative Draining** mechanism:

```text
       [Autoscaler Trigger]
                │
                ▼
      [Cordon Target Node] ────► [HTTP Returns 307 Redirects] ────► [WebSocket Clients Migrated]
                │
                ▼
     [Telemetry Zero Check] ───► [Flush Final Billing Data] ─────► [Clean VM Termination]
```

* **The Cordon Command:** The autoscaler flags the targeted node as `isCordon = true` via the secure control plane.
* **Session Migration:** The target server's HTTP gateway begins returning `307 Temporary Redirect` responses. It calls `.destroyAll()` on the local `SocketServer` to safely disconnect users, forcing their browsers to reconnect to other online sibling nodes.
* **Standby Verification:** The autoscaler monitors the target server's status in the database. Once the node reports `activeConnections: 0`, its buffers are fully flushed, and its database pools are closed, the autoscaler securely calls the cloud provider's API to destroy the instance.

---

## Configuration

Configure the autoscaler with the following policy structure. Cloud-provider connection details remain in the provider API configuration.

```json
{
  "scaleOut": {
    "cpuThreshold": 85,
    "memoryThreshold": 85,
    "consecutiveFlushes": 3,
    "maxClusterSize": 0
  },
  "scaleIn": {
    "cpuThreshold": 10,
    "memoryThreshold": 45,
    "consecutiveFlushes": 10,
    "preservation": "continent",
    "minClusterSize": 2,
    "decommissionStrategy": "oldest"
  },
  "geoScale": {
    "enabled": true,
    "sheddingThreshold": 20,
    "densityBy": "continent"
  },
  "vertical": {
    "enabled": true,
    "maxNodesPerTier": 2,
    "min": { "vCPU": 1, "memoryGb": 2 },
    "max": { "vCPU": 64, "memoryGb": 256 }
  }
}
```

### Vertical resource bounds

`vertical.min` defines the first server size and `vertical.max` defines the upper resource boundary. The autoscaler can add up to `maxNodesPerTier` regional servers at the current size. Once that count is reached, the next target doubles the current vCPU and memory values, capped independently by their configured maximums. The cloud adapter then selects the smallest available provider instance that satisfies both target values.

`getDensityTarget` calculates the demand centroid using the existing global or
continent-based policy. When enabled, scoped `servers_config` records of type
`dns` provide eligible locations. The autoscaler chooses one nearest POP per DNS connection,
sorts the selections by their exact distance from the demand centroid, and uses the first
POP to select the nearest allowed cloud region.
Without eligible DNS locations, it selects the cloud region directly from
the demand centroid. Instance sizing follows the selected cloud region as before.

DNS catalogs are merged into `dns`, keyed by provider, with arrays of
normalized locations containing `id`, `latitude`, `longitude`, and optional
`name`, `countryCode`, and `continent` fields. Locations marked `enabled: false`
or `allowLatencyRouting: false`, or missing finite coordinates, are excluded.
Cloud catalogs are loaded separately from records of type `clouds`; both catalog
queries use the same organization and runtime scope as the autoscaler settings.
The scale-out decision includes the sorted `dns` array. Each POP retains its provider,
location ID, connection `apiId`, coordinates and metadata. Each `distanceKm` measures demand-to-POP distance;
the decision's top-level `distanceKm` measures first-POP-to-cloud distance, or
demand-to-cloud distance when dns is empty. No eligible POPs produces `dns: []`.
The complete array travels in `deployment.dns` and is stored as `server.deployment.dns`.


### Decommission strategy

`scaleIn.decommissionStrategy` supports two values:

* `oldest` selects the active server with the earliest `created.on` timestamp. When that timestamp is unavailable, the timestamp embedded in a MongoDB ObjectId is used as a deterministic fallback.
* `local` selects the server running the autoscaler, allowing an eligible node to decommission itself autonomously. If that server is not present in the active cluster records, scale-in is rejected rather than targeting another node.

Unrecognized strategy values safely fall back to `oldest`.

---

## Installation

You can install this package locally via npm:

```bash
npm i @cocreate/autoscaler
```

Or via yarn:

```bash
yarn add @cocreate/autoscaler
```

---

## Announcements

All scaling adaptations, cloud adapter API patches, and metric evaluation revisions are tracked inside our release logs on the [CoCreate Server Autoscaler GitHub Releases](https://github.com/CoCreateJS/autoscaler/releases) page. Please subscribe to our release notifications for breaking updates on cloud provider parameters.

---

## Roadmap

Upcoming enhancements planned for our autonomous scaling system include:

* **Predictive Scaling Engine:** Utilizing linear regression models on historical time-series telemetry to preemptively scale up cluster capacity before scheduled traffic spikes.
* **Kubernetes KEDA Adapter:** Native scaling support for containerized Kubernetes workloads using CoCreate telemetry events as custom HPA metrics.

---

## How to Contribute

We encourage contribution to our libraries (you might even score some nifty swag), please see our [CONTRIBUTING.md](https://github.com/CoCreateJS/autoscaler/blob/master/CONTRIBUTING.md) guide for details. If you encounter any bugs or wish to make feature requests, please submit an issue on our [GitHub Issues](https://github.com/CoCreateJS/autoscaler/issues) tracker. We want this library to be community-driven, and CoCreate led. We need your help to realize this goal.

For broader system configurations and API guides, please visit our [CoCreate Server Autoscaler Documentation](https://cocreatejs.com/docs/autoscaler).

---

## About

`@cocreate/autoscaler` is designed, built, and supported by the CoCreate Developer Experience Team.

> [!NOTE]
> Please contact the Developer Experience Team via [GitHub Discussions](https://github.com/CoCreateJS/autoscaler/discussions) or join our Discord channel for any architecture or deployment queries.

`@cocreate/autoscaler` is maintained and funded by CoCreate. The names and logos for CoCreate are trademarks of CoCreate, LLC.

## Master status and available capacity

Available capacity and telemetry averages include only running masters. Provisioning is pending capacity. Draining/terminating masters are tracked separately for removal coordination; stopped, failed and terminated masters are excluded. Worker status and drain/cordon flags do not change server eligibility. State.save preserves failed/terminating outcomes by skipping subsequent State saves; scaling policy remains unchanged.


### Delayed server inventory cleanup

Initialization schedules an own-cluster sweep every ten minutes, with no startup sweep.
Retirement commits master.status terminating before the provider API call. Success retains
that state; failure overrides it with failed. Only terminating records are selected for
cleanup; failed records remain for investigation, and their Manager update cancels pending
Manager cleanup directly.
The shared deleteServer helper removes inventory without another server-status lookup or
cloud API request. An already-missing record is success. Managed local cleanup also sends
object.delete servers to Manager for its platform copy; unmanaged cleanup stays local.
Manager uses the same helper one minute after persisting a terminating report, deleting
the tenant copy before the platform copy. Manager deletion receipts do not mirror back.

Cleanup helpers receive an explicit server context so Manager workers can use them without
initializing an AutoScaler instance. Server instances expose deleteServer and
collectTerminatingServers on server.autoscaler. Timers are process-local; they do not
provide persistent scheduling or a platform-wide tenant sweep. Initial provisioning
remains Manager's responsibility, and failed inventory is never selected automatically.


### Organization-driven scale-to-zero

Mesh's confirmed organization.inactive event invokes the existing scaleIn operation
when the organization matches this node, autoscaling is enabled and minClusterSize is
zero, selecting the local node through the existing selection lookup. Each node retires
itself; ordinary scaling retains its configured selection strategy. Organization activation clears the idle marker. CPU/memory scale-in alone retains
the final node. The final idle removal does not require CPU/memory samples when no
capacity remains; other capacity-change checks still apply. Evaluation already in progress
can defer the retained idle request until a subsequent telemetry evaluation. No client
counts or peer registrations are validated again by AutoScaler. Drain, provider termination,
shutdown and inventory cleanup follow the existing lifecycle.


### Workflow provisioning

Scale-out keeps the saved cluster separate from merged autoscaler catalogs. After placement
and VM sizing, it sends `workflow.createOrganizationServer` with
`createOrganizationServer: { ...cluster, deployment }`. The deployment contains the selected
cloud API ID, region, type and sorted dns POP array. Local dispatch uses `server.workflow.run`;
managed nodes use the same envelope through `server.manager.send`. The common platform
workflow owns validation and inventory; provider workflows own cloud operations. Scale-out
requires a saved cluster and its rendered startup script. Scale-in sends `workflow.deleteOrganizationServer` through that same dispatch helper.


`scaleOut(cluster, [], coordinates)` generates a deployment for the supplied cluster.
The platform primary listens for `organizationPeers`, loads the non-local organization's
cluster and saved `location: { latitude, longitude }` on an empty result, and calls this
coordinate-based path. Policies and enabled cloud APIs are resolved for that target
cluster without replacing the platform's cached configuration. Missing or invalid
coordinates stop activation. Saved clusters no longer need a static deployment. The listener is installed before
Mesh initialization. Telemetry continues to call `scaleOut(clientLocations, activeServers)`.
`runWorkflow(name, cluster)` constructs a fresh standard envelope per operation, choosing
`server.manager.send` or `server.workflow.run`. It does not store a shared mutable payload.
Deletion passes the selected server reference; the parent workflow reloads canonical
inventory and delegates to `delete<CloudName>Instance`. DNS registration/removal is
still pending integration; delayed inventory cleanup remains separate.

AutoScaler fetches `autoscaler`, `clouds`, and `dns` configuration types. It does
not fetch a standalone startup-script configuration. `createClusterConfig` renders
`cluster.startupScript` at creation; AutoScaler forwards that saved cluster unchanged
except for the current deployment. Provider workflows consume the saved script.

### Optional provider selections

`cluster.clouds` and `cluster.dns` are optional API-ID whitelists. Missing values,
empty strings and empty arrays allow all enabled API connections of the corresponding
type in the executing organization. Nonempty selections restrict API records by ID;
a single ID string is also accepted. Matching `clouds` and `dns` server configs
supply catalogs, which are filtered through those connections. Multiple connections
for one DNS provider keep separate POP entries identified by `apiId`.

An explicit cloud selection with no usable connection fails placement. An explicit
DNS selection with no eligible POPs also fails; it never silently expands to other
providers. With no DNS restriction and no eligible DNS connections/POPs,
placement goes directly to a cloud region. API-read failures stop resolution.
First-node activation resolves connections in platform scope, while ordinary tenant
scaling resolves them in the tenant scope. Credentials are not added to DNS POPs.
