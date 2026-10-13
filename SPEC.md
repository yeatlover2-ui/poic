# GODSIM — architecture contract

A browser "god simulator". Every person is an agent; countries, governments, leaders,
economies, trade, markets, alliances and wars are all simulated bottom-up. **Nothing is
scripted**: there are no hard-coded storylines like "if USA dies, China invades Taiwan".
Outcomes must *emerge* from generic rules (utility-driven leaders, agents reacting to
their circumstances, markets reacting to flows and fear).

Plain browser JS, **no build step, no external libraries, no network**. Opening
`index.html` from disk (file://) must work. Every file is a classic `<script>` that attaches
to the single global namespace `globalThis.GS` (`var GS = globalThis.GS = globalThis.GS || {};`).
Simulation files (everything except `js/map.js`, `js/ui.js`, `js/main.js`) MUST NOT touch
`window`, `document`, or any DOM API — they also run in Node (`test/sim-node.js` loads them
with `vm`). Use `globalThis`, never `window`, in sim files.

## Files & load order (owner = the only file that defines these symbols)

| order | file | defines |
|---|---|---|
| 1 | `data/world-topo.js` | `GS_TOPO` (world-atlas countries-110m TopoJSON, already vendored) |
| 2 | `js/core.js` | `GS.RNG`, `GS.U`, `GS.Geo`, `GS.Names`, `GS.dateOf`, `GS.CONST` |
| 3 | `js/data.js` | `GS.DATA` |
| 4 | `js/people.js` | `GS.People` |
| 5 | `js/economy.js` | `GS.Economy` |
| 6 | `js/politics.js` | `GS.Politics` |
| 7 | `js/diplomacy.js` | `GS.Diplo` |
| 8 | `js/war.js` | `GS.War` |
| 9 | `js/world.js` | `GS.World`, `GS.news`, `GS.God` |
| 10 | `js/map.js` | `GS.MapView` (DOM) |
| 11 | `js/ui.js` | `GS.UI` (DOM) |
| 12 | `js/main.js` | bootstrap & game loop (DOM) |

`index.html` + `css/style.css` belong to the UI owner. `test/sim-node.js` belongs to the integrator.

Modules may reference each other's functions **only at call time** (inside functions), never at
file load time, so load order inside the sim is irrelevant except that `core.js`/`data.js` load first.

## Time

- 1 tick = 1 week. Start date **2026-10-13** (tick 0). `GS.dateOf(tick) -> {y, m, d, str:"Oct 2026", full:"13 Oct 2026"}`.
- "Monthly" logic runs when `W.tick % 4 === 0`; "yearly" when `W.tick % 52 === 0`.
- Rates stored as **annual** values; weekly application divides by 52.
- Stagger expensive per-country monthly logic: country `c` runs its monthly AI when `(W.tick + c.id) % 4 === 0`.

## Constants — `GS.CONST` (core.js)

```
MAP_W: 3600                  // projected map width units
AGENTS_TOTAL: 40000          // target agents proportional to population
AGENTS_MIN_PER_COUNTRY: 30
START: {y:2026, m:10, d:13}
JOBS: {CHILD:0, UNEMPLOYED:1, FARM:2, INDUSTRY:3, SERVICES:4, GOV:5, MILITARY:6, RETIRED:7, REBEL:8}
GOVS: ['democracy','flawed_democracy','hybrid','autocracy','oneparty','theocracy','monarchy','junta','anarchy']
```

## RNG & utils (core.js)

`new GS.RNG(seed)` → `.next()` [0,1), `.range(a,b)`, `.int(n)` [0,n), `.normal()` (mean0 sd1),
`.pick(arr)`, `.chance(p)`, `.weighted(arr, weightFn)` → element. Deterministic (mulberry32).
All sim randomness uses `W.rng` (never `Math.random`).

`GS.U`: `clamp(x,a,b)`, `lerp(a,b,t)`, `sigmoid(x)`, `smooth(old, target, rate)` (= old+(target-old)*rate),
`fmtMoney(billions)` → "$1.23T"/"$45.6B"/"$780M", `fmtNum(n)` → "8.12B"/"331M"/"12.3K", `fmtPct(x, digits)`
(x is fraction → "12.3%"), `hsl(h,s,l)` → [r,g,b], `mean(arr)`.

## Geography (core.js: `GS.Geo`)

`GS.Geo.buildRegions(GS_TOPO)` → `regions[]`. One **region** per TopoJSON feature
(Antarctica `010` excluded). Region:
```
{ id, key,           // key = topo id string (e.g. "840") or properties.name if id undefined
  name,              // properties.name
  polys: [ [ [x,y],... ring ] ... ],   // projected outer+inner rings (Float coords in map units), each poly = array of rings
  bbox: [x0,y0,x1,y1], area (map units², largest polygon dominant), cx, cy (projected label point inside the largest polygon),
  lon, lat,          // geographic centroid of largest polygon
  neighbors: [regionIds],               // share a TopoJSON arc (land border)
  owner: countryId,  // set by world.js; -1 = ungoverned/empty
  core: countryId,   // original owner at world creation
  devastation: 0     // 0..1 war/disaster damage, decays slowly (world.js)
}
```
Projection: Miller cylindrical, `x = (lon+180)/360*MAP_W`, `y = (M(84°) - M(lat)) * MAP_W/(2π)`
with `M(φ)=1.25*ln(tan(π/4+0.4φ))`, φ in radians. Expose `GS.Geo.project(lon,lat)`, `GS.Geo.MAP_H`.
Also: `GS.Geo.pointInRegion(region,x,y)`, `GS.Geo.randomPointInRegion(region, rng)` (rejection sampling
inside bbox, weighted to largest polygon; falls back to (cx,cy)), `GS.Geo.haversineKm(lon1,lat1,lon2,lat2)`.
Note antimeridian: Russia/Fiji/USA(Alaska) rings crossing ±180 must not draw horizontal streaks — split/clip
rings when consecutive points jump > MAP_W/2 in x.

## Names (core.js: `GS.Names`)

Cultures (string keys): `anglo, hispanic, lusophone, french, german, italian, nordic, slavic, baltic,
balkan, greek, turkic, arabic, persian, hebrew, south_asian, chinese, japanese, korean, sea (southeast asian),
african_west, african_east, african_south, african_central`. Each has `first_m[]`, `first_f[]`, `last[]` (≥25 each).
`GS.Names.lists[culture]`. `GS.Names.first(culture, sex, rng)` → index, `GS.Names.last(culture, rng)` → index,
`GS.Names.str(culture, sex, firstIdx, lastIdx)` → "Ana Souza". `GS.Names.leader(culture, rng)` → {name, sex}.
`GS.Names.newCountryName(baseName, kind, rng)` for rebels/new states ("Free Republic of X", "X People's Republic",
"Provisional Government of X", "Democratic X", ...).

## Data (data.js: `GS.DATA`)

`GS.DATA.countries`: object keyed by region key (topo id string like "840", or name for id-less features
"N. Cyprus","Somaliland","Kosovo"). Value:
```
{ name, iso3, pop /*millions*/, gdp /*$B nominal 2025*/, mil /*military % GDP*/, gov /*GOVS*/,
  econ /*-1 left..1 right*/, auth /*-1 libertarian..1 authoritarian*/, nat /*0..1 nationalism*/,
  oil /*0..1 relative production, Saudi=1*/, food /*-1 importer..1 exporter*/, minerals /*0..1*/,
  nukes /*warhead count*/, tech /*0.4..1.3 military/industrial tech*/, navy /*0..1 power projection*/,
  culture, blocs: ['NATO','EU',...], corruption /*0..1*/, color: [r,g,b] optional }
```
Covers essentially every feature in the topojson (≈170). `GS.DATA.ownerOverrides`: region key → owner key for
territories (Greenland→Denmark 208, Puerto Rico→840, Falkland Is.→826, Fr. S. Antarctic Lands→250,
New Caledonia→250, W. Sahara→504, N. Cyprus→792, Somaliland→706). `GS.DATA.blocs`: `[{name, type:'defense'|'economic'|'political', color:[r,g,b]}]`
(NATO, CSTO, EU, SCO?(political), ASEAN, GCC, AU(political), BRICS(economic), Mercosur, ANZUS→ treat as part of bilateral)
plus `GS.DATA.bilateralDefense`: pairs like ["840","392"] (US–Japan), ["840","410"], ["840","158"] (informal Taiwan),
["840","608"], ["840","036"], ["156","408"] (China–NK), ["643","112"]. `GS.DATA.relations`: seeds `[keyA, keyB, value]`
(e.g. US–China -30, US–Russia -65, Russia–Ukraine -95, India–Pakistan -70, Israel–Iran -90, China–Taiwan -60,
NK–SK -80, Saudi–Iran -50, Armenia–Azerbaijan -70, Greece–Turkey -20, China–India -30, ...).
`GS.DATA.claims`: `[claimantKey, regionKey]` (China→Taiwan, Russia→Ukraine, Venezuela→Guyana, Argentina→Falklands,
Morocco→W.Sahara, Serbia→Kosovo, Somalia→Somaliland, India↔Pakistan none at this resolution, Azerbaijan none, ...).
`GS.DATA.initialWars`: `[{attacker:'643', defender:'804', goal:'conquest'}]` (Russia–Ukraine), and Sudan civil war
is represented via politics (country starts with `startCivilWar: true` flag in its data entry).
`GS.DATA.reserveShares`: `{ "840":0.57, euro (split across EU members by GDP; key "EU"): 0.20, "392":0.055, "826":0.048, "156":0.022, "124":0.025, "036":0.02, "756":0.002, other:0.058 }`.

## World object `W` (created by `GS.World.create(seed)`)

```
W = {
  seed, rng, tick: 0, speed,
  regions: [...],                 // see Geography
  countries: [...],               // index === id; dead countries stay in array with alive=false
  people: <GS.People store>,       // see People
  alliances: [...], wars: [...],  // arrays; ended wars kept (ended=true) for history (cap 200)
  n: countries.length (capacity grows when new countries are created — see "Growing matrices")
  rel:   Float32Array(NC*NC)  relations -100..100, index a*NC+b, kept symmetric   (diplomacy.js)
  trade: Float32Array(NC*NC)  exports a→b in $B/yr                              (economy.js)
  dist:  Float32Array(NC*NC)  km between capitals                              (world.js)
  NC: matrix stride (capacity, e.g. countries.length + 40)
  global: { worldGDP, worldGrowth, worldPop, marketIndex /*1000 at start*/, oilPrice /*$/bbl, ~75*/,
            foodPrice /*index 100*/, fear /*0..1*/, baseRate /*0.04*/, tradeVolume,
            reserveShares: Float32Array(NC) /*sum 1*/, plagueActive:false, nukesUsed:0, warDeaths:0 },
  ghist: { t:[], market:[], oil:[], food:[], fear:[], gdp:[], pop:[], wars:[] }   // monthly, world.js
  news: [],                       // newest last, capped 400
  selected: -1                    // UI only
}
```
**Growing matrices**: only `GS.World.createCountry` adds countries. If `countries.length` exceeds `NC`, world.js
reallocates `rel`, `trade`, `dist`, `reserveShares` with a bigger stride and copies. Everyone else must always read
`W.NC` at call time (never cache stride).

## Country object (fields and owners)

Identity (world.js): `id, key, name, iso3, culture, color:[r,g,b], alive, regions:[regionIds] (kept in sync by
GS.World.setRegionOwner), capital (regionId), createdTick, diedTick, parent (id of country it seceded from or -1)`.
Data (world.js copies from DATA): `pop0, gdp0, data` (the raw DATA entry).

People aggregates (people.js `GS.People.aggregate(W)`, run every tick after people step):
`pop` (real people = Σweight), `agents` (count), `happiness, approval` (0..1, weighted means),
`ideoEcon, ideoAuth, ideoNat` (means), `polarization` (0..1, from ideology variance), `radicalShare`,
`protestShare` (fraction protesting), `milApproval` (approval among MILITARY agents), `unemployment`
(UNEMPLOYED / labor force), `workers:{farm,industry,services,gov,military}` (real people counts),
`avgIncome, avgWealth, gini`, `infected` (fraction), `deathsW, birthsW, emigW, immigW` (real people this week),
`refugeesOut` (cumulative), `minorityShare` (fraction of residents whose origin ≠ this country — occupied/immigrants).

Economy (economy.js): `gdp ($B/yr), gdpPotential, capital, tfp, growth (annualized, smoothed), inflation (annual),
laborDemand (0..1 target employment rate given to people.js), wage (avg annual income per worker in $),
debt ($B), debtRatio, taxRate (revenue/GDP), spendMil, spendWelfare, spendOther (fractions of GDP),
deficit (fraction GDP), bondYield, defaulted (bool), stockIndex (100 at start), currency (1 at start),
exports, imports ($B/yr), oil, food, minerals (copied from data, can change via God), confidence (0..1),
sanctionedBy (count), gdpPerCap ($)`.

Military (war.js owns `milStock, manpower, warExhaustion, atWar`; data: `nukes, tech, navy`):
`milStock` ($B equivalent capital; init ≈ annual mil spend × 6), `manpower` (real soldiers ≈ workers.military),
`warExhaustion` 0..1, `atWar` (bool, recomputed), `power` (cached `GS.War.power(W,c)` updated weekly).

Politics (politics.js): `gov` (GOVS), `leader: {name, sex, age, party, aggression, ambition, caution, econ, auth,
nat, competence, since}` (traits 0..1 except econ/auth -1..1), `parties:[{name, econ, auth, nat, support}]`,
`rulingParty` (index or -1), `nextElection` (tick or -1), `unrest` 0..1, `stability` 0..1, `legitimacy` 0..1,
`freedom` 0..1, `corruption` 0..1, `repression` 0..1, `civilWar` (null | {rebels:{econ,auth,nat}, rebelStrength,
govStrength, start, rebelName, regionHeld:[regionIds]}), `regimeSince` (tick), `policy:{taxTarget, milTarget, welfareTarget}`
(politics sets targets, economy moves actual spending toward them).

Diplomacy (diplomacy.js): `patron` (country id whose sphere this is in, or -1), `overlord` (puppet master or -1),
`threat` (0..1), `claims` (Array of region ids), `sanctions` (Array of target ids this country sanctions),
`greatPower` (bool), `influence` (number), `alliances` (Array of alliance ids, derived), `defensePacts` (Array of country ids — bilateral).

History (world.js, monthly, cap 600 points): `hist:{gdp:[], pop:[], approval:[], unrest:[], stock:[], power:[]}`.

## People (people.js: `GS.People`)

Structure-of-arrays store at `W.people` (`P`). Capacity `P.cap` (≈ 1.6× initial agents), free-list reuse.
```
P.n (high-water count), P.cap, P.free (array of dead slots)
alive Uint8, region Int16, origin Int16 (country id of birth/ethnicity), age Float32, sex Uint8 (0 m,1 f),
weight Float32 (real people represented), wealth Float32 ($), income Float32 ($/yr), job Uint8 (CONST.JOBS),
skill Float32 0..1, econ Float32 -1..1, auth Float32 -1..1, nat Float32 0..1, approval Float32 0..1,
happy Float32 0..1, radical Float32 0..1, health Float32 0..1, infect Uint8 (0 susceptible,1 infected,2 recovered),
flags Uint8 (1 PROTEST, 2 REFUGEE, 4 AT_FRONT, 8 MIGRANT), x Float32, y Float32 (map position in region), first Uint16, last Uint16,
born Int32 (tick)
P.log: Map<agentIndex, [{tick, text}]> (cap 14 entries per agent; only notable events)
```
A person's country is ALWAYS `W.regions[P.region[i]].owner` (helper `GS.People.countryOf(W,i)`). Conquest therefore
moves people automatically; their `origin` keeps their identity (→ minorities, independence movements).

API: `init(W)` (spawn agents ∝ population, min per country, ideology ~ Normal around country data, ages from a
plausible pyramid, wealth lognormal scaled to GDP/cap, positions random in owned regions), `step(W)`, `aggregate(W)`,
`kill(W, filter:{country?, region?, fraction, cause, jobs?}) → real people killed` (logs to life logs, updates death counts),
`spawn(W, region, origin, opts) → index`, `move(W, i, region)` (new x,y), `countryOf(W,i)`, `name(W,i)`,
`describe(W,i)` → rich object for the UI citizen card: `{name, age, sex, job, country, origin, wealth, income, happy,
approval, ideology text ("center-left, libertarian, mildly nationalist"), status words, log:[...]}`,
`randomCitizen(W, countryId) → index`, `infect(W, region, count)` (seed plague), `onCountryRemoved(W,c)`.

Per-tick behaviour (all emergent, per agent): aging/death (age, health, plague, war at front), births ∝ country fertility
(falls with wealth), job matching toward `c.laborDemand` (hire/fire, sector mix by development level; military
recruitment toward `c.spendMil`; conscription when at war), income = `c.wage` × sector multiplier × skill (× inflation
erosion), wealth accumulation with savings & asset price exposure (`c.stockIndex` changes hit the wealthy),
happiness from income change vs expectations, employment, safety (war, devastation), health, freedom-vs-preference,
approval smoothing (incumbent blamed for economy, rally-round-flag when attacked, ideology distance to leader),
radicalization (unhappy + low approval + peer effects), protests (`flags&PROTEST`), joining rebels (job REBEL) in civil
war, ideology drift (peers, crisis → extremes, war → nationalism), migration (unhappy & able → pick destination by
attractiveness: wealth, safety, relations, distance, openness; refugees from war zones flee to neighbors), plague
SIR within country and spillover via trade/migration links. People react to *conditions*, never to named countries.

## Economy (economy.js: `GS.Economy`)

`init(W)`, `step(W)`, `onCountryRemoved(W, c)`, `tradeShare(W,a,b)` (b's share of a's exports),
`dependence(W,a,b)` (0..1 how much a's GDP depends on b via trade+finance).
Model sketch (weekly): Cobb-Douglas potential from capital, labor (`c.workers`), TFP; actual GDP = potential ×
demand factor (consumer confidence from `c.happiness`, export demand from partners' GDP/import capacity, global
`fear`, war damage, sanctions, devastation, commodity terms of trade). Trade matrix initialised by gravity model
(GDP^a·GDP^b/dist^c, scaled to realistic openness); trade evolves: falls with sanctions/war/dead partners/low relations,
regrows toward gravity equilibrium over years (trade diversion = slow recovery). Commodity markets: oil & food price
from global supply (sum of producers not at war/sanctioned/dead) vs demand (industrial GDP); exporters gain income.
Financial: global `marketIndex` driven by expected world growth, `fear`, shocks; country `stockIndex`; reserve currency
`reserveShares` — when an issuer dies or defaults, holders lose reserves proportional to holdings (wealth shock +
confidence hit), and shares slowly migrate to the largest stable, liquid economies. Budgets: revenue = tax × GDP;
spending = mil + welfare + other + interest; deficit adds debt; bond yield = base + risk(debtRatio, stability, war,
inflation, fear); default when interest burden unsustainable → crisis. Inflation from deficits monetised, commodity
shocks, currency collapse. `fear` rises with shocks (big GDP lost, great-power war, nukes, defaults) and decays.
News for: market crashes (>10% monthly drop), commodity spikes, defaults, recessions in big economies, records.

## Politics (politics.js: `GS.Politics`)

`init(W)` (leader generation from culture names; parties from ideology distribution of agents), `step(W)`,
`changeLeader(W, c, reason)`, `changeGov(W, c, gov, reason)`, `startCivilWar(W, c)`, `govInfo(gov)` → {label, elections:bool, freedom, repressionCap}.
Monthly per country: compute `unrest` (protest share, unemployment, inflation, war exhaustion, famine), `stability`,
`legitimacy`; leader AI chooses policy targets (tax, military, welfare, repression) maximizing leader utility given
traits & ideology & threat (`c.threat`) & unrest; democracies hold elections (`nextElection`; agents vote for nearest
party with incumbent-approval bonus; extremists can win when the population radicalizes; authoritarian winners can erode
democracy); autocracies face coups (`milApproval` low + unrest), revolutions (unrest > repression capacity), and leader
death (age). Civil war when unrest & polarization high: rebel vs government strength each week drawn from agents
with job REBEL vs military; outcome changes regime/leader or (for regions with many non-core-origin agents = occupied
peoples) secession via `GS.World.createCountry`. Puppets (overlord ≠ -1) get leaders aligned with overlord.

## Diplomacy (diplomacy.js: `GS.Diplo`)

`init(W)`, `step(W)`, `rel(W,a,b)`, `addRel(W,a,b,delta)` (symmetric, clamped), `allies(W,c)` → ids bound to
defend c (alliance co-members of defense blocs + defense pacts + overlord), `inAlliance(W,a,b)`,
`createAlliance(W, name, founderId, type)`, `join(W, allianceId, c)`, `leave(W, allianceId, c, reason)`,
`onCountryRemoved(W,c)`, `sphereColor`… Monthly: relations drift (ideology similarity of leaders, trade dependence,
shared enemies/threats, border friction, claims, historical grudges decay), sanctions when relations collapse,
alliances re-evaluated (join a strong friendly patron's bloc when threatened; leave when relations sour or leader
gone; new blocs form when a great power ascends), `threat` = max over others of (their power×hostility×proximity ÷
own power+allies), `patron` = argmax of (power × relation × proximity) among stronger countries, `greatPower` = top-N by power.
Unowned regions (owner -1) next to a country can be claimed/settled by neighbors (expansion utility) → `GS.World.setRegionOwner`.

## War (war.js: `GS.War`)

`init(W)` (initial wars from data), `step(W)`, `power(W,c)` (milStock^0.8 × tech × manpower factor × morale ×
(1-exhaustion); nukes count separately as deterrent), `declare(W, attacker, defender, goal)` → war (pulls in
defender's allies who choose to honor obligations by utility; attacker's allies may join), `isAtWar(W,a,b)`,
`enemies(W,c)`, `warsOf(W,c)`, `makePeace(W, war, outcome)`, `onCountryRemoved(W,c)`.
Monthly leader war-AI per country (staggered): for each candidate target (land neighbor, or naval reach ∝ navy and
distance; or unowned/claimed regions) compute expected value = win probability (own+likely allies power vs
target+likely allies power, discounting allies by credibility/distance — so when a guarantor disappears, targets
become tempting *emergently*) × gain (GDP, resources, claimed regions, ideology hostility, diversion from unrest)
− costs (economic dependence on target, sanctions risk, nuclear deterrence, war exhaustion, leader caution); declare
if above a threshold scaled by `aggression`/`ambition`. Weekly war resolution: front power ratio, casualties
(`GS.People.kill` of MILITARY agents both sides + civilians in contested regions), region devastation, region capture
(contested border regions flip owner via `GS.World.setRegionOwner`), war score, exhaustion; peace when score extreme
or exhaustion high: annex claimed/captured regions, puppet (set `overlord`), regime change, or white peace.
Nuclear use: only by nuclear powers facing existential defeat (capital threatened) with high aggression/low caution —
very rare; catastrophic (kills, devastation, global fear, relations collapse). Also `GS.War.nuke(W, attacker, regionId)`.

## World / God (world.js)

`GS.World.create(seed)` builds regions (Geo), countries (one per region key; overrides merge territories into owner
countries), matrices, calls `People.init`, `Economy.init`, `Politics.init`, `Diplo.init`, `War.init`, seeds history.
`GS.World.step(W)`: order = People.step → People.aggregate → Economy.step → Politics.step → Diplo.step → War.step →
region devastation decay → monthly history sampling (country hist + ghist) → `W.tick++`. Each module call is wrapped
in try/catch in world.js? **No** — errors must surface during development.
`GS.World.setRegionOwner(W, regionId, countryId, reason)` (maintains `country.regions`, capital moves if lost;
country with 0 regions → `destroyCountry(W,c,'conquered')`), `GS.World.createCountry(W, {name, regions, culture,
gov, parent, color})` → id (grows matrices, inits economy/politics/diplomacy fields by calling module hooks
`Economy.initCountry(W,c)`, `Politics.initCountry(W,c)`, `Diplo.initCountry(W,c)`, `War.initCountry(W,c)`),
`GS.World.destroyCountry(W, c, mode)` (mode 'erased' → people vanish & regions become owner -1; 'conquered'),
calls `People.onCountryRemoved`, `Economy.onCountryRemoved`, `Diplo.onCountryRemoved`, `War.onCountryRemoved`.
`GS.news(W, text, {type, countries:[ids], importance:1..5})` → pushes `{tick, date, text, type, countries, importance}`.

`GS.God` (all take W first; each posts a news item of type 'god'):
`erase(W,c)` (country vanishes from existence: people & state gone, land empty), `collapse(W,c)` (state fails →
anarchy gov, leader removed, military disbands partially, civil war likely), `plague(W, regionId, severity)`,
`disaster(W, regionId)` (earthquake/tsunami: deaths, devastation), `nuke(W, regionId)`, `prosperity(W,c)` (TFP & happiness
boost), `famine(W,c)`, `marketCrash(W)`, `discoverOil(W,c)`, `revolution(W,c)` (radicalize & trigger), `assassinate(W,c)`,
`warmonger(W,c)` / `pacify(W,c)` (leader traits), `forceWar(W,a,b)`, `armUp(W,c)`, `meteor(W, regionId)`.

## UI (map.js, ui.js, main.js, index.html, css/style.css)

Full-window dark "god's view" app. Canvas world map (pan with drag, zoom with wheel, click to select country) with
map modes: Political, Alliances/Blocs, Spheres of influence, Relations (to selected), Stability/Unrest, Economy
(GDP growth), Wealth (GDP per cap), Government type, Plague. Overlays (toggle): People (one dot per agent at P.x,P.y,
colored by state: protesting red, soldier, refugee, infected, normal by happiness), Trade flows (top flows as arcs),
Wars (front lines/arrows, crossed swords at contested regions), Alliance links. Top bar: date, play/pause, speed
(1,2,5,10,25 ticks/frame-ish), world stats (population, world GDP, market index with ▲▼, oil price, fear meter,
active wars). Left: God powers palette (select a power, then click map; two-click for forceWar). Right: inspector for
selected country (flag-ish color swatch, gov, leader card with traits, economy stats, politics, military, alliances,
patron/sphere, top relations ±, top trade partners, ideology scatter/histogram of its agents, sparklines from `hist`)
and a "Meet a citizen" card (random agent, `GS.People.describe`, button for another, life log). Bottom: news ticker/feed
(filter by type, click to select country) and global charts (market, oil, fear, world GDP). Keyboard: space pause,
1-5 speeds. Scenario quick buttons: "Erase USA", "Erase China", "Collapse Russia", "Global plague", "Random seed restart".
