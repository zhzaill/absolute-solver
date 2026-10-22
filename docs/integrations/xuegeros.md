# XuegerOS Integration Boundary

## Classification

XuegerOS is a physical robot runtime, not a new Mind and not a second Hub.

It should enter Absolute Solver as:

- **Body adapter:** `xuegeros-car-01`
- **Perception ingress:** camera, scan, odometry, IMU, battery, ultrasonic
- **World projection:** mapping and navigation status
- **Tool-gated actions:** stop and low-speed motion only after a separate safety layer exists

The current PowerShell CLI must never be exposed directly to Persona as a generic tool.

## Observed Capabilities

| Capability | Source | State |
|---|---|---|
| VM lifecycle | VMware + XuegerOS CLI | Verified |
| Guest network | VMware NAT DHCP | Verified for current boot |
| Camera MJPEG | independent HTTP stream | Verified |
| Camera ROS topic | `/camera/image_raw/compressed` | Verified |
| micro-ROS Agent | UDP 8888 | Listening |
| Robot micro-ROS client | ESP32 → Agent | Not connected |
| `/odom` `/imu` `/scan` | robot feedback | Not currently published |
| Mapping | Gmapping | Blocked by missing `/scan` |
| Nav2 | ROS 2 | Blocked by missing map, scan, odom, and TF |
| Motion | `/cmd_vel` | Not verified; high risk |

## Architecture

```text
Camera MJPEG ───────────────┐
micro-ROS /odom /imu /scan ─┤
map / Nav2 status ──────────┤
                             ▼
                 XuegerOS Body Adapter
            status + observations + actions
                             │
                  Absolute Solver Hub
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
         Perception       Robotics World   Tool Gateway
          ingress          (read-only)      (motion only)
```

The adapter owns device I/O and transport. Hub owns turn, presence, routing, permissions, and trace. The Robotics World only projects bounded state into Persona context.

## Capability Contract

Proposed body registration:

```json
{
  "device_id": "xuegeros-car-01",
  "caps": {
    "display": "none",
    "speaker": false,
    "microphone": false,
    "camera": true,
    "lidar": true,
    "mobility": true,
    "sensors": ["camera", "scan", "odom", "imu", "battery", "ultrasonic"]
  }
}
```

Initial adapter endpoints should be read-only:

```text
GET /v1/status
GET /v1/observations/latest
GET /v1/mapping
GET /v1/navigation
```

`/v1/observations/latest` should return bounded metadata and a short-lived JPEG reference, not raw high-frequency streams. Scan/odom should be summarized or sampled before entering Persona context.

## Motion Is A Separate Safety Problem

The robot firmware has no command watchdog. A one-shot `/cmd_vel` may remain active indefinitely. The current CLI can publish a command and later publish zero, but it cannot guarantee that stop executes if the process, network, or VM fails.

Motion therefore requires all of:

1. A ROS-side command multiplexer with explicit priorities.
2. A watchdog that publishes zero within 200 ms of command loss.
3. A short-lived motion lease from the Tool Gateway.
4. Explicit human confirmation outside the model.
5. A physical emergency stop and lifted-wheel test before integration.
6. Blocking when `/odom`, `/scan`, or the micro-ROS client is stale.
7. Cancellation and stop receipts that cannot be confused with success.

Use mature ROS components such as `twist_mux` or the existing Loop-ROS `CmdMux` and `SafetyFilter` after license and runtime review. Do not build another ad-hoc motion publisher.

## Immediate Blocker

Mapping is not an algorithm problem yet.

The micro-ROS Agent is listening, but no robot-side client session exists. Without that session there is no `/odom`, `/imu`, or `/scan`, so there can be no valid `map -> odom` transform or map.

Required order:

1. Configure the ESP32 micro-ROS client to use `LAN_HUB_ADDRESS:8888`.
2. Confirm an Agent client session and live `/odom`, `/imu`, `/scan`.
3. Confirm only one `/scan` producer is active.
4. Check `/odom` freshness and wheel-track calibration.
5. Start Gmapping only after the sensor graph is healthy.
6. Validate `/map` and TF against live data.

The camera can continue as an independent perception source while mapping is blocked.

## Security Findings

- The current CLI passes SSH and guest passwords through process arguments. Do not expose it directly to an LLM or record its command lines.
- Vendor-specific IPs, VM paths, host key, and camera address are hard-coded defaults. They must be moved to local configuration before publishing the XuegerOS repository.
- `publish-cmd-vel` requires explicit confirmation, but still has no end-to-end deadman guarantee.
- `stop-motion` is a safety aid, not a replacement for a physical emergency stop.

## Delivery Order

1. Build a read-only XuegerOS adapter service.
2. Feed camera and robot health into Hub perception ingress.
3. Add a read-only Robotics World for map/Nav2 state.
4. Establish the micro-ROS client and validate `/scan`, `/odom`, and `/imu`.
5. Add `twist_mux` plus watchdog in shadow mode.
6. Test lifted-wheel motion with explicit confirmation.
7. Only then expose constrained motion tools through the gateway.

Until steps 1 through 6 pass, the robot is observable but not autonomously movable.
