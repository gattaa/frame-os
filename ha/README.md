# ha/ — Home Assistant config

The Home Assistant side of frame-os: the **live data** the overlay reads, plus
**night mode** and **screen control** for the frame. Assumes a self-hosted HA
behind nginx.

**Role:** HA is the live-data source the `frame/` PWA reads (battery, power,
energy, AC) and the target for AC + screen control. It is **not** part of the
photo ingest/processing path. See [`../CLAUDE.md`](../CLAUDE.md).

Everything here uses **clearly-marked placeholders** (`PLACEHOLDER_*`,
`REPLACE_ME_*`) for entity ids — replace them with your real ones. Nothing
invents your sensor ids.

## Install the package

1. Copy `secrets.yaml.example` → `secrets.yaml` (gitignored) and fill it in.
2. Copy `packages/` into your HA config dir (so you have
   `<config>/packages/frame.yaml`).
3. Enable packages in `configuration.yaml` (once):

   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```
4. **Developer Tools → YAML → Check Configuration**, then **Restart**.

## One-time UI setup (not YAML)

### 1. Long-lived access token for the PWA
HA → your **Profile → Security → Long-lived access tokens → Create Token**.
Copy it once. It does **not** go in Home Assistant — it goes in the **PWA**:

- `frame/.env` → `VITE_HA_TOKEN=<token>`
- `frame/.env` → `VITE_HA_BASE_URL=https://ha.example.com` (your HA URL via nginx)

(See `frame/src/config.ts` → `HA.TOKEN` / `HA.BASE_URL`.)

### 2. Fully Kiosk Browser integration (preferred over rest_command)
HA → **Settings → Devices & Services → Add Integration → "Fully Kiosk
Browser"**. Enter the **tablet's IP** and the **Fully remote-admin password**
(set that in the Fully Kiosk app: Settings → Remote Administration → enable +
password).

Why prefer it over `rest_command`: the integration gives you real **entities**
with state (not just fire-and-forget HTTP), which the automations here use
directly. It creates (names depend on your device):

| Entity | What it is | Used here as |
|--------|-----------|--------------|
| `light.<device>_screen` | screen brightness + on/off | `light.PLACEHOLDER_fully_kiosk_screen` |
| `switch.<device>_screensaver` | blank the panel | `switch.PLACEHOLDER_fully_kiosk_screensaver` |
| `switch.<device>_screen` / `maintenance_mode` / `kiosk_lock` / `motion_detection` | misc toggles | — |
| `sensor.<device>_*` | battery, storage, etc. | — |
| `button.<device>_restart_browser` / `load_start_url` | actions | — |
| service `fully_kiosk.load_url` | push a URL to the frame | handy for kiosk control |

Replace the two `PLACEHOLDER_fully_kiosk_*` ids in `packages/frame.yaml` with
your real `light.` and `switch.` ids.

If you'd rather **not** install the integration, use the commented
`rest_command` block at the bottom of `packages/frame.yaml` instead (host +
password from `secrets.yaml`). Trade-off: those are stateless HTTP calls — no
brightness entity, no screensaver state — so you lose the clean automations and
the PWA's brightness wiring has nothing to read back.

### 3. Confirm the 4 entities the PWA needs
Find your real ids (Developer Tools → States) and set them in `frame/.env` /
`frame/src/config.ts`. **Please confirm each of these exists on your system:**

| PWA placeholder (`config.ts` / `.env`) | What it is | Likely source |
|----------------------------------------|-----------|---------------|
| `BATTERY_PCT` (`VITE_HA_BATTERY_PCT`) | home battery state of charge, % | your battery/inverter integration |
| `POWER_NOW` (`VITE_HA_POWER_NOW`) | live power draw/flow, W | energy/grid sensor |
| `ENERGY_TODAY` (`VITE_HA_ENERGY_TODAY`) | energy today, kWh | daily energy sensor — see stub below |
| `CLIMATE_AC` (`VITE_HA_CLIMATE_AC`) | the AC unit | a `climate.*` entity |

If **energy today** isn't a single sensor, `packages/frame.yaml` has an
**optional, clearly-marked stub** (a `utility_meter` *or* a `template` sensor)
that derives `sensor.frame_energy_today` from a cumulative meter. Adapt the
source id to yours, then point `ENERGY_TODAY` at it.

## Placeholder → where you set it

| Placeholder | Lives in | Set it to |
|-------------|----------|-----------|
| `BATTERY_PCT` | `frame/.env` `VITE_HA_BATTERY_PCT` | your battery % sensor |
| `POWER_NOW` | `frame/.env` `VITE_HA_POWER_NOW` | your live power sensor |
| `ENERGY_TODAY` | `frame/.env` `VITE_HA_ENERGY_TODAY` | your daily energy sensor (or `sensor.frame_energy_today`) |
| `CLIMATE_AC` | `frame/.env` `VITE_HA_CLIMATE_AC` | your `climate.*` AC entity |
| night-mode boolean | `frame/src/config.ts` (see follow-up) | `input_boolean.frame_night_mode` |
| `FULLY_KIOSK_BASE` | `frame/.env` `VITE_FULLY_KIOSK_BASE` | `http://<tablet-ip>:2323` (only if the PWA calls Fully directly; otherwise HA drives the screen) |
| `light.PLACEHOLDER_fully_kiosk_screen` | `ha/packages/frame.yaml` | your Fully screen `light.` |
| `switch.PLACEHOLDER_fully_kiosk_screensaver` | `ha/packages/frame.yaml` | your Fully screensaver `switch.` |
| `sensor.REPLACE_ME_energy_total_kwh` | `ha/packages/frame.yaml` (energy stub) | your cumulative kWh sensor |

> **Note on `FULLY_KIOSK_BASE`:** with the HA integration driving brightness
> and screen on/off (the design here), the PWA does **not** need to call Fully
> directly — leave `VITE_FULLY_ENABLED=false`. Keep `FULLY_KIOSK_BASE` only if
> you want the PWA's own `brightness.ts` path as a secondary control.

## Night-mode + override logic

`input_boolean.frame_night_mode` is the **single source of truth** for day vs
night. The PWA reads it for its theme; the automations drive screen brightness
off it.

- **Sun-driven (gradual):** when the sun's **elevation** falls below
  `input_number.frame_dusk_elevation` (default 3°) → night mode **on**; when it
  rises back above → **off**. Using elevation (not just `below_horizon`) makes
  the switch happen at a configurable brightness of dusk/dawn.
- **Brightness follows night mode:** any change to `frame_night_mode` (sun *or*
  manual) sets the Fully screen `light` to `frame_brightness_day` /
  `frame_brightness_night` (both 0–255, adjustable in the UI).
- **Deep-night window:** between `frame_deepnight_start` and
  `frame_deepnight_end` (default 23:00–06:00) the screen goes **fully off** (the
  screensaver switch), then back on — brightness re-asserted for the current
  mode.
- **Override (`input_boolean.frame_night_override`) — Mum's escape hatch:**
  while **on**, the sun and deep-night automations **don't touch the frame**, so
  her manual choice sticks:
  - override **on** + night_mode **off** → *keep it bright*
  - override **on** + night_mode **on** → *force night*
  Brightness still follows manual `night_mode` toggles. Turn override **off** to
  hand control back to the sun.

### Optional: a little control card for Mum

```yaml
type: entities
title: Photo Frame
entities:
  - entity: input_boolean.frame_night_mode
  - entity: input_boolean.frame_night_override
  - entity: input_number.frame_brightness_day
  - entity: input_number.frame_brightness_night
  - entity: input_button.frame_process_now
```

## What's in `packages/frame.yaml`

- `input_boolean`: `frame_night_mode`, `frame_night_override`
- `input_number`: `frame_brightness_day`, `frame_brightness_night`,
  `frame_dusk_elevation`
- `input_datetime`: `frame_deepnight_start`, `frame_deepnight_end`
- `input_button`: `frame_process_now`
- automations: sun→night-mode, brightness→night-mode, deep-night off, deep-night on
- commented `rest_command` fallback (Fully REST) and a commented
  `shell_command` + automation to "process photos now" (the processor already
  loop-polls; this is just a nudge)

## Status

Implemented: night-mode/override helpers, sun + screen automations, energy
stub, and fallbacks. Replace the placeholder entity ids with yours.
