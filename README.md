# ISO Sailing Sim

A 3D physics simulation of an **ISO** two-person trapeze dinghy (asymmetric gennaker), running in the browser.
Every environmental factor and every boat control is a live variable.

```bash
npm install
npm run dev        # open the printed URL
npm test           # physics regression tests (headless)
npm run build      # static build in dist/
```

## What's modelled

**Rigid body (6 DOF).** Position/velocity of the combined CG, quaternion attitude, body-frame angular velocity,
full inertia tensor rebuilt every step from hull, rig and crew positions. When the crew move, the system CG
stays put and the hull moves under them (momentum conserved). Hydrodynamic added mass in surge/heave/sway and
roll/pitch/yaw. Fixed 200 Hz step, semi-implicit Euler; stiff terms (sheets, sail-in-water) are integrated implicitly.

**Hydrostatics.** The sealed hull is filled with ~400 volume cells; each one's submerged fraction is computed
against the *local wave surface* at any attitude, so buoyancy, centre of buoyancy, wave-induced heave/pitch/roll
and capsize all fall out of the same calculation.

**Hull hydrodynamics.**
- Skin friction on ~200 surface panels (ITTC-57 line, Reynolds number from speed, length and water viscosity).
- Cross-flow pressure drag/damping on those panels, using the *water-relative* velocity (tide + wave orbitals).
- Residuary (wave-making) resistance vs Froude number with heel/trim penalties; hump around Fn 0.6.
- Planing lift vs Froude number whose centre moves with trim, plus stagnation pressure on the bow rocker
  when it digs in. That's where the pitch stiffness at speed comes from.
- Munk moment (a hull sliding sideways wants to turn broadside, which gives weather helm).

**Foils.** Daggerboard (adjustable depth) and rudder in strip theory: finite-aspect-ratio lift slope, stall,
post-stall flat-plate behaviour to 180°, induced drag, loss of lift near the surface, and board downwash on the rudder.

**Sails.** Main, jib and gennaker, each split into horizontal strips that see their own apparent wind
(wind gradient, gusts, boat roll/pitch/yaw rates, heel geometry). Each sail swings freely about its luff and is
held only by its sheet (a one-sided rope), so they flog, weathervane, back and gybe on their own. Strings change the shape:
- **Kicker**: leech tension, so twist
- **Outhaul**: depth low down
- **Cunningham**: depth and luff tolerance (draft forward)
- **Mast rake**: centre of effort, so helm balance

Backwinded soft sails at small angles flog rather than make lift. With the kite up, the jib is blanketed and the
main sits in downwash.

**Crew.** Helm and crew positions fore/aft and athwartships (leeward → centre → side deck → full hike / flat on
the wire). They move at finite speed, swap sides through tacks and gybes, and their mass and windage are real.

**Environment.**

| Group | Variables |
|---|---|
| Wind | speed, direction, gustiness, gust size (patches travel with the wind and show on the water), oscillating shifts, gradient |
| Weather | air temp, pressure, humidity → **air density**; water temp, salinity → **water density and viscosity**; rain, fog, cloud (visual) |
| Waves | JONSWAP wind-sea (auto from wind + fetch, or manual Hs/Tp), direction and spread, swell; finite-depth dispersion; depth-limited breaking |
| Tide | range, charted depth, hours from HW, stream rate/direction. The stream moves the water (so the boat), Doppler-shifts and steepens waves, and sets the depth. You can run aground. |

**Assists (optional).** Auto-hike (PI on heel), auto-trim (sheets to target angle of attack, eases the main
and kite when overpowered, throws the boom across in a gybe), autopilot. They only move the same controls you would;
no forces are faked. Turn them off and sail it yourself.

## Controls

| Key | Action |
|---|---|
| ←/→ | rudder (springs back to centre) |
| W/S, Q/A, E/D | main, jib, gennaker sheet in/out |
| G | hoist/drop gennaker |
| B/N | daggerboard up/down |
| Z/X | crew out/in |
| H | auto-hike · **P** autopilot · **T** tack/gybe onto the mirror TWA |
| R | right a capsized boat |
| F | force arrows (sails, board, rudder, buoyancy, gravity, hull) |
| C | orbit / chase / top camera |
| Space | pause · **1–5** time scale |

All variables are also in the panel on the right. `window.sim` is exposed in the browser console.

## Honest limitations

- **Not calibrated against a real ISO polar.** Upwind numbers look right (≈6 kn in 12 kn), but kite-reaching
  speeds in 16 kn+ are probably 15–20% optimistic. The obvious next step is calibrating against logged GPS tracks.
- Dimensions from public sources: LOA 4.74 m, beam 1.75 m (2.0 m over the wings), hull 100 kg,
  14.3 m² upwind, 18.8 m² gennaker. The main/jib split, rig geometry, foil sizes and hull lines are
  plausible estimates, not class drawings. Everything is a variable or a constant in `src/physics/boat.ts` / `hull.ts`.
- Linear (Airy) waves, no wave breaking on the boat, no spray, no cockpit flooding, no righting procedure
  (R puts it upright, as if you'd done it).
- The tide is a single harmonic with slack at HW/LW. Real harbours (Chichester included) are messier.

## Layout

```
src/physics/   pure TypeScript physics. No DOM; runs in Node for tests
  sim.ts         fixed-step loop
  boat.ts        rigid body, hull, foils, sails, crew
  hull.ts        parametric hull, volume cells, skin panels
  coeffs.ts      lift/drag models (foils, soft sails, 0–180°)
  environment.ts weather → densities, tide, wind field
  waves.ts       spectrum, dispersion, orbital velocities
  assist.ts      auto-hike / auto-trim / autopilot
src/render/    three.js: GPU water (same wave components as physics), boat, sails, crew
src/ui/        lil-gui variables panel, HUD instruments
tests/         vitest physics checks
```
