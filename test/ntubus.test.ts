import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ntubus is a plain script shipped in the sandbox image; its functions are tested here against
// a small made-up campus, with NTU's web API replaced by a stand-in.
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntubus-test-'));
process.env.NTUBUS_CACHE_DIR = path.join(workDir, 'cache');
process.env.TZ = 'Asia/Singapore';

// @ts-expect-error a JavaScript module without type declarations
const bus = await import('../sandbox/workbench/ntubus/ntubus.mjs');

after(() => fs.rmSync(workDir, { recursive: true, force: true }));

// ── A made-up campus ─────────────────────────────────────────────────
// Red runs round a 445 m square: Hall 1 -> Hall 2 -> Lee Wee Nam Lib -> Hall 11 -> (Hall 1).
// Blue runs from Opp Hall 1 up to NIE Blk 2, which only Blue serves.

type Point = { lat: number; lng: number };
const corner: Point[] = [
  { lat: 1.34, lng: 103.68 },
  { lat: 1.34, lng: 103.684 },
  { lat: 1.344, lng: 103.684 },
  { lat: 1.344, lng: 103.68 },
];

function line(points: Point[], closed: boolean): Point[] {
  const out: Point[] = [];
  const count = closed ? points.length : points.length - 1;
  for (let i = 0; i < count; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    for (let step = 0; step < 8; step++) out.push({ lat: a.lat + ((b.lat - a.lat) * step) / 8, lng: a.lng + ((b.lng - a.lng) * step) / 8 });
  }
  return out;
}

const network: Record<string, { stops: Array<Point & { name: string }>; points: Point[] }> = {
  Red: {
    stops: [
      { name: 'Hall 1', ...corner[0] },
      { name: 'Hall 2', lat: 1.34, lng: 103.682 },
      { name: 'Lee Wee Nam Lib', ...corner[2] },
      { name: 'Hall 11', ...corner[3] },
    ],
    points: line(corner, true),
  },
  Blue: {
    stops: [
      { name: 'Opp Hall 1', lat: 1.3401, lng: 103.68 },
      { name: 'NIE Blk 2', lat: 1.352, lng: 103.68 },
    ],
    points: line([{ lat: 1.3401, lng: 103.68 }, { lat: 1.352, lng: 103.68 }], false),
  },
};

let arrivals: Record<string, Record<string, [string, string]>> = {};
let refuseFirstView = false;
const requests: Array<{ url: string; view?: string }> = [];

const reply = (data: unknown, extra: Record<string, unknown> = {}) =>
  ({ ok: true, status: 200, json: async () => ({ versionInfo: { hasModuleVersionChanged: false, hasApiVersionChanged: false }, data, ...extra }), text: async () => '' }) as unknown as Response;

globalThis.fetch = (async (input: unknown, init?: { body?: string }) => {
  const url = String(input);
  const body = init?.body ? JSON.parse(init.body) : {};
  requests.push({ url, view: body.viewName });

  if (url.endsWith('moduleversioninfo')) return { ok: true, status: 200, json: async () => ({ versionToken: 'test-token' }) } as unknown as Response;
  if (url.endsWith('moduleinfo')) return { ok: true, status: 200, json: async () => ({ manifest: { urlVersions: {} } }) } as unknown as Response;
  if (url.includes('DataActionGetRoutesList')) return reply({ RouteList: { List: Object.keys(network).map((Route) => ({ Route })) } });
  if (url.includes('DataActionGetPickupCheckPoints')) {
    const route = network[body.screenData.variables.RouteId];
    return reply({
      PickupPoints: { PickupPointResult: { Pickuppoint: { List: route.stops.map((s) => ({ Busstopcode: s.name, Pickupname: s.name, Lat: String(s.lat), Lng: String(s.lng) })) } } },
      CheckPoint: { CheckPointResult: { CheckPoint: { List: route.points.map((p) => ({ Latitude: String(p.lat), Longitude: String(p.lng) })) } } },
    });
  }
  if (url.includes('ActionGetFMSBusStopETA')) {
    if (refuseFirstView && body.viewName === 'CommonFlow.SelectedRouteServiceDetail') {
      return reply({}, { exception: { message: 'No role validation found' } });
    }
    const List = Object.entries(arrivals).flatMap(([RouteId, stops]) =>
      Object.entries(stops).map(([BusStopCode, [ArrivalTime, NextArrivalTime]]) => ({ RouteId, Name: RouteId, BusStopCode, BusStopLongName: BusStopCode, ArrivalTime, NextArrivalTime })),
    );
    return reply({ BusStopList: { List } });
  }
  throw new Error(`unexpected request to ${url}`);
}) as typeof fetch;

beforeEach(() => {
  refuseFirstView = false;
  requests.length = 0;
  arrivals = {
    Red: { 'Hall 1': ['3', '15'], 'Hall 2': ['5', '17'], 'Lee Wee Nam Lib': ['8', '20'], 'Hall 11': ['1', '13'] },
    Blue: { 'Opp Hall 1': ['6', '16'], 'NIE Blk 2': ['10', '20'] },
  };
});

// ── Finding stops ────────────────────────────────────────────────────

test('a stop is found by what people call it, never by a longer number', async () => {
  const net = await bus.loadNetwork();
  const names = (query: string) => bus.findStops(net, query).map((s: { name: string }) => s.name);
  assert.deepEqual(names('hall 1'), ['Hall 1', 'Opp Hall 1'], '"Hall 1" is not "Hall 11"');
  assert.deepEqual(names('Hall 11'), ['Hall 11']);
  assert.deepEqual(names('opposite hall 1'), ['Opp Hall 1']);
  assert.deepEqual(names('lwn'), ['Lee Wee Nam Lib'], 'nicknames work');
  assert.deepEqual(names('lee wee'), ['Lee Wee Nam Lib']);
  assert.deepEqual(names('nie'), ['NIE Blk 2']);
  assert.deepEqual(names('atlantis'), []);
  assert.equal(bus.oppositeOf(net, 'Hall 1').name, 'Opp Hall 1');
  assert.equal(bus.oppositeOf(net, 'Hall 2'), undefined);
});

test('the route is measured along the road, and round the loop when needed', async () => {
  const red = (await bus.loadNetwork()).routes.Red;
  assert.deepEqual(red.stops.map((s: { name: string }) => s.name), ['Hall 1', 'Hall 2', 'Lee Wee Nam Lib', 'Hall 11']);
  assert.ok(Math.abs(red.length - 1780) < 60, `loop is about 1.78 km, got ${Math.round(red.length)}`);
  const forward = bus.rideMetres(red, 0, 2); // Hall 1 -> Lee Wee Nam Lib: two sides of the square
  const wrapped = bus.rideMetres(red, 2, 0); // and back, carrying on round the loop
  assert.ok(Math.abs(forward - 890) < 40, `about 890 m, got ${Math.round(forward)}`);
  assert.ok(Math.abs(forward + wrapped - red.length) < 5, 'there and back is exactly one loop');
});

// ── Arrivals ─────────────────────────────────────────────────────────

test('arrivals cover the stop and the one across the road, soonest first', async () => {
  arrivals.Blue['Opp Hall 1'] = ['-', '-'];
  const result = await bus.arrivalsAt('hall 1');
  assert.equal(result.found, true);
  assert.deepEqual(result.stops.map((s: { stop: string }) => s.stop), ['Hall 1', 'Opp Hall 1']);
  assert.deepEqual(result.stops[0].routes, [{ route: 'Red', arr: 3, next: 15 }]);
  assert.deepEqual(result.stops[1].routes, [{ route: 'Blue', arr: null, next: null }], '"-" means no bus is coming');
  const text = bus.arrivalsText(result);
  assert.match(text, /Hall 1\n {2}Red: 3 min, then 15 min/);
  assert.match(text, /Opp Hall 1 \(across the road from Hall 1\)\n {2}Blue: no bus coming/);
});

test('an unknown stop or route is answered with what exists', async () => {
  const missing = await bus.arrivalsAt('atlantis');
  assert.equal(missing.found, false);
  assert.ok(missing.stops.includes('Lee Wee Nam Lib'));
  assert.match(bus.arrivalsText(await bus.arrivalsAt('hall 1', 'purple')), /There is no "purple" route\. Routes: Red, Blue\./);
});

test('when NTU renames the screen the arrivals belong to, the next known name is tried and remembered', async () => {
  refuseFirstView = true;
  const result = await bus.arrivalsAt('hall 2');
  assert.deepEqual(result.stops[0].routes, [{ route: 'Red', arr: 5, next: 17 }]);
  requests.length = 0;
  await bus.arrivalsAt('hall 2');
  const views = requests.filter((r) => r.url.includes('ActionGetFMSBusStopETA')).map((r) => r.view);
  assert.deepEqual(views, ['MainFlow.SelectedRouteServiceDetail'], 'the working name is used straight away next time');
});

// ── Planning ─────────────────────────────────────────────────────────

test('a direct trip names the route, where to board and get off, and adds wait and ride', async () => {
  const plan = await bus.planTrip('hall 1', 'lwn');
  assert.equal(plan.found, true);
  const best = plan.options[0];
  assert.deepEqual([best.type, best.route, best.board, best.alight, best.stops], ['direct', 'Red', 'Hall 1', 'Lee Wee Nam Lib', 2]);
  // The bus is 3 min from Hall 1 and predicted at the library 5 min after that.
  assert.deepEqual([best.busInMinutes, best.rideMinutes, best.totalMinutes], [3, 5, 8]);
  assert.ok(plan.walkMinutes >= 9 && plan.walkMinutes <= 12, `walking is about 10 min, got ${plan.walkMinutes}`);
  assert.match(bus.planText(plan), /1\. Red: at Hall 1, ride 2 stop\(s\) \(about 5 min\) to Lee Wee Nam Lib; bus in 3 min \(the next 15 min\); about 8 min in total/);
});

test('a place only another route serves is reached by walking to that route, or by changing', async () => {
  const plan = await bus.planTrip('hall 2', 'nie');
  const best = plan.options[0];
  assert.equal(best.alight, 'NIE Blk 2');
  assert.ok(best.type === 'transfer' || best.route === 'Blue', 'Blue is the only way to NIE');
  assert.match(bus.planText(plan), /Blue/);
});

test('a route that is not running is listed as such instead of being hidden', async () => {
  arrivals.Red = { 'Hall 1': ['-', '-'], 'Hall 2': ['-', '-'], 'Lee Wee Nam Lib': ['-', '-'], 'Hall 11': ['-', '-'] };
  const plan = await bus.planTrip('hall 1', 'lwn');
  const red = plan.options.find((o: { route: string }) => o.route === 'Red');
  assert.equal(red.running, false);
  assert.equal(red.totalMinutes, null);
  assert.match(bus.planText(plan), /Red: .*not running right now/);
});

// ── Alerts ───────────────────────────────────────────────────────────

test('an alert stays quiet until the bus is close, speaks once, and then stays quiet', async () => {
  const check = () => bus.checkAlert({ stop: 'Hall 2', route: 'red', within: 3, key: 'once', mention: '@will' });
  assert.equal(await check(), '', '5 min away: nothing yet');
  arrivals.Red['Hall 2'] = ['3', '15'];
  assert.equal(await check(), '@will 🚌 Red bus reaches Hall 2 in 3 min. The one after is 15 min away.');
  arrivals.Red['Hall 2'] = ['2', '14'];
  assert.equal(await check(), '', 'already said');
  const before = requests.length;
  await check();
  assert.equal(requests.length, before, 'once it has spoken it does not even ask NTU again');
});

test('a repeating alert speaks again for the next bus', async () => {
  const check = () => bus.checkAlert({ stop: 'Hall 2', within: 3, key: 'again', repeat: true });
  arrivals.Red['Hall 2'] = ['2', '14'];
  assert.match(await check(), /Red bus reaches Hall 2 in 2 min/);
  assert.equal(await check(), '', 'same bus');
  arrivals.Red['Hall 2'] = ['12', '24']; // that bus has gone
  assert.equal(await check(), '');
  arrivals.Red['Hall 2'] = ['0', '12'];
  assert.match(await check(), /Red bus at Hall 2 is arriving now/);
});

test('an alert says once when nothing is running, and once when the stop is unknown', async () => {
  arrivals.Red['Hall 2'] = ['-', '-'];
  const idle = () => bus.checkAlert({ stop: 'Hall 2', key: 'idle' });
  assert.match(await idle(), /No campus bus is heading to Hall 2 right now/);
  assert.equal(await idle(), '');
  const unknown = () => bus.checkAlert({ stop: 'atlantis', key: 'unknown' });
  assert.match(await unknown(), /don't know a stop called "atlantis"/);
  assert.equal(await unknown(), '');
});

test('preparing an alert writes a script a schedule can run, with everything safely quoted', async () => {
  const dir = path.join(workDir, 'alerts').replace(/\\/g, '/');
  const result = await bus.prepareAlert({ stop: 'hall 2', route: 'RED', within: 4, mention: "@o'neil", dir });
  assert.equal(result.ok, true);
  assert.deepEqual([result.stop, result.route, result.within], ['Hall 2', 'Red', 4]);
  const script = fs.readFileSync(result.script, 'utf8');
  assert.match(script, /^#!\/bin\/bash\n/);
  assert.match(script, /exec ntubus alert --stop 'Hall 2' --within 4 --key 'hall-2-red-[a-z0-9]+' --route 'Red' --mention '@o'\\''neil'\n$/);

  const wrongRoute = await bus.prepareAlert({ stop: 'nie', route: 'red', dir });
  assert.equal(wrongRoute.ok, false);
  assert.match(wrongRoute.problem, /The Red route does not stop at NIE Blk 2\. Routes there: Blue\./);
  assert.equal((await bus.prepareAlert({ stop: 'atlantis', dir })).ok, false);
});
