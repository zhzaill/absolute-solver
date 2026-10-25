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
| Robot micro-ROS client | ESP32 → Agent | Connected |
| `/odom` `/imu` `/scan` | robot feedback | Verified |
| Mapping | Gmapping | Running; `/map` and TF verified |
| Nav2 | ROS 2 | Not started; motion remains safety-blocked |
| Motion | `/cmd_vel` | Low-speed manual movement verified; high risk |

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

## Implementation Status

The XuegerOS repository now implements the first safety boundary:

- `tools/xuegeros.ps1` is a key-only maintenance and observation CLI.
- The CLI has no `/cmd_vel` action.
- `tools/xuegeros_body_adapter.py` exposes the read-only adapter endpoints.
- `tools/xuegeros_motion_gateway.py` is a separate shadow-mode lease service with no physical backend.
- `ros2_safety/xuegeros_safety` contains `twist_mux`, a 200 ms command watchdog, velocity clamping, lease validation, and a disarm service.

This is not yet a Hub integration. The adapter service and ROS safety package still need deployment and live validation.

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
GET /v1/world
```

`/v1/observations/latest` returns bounded structured detections and health
metrics only. Camera MJPEG frames are parsed into a single-slot in-memory buffer;
the YOLO worker consumes only the newest frame and drops unread older frames.
Neither JPEG frames nor inference tensors are written to disk, trace, memory, or
Persona context. Stale/disconnected camera state clears detections. Each frame
is capped at 20 detections with normalized bounding boxes. `/v1/world` combines
this observation with read-only status, map, and navigation summaries; scan and
odometry remain summarized before any future Persona projection.

World health probes run independently in the background. A sleeping or
unreachable XuegerOS VM therefore marks VM/map/navigation state unavailable
without blocking fresh camera detections from `/v1/world`.

The adapter starts its camera and CPU YOLO workers when the service starts. The
default model is `yolo11n.pt`, with model cache storage limited to model weights;
image inputs remain in memory. `XUEGEROS_YOLO_MODEL`,
`XUEGEROS_YOLO_IMAGE_SIZE`, and `XUEGEROS_CAMERA_MAX_FRAME_BYTES` can override
the model, inference size, and per-frame memory bound. The adapter does not
publish movement commands and always reports `autonomous_motion_allowed: false`.

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

## Current Runtime State

The robot-side micro-ROS client is now connected to the Agent.

Verified graph:

- `/odom`
- `/imu`
- `/scan` with one publisher at approximately 9.8 Hz
- `/battery_state`
- `/ultrasonic`
- `/tf` and `/tf_static`
- `/map` from Gmapping, width 384

The robot controller is on the wired LAN at `<robot-lan-ip>` and uses Agent
`<hub-lan-ip>:8888`. The camera remains an independent HTTP source at
`<camera-lan-ip>:81`.

VMware NAT UDP forwarding was replaced by a server-side relay because the
bidirectional micro-ROS session was unstable:

```text
<hub-lan-ip>:8888 -> <guest-ip>:8888
```

The ROS-side mux, 200 ms watchdog, lease path, ESP32 command ingress, and motor
output were verified after restoring 2S battery power:

- forward and backward odometry changes
- left turn yaw change
- right arc translation and yaw change
- zero velocity and disarm after every pulse

Residual issue: a pure negative angular command intermittently did not appear on
`/cmd_vel_safe_raw`, while a right arc command passed. Turn-only autonomy remains
blocked until this path is reproducible.

## Security Findings

- Resolved: the maintenance CLI no longer accepts or places passwords in process arguments. It uses SSH keys and a local OpenSSH ProxyCommand for guest access.
- Resolved: vendor-specific IPs, VM paths, and camera addresses now live in an ignored local configuration file.
- Resolved: motion was removed from the maintenance CLI and moved to a separately started, disabled-by-default, shadow-mode gateway.
- Open: shadow mode has no physical command backend. Physical output stays blocked until the ROS safety package is deployed and validated.
- Open: the firmware still requires a real command watchdog. A one-shot stop command is not a deadman guarantee.
- Mandatory: a physical emergency stop remains non-negotiable.

## Delivery Order

1. Deploy and connect the implemented read-only XuegerOS adapter service.
2. Feed camera and robot health into Hub perception ingress.
3. Add a read-only Robotics World for map/Nav2 state.
4. Completed: micro-ROS client, `/scan`, `/odom`, `/imu`, Gmapping, and `/map`.
5. Deploy the implemented `twist_mux` plus watchdog in shadow mode.
6. Completed: limited manual forward/backward/turn tests with safety receipts.
7. Fix the pure-negative-turn mux anomaly, then expose constrained motion tools
   through the gateway.

Until Hub integration and the remaining turn-only mux issue are resolved, the
robot is manually testable but not autonomously movable.
