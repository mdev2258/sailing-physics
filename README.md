# ISO Sailing Sim

A 3D physics simulation of an **ISO** two-person trapeze dinghy (asymmetric gennaker), running in the browser.
Every environmental factor and every boat control is a live variable, and every force the physics
computes can be switched on as a layer: flow, pressure, forces, centres.

```bash
npm install
npm run dev        # open the printed URL
npm test           # physics regression tests (headless)
npm run build      # static build in dist/
```

## What's modelled

The physics was rebuilt from the keel up in v0.2. The short version: nothing is a lookup of "what a boat
does"; every force comes from a model of the thing that makes it, and they are all summed into one
ledger that the on-screen layers read straight from.

**Rigid body (6 DOF) with the water's added mass.** Position/velocity of the combined CG, quaternion
attitude, body-frame angular velocity, full inertia tensor rebuilt every step from hull, rig and crew
positions (when the crew move, the CG stays put and the hull moves under them). The hull, board and
rudder each carry an added-mass tensor; the step solves the full 6×6 Kirchhoff system, so the
momentum-turning terms come out of the equations rather than being bolted on. The best known is the
Munk moment (a hull sliding sideways wants to turn broadside-on: a real source of weather helm).
Fixed 200 Hz step, semi-implicit Euler; stiff terms (sheets, sail-in-water) are integrated implicitly.

**Sails and foils: a vortex system, not a coefficient table.** Every strip of every sail (30 of them)
and of the daggerboard and rudder (14) carries a horseshoe vortex. Its strength is whatever makes the
Kutta–Joukowski lift equal the lift its own 2-D section makes in the flow it *actually* sees:
free stream plus what every other vortex induces there, plus their mirror images in the sea (under the
sails) and the hull bottom (above the foils). That one calculation gives, with no fudge factors:

- induced drag and tip loss (the test suite checks it against Prandtl's lifting-line theory);
- the slot: the main's upwash lifts the jib, the jib's downwash heads the lower main;
- the kite's effect on the sails behind it;
- the board's downwash on the rudder (the rudder sees roughly half the leeway the board does);
- circulation lag: lift takes a couple of chord lengths of travel to build, as it really does.

**Section models.** Each strip's section is a Kirchhoff separated-flow model: lift
`cla·((1+√fs)/2)²·(α−α0)` where `fs` is where the flow lets go of the leeward side (1 = attached to the
leech). `fs` lags like real dynamic stall (quick to separate, slow to re-attach), blends into
bluff-plate behaviour right round to 180°, and is exactly what the telltales and the ragged
streamlines are drawn from. Sails: zero-lift angle and maximum lift from camber, luffing below the
entry angle, flogging when backed. Foils: Reynolds-dependent skin friction with transition, stall near 12°.

**Hydrostatics.** The sealed tanks are ~900 volume cells, each tested against the *local wave surface*
(with Froude–Krylov depth attenuation), so buoyancy, the centre of buoyancy, wave-induced motion and
capsize all come from one sum. Stability curve: GM ≈ 0.95 m, GZ peaks near 25°, vanishes about 65°.

**Hull hydrodynamics.**
- Skin friction on ~200 panels (ITTC-57, Reynolds from speed and water viscosity), using each panel's
  water-relative velocity (tide + wave orbitals).
- Wave-making resistance of the buoyant part of the hull vs Froude number. It also raises the hull's
  own wave: crest at the bow, trough working aft, so she squats and lifts her bow climbing the hump.
- **Planing**, station by station: slender-body ("2D+t") pressure on each half of the bottom, scaled to
  Savitsky's planing regression. Lift appears at the front of the wetted area, governed by the angle
  the bottom meets the water there; its drag is just that pressure tilted by the bottom's slope. Press
  the bow down and the wetted front moves on to the steeper forefoot and lifts harder: that is why she
  doesn't trip. Heel her and the leeward half carries more: dynamic stability at speed.
- Once the transom runs dry the after sections lose part of their static buoyancy (the pressure must
  fall to atmospheric at the edge), which is what lets the stern settle on to the plane.
- Cross-flow drag and wave-radiation damping on the panels (motion across the hull only), slender-body
  side force of the hull itself, immersed-transom drag at low speed.
- Towing-tank result (see tests): drag/weight ≈ 0.08 at 6 kn, a gentle hump of ≈ 0.11 at 7–10 kn,
  0.14 at 16 kn; bow up about 2° on the plane; no porpoising.

**Sail controls** (led to both side decks, as on the real boat). Each line changes the sail *shape*
(depth, twist, groove width, how far in the sheet can bring the sail) and the forces follow from that:

| Line | Effect |
|---|---|
| Downhaul | flattens the luff, pulls the draft forward (wider groove), opens the top leech |
| Kicker | holds the leech down at any boom angle, so it controls twist when the main is eased; bends the mast, which flattens the top |
| Outhaul | flattens the foot, fading out by about ⅔ height |
| Jib barber hauler | pulls the lead in and down: tighter sheeting angle, firmer jib leech |
| Mainsheet bridle length | short = block low, sheet pulls down (tight leech) but the boom slides to leeward and can't centre; long = block high, boom centres but the leech twists |
| Forestay / rig tension | less forestay sag (flatter jib, narrower groove, points higher), plus some mast pre-bend |

Each sail swings freely about its luff and is held only by its sheet (a one-sided rope), so they flog,
weathervane, back and gybe on their own.

**Crew.** Helm and crew weights, and their positions fore/aft and athwartships (leeward → centre → side deck → full hike / flat on
the wire). **Wings** on or off (published 1.75 m hull / 2.0 m overall beam). They move at finite speed, swap sides through tacks and gybes, and their mass and windage are real.

**Environment.**

| Group | Variables |
|---|---|
| Wind | speed, direction, gustiness, gust size (patches travel with the wind and show on the water), oscillating shifts, gradient |
| Weather | air temp, pressure, humidity → **air density**; water temp, salinity → **water density and viscosity**; rain, fog, cloud (visual) |
| Waves | JONSWAP wind-sea (auto from wind + fetch, or manual Hs/Tp), direction and spread, swell; finite-depth dispersion; depth-limited breaking |
| Tide | range, charted depth, hours from HW, stream rate/direction. The stream moves the water (so the boat), Doppler-shifts and steepens waves, and sets the depth. You can run aground. |

**Assists (optional).** Auto-hike (PI on heel), auto-trim (sheets to each sail's best working angle;
eases until she's flat once the crew are fully out; throws the boom across in a gybe), autopilot.
They only move the same controls you would; no forces are faked.

## Layers

The bar at the top switches them. Every layer draws numbers the physics computed that instant.

| Layer | Key | What it shows |
|---|---|---|
| Air flow | V | Streamlines integrated through the solved vortex field: upwash ahead of the jib, the slot, the bend behind the rig. Blue = slowed (windward side), orange = speeded up (leeward suction), ragged red = the section model says the flow has separated. |
| Water flow | U | The same for the board and rudder: leeway coming in, the board bending it, the downwash at the rudder. |
| Telltales | Y | Luff telltales both sides and a leech ribbon at three heights per sail: green streaming, amber lifting (luffing), red drooping (stalled). |
| Tip vortices | O | The trailing vortices from head, foot and foil tips: the induced drag you are paying. |
| Sail pressure | I | Pressure difference across the cloth: section lift × local dynamic pressure, distributed along the chord by thin-aerofoil theory, flat behind the separation point, negative (blue) at a luffing luff. |
| Wetted hull | J | Blue deepening with static pressure (depth), orange where the bottom carries planing pressure. |
| Forces | F | The totals, each where it acts: sails at the CE, hull + foils at the CLR, weight at G, buoyancy at B, planing lift. |
| Drive / heel split | 6 | Sail force into drive and heeling force; water force into drag and side force. |
| Force distribution | 7 | Force on every sail and foil strip, buoyancy and planing lift per hull station, each weight. Drawn 5× longer than the totals. |
| Force table | 8 | Every force in newtons (ahead / starboard / up), heeling vs righting moment, yaw moments, sheet loads. Net ≈ 0 when she has settled. |
| Centres | K | CE, CLR, G, B, M, the planing centre P, and the GZ lever. |
| Wind triangle | 9 | True wind, boat velocity and the apparent wind they add up to; heading against track through the water (leeway). |
| X-ray boat | 0 | See-through hull, sails and water. |

With an under-water layer on, the water goes glassy round the boat and you can take the camera below the surface.
`physics/balance.ts` is the same sum the force table shows; `balance()` in the browser console returns it.

## How much help? (M)

The physics is the same on every level; only the virtual crew's jobs change.

| Level | Steering | Sheets | Hiking | Extras |
|---|---|---|---|---|
| **Easy** (default) | ←/→ turn the boat at a steady rate and it holds the course | auto-trimmed | auto | won't pinch into irons (hold into the wind to tack), auto-right after a capsize |
| **Normal** | same as Easy | you (W/S, Q/A, E/D) | auto | auto-right |
| **Realistic** | ←/→ move the tiller | you | you (Z/X) | none, press R to right it |

T tacks or gybes on any level. Touching a sheet key switches auto-trim off, and the level shows as "Custom".

## Instruments

- **Points-of-sail dial** (north-up): RYA zones round the true wind, the boat at its heading with the boom on
  its real side, a dashed course-over-ground line (shows tide and leeway), plus point of sail, tack, TWA and AWA.
  The wind defaults to coming from true north, so the north-up top camera reads like the classic diagram.
- **Centres** (K): CE (where the total sail force acts), CLR (where the sideways water force acts, including
  the Munk couple, averaged over about a second), G, B, the metacentre M once heeled past 4°, and the
  planing centre P. "CE ahead of CLR" in the HUD is the live lead (near zero when balanced: the rudder
  makes up the rest); "design" is the geometric lead from area centroids.

- **Heel gauge**: clinometer seen from astern, with the hull section tilting, the crew drawn where they are,
  and your heel target marked. Green is flat, amber is losing drive, red is on the way over.
- **Sail trim mode (L)**: the boat steers itself at a chosen true wind angle (following any shifts) and the
  crew hike for you. The camera sits behind the helm looking up the rig, and the panel holds only sails,
  control lines and point-of-sail presets. A score shows your 2-second-average speed (VMG upwind and downwind)
  against the best you've managed at that angle and wind, so you can tell whether a change helped.
  In trim mode ←/→ change the wind angle and T changes tack.

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
| F V K U Y O I J 6 7 8 9 0 | layers (see above; the key is on each chip) |
| C | orbit / chase / top camera |
| L | sail trim mode on/off |
| Space | pause · **1–5** time scale |

All variables are also in the panel on the right. `window.sim` is exposed in the browser console.

## Honest limitations

- **Not calibrated against a real ISO polar or tank test.** The models are the textbook ones and the
  numbers land where they should (≈5.4 kn upwind in 12 kn, ≈8 kn beam reaching, ≈13 kn with the kite in
  16 kn), but breezy reaching speeds are probably still 10–15% optimistic. Logged GPS tracks are the obvious next step.
- A lifting line is not CFD. It has no thickness, no mast wake, and the separated wake behind a
  stalled sail is drawn from the section model's separation point, not computed. Sail shape comes
  from the control lines by rule, not from cloth mechanics.
- Planing uses slender-body theory scaled to Savitsky with the suction terms dropped; there is no spray
  sheet, and the hull's own wave is a single transverse component.
- Dimensions from public sources: LOA 4.74 m, beam 1.75 m (2.0 m over the wings), hull 100 kg,
  14.3 m² upwind, 18.8 m² gennaker. The main/jib split, rig geometry, foil sizes and hull lines are
  plausible estimates, not class drawings. Everything is a constant in `src/physics/boat.ts` / `hull.ts`.
- Linear (Airy) waves, no wave breaking on the boat, no cockpit flooding, no righting procedure
  (R puts it upright, as if you'd done it).
- The tide is a single harmonic with slack at HW/LW. Real harbours (Chichester included) are messier.

## Layout

```
src/physics/   pure TypeScript physics. No DOM; runs in Node for tests
  sim.ts         fixed-step loop
  boat.ts        rigid body, hull, foils, sails, crew, the force ledger
  vortex.ts      horseshoe-vortex system (lifting line + mirror images + the field anywhere in space)
  sections.ts    2-D section models: Kirchhoff separation, sails and foils, 0–180°
  planing.ts     slender-body planing scaled to Savitsky; 6×6 solver
  balance.ts     the ledger added up in level axes (forces, moments)
  hull.ts        parametric hull, volume cells, skin panels
  environment.ts weather → densities, tide, wind field
  waves.ts       spectrum, dispersion, orbital velocities
  assist.ts      auto-hike / auto-trim / autopilot
src/render/    three.js: GPU water (same wave components as physics), boat, sails, crew,
               and the layers (flowView, forceView, windView, centresView, pressure in boatView)
src/ui/        layer bar, force table, lil-gui variables panel, HUD instruments
tests/         vitest: 56 checks from fluid properties to lifting-line theory to a towing tank
```
