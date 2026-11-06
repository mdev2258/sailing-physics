// Every variable the sim exposes. The UI mutates these objects directly; the sim reads them each step.

export interface WindParams {
  speedKn: number; // mean true wind at 10 m
  fromDeg: number; // meteorological: direction the wind blows FROM
  gustiness: number; // 0..1, gust peaks ≈ mean × (1 + gustiness)
  gustScaleM: number; // typical gust patch wavelength on the water
  shiftAmpDeg: number; // oscillating shift amplitude
  shiftPeriodS: number; // oscillating shift period
  gradientExp: number; // power-law wind gradient exponent (≈1/7 over open water)
}

export interface WeatherParams {
  airTempC: number;
  pressureHPa: number;
  humidityPct: number;
  waterTempC: number;
  salinityPSU: number; // ≈35 open sea, ≈30–34 in a harbour, 0 fresh
  rain: number; // 0..1 (visual)
  fog: number; // 0..1 (visual)
  cloud: number; // 0..1 (visual lighting)
}

export interface WaveParams {
  autoFromWind: boolean; // derive Hs/Tp from wind speed + fetch (JONSWAP fetch-limited)
  fetchKm: number;
  heightM: number; // significant wave height Hs (when not auto)
  periodS: number; // peak period Tp (when not auto)
  lockToWind: boolean; // wind-sea comes from the wind direction
  fromDeg: number; // wind-sea direction (when not locked)
  spreadDeg: number; // directional spread of the wind-sea
  swellHeightM: number;
  swellPeriodS: number;
  swellFromDeg: number;
  seed: number;
}

export interface TideParams {
  rangeM: number; // HW − LW
  chartDepthM: number; // depth below chart datum at the sailing area
  hoursFromHW: number; // −6.2 … +6.2 (negative = before high water)
  periodH: number; // semi-diurnal ≈ 12.42 h
  maxStreamKn: number; // peak stream (mid-tide)
  floodToDeg: number; // direction the flood stream sets TOWARDS
  advanceWithSim: boolean; // tide clock runs with sim time
}

export type SideMode = 'auto' | 'port' | 'starboard';

export interface ControlParams {
  rudderDeg: number; // + = bear away to starboard (bow swings right)
  mainsheet: number; // 0 = fully eased … 1 = two-blocked
  jibSheet: number;
  gennakerHoisted: boolean;
  gennakerSheet: number;
  kicker: number; // vang 0..1
  downhaul: number; // luff downhaul (cunningham) 0..1
  barberHauler: number; // jib barber hauler: 0 off … 1 lead pulled fully in & down
  bridleLengthM: number; // mainsheet bridle length (m): short = block low, long = block high
  forestayTension: number; // rig / forestay tension 0 slack … 1 bar tight
  outhaul: number; // 0..1
  boardDown: number; // daggerboard 0 = fully up … 1 = fully down
  helmFwd: number; // metres fore(+)/aft(−) of the normal helming spot
  helmOut: number; // −0.5 leeward … 0 centreline … 0.5 on the side … 1 full hike
  crewFwd: number; // metres fore(+)/aft(−)
  crewOut: number; // −0.5 leeward … 0.5 on the side … 1 flat out on the trapeze
  side: SideMode; // which side the crew sit (auto = windward, follows the boom)
  autoHike: boolean; // helm + crew hike to hold heelTargetDeg
  heelTargetDeg: number;
  autoTrim: boolean; // sheets trimmed to target angle of attack
  autopilot: boolean; // hold compass heading
  autopilotHeadingDeg: number;
}

export interface BoatSetup {
  hullMassKg: number;
  rigMassKg: number;
  helmMassKg: number;
  crewMassKg: number;
  mainAreaM2: number;
  jibAreaM2: number;
  gennakerAreaM2: number;
  mastRakeDeg: number; // aft rake: moves the rig's centre of effort aft → more weather helm
}

export interface SimParams {
  wind: WindParams;
  weather: WeatherParams;
  waves: WaveParams;
  tide: TideParams;
  controls: ControlParams;
  setup: BoatSetup;
}

/** Defaults: a pleasant 12 kt sou'westerly in Chichester Harbour an hour before HW. */
export function defaultParams(): SimParams {
  return {
    wind: { speedKn: 12, fromDeg: 225, gustiness: 0.25, gustScaleM: 80, shiftAmpDeg: 6, shiftPeriodS: 90, gradientExp: 1 / 7 },
    weather: { airTempC: 14, pressureHPa: 1013, humidityPct: 75, waterTempC: 13, salinityPSU: 33, rain: 0, fog: 0, cloud: 0.3 },
    waves: {
      autoFromWind: true, fetchKm: 3, heightM: 0.3, periodS: 2.5, lockToWind: true, fromDeg: 225, spreadDeg: 25,
      swellHeightM: 0, swellPeriodS: 8, swellFromDeg: 200, seed: 7,
    },
    tide: { rangeM: 4.0, chartDepthM: 1.0, hoursFromHW: -1, periodH: 12.42, maxStreamKn: 1.2, floodToDeg: 350, advanceWithSim: true },
    controls: {
      rudderDeg: 0, mainsheet: 0.85, jibSheet: 0.85, gennakerHoisted: false, gennakerSheet: 0.5,
      kicker: 0.5, downhaul: 0.2, outhaul: 0.5, barberHauler: 0.3, bridleLengthM: 1.0, forestayTension: 0.5, boardDown: 1,
      helmFwd: 0, helmOut: 0.5, crewFwd: 0, crewOut: 0.5, side: 'auto',
      autoHike: true, heelTargetDeg: 3, autoTrim: false, autopilot: false, autopilotHeadingDeg: 0,
    },
    setup: {
      // ISO: 100 kg hull, 14.3 m² upwind (main/jib split estimated), 18.8 m² asymmetric.
      hullMassKg: 100, rigMassKg: 14, helmMassKg: 72, crewMassKg: 65,
      mainAreaM2: 10.4, jibAreaM2: 3.9, gennakerAreaM2: 18.8, mastRakeDeg: 4,
    },
  };
}
