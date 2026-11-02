# Compute and networking (simulated control plane)

`src/modules/compute.js`, `src/modules/network.js`, UI `public/ui/compute.js` and `public/ui/network.js`.

**There are no real virtual machines, containers or packets.** What is real: the resource state machines, IPv4 CIDR maths, address allocation, security-group rule evaluation, quotas, tenant isolation and metering (instance hours, volume GB-months, Elastic-IP hours flow into billing and invoices).
What is synthetic: CPU/memory/network/disk metrics (a deterministic pure function of instance id and minute, with workload tags `idle|web|batch|db`), the serial console text, and health checks. Every API response and UI screen that shows such data is labelled `simulated`.

## Instances
States `pending → running`, `running → stopping → stopped`, `* → shutting-down → terminated`. Transitions complete instantly by default; set `RD_SIM_DELAY_MS` (e.g. 2000) to see real transitional states (conflicting operations answer 409 while a transition is in flight; unfinished transitions are settled after a restart).
`POST /api/compute/instances {name, type, image, region, az, subnetId, securityGroupIds, keyPairId, tags, userData}`; `start|stop|reboot|terminate|resize` (resize only when stopped), `PATCH` name/tags, filters `?state=&name=&tag.env=prod`, `GET …/console`, `GET …/metrics?window=1h|6h|24h&period=60|300|900` (samples only for time the instance was running).
Catalogue: `GET /api/compute/regions|images|types`. Limits: `RD_COMPUTE_MAX_INSTANCES` (25) and the plan quota `compute.instances`; ≤ 30 tags (the `rd:` prefix is reserved for the platform). Billing meters `compute.<type>` hours from `runningSince`/`accruedMs` (instances stop accruing when stopped).
`POST /api/compute/estimate` prices a configuration (instances × hours, volumes, Elastic IPs) from the live price table.

## Key pairs
Real **ed25519** keys generated with `node:crypto`; the private key (PKCS#8 PEM) is returned **once** and never stored; the public key is returned in OpenSSH format with its `SHA256:` fingerprint (the tests verify the blob, the fingerprint and a signature round-trip independently).

## Volumes and snapshots
1–16384 GB, per-AZ, `attach` (zone must match, devices `/dev/sdf…/dev/sdp`, ≤ 8 per instance), `detach`, grow-only `resize`, snapshots (≤ 20 per volume) and restore-to-volume; terminating an instance detaches its volumes. Caps `RD_COMPUTE_MAX_VOLUMES` (20) and `RD_COMPUTE_MAX_VOLUME_GB` (4096 total). Metered daily as `compute.volume_gb_month`.

## Autoscaling groups
`{name, minSize, maxSize, desired, targetCpu, cooldownSec, template}`; the template (type, image, region, subnets, security groups, key pair, tags) launches instances (tagged `rd:asg`). A sweeper (every 15 s, also callable) reconciles membership, **replaces unhealthy members** (stopped/terminated/missing) and applies **target tracking** on the simulated CPU: scale out one step above target+10 %, scale in one step below target−20 %, once per cooldown, always within min/max. Plan/instance quotas apply; failures are reported in the group's activity log. ≤ 5 groups, ≤ 20 instances each.

## Load balancers
Listeners (http/https/tcp), a target group with health-check settings, registered instances and simulated health: `initial` until `intervalSec × healthyThreshold` after the instance started running, `healthy` afterwards, `unhealthy` while stopped, auto-deregistered on termination.

## Networking (`/api/network/…`)
* **VPCs**: RFC 1918 CIDRs only, /16–/28, ≤ 5 per user, each with a main route table and a default security group (members may talk to each other, all outbound allowed).
* **Subnets**: must be inside the VPC, ≤ /28, **no overlap** (409), the AZ must belong to the VPC's region. Address allocation is real: the first four and the last address are reserved (as in AWS), the lowest free address is handed out, freed addresses are reused, exhaustion answers 409.
* **Route tables / internet gateways**: `local` route is permanent, routes may target an attached gateway or `blackhole`, detaching a gateway turns its routes into blackholes, one gateway per VPC.
* **Elastic IPs** (documentation ranges 198.51.100.0/24 and 203.0.113.0/24), ≤ 5 per user, need an instance in a VPC that has an internet gateway, survive stop/start; auto-assigned public IPs of instances in public subnets are released on stop. Billed `network.eip_hour` while allocated.
* **Security groups**: ingress/egress rules (`tcp|udp|icmp|-1`, ports, CIDR or another group of the same VPC), validation, duplicate detection, ≤ 60 rules, deletion refused while attached or referenced.
* **Rule evaluator** `POST /api/network/check {from, to, protocol, port}` (instance ids or IPs) explains the decision: routing (same VPC local route; different VPCs have no route; internet needs a `0.0.0.0/0` route to a gateway and a public IP), the source's egress rules, the destination's ingress rules, naming the matching rule or the reason for denial.
* `GET /api/network/topology` feeds the SVG diagram in the console.

## Limitations
No real compute, no VPC peering/NAT/NACLs/IPv6, load balancers do not route traffic, metrics are synthetic, console output is generated, a single "default" workload model, no instance storage or boot volumes.
