#!/usr/bin/env node
/**
 * ntubus: NTU campus shuttle buses, for people, scripts and the secretary.
 *
 * Everything is read live from the NTU Omnibus app's own (unofficial) web API:
 * the routes, each route's stops in order with coordinates, the road geometry,
 * arrival times, bus positions with crowd levels, and service announcements.
 * Nothing about the network is hard-coded, so a new or temporary route (such
 * as the exam-period Grey loop) simply shows up.
 *
 * Three ways to use it:
 *   ntubus arrivals "Hall 1"            command line, readable text (add --json for data)
 *   ntubus alert --stop "Hall 1" ...    one quiet check, made for scheduled scripts
 *   ntubus mcp                          an MCP server on stdio, for the secretary
 *
 * No dependencies; needs Node 20 or newer. Not affiliated with NTU.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.0.0';

// ── The NTU Omnibus API ──────────────────────────────────────────────

const BASE = 'https://apps.ntu.edu.sg/NTUOmnibus';
// The app's fixed token for anonymous (not signed-in) requests.
const CSRF_TOKEN = 'T6C+9iB49TLra4jEsMeSckDMNhQ=';

const ENDPOINTS = {
  eta: 'screenservices/NTUMobile_MCW/ActionGetFMSBusStopETA',
  live: 'screenservices/CampusShuttle_MUI/MainFlow/RenderMap/DataActionGetActiveBusServicesData',
  points: 'screenservices/CampusShuttle_MUI/MainFlow/RenderMap/DataActionGetPickupCheckPoints',
  routes: 'screenservices/CampusShuttle_MUI/MainFlow/RenderMap/DataActionGetRoutesList',
  news: 'screenservices/NTUOmnibus/ActionGetAnnoucements',
};

// Each endpoint has a version key that changes when NTU republishes the app. These are the
// keys known to work; when one stops working, the current ones are read from the app's scripts.
const KNOWN_KEYS = {
  eta: '7+sPcG48iaiQFj4lnWvUpw',
  live: 'X18_TOlljR63ZC0gtWKItg',
  points: 'T2ld7BA3eca74ndBz+xz1Q',
  routes: 'LTmSrAcALxEQn_uoCNK2RA',
  news: 'agAUaSp+Gt+ysBfwCD5SRA',
};

// The arrivals endpoint only answers for certain screen names, and NTU has renamed them before.
const ETA_VIEWS = ['CommonFlow.SelectedRouteServiceDetail', 'MainFlow.SelectedRouteServiceDetail', 'CommonFlow.AllRoutesServiceDetails'];
const MAP_VIEW = 'MainFlow.Shuttle';

const REQUEST_TIMEOUT_MS = 10_000;
const NETWORK_TTL_MS = 6 * 3600_000;
const STATE_TTL_MS = 3600_000;

function cacheDir() {
  return process.env.NTUBUS_CACHE_DIR || path.join(process.env.HOME || os.homedir(), '.cache', 'ntubus');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(cacheDir(), file), 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file, value) {
  try {
    const full = path.join(cacheDir(), file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(`${full}.tmp`, JSON.stringify(value));
    fs.renameSync(`${full}.tmp`, full);
  } catch {
    // A cache that cannot be written only costs speed.
  }
}

let state; // { moduleVersion, keys, etaView, at }

function loadState() {
  if (!state) state = readJson('state.json') ?? {};
  state.keys = { ...KNOWN_KEYS, ...(state.keys ?? {}) };
  return state;
}

function saveState() {
  writeJson('state.json', { ...state, at: Date.now() });
}

async function httpJson(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`NTU's bus service answered with HTTP ${response.status}`);
  return response.json();
}

async function moduleVersion(force = false) {
  const s = loadState();
  if (!force && s.moduleVersion && Date.now() - (s.at ?? 0) < STATE_TTL_MS) return s.moduleVersion;
  try {
    const info = await httpJson(`${BASE}/moduleservices/moduleversioninfo`, { headers: { 'OutSystems-client-env': 'browser' } });
    if (info?.versionToken) {
      s.moduleVersion = info.versionToken;
      saveState();
    }
  } catch {
    // The data endpoints answer even with an old token, so carry on with what we have.
  }
  return s.moduleVersion ?? 'unknown';
}

/** Read the current version keys of our endpoints out of the app's own scripts. */
async function discoverKeys() {
  const s = loadState();
  const info = await httpJson(`${BASE}/moduleservices/moduleinfo`, { headers: { 'OutSystems-client-env': 'browser' } });
  const versions = info?.manifest?.urlVersions ?? {};
  const wanted = ['NTUMobile_MCW.controller.js', 'CampusShuttle_MUI.MainFlow.RenderMap.mvc.js', 'NTUOmnibus.controller.js'];
  const found = {};
  for (const [url, suffix] of Object.entries(versions)) {
    if (!wanted.some((name) => url.endsWith(`/${name}`))) continue;
    const text = await (await fetch(`https://apps.ntu.edu.sg${url}${suffix ?? ''}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })).text();
    for (const match of text.matchAll(/"(screenservices\/[^"]+)"\s*,\s*"([A-Za-z0-9_+/=-]{20,26})"/g)) {
      found[match[1]] = match[2];
    }
  }
  let changed = false;
  for (const [name, endpoint] of Object.entries(ENDPOINTS)) {
    if (found[endpoint] && found[endpoint] !== s.keys[name]) {
      s.keys[name] = found[endpoint];
      changed = true;
    }
  }
  if (changed) saveState();
  return changed;
}

/** Call one endpoint. Recovers by itself from a changed version key or a renamed screen. */
async function call(name, body, { viewName = MAP_VIEW, retry = true } = {}) {
  const s = loadState();
  const post = async (view) =>
    httpJson(`${BASE}/${ENDPOINTS[name]}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Csrftoken': CSRF_TOKEN },
      body: JSON.stringify({ versionInfo: { moduleVersion: await moduleVersion(), apiVersion: s.keys[name] }, viewName: view, ...body }),
    });

  let json = await post(viewName);

  if (json?.exception && name === 'eta' && /role validation/i.test(json.exception.message ?? '')) {
    for (const view of ETA_VIEWS) {
      if (view === viewName) continue;
      json = await post(view);
      if (!json?.exception) {
        s.etaView = view;
        saveState();
        break;
      }
    }
  }

  const stale = json?.versionInfo?.hasApiVersionChanged || (json?.exception && !Object.keys(json?.data ?? {}).length);
  if (stale && retry) {
    const changed = await discoverKeys().catch(() => false);
    await moduleVersion(true);
    if (changed || json?.versionInfo?.hasModuleVersionChanged) return call(name, body, { viewName, retry: false });
  }
  if (json?.exception && !Object.keys(json?.data ?? {}).length) {
    throw new Error(`NTU's bus service refused the request (${json.exception.message ?? 'unknown reason'}). The app may have changed.`);
  }
  return json.data ?? {};
}

// ── Geometry ─────────────────────────────────────────────────────────

const toRad = (deg) => (deg * Math.PI) / 180;

/** Distance in metres between two points on the ground. */
export function metres(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

/**
 * Turn a route's raw stops and road points into something that can be measured:
 * each stop gets its distance along the loop from the start of the road line.
 * Stops come in travel order, so each one is looked for further along than the last;
 * that keeps a road the bus uses in both directions from confusing things.
 */
export function buildRoute(name, rawStops, rawPoints) {
  const points = rawPoints.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const along = [0];
  for (let i = 1; i < points.length; i++) along.push(along[i - 1] + metres(points[i - 1], points[i]));
  const length = points.length > 1 ? along[along.length - 1] + metres(points[points.length - 1], points[0]) : 0;

  let from = 0;
  const stops = rawStops.map((stop) => {
    const here = { lat: Number(stop.lat), lng: Number(stop.lng) };
    let best = -1;
    let bestDistance = Infinity;
    for (let i = from; i < points.length; i++) {
      const d = metres(here, points[i]);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    }
    // Not near the rest of the line: the stop list was not in travel order after all.
    if (best === -1 || bestDistance > 200) {
      for (let i = 0; i < points.length; i++) {
        const d = metres(here, points[i]);
        if (d < bestDistance) {
          bestDistance = d;
          best = i;
        }
      }
    } else {
      from = best;
    }
    return { name: stop.name, lat: here.lat, lng: here.lng, at: best === -1 ? 0 : along[best] };
  });

  return { name, stops, length, points, along };
}

/** Metres a bus on this route travels from stop index i to stop index j, going round the loop if needed. */
export function rideMetres(route, i, j) {
  if (!route.length) return metres(route.stops[i], route.stops[j]) * 1.3;
  const d = route.stops[j].at - route.stops[i].at;
  return d > 0 ? d : d + route.length;
}

// ── Reading the network ──────────────────────────────────────────────

/** Every route with its stops in travel order. Cached for a few hours; it rarely changes. */
export async function loadNetwork({ fresh = false } = {}) {
  const cached = readJson('network.json');
  if (!fresh && cached?.routes && Date.now() - cached.at < NETWORK_TTL_MS) return cached;

  let names = [];
  try {
    const data = await call('routes', { screenData: { variables: { RouteId: 'Red' } } });
    names = (data?.RouteList?.List ?? []).map((r) => r.Route).filter(Boolean);
  } catch {
    names = [];
  }
  if (!names.length) names = ['Red', 'Blue', 'Green', 'Brown'];

  const routes = {};
  for (const name of names) {
    const data = await call('points', { screenData: { variables: { RouteId: name } } });
    const stops = (data?.PickupPoints?.PickupPointResult?.Pickuppoint?.List ?? []).map((p) => ({ name: p.Busstopcode || p.Pickupname, lat: p.Lat, lng: p.Lng }));
    const points = (data?.CheckPoint?.CheckPointResult?.CheckPoint?.List ?? []).map((p) => ({ lat: p.Latitude, lng: p.Longitude }));
    if (stops.length) {
      const built = buildRoute(name, stops, points);
      // The road line is only needed for measuring; keep the cache small.
      routes[name] = { name, stops: built.stops, length: built.length, points: thin(built.points, built.along) };
    }
  }
  if (!Object.keys(routes).length) {
    if (cached?.routes) return cached;
    throw new Error("Could not read the routes from NTU's bus service.");
  }
  const network = { routes, at: Date.now() };
  writeJson('network.json', network);
  return network;
}

/** Keep roughly one road point every 40 m, with its distance along the route. */
function thin(points, along) {
  const kept = [];
  let last = -Infinity;
  for (let i = 0; i < points.length; i++) {
    if (along[i] - last >= 40 || i === points.length - 1) {
      kept.push({ lat: points[i].lat, lng: points[i].lng, at: Math.round(along[i]) });
      last = along[i];
    }
  }
  return kept;
}

const minutes = (value) => {
  const n = Number(String(value ?? '').trim());
  return Number.isFinite(n) && String(value).trim() !== '' ? n : null;
};

/** Arrival times right now: route -> stop -> { arr, next } in minutes, or null when no bus is coming. */
export async function loadArrivals() {
  const s = loadState();
  const data = await call('eta', { inputParameters: { ServiceId: 'NTU' } }, { viewName: s.etaView ?? ETA_VIEWS[0] });
  const list = data?.BusStopList?.List ?? [];
  const arrivals = {};
  for (const entry of list) {
    const route = entry.RouteId || entry.Name;
    if (!route || !entry.BusStopCode) continue;
    (arrivals[route] ??= {})[entry.BusStopCode] = { arr: minutes(entry.ArrivalTime), next: minutes(entry.NextArrivalTime) };
  }
  return arrivals;
}

/** Buses on the road for one route: where they are, how fast, how full. */
export async function loadBuses(routeName) {
  const data = await call('live', { screenData: { variables: { RouteId: routeName } } });
  const list = data?.Response?.ActiveBusResult?.Activebus?.List ?? [];
  return list
    .map((bus) => ({
      plate: bus.Vehplate,
      lat: Number(bus.Lat),
      lng: Number(bus.Lng),
      speed: Number(bus.Speed) || 0,
      crowd: (bus.LoadInfo?.CrowdLevel || '').toLowerCase() || null,
    }))
    .filter((bus) => Number.isFinite(bus.lat) && Number.isFinite(bus.lng));
}

export async function loadNews() {
  const data = await call('news', { inputParameters: {} });
  const now = Date.now();
  return (data?.Response?.AnnouncementsResult?.Announcement?.List ?? [])
    .filter((a) => a.Status === 'Enabled' && (!a.Display_To || new Date(a.Display_To).getTime() > now))
    .map((a) => String(a.Text ?? '').trim())
    .filter(Boolean);
}

// ── Finding stops by what people call them ───────────────────────────

/** What people say, mapped to words that appear in stop names. Kept to the well-known ones. */
const ALIASES = {
  pioneer: ['Pioneer Stn Exit B'],
  'pioneer mrt': ['Pioneer Stn Exit B'],
  mrt: ['Pioneer Stn Exit B'],
  lwn: ['Lee Wee Nam Lib'],
  'lee wee nam': ['Lee Wee Nam Lib'],
  library: ['Lee Wee Nam Lib'],
  'north spine': ['Lee Wee Nam Lib', 'Opp CEE'],
  'south spine': ['SPMS', 'Opp SPMS', 'Opp S2'],
  nie: ['NIE Blk 2'],
  sbs: ['Sch of Biological Sciences'],
  'biological sciences': ['Sch of Biological Sciences'],
  wkw: ['WKWSCI', 'Opp WKWSCI'],
  adm: ['Sch of ADM'],
  cee: ['Sch of CEE', 'Opp CEE'],
  uhs: ['Uni Health Service'],
  'health service': ['Uni Health Service'],
  clinic: ['Uni Health Service'],
  tct: ['TCT-LT'],
  'tan chin tuan': ['TCT-LT'],
  wcy: ['Wee Cho Yaw Plaza', 'Opp Yunnan Gdn'],
  'yunnan garden': ['Wee Cho Yaw Plaza', 'Opp Yunnan Gdn'],
  'ny cres': ['Nanyang Crescent Halls', 'NY Cres Halls', 'Opp NY Cres Halls'],
  crescent: ['Nanyang Crescent Halls', 'NY Cres Halls', 'Opp NY Cres Halls'],
  'nanyang crescent': ['Nanyang Crescent Halls', 'NY Cres Halls', 'Opp NY Cres Halls'],
  'hall 8': ['Hall 8 & 9', 'Hall 8 Blk 41'],
  'hall 9': ['Hall 8 & 9'],
  'hall 14': ['Opp Hall 14'],
  'hall 16': ['Opp Hall 16'],
};

export function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bopposite\b/g, 'opp')
    .replace(/\bstation\b/g, 'stn')
    .replace(/\bschool\b/g, 'sch')
    .replace(/\bgarden\b/g, 'gdn')
    .replace(/\bblock\b/g, 'blk')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** All stop names in the network, each with the routes that serve it and where it is. */
export function allStops(network) {
  const stops = new Map();
  for (const route of Object.values(network.routes)) {
    for (const stop of route.stops) {
      const entry = stops.get(stop.name) ?? { name: stop.name, lat: stop.lat, lng: stop.lng, routes: [] };
      if (!entry.routes.includes(route.name)) entry.routes.push(route.name);
      stops.set(stop.name, entry);
    }
  }
  return [...stops.values()];
}

/**
 * Stops a person most likely means, best first. "Hall 1" finds Hall 1 and then
 * Opp Hall 1 (the other side of the road), but never Hall 11 or Hall 12.
 */
export function findStops(network, query) {
  const stops = allStops(network);
  const wanted = normalise(query);
  if (!wanted) return [];

  const exact = stops.filter((s) => normalise(s.name) === wanted);
  const aliased = (ALIASES[wanted] ?? []).map((name) => stops.find((s) => s.name === name)).filter(Boolean);

  const tokens = wanted.split(' ');
  const wordy = stops
    .map((stop) => {
      const words = normalise(stop.name).split(' ');
      // Numbers must match whole ("1" is not "11"); words may be the start of a word.
      const all = tokens.every((t) => (/^\d+$/.test(t) ? words.includes(t) : words.some((w) => w.startsWith(t))));
      return all ? { stop, extra: words.length - tokens.length } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.extra - b.extra)
    .map((m) => m.stop);

  const seen = new Set();
  return [...exact, ...aliased, ...wordy].filter((s) => (seen.has(s.name) ? false : seen.add(s.name)));
}

/** The stop across the road, when the network has one ("Hall 1" <-> "Opp Hall 1"). */
export function oppositeOf(network, stopName) {
  const stops = allStops(network);
  const base = normalise(stopName).replace(/^opp /, '');
  return stops.find((s) => s.name !== stopName && normalise(s.name).replace(/^opp /, '') === base);
}

function nearestStops(network, here, limit = 3) {
  return allStops(network)
    .map((stop) => ({ ...stop, metres: Math.round(metres(here, stop)) }))
    .sort((a, b) => a.metres - b.metres)
    .slice(0, limit);
}

function matchRoute(network, query) {
  if (!query) return undefined;
  const wanted = normalise(query).replace(/ (route|loop|line|bus)$/, '');
  return Object.keys(network.routes).find((name) => normalise(name) === wanted);
}

// ── Answers ──────────────────────────────────────────────────────────

const WALK_METRES_PER_MIN = 75;
const WALK_DETOUR = 1.25; // paths are longer than a straight line
const BUS_METRES_PER_MIN = 300; // about 18 km/h while moving
const DWELL_MIN_PER_STOP = 0.4;

const walkMinutes = (a, b) => Math.max(1, Math.round((metres(a, b) * WALK_DETOUR) / WALK_METRES_PER_MIN));

/** Arrivals at the stops matching a name, including the stop across the road. */
export async function arrivalsAt(query, routeQuery) {
  const network = await loadNetwork();
  const matches = findStops(network, query);
  if (!matches.length) return { found: false, query, stops: allStops(network).map((s) => s.name).sort() };

  const route = matchRoute(network, routeQuery);
  if (routeQuery && !route) return { found: false, query, problem: `There is no "${routeQuery}" route.`, routes: Object.keys(network.routes) };

  const arrivals = await loadArrivals();
  const primary = matches[0];
  const opposite = oppositeOf(network, primary.name);
  // An alias such as "south spine" names several stops; a plain name means one stop and its opposite side.
  const aliasHit = (ALIASES[normalise(query)] ?? []).length > 1;
  const chosen = aliasHit ? matches.slice(0, 4) : [primary, ...(opposite ? [opposite] : [])];

  const stops = chosen.map((stop) => ({
    stop: stop.name,
    acrossTheRoadFrom: stop !== primary && !aliasHit ? primary.name : undefined,
    routes: stop.routes
      .filter((name) => !route || name === route)
      .map((name) => ({ route: name, ...(arrivals[name]?.[stop.name] ?? { arr: null, next: null }) }))
      .sort((a, b) => (a.arr ?? 999) - (b.arr ?? 999)),
  }));
  const shown = new Set(chosen.map((c) => c.name));
  const others = matches.filter((m) => !shown.has(m.name)).map((m) => m.name);
  return { found: true, query, stops: stops.filter((s) => s.routes.length), otherMatches: others.slice(0, 6) };
}

/** How far someone will reasonably walk to or from a stop that is not the one they named. */
const NEARBY_METRES = 400;

/** The named stops, plus other stops close enough to walk to, each with the walk in minutes. */
function reachable(network, named) {
  const result = new Map();
  for (const stop of named) result.set(stop.name, { stop, walk: 0, via: null });
  for (const stop of allStops(network)) {
    if (result.has(stop.name)) continue;
    let closest = null;
    for (const anchor of named) {
      const d = metres(anchor, stop);
      if (d <= NEARBY_METRES && (!closest || d < closest.d)) closest = { d, anchor };
    }
    if (closest) result.set(stop.name, { stop, walk: walkMinutes(closest.anchor, stop), via: closest.anchor.name });
  }
  return result;
}

/** Ways to get from one place to another by campus bus, quickest first, plus the walk. */
export async function planTrip(fromQuery, toQuery) {
  const network = await loadNetwork();
  const origins = findStops(network, fromQuery).slice(0, 4);
  const destinations = findStops(network, toQuery).slice(0, 4);
  if (!origins.length || !destinations.length) {
    return { found: false, unknown: !origins.length ? fromQuery : toQuery, stops: allStops(network).map((s) => s.name).sort() };
  }
  const arrivals = await loadArrivals();
  const boardAt = reachable(network, origins);
  const alightAt = reachable(network, destinations);

  let walk = Infinity;
  for (const from of origins) for (const to of destinations) walk = Math.min(walk, walkMinutes(from, to));

  const headway = (routeName, stopName) => {
    const a = arrivals[routeName]?.[stopName];
    return a && a.arr !== null && a.next !== null && a.next > a.arr ? a.next - a.arr : 10;
  };

  /** Minutes on the bus from stop i to stop j. Distance gives a first guess; NTU's own predictions refine it. */
  const ride = (route, i, j) => {
    const stops = (j - i + route.stops.length) % route.stops.length;
    const guess = rideMetres(route, i, j) / BUS_METRES_PER_MIN + DWELL_MIN_PER_STOP * stops;
    const from = arrivals[route.name]?.[route.stops[i].name];
    const to = arrivals[route.name]?.[route.stops[j].name];
    let best = guess;
    if (from?.arr !== null && from?.arr !== undefined && to) {
      // The same bus is predicted at both stops; the difference is its travel time.
      const predicted = [to.arr, to.next].filter((t) => t !== null).map((t) => t - from.arr).filter((t) => t >= guess * 0.4 && t <= guess * 1.8);
      if (predicted.length) best = Math.min(...predicted);
    }
    return { minutes: Math.max(1, Math.round(best)), stops };
  };

  /** When the person can actually be on a bus at this stop, given the walk to it. */
  const departure = (routeName, stopName, walkIn) => {
    const a = arrivals[routeName]?.[stopName];
    if (!a || a.arr === null) return null;
    if (a.arr >= walkIn) return { at: a.arr, bus: a.arr, then: a.next };
    if (a.next !== null && a.next >= walkIn) return { at: a.next, bus: a.next, then: null };
    return { at: walkIn + Math.round(headway(routeName, stopName) / 2), bus: null, then: null };
  };

  const direct = [];
  for (const route of Object.values(network.routes)) {
    let best;
    route.stops.forEach((from, i) => {
      const origin = boardAt.get(from.name);
      if (!origin) return;
      route.stops.forEach((to, j) => {
        const destination = alightAt.get(to.name);
        if (i === j || !destination) return;
        // Walking most of the way to save a short ride is not a bus trip.
        if (origin.walk + destination.walk >= walk) return;
        const leg = ride(route, i, j);
        const depart = departure(route.name, from.name, origin.walk);
        const longWayRound = route.length > 0 && rideMetres(route, i, j) > route.length * 0.7;
        const option = {
          type: 'direct',
          route: route.name,
          walkToStopMinutes: origin.walk,
          board: from.name,
          alight: to.name,
          walkFromStopMinutes: destination.walk,
          busInMinutes: depart?.bus ?? null,
          busAfterThatMinutes: depart?.then ?? null,
          rideMinutes: leg.minutes,
          stops: leg.stops,
          running: depart !== null,
          totalMinutes: depart === null ? null : depart.at + leg.minutes + destination.walk,
          longWayRound,
        };
        // Between two equally quick ways, the one with less walking wins.
        const score = (o) => (o.totalMinutes ?? 1e9) + (o.longWayRound ? 5 : 0) + 0.3 * (o.walkToStopMinutes + o.walkFromStopMinutes);
        if (!best || score(option) < score(best)) best = option;
      });
    });
    if (best) direct.push(best);
  }

  // One change of bus, only worth working out when nothing runs direct.
  const transfers = [];
  if (!direct.some((o) => o.running && !o.longWayRound)) {
    for (const first of Object.values(network.routes)) {
      first.stops.forEach((from, i) => {
        const origin = boardAt.get(from.name);
        if (!origin) return;
        const depart = departure(first.name, from.name, origin.walk);
        if (!depart) return;
        first.stops.forEach((change, k) => {
          if (k === i) return;
          const leg1 = ride(first, i, k);
          for (const second of Object.values(network.routes)) {
            if (second.name === first.name) continue;
            second.stops.forEach((board, m) => {
              const hop = board.name === change.name ? 0 : metres(change, board) <= 160 ? walkMinutes(change, board) : null;
              const there = arrivals[second.name]?.[board.name];
              if (hop === null || !there || there.arr === null) return;
              second.stops.forEach((to, n) => {
                const destination = alightAt.get(to.name);
                if (n === m || !destination) return;
                const leg2 = ride(second, m, n);
                transfers.push({
                  type: 'transfer',
                  route: first.name,
                  walkToStopMinutes: origin.walk,
                  board: from.name,
                  busInMinutes: depart.bus,
                  changeAt: change.name,
                  walkBetweenMinutes: hop,
                  thenRoute: second.name,
                  thenBoard: board.name,
                  alight: to.name,
                  walkFromStopMinutes: destination.walk,
                  totalMinutes: depart.at + leg1.minutes + hop + Math.round(headway(second.name, board.name) / 2) + leg2.minutes + destination.walk,
                  running: true,
                });
              });
            });
          }
        });
      });
    }
    transfers.sort((a, b) => a.totalMinutes - b.totalMinutes);
  }

  const options = [...direct, ...transfers.slice(0, 2)].sort(
    (a, b) => (a.totalMinutes ?? 1e9) + (a.longWayRound ? 5 : 0) - ((b.totalMinutes ?? 1e9) + (b.longWayRound ? 5 : 0)),
  );
  return { found: true, from: origins.map((s) => s.name), to: destinations.map((s) => s.name), options: options.slice(0, 4), walkMinutes: Number.isFinite(walk) ? walk : null };
}

/** Where the buses are right now, per route. */
export async function liveBuses(routeQuery) {
  const network = await loadNetwork();
  const route = matchRoute(network, routeQuery);
  if (routeQuery && !route) return { found: false, problem: `There is no "${routeQuery}" route.`, routes: Object.keys(network.routes) };
  const names = route ? [route] : Object.keys(network.routes);
  const routes = [];
  for (const name of names) {
    const buses = await loadBuses(name).catch(() => []);
    routes.push({
      route: name,
      buses: buses.map((bus) => {
        const near = network.routes[name].stops.map((stop) => ({ stop: stop.name, metres: Math.round(metres(bus, stop)) })).sort((a, b) => a.metres - b.metres)[0];
        return { plate: bus.plate, near: near?.stop, metresAway: near?.metres, speedKmh: bus.speed, crowd: bus.crowd, lat: bus.lat, lng: bus.lng };
      }),
    });
  }
  return { found: true, routes };
}

export async function networkSummary() {
  const network = await loadNetwork();
  const arrivals = await loadArrivals().catch(() => ({}));
  return Object.values(network.routes).map((route) => ({
    route: route.name,
    running: Object.values(arrivals[route.name] ?? {}).some((a) => a.arr !== null),
    loopKm: Math.round(route.length / 100) / 10,
    stops: route.stops.map((s) => s.name),
  }));
}

// ── Alerts: one quiet check, for scheduled scripts ───────────────────

/**
 * Check once whether a bus is within `within` minutes of a stop. Returns the
 * message to post, or '' to stay silent. It speaks once and then stays quiet,
 * so a schedule can run it every few seconds without repeating itself.
 */
export async function checkAlert({ stop, route, within = 3, key, mention = '', repeat = false }) {
  const file = `alerts/${String(key || `${stop}-${route || 'any'}-${within}`).replace(/[^\w.-]+/g, '_')}.json`;
  const memory = readJson(file) ?? {};
  if (memory.done && !repeat) return '';

  const network = await loadNetwork();
  const match = findStops(network, stop)[0];
  if (!match) {
    if (memory.complained) return '';
    writeJson(file, { ...memory, complained: true });
    return `⚠️ Bus alert: I don't know a stop called "${stop}".`;
  }
  const wantedRoute = matchRoute(network, route);
  const arrivals = await loadArrivals();
  const coming = match.routes
    .filter((name) => !wantedRoute || name === wantedRoute)
    .map((name) => ({ route: name, ...(arrivals[name]?.[match.name] ?? { arr: null, next: null }) }))
    .filter((a) => a.arr !== null)
    .sort((a, b) => a.arr - b.arr);

  if (!coming.length) {
    if (memory.toldNotRunning) return '';
    writeJson(file, { ...memory, toldNotRunning: true });
    return `${mention ? `${mention} ` : ''}🚌 No ${wantedRoute ?? 'campus'} bus is heading to ${match.name} right now. I'll keep watching and tell you when one is close.`;
  }

  const soonest = coming[0];
  if (soonest.arr > within) {
    // The bus that set off the last alert has gone; be ready for the next one.
    if (repeat && memory.done && soonest.arr > within + 1) writeJson(file, { ...memory, done: false });
    return '';
  }
  if (memory.done) return '';
  writeJson(file, { ...memory, done: true, at: Date.now() });
  const when = soonest.arr <= 0 ? 'is arriving now' : `reaches ${match.name} in ${soonest.arr} min`;
  const after = soonest.next !== null ? ` The one after is ${soonest.next} min away.` : '';
  return `${mention ? `${mention} ` : ''}🚌 ${soonest.route} bus ${soonest.arr <= 0 ? `at ${match.name} ` : ''}${when}.${after}`;
}

/** Write the small script a schedule runs for an alert, and say how to schedule it. */
export async function prepareAlert({ stop, route, within = 3, mention = '', repeat = false, dir = 'ntubus-alerts' }) {
  const network = await loadNetwork();
  const match = findStops(network, stop)[0];
  if (!match) return { ok: false, problem: `There is no stop called "${stop}".`, stops: allStops(network).map((s) => s.name).sort() };
  const wantedRoute = matchRoute(network, route);
  if (route && !wantedRoute) return { ok: false, problem: `There is no "${route}" route.`, routes: Object.keys(network.routes) };
  if (wantedRoute && !match.routes.includes(wantedRoute)) {
    return { ok: false, problem: `The ${wantedRoute} route does not stop at ${match.name}. Routes there: ${match.routes.join(', ')}.` };
  }

  const key = `${normalise(match.name).replace(/ /g, '-')}-${(wantedRoute ?? 'any').toLowerCase()}-${Date.now().toString(36)}`;
  const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const args = ['--stop', quote(match.name), '--within', String(within), '--key', quote(key)];
  if (wantedRoute) args.push('--route', quote(wantedRoute));
  if (mention) args.push('--mention', quote(mention));
  if (repeat) args.push('--repeat');

  fs.mkdirSync(dir, { recursive: true });
  const script = `${dir}/${key}.sh`;
  fs.writeFileSync(script, `#!/bin/bash\n# Posts once when a bus is within ${within} min of ${match.name}. Made by ntubus.\nexec ntubus alert ${args.join(' ')}\n`, { mode: 0o755 });

  const arrivals = await loadArrivals().catch(() => ({}));
  const now = match.routes
    .filter((name) => !wantedRoute || name === wantedRoute)
    .map((name) => ({ route: name, ...(arrivals[name]?.[match.name] ?? { arr: null, next: null }) }));
  return { ok: true, script, stop: match.name, route: wantedRoute ?? null, within, repeat, now };
}

// ── Text for people ──────────────────────────────────────────────────

const clock = () => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: process.env.TZ || 'Asia/Singapore' }).format(new Date());
const eta = (a) => (a.arr === null ? 'no bus coming' : `${a.arr <= 0 ? 'arriving now' : `${a.arr} min`}${a.next !== null ? `, then ${a.next} min` : ''}`);

export function arrivalsText(result) {
  if (!result.found) {
    return result.problem ? `${result.problem} Routes: ${result.routes.join(', ')}.` : `No stop matches "${result.query}". Stops: ${result.stops.join(', ')}.`;
  }
  const lines = [`Arrivals at ${clock()}:`];
  for (const stop of result.stops) {
    lines.push(`${stop.stop}${stop.acrossTheRoadFrom ? ` (across the road from ${stop.acrossTheRoadFrom})` : ''}`);
    for (const r of stop.routes) lines.push(`  ${r.route}: ${eta(r)}`);
  }
  if (result.otherMatches?.length) lines.push(`Other stops with a similar name: ${result.otherMatches.join(', ')}.`);
  return lines.join('\n');
}

export function planText(result) {
  if (!result.found) return `No stop matches "${result.unknown}". Stops: ${result.stops.join(', ')}.`;
  const lines = [`From ${result.from.join(' / ')} to ${result.to.join(' / ')}, at ${clock()}:`];
  if (!result.options.length) lines.push('No campus bus route connects these places, even with one change.');
  const walkIn = (o) => (o.walkToStopMinutes ? `walk ${o.walkToStopMinutes} min to ${o.board}, ` : `at ${o.board}, `);
  const walkOut = (o) => (o.walkFromStopMinutes ? `, then walk ${o.walkFromStopMinutes} min` : '');
  const bus = (minutes) => (minutes === null ? 'bus time not predicted yet' : minutes <= 0 ? 'bus arriving now' : `bus in ${minutes} min`);
  result.options.forEach((o, index) => {
    if (o.type === 'direct') {
      const status = o.running
        ? `${bus(o.busInMinutes)}${o.busAfterThatMinutes !== null ? ` (the next ${o.busAfterThatMinutes} min)` : ''}; about ${o.totalMinutes} min in total`
        : 'not running right now';
      lines.push(`${index + 1}. ${o.route}: ${walkIn(o)}ride ${o.stops} stop(s) (about ${o.rideMinutes} min) to ${o.alight}${walkOut(o)}; ${status}${o.longWayRound ? '; this goes most of the way round the loop' : ''}`);
    } else {
      lines.push(
        `${index + 1}. ${o.route} then ${o.thenRoute}: ${walkIn(o)}take ${o.route} (${bus(o.busInMinutes)}) to ${o.changeAt}` +
          `${o.walkBetweenMinutes ? `, walk ${o.walkBetweenMinutes} min to ${o.thenBoard}` : ''}, take ${o.thenRoute} to ${o.alight}${walkOut(o)}; about ${o.totalMinutes} min in total`,
      );
    }
  });
  if (result.walkMinutes !== null) {
    const fastest = result.options.find((o) => o.running)?.totalMinutes;
    lines.push(`Walking the whole way takes about ${result.walkMinutes} min${fastest !== undefined && result.walkMinutes <= fastest ? ', which is as quick as the bus right now' : ''}.`);
  }
  lines.push('Bus waiting times are live; ride and walking times are estimates.');
  return lines.join('\n');
}

export function liveText(result) {
  if (!result.found) return `${result.problem} Routes: ${result.routes.join(', ')}.`;
  const lines = [`Buses on the road at ${clock()}:`];
  for (const route of result.routes) {
    if (!route.buses.length) {
      lines.push(`${route.route}: none`);
      continue;
    }
    lines.push(`${route.route}: ${route.buses.length}`);
    for (const bus of route.buses) {
      lines.push(`  ${bus.plate}: ${bus.metresAway <= 60 ? 'at' : 'near'} ${bus.near}, ${bus.speedKmh ? `${bus.speedKmh} km/h` : 'stopped'}${bus.crowd ? `, crowd ${bus.crowd}` : ''}`);
    }
  }
  return lines.join('\n');
}

export function routesText(summary) {
  return summary.map((r) => `${r.route} (${r.running ? 'running' : 'not running now'}, ${r.loopKm} km loop): ${r.stops.join(' → ')}`).join('\n');
}

function alertText(result) {
  if (!result.ok) return result.problem + (result.stops ? ` Stops: ${result.stops.join(', ')}.` : '') + (result.routes ? ` Routes: ${result.routes.join(', ')}.` : '');
  const now = result.now.map((r) => `${r.route} ${eta(r)}`).join('; ') || 'no bus coming';
  return [
    `Alert script written: ${result.script}`,
    `It posts once when a ${result.route ?? 'campus'} bus is within ${result.within} min of ${result.stop}${result.repeat ? ', and again for each later bus' : ''}, and prints nothing otherwise.`,
    `Right now at ${result.stop}: ${now}.`,
    `To switch it on, schedule it: schedule_create with kind "script", text "${result.script}", every_seconds 20, and "until" set to when the person no longer needs it (about 45 minutes from now if they did not say). Nothing is watching until you do that.`,
  ].join('\n');
}

// ── MCP server (stdio) ───────────────────────────────────────────────

const INSTRUCTIONS = `Live NTU campus shuttle buses (the Red, Blue, Green and Brown loops and any temporary ones), read from NTU's own bus app. Use these tools for anything about campus buses: when the next bus comes, which bus to take between two places on campus, where the buses are and how full, and service notices. They are live, so prefer them over memory or the web for anything about campus shuttles. Public buses (179, 199 and others) are not covered here.

Stop names are what NTU calls them (Hall 1, Opp Hall 1, Lee Wee Nam Lib, Pioneer Stn Exit B). Give the name the person used; common nicknames are understood, and a miss returns the full list of stops to choose from. "Opp X" is the stop across the road from X, served by buses going the other way, so say which side when it matters.

For "tell me when the bus is close" or "remind me when it's N minutes away", call arrival_alert, then schedule the script it writes with schedule_create (kind "script", every_seconds 20, an "until" time). That runs without Claude and posts once. The same tool is on the command line as "ntubus" for hooks and scheduled scripts: ntubus arrivals <stop>, ntubus plan <from> <to>, ntubus live [route], ntubus routes, ntubus news, each with --json.`;

const TOOLS = [
  {
    name: 'arrivals',
    description: 'Minutes until the next and the following campus bus at a stop, per route, including the stop across the road.',
    inputSchema: {
      type: 'object',
      properties: {
        stop: { type: 'string', description: 'Stop name as the person said it, e.g. "Hall 1", "LWN", "Pioneer".' },
        route: { type: 'string', description: 'Only this route, e.g. "Red". Optional.' },
      },
      required: ['stop'],
    },
    run: async ({ stop, route }) => arrivalsText(await arrivalsAt(stop, route)),
  },
  {
    name: 'plan_trip',
    description: 'How to get from one place on campus to another by campus bus: which route, where to board and get off, live waiting time, estimated total time, one change of bus if needed, and the walking time for comparison.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Where the person starts, as a stop name or nickname.' },
        to: { type: 'string', description: 'Where they want to go.' },
      },
      required: ['from', 'to'],
    },
    run: async ({ from, to }) => planText(await planTrip(from, to)),
  },
  {
    name: 'live_buses',
    description: 'Where the campus buses are right now, their speed and how crowded each one is. All routes, or one.',
    inputSchema: { type: 'object', properties: { route: { type: 'string', description: 'A route name such as "Blue". Optional.' } } },
    run: async ({ route }) => liveText(await liveBuses(route)),
  },
  {
    name: 'routes',
    description: 'Every campus bus route with its stops in travel order and whether it is running now.',
    inputSchema: { type: 'object', properties: {} },
    run: async () => routesText(await networkSummary()),
  },
  {
    name: 'notices',
    description: "Current service announcements from NTU's bus app (changed frequencies, temporary routes, disruptions).",
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      const news = await loadNews();
      return news.length ? news.map((n) => `• ${n}`).join('\n') : 'No service announcements right now.';
    },
  },
  {
    name: 'arrival_alert',
    description: 'Prepare an alert for when a bus gets close to a stop. Writes a small script into the workspace and tells you how to schedule it; the alert is not active until you schedule it.',
    inputSchema: {
      type: 'object',
      properties: {
        stop: { type: 'string', description: 'The stop to watch.' },
        route: { type: 'string', description: 'Only this route. Optional: any route serving the stop.' },
        within_minutes: { type: 'number', description: 'Alert when a bus is this many minutes away or less. Default 3.' },
        mention: { type: 'string', description: 'Who to address in the alert, e.g. "@william". Optional.' },
        repeat: { type: 'boolean', description: 'Alert for every bus instead of only the first. Default false.' },
      },
      required: ['stop'],
    },
    run: async ({ stop, route, within_minutes, mention, repeat }) =>
      alertText(await prepareAlert({ stop, route, within: Number(within_minutes) > 0 ? Number(within_minutes) : 3, mention: mention ?? '', repeat: Boolean(repeat) })),
  },
];

async function serveMcp() {
  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  let buffer = '';
  let pending = Promise.resolve();

  const handle = async (message) => {
    const { id, method, params } = message;
    if (method === 'initialize') {
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'ntubus', version: VERSION },
          instructions: INSTRUCTIONS,
        },
      });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') {
      return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    }
    if (method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
      try {
        const text = await tool.run(params?.arguments ?? {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      } catch (error) {
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Could not get bus information: ${error.message}` }], isError: true } });
      }
    }
    // Notifications have no id and need no answer.
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  };

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      pending = pending.then(() => handle(message)).catch(() => {});
    }
  });
  // Finish what is in progress, then leave once the connections have closed.
  process.stdin.on('end', () => pending.then(() => setTimeout(() => process.exit(0), 200)));
}

// ── Command line ─────────────────────────────────────────────────────

const HELP = `ntubus ${VERSION}: live NTU campus shuttle buses

  ntubus arrivals <stop> [--route R]     when the next buses come
  ntubus plan <from> <to>                which bus to take, and how long
  ntubus live [route]                    where the buses are, and how full
  ntubus routes                          every route and its stops
  ntubus stops [text]                    stop names (matching text)
  ntubus near <lat> <lng>                the closest stops to a point
  ntubus news                            service announcements
  ntubus alert --stop S [--route R] [--within N] [--key K] [--mention @x] [--repeat]
                                         one check: prints a line when a bus is within N minutes
                                         (default 3), once, and nothing otherwise. Run it from a
                                         schedule every 20 seconds.
  ntubus watch --stop S [--route R] [--within N] [--for MINUTES]
                                         the same, but waits here until it happens
  ntubus mcp                             serve these as MCP tools on stdio

Add --json to get data instead of text. Stop names are NTU's own ("Hall 1", "Opp Hall 1",
"Lee Wee Nam Lib"); common nicknames work. Not affiliated with NTU.`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (['json', 'repeat', 'fresh', 'help'].includes(name) || next === undefined || next.startsWith('--')) flags[name] = true;
      else flags[name] = argv[++i];
    } else positional.push(arg);
  }
  return { positional, flags };
}

async function main(argv) {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const out = (data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text);

  switch (command) {
    case 'arrivals': {
      if (!positional.length) throw new Error('Which stop? e.g. ntubus arrivals "Hall 1"');
      const result = await arrivalsAt(positional.join(' '), flags.route);
      return out(result, arrivalsText(result));
    }
    case 'plan': {
      if (positional.length < 2) throw new Error('Give two places, e.g. ntubus plan "Hall 1" "NIE"');
      const result = await planTrip(positional[0], positional.slice(1).join(' '));
      return out(result, planText(result));
    }
    case 'live': {
      const result = await liveBuses(positional.join(' ') || flags.route);
      return out(result, liveText(result));
    }
    case 'routes': {
      const result = await networkSummary();
      return out(result, routesText(result));
    }
    case 'stops': {
      const network = await loadNetwork({ fresh: Boolean(flags.fresh) });
      const stops = positional.length ? findStops(network, positional.join(' ')) : allStops(network).sort((a, b) => a.name.localeCompare(b.name));
      return out(stops, stops.map((s) => `${s.name} (${s.routes.join(', ')})`).join('\n') || 'No stop matches.');
    }
    case 'near': {
      const here = { lat: Number(positional[0]), lng: Number(positional[1]) };
      if (!Number.isFinite(here.lat) || !Number.isFinite(here.lng)) throw new Error('Give a latitude and longitude, e.g. ntubus near 1.3456 103.6878');
      const stops = nearestStops(await loadNetwork(), here, 4);
      return out(stops, stops.map((s) => `${s.name}: ${s.metres} m (${s.routes.join(', ')})`).join('\n'));
    }
    case 'news': {
      const news = await loadNews();
      return out(news, news.length ? news.map((n) => `• ${n}`).join('\n') : 'No service announcements right now.');
    }
    case 'alert': {
      if (!flags.stop) throw new Error('Which stop? e.g. ntubus alert --stop "Hall 1" --route Red --within 3');
      const text = await checkAlert({ stop: flags.stop, route: flags.route, within: Number(flags.within) > 0 ? Number(flags.within) : 3, key: flags.key, mention: typeof flags.mention === 'string' ? flags.mention : '', repeat: Boolean(flags.repeat) });
      if (text) console.log(text);
      return;
    }
    case 'watch': {
      if (!flags.stop) throw new Error('Which stop? e.g. ntubus watch --stop "Hall 1" --route Red --within 3');
      const deadline = Date.now() + (Number(flags.for) > 0 ? Number(flags.for) : 30) * 60_000;
      const key = flags.key || `watch-${process.pid}-${Date.now()}`;
      while (Date.now() < deadline) {
        const text = await checkAlert({ stop: flags.stop, route: flags.route, within: Number(flags.within) > 0 ? Number(flags.within) : 3, key, mention: typeof flags.mention === 'string' ? flags.mention : '' }).catch(() => '');
        if (text && !/keep watching/.test(text)) {
          console.log(text);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
      console.log(`No bus came within range of ${flags.stop} in that time.`);
      process.exitCode = 3;
      return;
    }
    case 'mcp':
      return serveMcp();
    case undefined:
    case 'help':
    case '--help':
      return console.log(HELP);
    default:
      throw new Error(`Unknown command "${command}". Run ntubus help.`);
  }
}

// Run only when started as a program, not when imported (the tests import the functions above).
const startedDirectly = (() => {
  try {
    return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (startedDirectly) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`ntubus: ${error.message}`);
    process.exit(1);
  });
}
