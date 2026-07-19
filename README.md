# CoCreate Server Autoscaler

A decentralized, self-healing, and autonomous cluster lifecycle manager designed for high-performance multi-tenant ecosystems. Driven directly by real-time telemetry metrics, this module orchestrates vertical and horizontal scaling across top cloud providers using a peer-to-peer, masterless replication model.

---

## Documentation

For advanced cloud provider configurations, identity IAM role policies, and threshold triggers, refer to the [CoCreate Server Autoscaler Documentation](https://cocreatejs.com/docs/server-autoscaler).

## Table of Contents

* [The Masterless Replicating Node Architecture](#the-masterless-replicating-node-architecture)
* [Why CoCreate Server Autoscaler?](#why-cocreate-server-autoscaler)
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

`@cocreate/server-autoscaler` implements a **Decentralized, Peer-to-Peer (P2P) Replication Model**:

* **Every Node is Both Master and Worker:** There are no specialized roles. Each node independently monitors its own resource limits, registers its state within the shared platform database, and monitors peer health via the `@cocreate/server-mesh` Control Plane.
* **Autonomous Self-Replication:** If a node detects cluster-wide saturation or localized system boundaries, it doesn't wait for a central master to act. It directly contacts your cloud provider's API to clone its own VM image, dynamically spawning an exact sibling node to scale out immediately:

$$\text{Resource Boundary Tripped} \implies \text{Node } A \xrightarrow{\text{Direct Cloud API Call}} \text{Clone VM Image} \implies \text{Spawn Sibling Node } B$$

* **Zero Single Point of Failure (SPOF):** If any node drops offline or crashes, surviving peer nodes detect the loss of its keep-alive heartbeat on the mesh control plane and dynamically adjust scaling priorities.

---

## Why CoCreate Server Autoscaler?

Unlike standard cloud-native autoscaling groups (like AWS ASGs) that only monitor generic hypervisor metrics like raw CPU and ignore application-level boundaries, `@cocreate/server-autoscaler` is tightly integrated with the CoCreate core.

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

The autoscaler connects directly to the local `@cocreate/server-telemetry` Data Engine pipeline. It processes system telemetry metrics to continuously calculate a weighted saturation index:

$$\text{Saturation Index} = \alpha \cdot \text{V8 CPU Lag} + \beta \cdot \text{RAM Utilization} + \gamma \cdot \text{Socket Density}$$

* **Self-Healing Interventions:** If the Saturation Index exceeds your configured safety threshold for a sustained period, the autoscaler initiates scaling protocols.
* **Dead-Node Pruning:** When a peer server drops offline without a clean exit (e.g., hardware failure or kernel panic), the active nodes wait for a stagger delay before pruning the dead node's records from the database registry and redistributing tenant routing channels.

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

Place an `autoscaler.config.json` file in your server's root directory to declare your cloud provider credentials, scaling thresholds, and adapter settings.

```json
{
  "provider": "aws",
  "credentials": {
    "region": "us-east-1",
    "iamRole": "CoCreateAutoscalerRole"
  },
  "scaling": {
    "minInstances": 2,
    "maxInstances": 10,
    "cooldownPeriodSeconds": 300,
    "thresholds": {
      "cpuUtilizationPercent": 80,
      "memoryUtilizationPercent": 85,
      "websocketConnectionsPerNode": 5000,
      "v8LagLimitMs": 100
    }
  },
  "replication": {
    "imageId": "ami-cocreate-node-v1.6.1",
    "instanceType": "t3.medium",
    "securityGroup": "sg-cocreate-mesh-internal"
  }
}
```

---

## Installation

You can install this package locally via npm:

```bash
npm i @cocreate/server-autoscaler
```

Or via yarn:

```bash
yarn add @cocreate/server-autoscaler
```

---

## Announcements

All scaling adaptations, cloud adapter API patches, and metric evaluation revisions are tracked inside our release logs on the [CoCreate Server Autoscaler GitHub Releases](https://github.com/CoCreate-app/CoCreate-server-autoscaler/releases) page. Please subscribe to our release notifications for breaking updates on cloud provider parameters.

---

## Roadmap

Upcoming enhancements planned for our autonomous scaling system include:

* **Predictive Scaling Engine:** Utilizing linear regression models on historical time-series telemetry to preemptively scale up cluster capacity before scheduled traffic spikes.
* **Kubernetes KEDA Adapter:** Native scaling support for containerized Kubernetes workloads using CoCreate telemetry events as custom HPA metrics.

---

## How to Contribute

We encourage contribution to our libraries (you might even score some nifty swag), please see our [CONTRIBUTING.md](https://github.com/CoCreate-app/CoCreate-server-autoscaler/blob/master/CONTRIBUTING.md) guide for details. If you encounter any bugs or wish to make feature requests, please submit an issue on our [GitHub Issues](https://github.com/CoCreate-app/CoCreate-server-autoscaler/issues) tracker. We want this library to be community-driven, and CoCreate led. We need your help to realize this goal.

For broader system configurations and API guides, please visit our [CoCreate Server Autoscaler Documentation](https://cocreatejs.com/docs/server-autoscaler).

---

## About

`@cocreate/server-autoscaler` is designed, built, and supported by the CoCreate Developer Experience Team.

> [!NOTE]
> Please contact the Developer Experience Team via [GitHub Discussions](https://github.com/CoCreate-app/CoCreate-server-autoscaler/discussions) or join our Discord channel for any architecture or deployment queries.

`@cocreate/server-autoscaler` is maintained and funded by CoCreate. The names and logos for CoCreate are trademarks of CoCreate, LLC.