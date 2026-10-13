# GODSIM

A browser "god simulator" of the whole world, starting on 13 October 2026. Every person is represented by an
agent (~41,000 agents standing for ~8.2 billion people), and countries, governments, leaders, economies, trade,
markets, alliances and wars are all simulated from the bottom up. **Nothing is scripted.** There is no rule like
"if the USA disappears, China invades Taiwan". Outcomes like that come out of generic rules: leaders who maximise
their own utility, agents who react to what is happening around them, and markets that react to flows and fear.
You watch, and you can intervene with divine powers.

Plain JavaScript. No build step, no libraries, no network.

## Running it

Open `index.html` in a modern browser. Opening it straight from disk (`file://`) works.

- `index.html#seed=42` starts a reproducible world from seed 42. Without a seed, a random one is used.
- **Space** pauses and resumes. Keys **1–5** set the speed (4, 10, 25 and 60 weeks/s, then "as fast as possible").
- Drag to pan, scroll to zoom, click a country to inspect it. **Esc** cancels an armed power or clears the selection.

### The screen

- **Top bar:** date, play/pause, speed, and world stats (population, world GDP, market index, oil, food, fear,
  wars, nations, war dead). It also shows the measured simulation cost per tick.
- **Left, divine powers:** pick a power, then click the map. Force war takes two clicks: the aggressor, then the
  victim. Hold Shift to keep a power armed after use. Below the powers are the scenario buttons.
- **Map modes:** Political, Blocs, Spheres of influence, Relations (to the selected country), Stability, Growth,
  Wealth (GDP per head), Government, Plague.
- **Map overlays:** People (one dot per agent, coloured by state), Wars (fronts and contested regions), Trade
  (largest flows), Alliances (links between members), Labels.
- **Right, inspector:** the world overview, or the selected country. For a country it shows the leader and their
  traits, history sparklines, economy, politics, military, diplomacy, relations, trade partners and the ideology of
  its people. It also has a "Meet a citizen" card for a random agent, with their life log and Follow/Locate buttons.
- **Bottom:** a news feed you can filter by type (click an item to select its country), and global charts for
  markets, oil, fear and world GDP.

## The model

All simulation files attach to one global, `GS`, and run unchanged in Node (see Tests). One tick is one week.
Monthly logic for each country is staggered over four ticks, and agents are updated a quarter at a time.

| file | module | owns |
|---|---|---|
| `data/world-topo.js` | `GS_TOPO` | Natural Earth 110m country shapes (TopoJSON) |
| `js/core.js` | `GS.RNG`, `GS.U`, `GS.Geo`, `GS.Names`, `GS.CONST` | seeded RNG, utilities, Miller projection, regions and borders, name generators for 24 cultures |
| `js/data.js` | `GS.DATA` | 2025–26 baseline for about 176 territories: population, GDP, military spending, government type, ideology, resources, nukes, tech, blocs, debt, relations, claims, sanctions, initial wars |
| `js/people.js` | `GS.People` | agent store (structure of arrays) and agent behaviour |
| `js/economy.js` | `GS.Economy` | production, trade, commodities, finance, budgets |
| `js/politics.js` | `GS.Politics` | leaders, parties, elections, unrest, coups, revolutions, civil wars, policy |
| `js/diplomacy.js` | `GS.Diplo` | relations, sanctions, alliances, spheres, threat, great powers, settlement of empty land |
| `js/war.js` | `GS.War` | military power, the leaders' war AI, fronts, casualties, conquest, peace, nuclear use |
| `js/world.js` | `GS.World`, `GS.news`, `GS.God` | world creation, tick order, region ownership, country birth and death, history, god powers, scenarios |
| `js/map.js`, `js/ui.js`, `js/main.js` | `GS.MapView`, `GS.UI`, `GS.Main` | canvas map, panels, game loop (the only DOM code) |

**People.** Each agent has a region, an origin (ethnicity), age, sex, job, skill, wealth, income, ideology
(economic left–right, authority, nationalism), approval, happiness, radicalism, health and infection state. Each
week agents:

- age, give birth and die. Fertility falls with development, and mortality depends on health, famine,
  devastation, the front line and plague.
- look for work or lose it, depending on the economy's labour demand. When their country is at war, some are
  recruited or conscripted.
- earn and save, and gain or lose wealth when markets crash or the state defaults.
- judge their lives against what they expected, and judge the government on the economy, freedom and ideology.
  There is a rally-round-the-flag effect when the country is attacked.
- may radicalise, protest, join rebels, migrate, or flee as refugees.

An agent's country is always the owner of its region. Conquest therefore moves people automatically, and their
origin is what produces minorities and independence movements.

**Economy.** Each country has Cobb–Douglas potential output from capital, labour (the real employed agents) and
total factor productivity. Actual GDP is potential times demand, and demand responds to confidence, fear,
exports, war, sanctions, devastation, commodity prices and plague. On top of that:

- **Trade:** a gravity-model trade matrix that decays with war, sanctions and bad relations, and slowly regrows.
- **Commodities:** oil and food prices are set by producer supply against demand.
- **Markets:** a global stock index, a stock index per country, and reserve-currency shares. When an issuer dies,
  those shares migrate.
- **Budgets:** tax and spending (military, welfare, other, interest), debt, bond yields from risk, and sovereign
  default.
- **Prices:** inflation, currencies, and a world `fear` gauge that spikes on shocks and decays over time.

**Politics.** Each month the leader of every country picks tax, military, welfare and repression levels to
maximise their own utility. That utility depends on their traits and ideology, the threat they face, unrest and
fiscal limits. The other mechanics:

- **Democracies** hold elections. Agents vote for the party nearest to their views, and radicalised electorates
  elect extremists.
- **Autocracies** risk coups (when the army disapproves) and revolutions (when unrest exceeds the regime's capacity
  to repress).
- **Civil wars** start when unrest and polarisation are high, and far more easily in poor states with weak armies
  (state capacity); poor, divided countries also see low-level insurgencies. They are fought between real rebel
  agents and real soldiers. A long stalemate can end in **partition**: the rebels keep the provinces they hold as a
  new state, which the rump state still claims.
- **Occupied peoples** can rise in independence wars, which can recreate dead nations through
  `GS.World.createCountry`.

**Diplomacy.** Relations between countries drift with:

- how similar their leaders' ideologies are
- trade dependence
- shared enemies
- border friction and territorial claims
- grudges, which fade slowly

Sanctions follow collapsed relations. Threatened countries join a strong, friendly patron's bloc, new blocs
form around rising powers, and membership drifts with relations (close friends of a bloc leader drift in,
estranged members drift out). Patrons, spheres of influence and great powers come from relative power; a state in
anarchy or losing a civil war projects little power, so its clients look elsewhere and its bloc loosens. Empty land
(for example after an erasure) is settled gradually: each neighbour builds up progress month by month according to
its strength and the size of the land, rival settlers of the same land clash, and the winner gains the land's
resources and moves some of its people there.

**Provinces.** Large countries (35 of them, from Russia and Canada down to Ukraine and Peru) are split into 2–6
provinces along their long axis, so land can change hands piece by piece: partial conquest, partition after a
civil war, and gradual settlement. The map draws each country's real outline; provinces only show when their
owners differ.

**War.** Each month a leader considers targets: neighbours, places within naval reach, and claimed regions. They
weigh the expected value: the chance of winning (including allies, discounted by how credible they are), against
the gains (GDP, resources, claims, ideological hostility, distraction from unrest) and the costs (economic
dependence, nuclear deterrence, exhaustion, caution). Each week, a war:

- compares front strengths
- kills soldiers on both sides and civilians in the contested regions
- devastates land (scaled by region size)
- flips border regions
- moves the war score and adds exhaustion

Peace can bring annexation, a puppet state, regime change, a white peace or a ceasefire. Nuclear powers facing
existential defeat may use their weapons. This is very rare.

**People.** Fertility starts from each country's real rate and follows the demographic transition. Migrants carry
their destination's agent weight (a group the size of one local agent moves; the rest stay home), and economic
migration is limited by each country's openness and yearly quota. Refugees avoid saturated hosts. A plague's
strain is per country; governments close borders when neighbours and trade partners are infected, which slows
trade, migration and the spread.

**Emergence.** Because the guarantor is just another country in these calculations, removing one changes every
other leader's sums. In test runs, erasing the USA led China to attack Taiwan within weeks. New Chinese- and
Indian-led blocs formed, NATO's leadership passed to Europe, and Canada settled the empty land. None of this is
written anywhere in the code.

## God powers

Region powers (click a region): **Meteor**, **Nuclear strike**, **Natural disaster**, **Plague**.
Nation powers (click a country): **Famine**, **Erase nation**, **Collapse state**, **Revolution**,
**Assassinate leader**, **Warmonger**, **Pacify**, **Golden age**, **Arm up**, **Discover oil**.
Other powers: **Force war** (two clicks: aggressor, then victim) and **Market crash** (applies immediately).
Scenario buttons (top of the left panel): **Erase USA**, **Erase China**, **Collapse Russia**, **Global plague**,
**Outbreak in one city**, **Random seed restart**.

From the console, every power is available as `GS.God.<name>(W, …)` and every scenario as
`GS.World.scenarios.<name>(W)`. The current world is `window.W`.

## Tests

Both tests run with plain `node`. Nothing needs to be installed except Playwright for the browser test.

```sh
# headless simulation: yearly table, NaN/Infinity checks, agent-count sanity, ms/tick
node test/sim-node.js 1 --years 30
node test/sim-node.js 2 --years 15 --scenario eraseUSA        # also eraseChina, collapseRussia, globalPlague, singlePlague
node test/sim-node.js 7 --years 60 --chaos                     # a random god power every year + invariant checks
node test/sim-node.js 7 --years 10 --scenario globalPlague --at 3 --quiet
node test/sim-node.js 1 --years 5 --json > run.json

# browser smoke test: loads index.html in headless Chromium, runs a few years, clicks around,
# cycles every map mode and overlay, erases the USA, and saves screenshots to ./shots (or --out DIR)
PW_PATH=/path/to/node_modules/playwright node test/ui-smoke.js --seed 5 --out shots
```

`sim-node.js` exits with code 1 if any of these happen:

- an exception
- NaN or Infinity in a country field (including its `eco` block), `W.global`, or the rel/trade/dist matrices
- a region whose owner list is inconsistent, a living country without land, capital or leader, or alliances,
  pacts, wars or patrons that refer to dead countries, or agents living on a dead country's land
- an agent count that leaves its sane band
- for `eraseUSA` / `eraseChina`: no global shock (fear must peak above 0.5 and the main trade partner's GDP must
  be below 0.9× the same seed's baseline 13 weeks later)

Scenarios are applied after the first 8 weeks (`--at Y` applies them at year Y), so the shock lands on a running
economy.

`ui-smoke.js` exits with code 1 on any console error or page error. `PW_CHROME` can point it at a specific
Chromium binary.
