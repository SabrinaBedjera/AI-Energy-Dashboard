import React, { useEffect, useMemo, useRef, useState } from "react";
import { geoConicEqualArea, geoPath } from "d3-geo";

type Project = {
  id: string;
  name: string;
  operator: string;
  province: string;
  city: string;
  lat: string;
  lon: string;
  location_precision: string;
  status: "Operating" | "Under construction" | "Proposed";
  reported_mw: string;
  what_the_mw_measures: string;
  notes: string;
  source: string;
  source_2: string;
  check_status: string;
};

type Province = {
  province: string;
  planned_mw: string;
  share_of_active_sites: string;
  main_power_source: string;
  grid_rules: string;
  clean_energy_level: string;
  openness: string;
  planned_mw_source: string;
};

type EnergyMix = Record<string, string> & { Province: string };
type MapMode =
  | "capacity"
  | "power"
  | "energy"
  | "clean"
  | "water"
  | "people"
  | "grid"
  | "projects"
  | "price"
  | "sitesActive"
  | "sitesPlanned";

type Annotation = { lon: number; lat: number; dx: number; dy: number; lines: [string, string]; anchor?: "start" | "end" };

type FillMode = "none" | "capacity" | "energy" | "people" | "price" | "sitesActive" | "sitesPlanned";
type Layers = { people: boolean; lines: boolean; clean: boolean; water: boolean };
const noLayers: Layers = { people: false, lines: false, clean: false, water: false };

// Scrolly steps still describe one "mode"; turn it into a fill + overlays
function viewFor(mode: MapMode): { fill: FillMode; layers: Layers } {
  if (mode === "power") return { fill: "none", layers: { ...noLayers, lines: true } };
  if (mode === "clean") return { fill: "none", layers: { ...noLayers, clean: true } };
  if (mode === "projects") return { fill: "none", layers: noLayers };
  if (mode === "grid") return { fill: "none", layers: { ...noLayers, lines: true, clean: true } };
  if (mode === "people") return { fill: "none", layers: { ...noLayers, people: true } };
  if (mode === "water") return { fill: "none", layers: { ...noLayers, water: true } };
  return { fill: mode as FillMode, layers: noLayers };
}

type PriceRow = {
  city: string;
  province: string;
  utility_per_hq_report: string;
  cents_per_kwh_50mw: string;
  cents_per_kwh_5mw: string;
  note: string;
  lat: string;
  lon: string;
  source: string;
  source_page: string;
};
type PowerLine = {
  province: string;
  length_km: number;
  voltage_kv: number | null;
  voltage_status: string;
  osm_operator?: string | null;
  osm_line_name?: string | null;
  check_source?: string | null;
};

const provinceCodes: Record<string, string> = {
  Alberta: "AB",
  "British Columbia": "BC",
  Manitoba: "MB",
  "New Brunswick": "NB",
  "Newfoundland and Labrador": "NL",
  "Nova Scotia": "NS",
  Ontario: "ON",
  "Prince Edward Island": "PE",
  Quebec: "QC",
  Saskatchewan: "SK",
  Yukon: "YT",
  "Northwest Territories": "NT",
  Nunavut: "NU",
};

const codeToProvince = Object.fromEntries(
  Object.entries(provinceCodes).map(([name, code]) => [code, name]),
);

// Palette: teal map, hot pink accent, navy ink (chosen Nov 12, 2026)
const statusColors = {
  Operating: "#ffffff",
  "Under construction": "#f5c242",
  Proposed: "#e0457b",
};

const statusStroke = {
  Operating: "#172d49",
  "Under construction": "#172d49",
  Proposed: "#ffffff",
};

// Teal = clean grid, pink = fossil grid (share of 2025 generation from fossil fuels)
const fossilScale = ["#0b5f57", "#3f9e8f", "#a9d6cd", "#f1efea", "#f4b6c8", "#e57aa0", "#c2185b"];
const fossilBands = ["0–14%", "", "", "43–57%", "", "", "86–100%"];
const cleanColors: Record<string, string> = {
  Hydro: "#0b5f57",
  Wind: "#5fb3a6",
  Nuclear: "#6c5b8f",
  Solar: "#d9a62e",
  Biomass: "#9a8f7a",
  Tidal: "#172d49",
};

const drainageColors = ["#d7e6ef", "#c4d9e6", "#b1cbdc", "#e2ecf2"];

const capacityColors = ["#d4ebe6", "#94cdc2", "#3f9e8f", "#0b5f57"];

// Share of York's data centre sites (Appendix Table A2), used in the story only
const siteShareColors = ["#e8e5df", "#f6d3df", "#ec97b5", "#d6457b", "#8f1f4f"];
const siteShareColor = (share: number) =>
  siteShareColors[share === 0 ? 0 : share < 5 ? 1 : share < 15 ? 2 : share < 35 ? 3 : 4];

// People per km² (Statistics Canada 2021 Census, census divisions)
const peopleColors = ["#e2ded5", "#d0d6de", "#a9b4c4", "#6b7f9c", "#172d49"];
const peopleBands = ["Under 1", "1–9", "10–99", "100–999", "1,000+"];
const peopleColor = (density: number) =>
  peopleColors[density < 1 ? 0 : density < 10 ? 1 : density < 100 ? 2 : density < 1000 ? 3 : 4];

// Large-customer electricity price, ¢/kWh (Hydro-Québec 2025 comparison, 50,000 kW)
const priceColors = ["#fbefc4", "#efc46a", "#b5617a", "#5a2a55"];
const priceBands = ["Under 6¢", "6–8.99¢", "9–11.99¢", "12¢ and up"];
const priceColor = (cents: number) =>
  priceColors[cents < 6 ? 0 : cents < 9 ? 1 : cents < 12 ? 2 : 3];
// Label placement so nearby cities don't overlap: [dx, dy, anchor]
const priceLabel: Record<string, [number, number, "start" | "end" | "middle"]> = {
  Vancouver: [-12, 4, "end"],
  Calgary: [0, 22, "middle"],
  Edmonton: [0, -13, "middle"],
  Regina: [0, -13, "middle"],
  Winnipeg: [0, -13, "middle"],
  Toronto: [0, 22, "middle"],
  Ottawa: [-12, 4, "end"],
  "Montréal": [0, -13, "middle"],
  Moncton: [-12, -8, "end"],
  Charlottetown: [6, -14, "middle"],
  Halifax: [0, 22, "middle"],
  "St. John's": [0, 22, "middle"],
};

const fossilColor = (share: number) => fossilScale[Math.min(6, Math.floor((share / 100) * 7))];

const energyColors: Record<string, string> = {
  Hydro: "#0b5f57",
  Nuclear: "#6c5b8f",
  "Fossil fuels": "#c2185b",
  Wind: "#5fb3a6",
  Solar: "#d9a62e",
  Biomass: "#9a8f7a",
  Other: "#b8b4ab",
};

const voltageColors = {
  highest: "#172d49",
  high: "#4a6488",
  lower: "#9aaac0",
  unknown: "#c9c6bf",
};

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index++;
      row.push(cell);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const headers = rows.shift() ?? [];
  return rows.map((values) =>
    Object.fromEntries(
      headers.map((header, index) => [header.replace(/^\uFEFF/, ""), values[index] ?? ""]),
    ),
  );
}

const formatMw = (value: string | number) =>
  value === "" || value === null ? "Not disclosed" : `${Number(value).toLocaleString("en-CA")} MW`;

const dataUrl = (file: string) => `${import.meta.env.BASE_URL}data/${file}`;

const getUrl = (source: string) => source.match(/https?:\/\/[^\s]+/)?.[0] ?? "#";

function dominantEnergy(mix?: EnergyMix) {
  if (!mix) return "Other";
  return ["Hydro", "Nuclear", "Fossil fuels", "Wind", "Solar", "Biomass", "Other"].reduce(
    (largest, source) =>
      Number(mix[`${source} %`] || 0) > Number(mix[`${largest} %`] || 0) ? source : largest,
    "Other",
  );
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [provinces, setProvinces] = useState<Province[]>([]);
  const [energy, setEnergy] = useState<EnergyMix[]>([]);
  const [boundaries, setBoundaries] = useState<any>(null);
  const [powerLines, setPowerLines] = useState<any>(null);
  const [cleanStations, setCleanStations] = useState<any>(null);
  const [drainage, setDrainage] = useState<any>(null);
  const [population, setPopulation] = useState<any>(null);
  const [prices, setPrices] = useState<PriceRow[]>([]);
  const [fill, setFill] = useState<FillMode>("none");
  const [layers, setLayers] = useState<Layers>(noLayers);
  const [provinceFilter, setProvinceFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedPowerLine, setSelectedPowerLine] = useState<PowerLine | null>(null);
  const [selectedProvince, setSelectedProvince] = useState("Alberta");
  const [panelOpen, setPanelOpen] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch(dataUrl("projects.csv")).then((response) => response.text()),
      fetch(dataUrl("provinces.csv")).then((response) => response.text()),
      fetch(dataUrl("energy_mix_2025.csv")).then((response) => response.text()),
      fetch(dataUrl("canada-provinces.geojson")).then((response) => response.json()),
      fetch(dataUrl("power-lines.geojson")).then((response) => response.json()),
      fetch(dataUrl("clean-power-stations.geojson")).then((response) => response.json()),
      fetch(dataUrl("drainage-areas.geojson")).then((response) => response.json()),
      fetch(dataUrl("population-density.geojson")).then((response) => response.json()),
      fetch(dataUrl("electricity_prices_2025.csv")).then((response) => response.text()),
    ]).then(([projectText, provinceText, energyText, boundaryData, powerLineData, cleanData, drainageData, populationData, priceText]) => {
      setPopulation(populationData);
      setPrices(parseCsv(priceText) as PriceRow[]);
      setCleanStations(cleanData);
      setDrainage(drainageData);
      setProjects(parseCsv(projectText) as Project[]);
      setProvinces(parseCsv(provinceText) as Province[]);
      setEnergy(parseCsv(energyText) as EnergyMix[]);
      setBoundaries(boundaryData);
      setPowerLines(powerLineData);
    });
  }, []);

  const provinceByName = useMemo(
    () => Object.fromEntries(provinces.map((province) => [province.province, province])),
    [provinces],
  );

  const enrichedBoundaries = useMemo(() => {
    if (!boundaries) return null;
    return {
      ...boundaries,
      features: boundaries.features.map((feature: any) => {
        const name =
          feature.properties.name === "Yukon Territory" ? "Yukon" : feature.properties.name;
        const province = provinceByName[name];
        const mix = energy.find((item) => item.Province === name);
        return {
          ...feature,
          properties: {
            ...feature.properties,
            name,
            planned_mw: Number(province?.planned_mw || 0),
            has_capacity: Boolean(province?.planned_mw),
            dominant_energy: dominantEnergy(mix),
            fossil_share: mix ? Number(mix["Fossil fuels %"]) : null,
          },
        };
      }),
    };
  }, [boundaries, energy, provinceByName]);

  const filteredProjects = useMemo(
    () =>
      projects.filter(
        (project) =>
          (provinceFilter === "All" || project.province === provinceFilter) &&
          (statusFilter === "All" || project.status === statusFilter),
      ),
    [projects, provinceFilter, statusFilter],
  );

  const selectedProvinceData = provinceByName[selectedProvince];
  const selectedEnergy = energy.find((item) => item.Province === selectedProvince);

  const nationalPlanned = provinces.reduce(
    (total, province) => total + Number(province.planned_mw || 0),
    0,
  );
  const albertaShare = nationalPlanned
    ? (Number(provinceByName.Alberta?.planned_mw || 0) / nationalPlanned) * 100
    : 0;

  const plannedProjects = projects.filter((project) => project.status !== "Operating");
  const plannedCount = plannedProjects.length;
  const albertaPlannedCount = plannedProjects.filter((project) => project.province === "AB").length;
  const mixFor = (name: string) => energy.find((item) => item.Province === name);
  const pct = (name: string, column: string) => mixFor(name)?.[column] ?? "…";

  const selectProject = (project: Project) => {
    setSelectedProject(project);
    setSelectedPowerLine(null);
    setSelectedProvince(codeToProvince[project.province]);
    setPanelOpen(true);
  };

  const selectProvince = (name: string) => {
    setSelectedProvince(name);
    setSelectedProject(null);
    setSelectedPowerLine(null);
    setPanelOpen(true);
  };

  return (
    <main>
      <Scrolly
        boundaries={enrichedBoundaries}
        powerLines={powerLines}
        cleanStations={cleanStations}
        drainage={drainage}
        population={population}
        prices={prices}
        projects={projects}
        pct={pct}
        albertaShare={albertaShare}
        plannedCount={plannedCount}
        albertaPlannedCount={albertaPlannedCount}
      />

      <div className="explore-intro" id="explore">
        <h2>Your turn.</h2>
        <p>
          Click any dot for its source and what its number actually measures. Colour the map by one
          measure (click it again to turn it off), then add power lines, clean power stations or watersheds on top.
        </p>
      </div>

      <section className="map-experience explorer">
        <div className="map-controls explorer-controls">
          <div className="filters">
            <label>
              <span>Status</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
              >
                <option value="All">All statuses</option>
                <option>Operating</option>
                <option>Under construction</option>
                <option>Proposed</option>
              </select>
            </label>
            <label>
              <span>Province</span>
              <select
                value={provinceFilter}
                onChange={(event) => setProvinceFilter(event.target.value)}
              >
                <option value="All">All provinces</option>
                {Object.entries(codeToProvince)
                  .filter(([code]) => projects.some((project) => project.province === code))
                  .map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <div className="control-group" aria-label="Colour provinces by">
            <span>Colour the map by</span>
            <div className="chips">
              {(
                [
                  ["capacity", "Planned MW"],
                  ["energy", "Energy source"],
                ] as [FillMode, string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={fill === value ? "active" : ""}
                  aria-pressed={fill === value}
                  onClick={() => setFill(fill === value ? "none" : value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="control-group" aria-label="Add layers">
            <span>Add to the map</span>
            <div className="chips">
              {(
                [
                  ["people", "Where people live"],
                  ["lines", "Power lines"],
                  ["clean", "Clean power stations"],
                  ["water", "Watersheds"],
                ] as [keyof Layers, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  className={`toggle ${layers[key] ? "active" : ""}`}
                  aria-pressed={layers[key]}
                  onClick={() => setLayers((current) => ({ ...current, [key]: !current[key] }))}
                >
                  <i aria-hidden="true">{layers[key] ? "✓" : "+"}</i>
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={`explorer-stage ${panelOpen ? "with-panel" : ""}`}>
          <div className="explorer-map">
            <SvgMap
              boundaries={enrichedBoundaries}
              powerLines={powerLines}
              cleanStations={cleanStations}
              drainage={drainage}
              population={population}
              prices={prices}
              projects={filteredProjects}
              focusProvince={provinceFilter === "All" ? undefined : codeToProvince[provinceFilter]}
              fill={fill}
              layers={layers}
              zoomable
              selectedProject={selectedProject}
              onSelectProject={selectProject}
              onSelectProvince={selectProvince}
              onSelectPowerLine={(line) => {
                setSelectedPowerLine(line);
                setSelectedProject(null);
                setPanelOpen(true);
              }}
            />
            {!panelOpen && (
              <button className="open-panel" onClick={() => setPanelOpen(true)}>
                View {selectedPowerLine ? "power line" : selectedProject ? "project" : "province"}{" "}
                details
              </button>
            )}
            <MapLegend fill={fill} layers={layers} shown={filteredProjects.length} total={projects.length} />
          </div>

          {panelOpen && (
            <aside className="detail-drawer" aria-live="polite">
              <button
                className="drawer-close"
                onClick={() => setPanelOpen(false)}
                aria-label="Close details"
              >
                ×
              </button>
              {selectedPowerLine ? (
                <PowerLineDetail line={selectedPowerLine} />
              ) : selectedProject ? (
                <ProjectDetail
                  project={selectedProject}
                  onProvince={() => setSelectedProject(null)}
                />
              ) : selectedProvinceData ? (
                <ProvinceDetail
                  province={selectedProvinceData}
                  energy={selectedEnergy}
                  mode={fill === "capacity" || fill === "none" ? "capacity" : "energy"}
                  prices={prices.filter((row) => row.province === provinceCodes[selectedProvince])}
                />
              ) : null}
            </aside>
          )}
        </div>
      </section>

      <ChartsSection prices={prices ?? []} />

      <section id="methods" className="about">
        <div>
          <p className="eyebrow">Methods</p>
          <h2>Reported numbers, not estimates.</h2>
        </div>
        <div className="about-copy">
          <p>
            Project capacity appears only when a public source reports it. Different figures can
            describe IT load, total project capability, grid demand, or on-site generation. Open a
            project to see exactly what its number measures. The project list and the York
            paper&apos;s provincial estimates are separate datasets with different coverage, so
            their totals don&apos;t match. The list includes every kind of data centre (cloud,
            hosting and AI), not only AI ones. All project pins are approximate. Six rows I couldn&apos;t
            open at the source are marked as lower confidence.
          </p>
          <p>
            The energy view shows each province&apos;s share of 2025 electricity generated from
            fossil fuels. It does not claim that a data centre uses that exact mix, especially when a
            project reports its own on-site power.
          </p>
          <p>
            Power lines come from NRCan CanVec at 1:250,000 scale, mostly high-voltage transmission
            lines. A project near a line is not proof that it connects to it.
          </p>
          <p>
            The people view shows population density by census division from the 2021 Census,
            exactly as Statistics Canada publishes it. Shapes are simplified for the web.
          </p>
          <p>
            Power prices are Hydro-Québec&apos;s estimates from its 2025 comparison of electricity
            prices in major cities, for a customer using 50,000 kW at 120 kV, on rates in effect April 1, 2025,
            before taxes. It is one city per province, not a provincial average. Hydro-Québec
            estimated some bills (Toronto, Charlottetown, Edmonton), and Alberta prices move with its
            open market. I checked the Montréal and Winnipeg prices against Hydro-Québec&apos;s and
            Manitoba Hydro&apos;s own published rates, and both matched to the cent.
          </p>
        </div>
        <div className="sources">
          <h3>Sources</h3>
          <a
            href="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6464099"
            target="_blank"
            rel="noreferrer"
          >
            Carlo &amp; Rolheiser, York University, 2026 ↗
          </a>
          <a href="https://majorprojects.alberta.ca/" target="_blank" rel="noreferrer">
            Government of Alberta Major Projects ↗
          </a>
          <a
            href="https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=2510001501"
            target="_blank"
            rel="noreferrer"
          >
            Statistics Canada, Table 25-10-0015-01 ↗
          </a>
          <a
            href="https://open.canada.ca/data/en/dataset/92dbea79-f644-4a62-b25e-8eb993ca0264"
            target="_blank"
            rel="noreferrer"
          >
            NRCan CanVec 1:250K power lines ↗
          </a>
          <a
            href="https://geoappext.nrcan.gc.ca/arcgis/rest/services/Energy/CERP_EN/MapServer"
            target="_blank"
            rel="noreferrer"
          >
            NRCan Clean Energy Resources and Projects ↗
          </a>
          <a
            href="https://geoappext.nrcan.gc.ca/arcgis/rest/services/NRCAN/AtlasWatershedsEN/MapServer"
            target="_blank"
            rel="noreferrer"
          >
            NRCan Atlas of Canada, drainage areas ↗
          </a>
          <a
            href="https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=9810000701"
            target="_blank"
            rel="noreferrer"
          >
            Statistics Canada, Table 98-10-0007-01 (2021 Census) ↗
          </a>
          <a
            href="https://www.hydroquebec.com/data/documents-donnees/pdf/comparaison-prix-2025-en.pdf"
            target="_blank"
            rel="noreferrer"
          >
            Hydro-Québec, Comparison of Electricity Prices 2025 ↗
          </a>
          <span>Individual project sources are linked in the map.</span>
        </div>
        <footer>
          <span>Personal project, views my own.</span>
          <span>Data prepared November 10–12, 2026</span>
        </footer>
      </section>
    </main>
  );
}

type ScrollStep = {
  mode: MapMode;
  focus?: string;
  hideProjects?: boolean;
  fadeAll?: boolean;
  highlight?: string;
  body: React.ReactNode;
  hero?: boolean;
  annotations?: Annotation[];
  wide?: boolean;
};

function Scrolly(props: {
  boundaries: any;
  powerLines: any;
  cleanStations: any;
  drainage: any;
  population: any;
  prices: PriceRow[];
  projects: Project[];
  pct: (name: string, column: string) => string;
  albertaShare: number;
  plannedCount: number;
  albertaPlannedCount: number;
}) {
  const { pct } = props;
  const priceText = (city: string) => {
    const row = props.prices.find((item) => item.city === city);
    return row ? Number(row.cents_per_kwh_50mw).toFixed(2) : "…";
  };
  const [active, setActive] = useState(0);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);

  const steps: ScrollStep[] = [
    {
      mode: "projects",
      hero: true,
      annotations: [
        { lon: -114, lat: 56, dx: 40, dy: -200, anchor: "start", lines: ["Most planned data centres", "Alberta: 78% of planned sites"] },
        { lon: -79.6, lat: 43.9, dx: -170, dy: 20, lines: ["Most running today", "Ontario: 41% of operating sites"] },
        { lon: -73.6, lat: 45.6, dx: 60, dy: -170, anchor: "start", lines: ["Next most running today", "Quebec: 30% of operating sites"] },
      ],
      body: (
        <>
          <h1>Canada&apos;s AI Boom</h1>
          <p className="hero-sub">An exploration of where Canada&apos;s AI will get its power</p>
          <p className="hero-summary">
            Canada has <strong>194</strong> data centres running. Another <strong>213</strong> are
            planned, and they would draw about <strong>14 times</strong> the power of the ones running now.
          </p>
          <p className="hero-byline">By Sabrina Bedjera · November 2026</p>
          <p className="scroll-cue">
            Scroll ↓ <span>or</span>{" "}
            <a className="skip-link" href="#explore">
              skip to the interactive map
            </a>
          </p>
        </>
      ),
    },
    {
      mode: "power",
      hideProjects: true,
      body: (
        <p className="placeholder">
          [Your hook goes here: one or two sentences, in your words, on why you got curious about
          where Canada&apos;s data centres are going.]
        </p>
      ),
    },
    {
      mode: "power",
      hideProjects: true,
      fadeAll: true,
      body: (
        <>
          <p>
            AI runs in data centres: buildings full of computers that run day and night. Worldwide,
            data centres used about <strong>1.5% of all electricity</strong> in 2024. The
            International Energy Agency expects that to more than double by 2030, to about as much
            as <span className="hl hl-pink">all of Japan uses today</span>. AI is the biggest
            driver.
          </p>
          <p>
            Closer to home, York University researchers estimate that one average announced
            Canadian data centre (<strong>122 MW</strong>) would use as much electricity in a year as{" "}
            <span className="hl hl-pink">49,000 to 78,000 Canadian homes</span>.
          </p>
          <p className="york-source">
            Sources:{" "}
            <a href={ieaUrl} target="_blank" rel="noreferrer">
              IEA, Energy and AI (2025)
            </a>
            , executive summary;{" "}
            <a href={yorkUrl} target="_blank" rel="noreferrer">
              Carlo &amp; Rolheiser, York University (2026)
            </a>
            , section 2.2. The homes range assumes the data centre runs at 50% to 80% of capacity.
          </p>
        </>
      ),
    },
    {
      mode: "grid",
      hideProjects: true,
      body: (
        <>
        <p>
          Where a data centre gets its power matters as much as where it&apos;s built. Some plug
          into the grid. Others sign deals for clean power or build their own. In BC, TELUS has
          secured <strong>85 MW</strong> of clean, renewable power from BC Hydro, and Bell
          describes its BC sites as hydroelectric-powered. In Nova Scotia, EverWind plans to run its
          data centre on wind, with <strong>$2 billion</strong> for new wind projects. In Alberta,
          most projects that name a fuel plan their own natural gas plants, some with carbon
          capture.
        </p>
        <p className="york-source">
          Sources:{" "}
          <a href="https://www.telus.com/en/about/news-and-events/media-releases/TELUS-and-Government-of-Canada-advance-work-to-scale-Canadas-sovereign-AI-infrastructure" target="_blank" rel="noreferrer">TELUS</a>
          ,{" "}
          <a href="https://cfjctoday.com/2025/05/28/bell-announces-plans-to-open-six-ai-data-centres-in-b-c-as-part-of-bell-ai-fabric/" target="_blank" rel="noreferrer">CFJC (Bell)</a>
          ,{" "}
          <a href="https://www.cp24.com/news/canada/2026/10/16/everwind-says-10b-ai-data-centre-proposal-largest-private-investment-in-ns-history/" target="_blank" rel="noreferrer">CP24 (EverWind)</a>
          , and the power source column in my project list.
        </p>
        </>
      ),
    },
    {
      mode: "power",
      hideProjects: true,
      fadeAll: true,
      body: (
        <p>
          Data centres aren&apos;t new. They&apos;ve run websites, email, online banking,
          streaming and cloud storage for years, and most still do. York flags only{" "}
          <strong>5 of the 194</strong> data centres running in Canada as AI-related, and{" "}
          <strong>49 of the 213</strong> planned ones. York calls these a lower bound, since a site only counts when its
          plans mention AI. AI is a growing slice, but the boom is about all kinds of computing.
        </p>
      ),
    },
    {
      mode: "sitesActive",
      hideProjects: true,
      body: (
        <p>
          Canada has <strong>194 data centres running</strong> today, using about{" "}
          <strong>1.6 GW</strong>. Most sit in three provinces: <strong>Ontario</strong> (41%),{" "}
          <strong>Quebec</strong> (30%) and <strong>BC</strong> (14%), close to big cities. Half of
          them are within about <strong>4 km of a downtown</strong>.
        </p>
      ),
    },
    {
      mode: "sitesPlanned",
      hideProjects: true,
      wide: true,
      body: (
        <>
          <p>
            Another <strong>213</strong> are announced or being built, adding up to{" "}
            <span className="hl hl-pink">22.2 GW</span>, almost <strong>14 times</strong> what runs
            today. And they point somewhere else:{" "}
            <span className="hl hl-pink">167 of the 213, or 78%, are in Alberta</span>, and
            they&apos;re farther out. Half of the announced sites are more than{" "}
            <strong>48 km from a downtown</strong>.
          </p>
          <ProvinceShift />
        </>
      ),
    },
    {
      mode: "capacity",
      focus: "Alberta",
      hideProjects: true,
      body: (
        <>
          <p>
            By capacity it&apos;s even more lopsided. York puts Alberta at{" "}
            <span className="hl hl-teal">
              {props.albertaShare.toFixed(0)}% of all planned data centre MW
            </span>{" "}
            in Canada.
          </p>
          <p>
            Alberta&apos;s own numbers point the same way. Companies have asked to connect about{" "}
            <strong>19,565 MW</strong> of new data centre load to its grid. That&apos;s more than
            the most power the whole province has ever used in one hour (about 12,800 MW).
          </p>
          <p className="york-source">
            Sources: York University (2026), Figure 3b;{" "}
            <a href="https://www.alberta.ca/datacentres/grid" target="_blank" rel="noreferrer">
              Government of Alberta
            </a>
            , citing the AESO connection list of July 30, 2026.
          </p>
        </>
      ),
    },
    {
      mode: "capacity",
      body: (
        <p>
          Those numbers come from a commercial database I can&apos;t access, so I can&apos;t see
          which sites they are. I wanted the projects anyone can check. I looked for every data
          centre project in Canada I could trace to a public source and found{" "}
          <strong>{props.projects.length}</strong>. The{" "}
          <span className="hl hl-pink">pink dots</span> are still plans, the{" "}
          <span className="hl hl-yellow">yellow</span> ones are being built, and the{" "}
          <span className="hl hl-white">white</span> ones are already running.{" "}
          {props.albertaPlannedCount} of the {props.plannedCount} planned or under construction are
          in Alberta too.
        </p>
      ),
    },
    {
      mode: "energy",
      hideProjects: true,
      body: (
        <p>
          That&apos;s surprising, because Alberta&apos;s grid leans hard on fossil fuels. In 2025,{" "}
          <span className="hl hl-pink">{pct("Alberta", "Fossil fuels %")}%</span> of its
          electricity came from fossil fuels. In Quebec it was{" "}
          <span className="hl hl-teal">{pct("Quebec", "Fossil fuels %")}%</span>.
        </p>
      ),
    },
    {
      mode: "clean",
      hideProjects: true,
      wide: true,
      body: (
        <>
          <p>
            Provinces set the rules, and the rules differ a lot. The hydro provinces have clean
            power but ration it. Alberta capped its grid and opened a faster path for projects
            that bring their own power.
          </p>
          <RulesTable />
        </>
      ),
    },
    {
      mode: "projects",
      hideProjects: true,
      fadeAll: true,
      wide: true,
      body: (
        <>
        <p>
          It&apos;s also the cheapest power for big customers. In Hydro-Québec&apos;s 2025 price
          comparison, a large industrial customer paid{" "}
          <strong>{priceText("Winnipeg")}¢/kWh in Winnipeg</strong> and{" "}
          <strong>{priceText("Montréal")}¢ in Montréal</strong>. In Calgary it was{" "}
          <strong>{priceText("Calgary")}¢</strong>.
        </p>
        <PriceChart prices={props.prices} />
        </>
      ),
    },
    {
      mode: "capacity",
      focus: "Alberta",
      highlight: "Wonder Valley",
      body: (
        <p>
          Alberta took a different route: <strong>bring your own power</strong>. Its grid only had
          room for 1,200 MW of big new loads, and that&apos;s taken. So projects like{" "}
          <span className="hl hl-pink">Wonder Valley</span> are planning their own power plants.
          Its first phase alone is a 1.4 GW gas and geothermal system.
        </p>
      ),
    },
    {
      mode: "power",
      hideProjects: true,
      fadeAll: true,
      wide: true,
      body: (
        <>
          <p>
            Zoom out, and Canada is still small. York counts <strong>1,989 data centres running
            in the US</strong> (46.8 GW), against 194 in Canada. But Canada&apos;s planned projects
            are bigger on average: <span className="hl hl-pink">122 MW vs 95 MW</span>.
          </p>
          <YorkComparison />
        </>
      ),
    },
    {
      mode: "power",
      hideProjects: true,
      fadeAll: true,
      body: (
        <>
          <p>
            Worldwide, the US used <strong>45%</strong> of all data centre electricity in 2024,
            China <strong>25%</strong> and Europe <strong>15%</strong>. In the US, data centres
            make up nearly <strong>half of all the growth in electricity demand</strong> expected
            by 2030. Canada is a small player, but a fast-growing one.
          </p>
          <p className="york-source">
            Source:{" "}
            <a href={ieaUrl} target="_blank" rel="noreferrer">
              IEA, Energy and AI (2025)
            </a>
            , executive summary.
          </p>
        </>
      ),
    },
  ];

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActive(Number((entry.target as HTMLElement).dataset.step));
        }
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    stepRefs.current.forEach((element) => element && observer.observe(element));
    return () => observer.disconnect();
  }, []);

  const step = steps[active];
  return (
    <section className="scrolly">
      <div className={`scrolly-graphic ${step.wide ? "shift" : ""}`}>
        <SvgMap
          boundaries={props.boundaries}
          powerLines={props.powerLines}
          cleanStations={props.cleanStations}
          drainage={props.drainage}
          population={props.population}
          prices={props.prices}
          projects={props.projects}
          fill={viewFor(step.mode).fill}
          layers={viewFor(step.mode).layers}
          selectedProject={null}
          onSelectProject={() => {}}
          onSelectProvince={() => {}}
          onSelectPowerLine={() => {}}
          focusProvince={step.focus}
          hideProjects={step.hideProjects}
          highlightProject={step.highlight}
          fadeAll={step.fadeAll}
          annotations={step.annotations}
        />
      </div>
      <div className="scrolly-steps">
        {steps.map((item, index) => (
          <div
            key={index}
            ref={(element) => {
              stepRefs.current[index] = element;
            }}
            data-step={index}
            className={`scrolly-step ${item.hero ? "hero" : ""} ${item.wide ? "wide" : ""} ${index === active ? "is-active" : ""}`}
          >
            <div className="step-card">{item.body}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ProvinceBar({ provinces }: { provinces: Province[] }) {
  const rows = provinces
    .filter((province) => Number(province.planned_mw) > 0)
    .map((province) => ({ name: province.province, mw: Number(province.planned_mw) }))
    .sort((a, b) => b.mw - a.mw);
  const total = rows.reduce((sum, row) => sum + row.mw, 0);
  if (!total) return null;
  const [top, ...rest] = rows;
  const restTotal = rest.reduce((sum, row) => sum + row.mw, 0);
  return (
    <figure className="province-bar">
      <figcaption>Planned data centre capacity by province (MW), York University estimate</figcaption>
      <div className="bar-track">
        <div className="bar-segment lead" style={{ width: `${(top.mw / total) * 100}%` }}>
          <span>
            {top.name} <b>{top.mw.toLocaleString("en-CA")}</b>
          </span>
        </div>
        {rest.map((row, index) => (
          <div
            key={row.name}
            className="bar-segment"
            style={{
              width: `${(row.mw / total) * 100}%`,
              background: capacityColors[Math.max(0, 2 - index)],
            }}
            title={`${row.name}: ${row.mw.toLocaleString("en-CA")} MW`}
          />
        ))}
      </div>
      <p className="bar-note">
        Every other province combined: <b>{restTotal.toLocaleString("en-CA")} MW</b> (
        {rest.map((row) => `${provinceCodes[row.name]} ${row.mw.toLocaleString("en-CA")}`).join(" · ")}
        )
      </p>
    </figure>
  );
}

// York University paper (Carlo & Rolheiser 2026, SSRN 6464099), Table 1, data downloaded June 8, 2026.
// Checked against the paper PDF on Nov 12, 2026. "Planned" = announcement + construction stages.
const yorkUrl = "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6464099";
const ieaUrl = "https://www.iea.org/reports/energy-and-ai";
const yorkTable1 = {
  Canada: { activeCount: 194, activeGW: 1.6, annGW: 21.7, constGW: 0.5, activeAvgMW: 11.3, annAvgMW: 122.0 },
  "United States": { activeCount: 1989, activeGW: 46.8, annGW: 303.0, constGW: 62.4, activeAvgMW: 24.9, annAvgMW: 95.4 },
};

function YorkComparison() {
  const rows = Object.entries(yorkTable1) as [string, (typeof yorkTable1)["Canada"]][];
  const maxMW = 130;
  const x = (mw: number) => 118 + (mw / maxMW) * 300;
  return (
    <div className="york-charts">
      <figure>
        <figcaption>Average size of one data centre (MW)</figcaption>
        <svg viewBox="0 0 440 128" role="img" aria-label="Average data centre size, operating versus announced, Canada and US">
          {[0, 50, 100].map((tick) => (
            <g key={tick} className="york-grid">
              <line x1={x(tick)} x2={x(tick)} y1={18} y2={104} />
              <text x={x(tick)} y={120}>{tick}</text>
            </g>
          ))}
          {rows.map(([country, d], index) => {
            const y = 40 + index * 48;
            return (
              <g key={country}>
                <text className="york-country" x={0} y={y + 4}>{country === "United States" ? "United States" : "Canada"}</text>
                <line className="york-link" x1={x(d.activeAvgMW)} x2={x(d.annAvgMW)} y1={y} y2={y} />
                <circle className="york-today" cx={x(d.activeAvgMW)} cy={y} r={6}>
                  <title>{`${country}, operating: ${d.activeAvgMW} MW average`}</title>
                </circle>
                <circle className="york-planned" cx={x(d.annAvgMW)} cy={y} r={6}>
                  <title>{`${country}, announced: ${d.annAvgMW} MW average`}</title>
                </circle>
                <text className="york-value" x={x(d.activeAvgMW)} y={y - 11} textAnchor="middle">{d.activeAvgMW}</text>
                <text className="york-value strong" x={x(d.annAvgMW)} y={y - 11} textAnchor="middle">{d.annAvgMW.toFixed(1)}</text>
              </g>
            );
          })}
        </svg>
        <div className="york-key">
          <span><i className="york-today" /> Operating today</span>
          <span><i className="york-planned" /> Announced</span>
        </div>
      </figure>
      <p className="york-source">
        Source:{" "}
        <a href={yorkUrl} target="_blank" rel="noreferrer">
          Carlo &amp; Rolheiser, York University (2026), Table 1
        </a>
        , using Aterio data to June 8, 2026. Averages only count sites with a reported capacity.
      </p>
    </div>
  );
}

// York University paper, Appendix Table A2 (page 42): number of data centres by province and stage.
// Planned = announcement + construction. Checked against the paper PDF on Nov 12, 2026.
const yorkTableA2: [string, number, number][] = [
  ["Ontario", 79, 16],
  ["Quebec", 59, 7],
  ["British Columbia", 27, 8],
  ["Alberta", 20, 167],
  ["Saskatchewan", 4, 8],
  ["Manitoba", 2, 2],
  ["New Brunswick", 2, 5],
  ["Nova Scotia", 1, 0],
];

function PriceChart({ prices }: { prices: PriceRow[] }) {
  const rows = [...prices]
    .filter((row) => row.cents_per_kwh_50mw)
    .sort((a, b) => Number(a.cents_per_kwh_50mw) - Number(b.cents_per_kwh_50mw));
  const max = Math.max(...rows.map((row) => Number(row.cents_per_kwh_50mw)), 1);
  const w = (value: number) => (value / max) * 230;
  return (
    <div className="york-charts">
      <figure>
        <figcaption>Price for a large (50 MW) customer · ¢/kWh · April 2025</figcaption>
        <svg viewBox={`0 0 440 ${rows.length * 24 + 8}`} role="img" aria-label="Electricity price for a 50 MW customer by city">
          {rows.map((row, index) => {
            const value = Number(row.cents_per_kwh_50mw);
            const y = 4 + index * 24;
            const alberta = row.province === "AB";
            return (
              <g key={row.city}>
                <text className="york-country" x={0} y={y + 12}>{`${row.city}, ${row.province}`}</text>
                <rect className={alberta ? "york-planned" : "york-today"} x={150} y={y + 2} width={w(value)} height={13} rx={2}>
                  <title>{`${row.city}: ${value.toFixed(2)}¢/kWh (${row.utility_per_hq_report})`}</title>
                </rect>
                <text className={`york-value ${alberta ? "strong" : ""}`} x={156 + w(value)} y={y + 12}>{`${value.toFixed(2)}¢`}</text>
              </g>
            );
          })}
        </svg>
      </figure>
      <p className="york-source">
        Source:{" "}
        <a href="https://www.hydroquebec.com/data/documents-donnees/pdf/comparaison-prix-2025-en.pdf" target="_blank" rel="noreferrer">
          Hydro-Québec, Comparison of Electricity Prices 2025, p.17
        </a>
        . Hydro-Québec&apos;s estimate for one city per province, before taxes. Montréal and Winnipeg checked
        against the utilities&apos; own rates. Alberta in pink.
      </p>
    </div>
  );
}

function ChartsSection({ prices }: { prices: PriceRow[] }) {
  return (
    <section className="charts-section" id="charts">
      <p className="eyebrow">From the story</p>
      <h2>Charts</h2>
      <div className="charts-grid">
        <div className="chart-card">
          <h3>Where data centres are, and where they&apos;re planned</h3>
          <ProvinceShift />
        </div>
        <div className="chart-card">
          <h3>What big customers pay for power</h3>
          <PriceChart prices={prices} />
        </div>
        <div className="chart-card">
          <h3>The rules by province</h3>
          <RulesTable />
        </div>
        <div className="chart-card">
          <h3>Canada and the US</h3>
          <YorkComparison />
        </div>
      </div>
    </section>
  );
}

const rulesRows: [string, string, string][] = [
  ["Alberta", "Grid capped at 1,200 MW for big new loads (all allocated). Bill 8 fast-tracks data centres that bring their own power.", "https://www.aeso.ca/grid/connecting-to-the-grid/large-load-projects"],
  ["British Columbia", "Competitive process: up to 300 MW for AI and 100 MW for other data centres over two years, 145 MW max per project.", "https://news.gov.bc.ca/releases/2026ECS0005-000095"],
  ["Quebec", "A minister must authorize power for any data centre of 5 MW or more (Bill 69).", "https://www.blg.com/en/insights/2026/07/data-centre-regulation-in-quebec-from-honeyed-promise-to-iron-control"],
  ["Ontario", "The government decides which large loads can connect, and weighs economic benefit (Bill 40).", "https://www.torys.com/en/our-latest-thinking/publications/2025/12/key-takeaways-and-next-steps-on-new-energy-law"],
  ["Manitoba", "Proposed a separate rate class for data centres (Bill 39). Not yet clear if it's in force.", "https://web2.gov.mb.ca/bills/43-3/pdf/b039.pdf"],
  ["Saskatchewan", "No data centre cap. Big projects can bring their own power.", "https://www.cp24.com/news/canada/2026/09/15/bell-ai-data-centre-project-near-regina-to-quadruple-in-size/"],
  ["Nova Scotia, New Brunswick", "Standard grid connection, no data centre rules yet.", "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6464099"],
];

function RulesTable() {
  return (
    <div className="york-charts">
      <table className="rules-table">
        <tbody>
          {rulesRows.map(([province, rule, url]) => (
            <tr key={province}>
              <th scope="row">{province}</th>
              <td>
                {rule}{" "}
                <a href={url} target="_blank" rel="noreferrer" aria-label={`Source for ${province}`}>
                  ↗
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="york-source">
        Rules as of November 2026. Summary based on York University (2026), Table 2, and each
        province&apos;s own sources (↗).
      </p>
    </div>
  );
}

function ProvinceShift() {
  const activeTotal = 194;
  const plannedTotal = 213;
  const w = (share: number) => (share / 100) * 250;
  return (
    <div className="york-charts">
      <figure>
        <figcaption>Share of data centre sites by province</figcaption>
        <svg viewBox="0 0 440 300" role="img" aria-label="Share of operating and planned data centre sites by province">
          {yorkTableA2.map(([province, active, planned], index) => {
            const y = 14 + index * 35;
            const aShare = (active / activeTotal) * 100;
            const pShare = (planned / plannedTotal) * 100;
            return (
              <g key={province}>
                <text className="york-country" x={0} y={y + 12}>{province}</text>
                <rect className="york-today" x={128} y={y} width={Math.max(w(aShare), 1.5)} height={11} rx={2}>
                  <title>{`${province}: ${active} of ${activeTotal} operating sites`}</title>
                </rect>
                <text className="york-value" x={134 + w(aShare)} y={y + 9}>{`${aShare.toFixed(1)}%`}</text>
                <rect className="york-planned" x={128} y={y + 13} width={Math.max(w(pShare), 1.5)} height={11} rx={2}>
                  <title>{`${province}: ${planned} of ${plannedTotal} planned sites`}</title>
                </rect>
                <text className="york-value strong" x={134 + w(pShare)} y={y + 22}>{`${pShare.toFixed(1)}%`}</text>
              </g>
            );
          })}
        </svg>
        <div className="york-key">
          <span><i className="york-today" /> Operating (194 sites)</span>
          <span><i className="york-planned" /> Planned (213 sites)</span>
        </div>
      </figure>
      <p className="york-source">
        Source:{" "}
        <a href={yorkUrl} target="_blank" rel="noreferrer">
          Carlo &amp; Rolheiser, York University (2026), Appendix Table A2
        </a>
        . Planned = announced or under construction. Counts sites, not MW.
      </p>
    </div>
  );
}

function SvgMap({
  boundaries,
  powerLines,
  cleanStations,
  drainage,
  population,
  prices,
  projects,
  fill,
  layers,
  selectedProject,
  onSelectProject,
  onSelectProvince,
  onSelectPowerLine,
  focusProvince,
  hideProjects,
  highlightProject,
  fadeAll,
  zoomable,
  annotations,
}: {
  annotations?: Annotation[];
  focusProvince?: string;
  hideProjects?: boolean;
  highlightProject?: string;
  fadeAll?: boolean;
  zoomable?: boolean;
  boundaries: any;
  powerLines: any;
  cleanStations: any;
  drainage: any;
  population?: any;
  prices?: PriceRow[];
  projects: Project[];
  fill: FillMode;
  layers: Layers;
  selectedProject: Project | null;
  onSelectProject: (project: Project) => void;
  onSelectProvince: (name: string) => void;
  onSelectPowerLine: (line: PowerLine) => void;
}) {
  const projection = useMemo(() => {
    const nextProjection = geoConicEqualArea().parallels([50, 70]).rotate([96, 0]).center([0, 62]);
    if (boundaries)
      nextProjection.fitExtent(
        [
          [12, 12],
          [988, 588],
        ],
        boundaries,
      );
    return nextProjection;
  }, [boundaries]);
  const pathGenerator = useMemo(() => geoPath(projection), [projection]);

  const focus = useMemo(() => {
    const feature = boundaries?.features?.find(
      (item: any) => item.properties.name === focusProvince,
    );
    if (!feature) return { k: 1, x: 0, y: 0 };
    const [[x0, y0], [x1, y1]] = pathGenerator.bounds(feature);
    const k = Math.min((0.75 * 1000) / (x1 - x0), (0.8 * 600) / (y1 - y0), 4);
    return { k, x: 560 - k * ((x0 + x1) / 2), y: 300 - k * ((y0 + y1) / 2) };
  }, [boundaries, focusProvince, pathGenerator]);

  // User zoom (explorer only): buttons, double-click, Ctrl/⌘ + scroll, drag to pan
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  useEffect(() => setView({ k: 1, x: 0, y: 0 }), [focusProvince]);
  const toSvg = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 500, y: 300 };
    const point = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: point.x, y: point.y };
  };
  const zoomAt = (factor: number, cx = 500, cy = 300) =>
    setView((current) => {
      const k = Math.min(12, Math.max(1, current.k * factor));
      if (k === 1) return { k: 1, x: 0, y: 0 };
      const ratio = k / current.k;
      return { k, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio };
    });
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !zoomable) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const { x, y } = toSvg(event.clientX, event.clientY);
      zoomAt(event.deltaY < 0 ? 1.25 : 0.8, x, y);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [zoomable]);

  const scale = view.k * focus.k;
  const siteShare = (name: string, which: FillMode) => {
    const row = yorkTableA2.find(([province]) => province === name);
    if (!row) return null;
    return which === "sitesActive" ? (row[1] / 194) * 100 : (row[2] / 213) * 100;
  };
  const r = (radius: number) => radius / Math.sqrt(scale);

  const pricesByProvince = useMemo(() => {
    const out: Record<string, PriceRow[]> = {};
    (prices ?? []).forEach((row) => (out[row.province] = [...(out[row.province] ?? []), row]));
    return out;
  }, [prices]);

  const provinceFill = (properties: any) => {
    if (fill === "sitesActive" || fill === "sitesPlanned") {
      const share = siteShare(properties.name, fill);
      return share === null ? "#e8e5df" : siteShareColor(share);
    }
    if (fill === "price") {
      const rows = pricesByProvince[provinceCodes[properties.name]];
      return rows ? priceColor(Number(rows[0].cents_per_kwh_50mw)) : "#dcd9d2";
    }
    if (fill === "energy")
      return properties.fossil_share === null ? "#e8e5df" : fossilColor(properties.fossil_share);
    if (fill !== "capacity" || !properties.has_capacity) return "#e8e5df";
    const capacity = Number(properties.planned_mw);
    if (capacity >= 10000) return capacityColors[3];
    if (capacity >= 500) return capacityColors[2];
    if (capacity >= 100) return capacityColors[1];
    return capacityColors[0];
  };

  return (
    <svg
      ref={svgRef}
      className={`map-canvas svg-map ${zoomable ? "zoomable" : ""}`}
      viewBox="0 0 1000 600"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Interactive map of Canadian data centre projects"
      onDoubleClick={(event) => {
        if (!zoomable) return;
        const { x, y } = toSvg(event.clientX, event.clientY);
        zoomAt(1.6, x, y);
      }}
      onPointerDown={(event) => {
        if (!zoomable) return;
        drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y };
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        const start = toSvg(drag.current.x, drag.current.y);
        const now = toSvg(event.clientX, event.clientY);
        const { vx, vy } = drag.current;
        setView((current) => ({ ...current, x: vx + now.x - start.x, y: vy + now.y - start.y }));
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerLeave={() => (drag.current = null)}
    >
      <rect width="1000" height="600" fill="#e8ebe7" />
      <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
      <g
        className={`zoom-layer ${fadeAll ? "faded" : ""}`}
        style={{ transform: `translate(${focus.x}px, ${focus.y}px) scale(${focus.k})` }}
      >
      <g className="svg-provinces">
        {boundaries?.features?.map((feature: any) => (
          <path
            key={feature.properties.name}
            d={pathGenerator(feature) ?? undefined}
            fill={provinceFill(feature.properties)}
            opacity={focusProvince && feature.properties.name !== focusProvince ? 0.45 : 1}
            onClick={() => onSelectProvince(feature.properties.name)}
          />
        ))}
      </g>
      {layers.people && (
        <g className="svg-people">
          {population?.features?.filter((feature: any) => feature.properties.density_per_km2 >= 10).map((feature: any) => {
            const p = feature.properties;
            return (
              <path
                key={p.cd_uid}
                d={pathGenerator(feature) ?? undefined}
                fill={peopleColor(p.density_per_km2)}
              >
                <title>
                  {`${p.name}: ${p.density_per_km2.toLocaleString("en-CA")} people per km² (${p.population_2021.toLocaleString("en-CA")} people, 2021 Census)`}
                </title>
              </path>
            );
          })}
          {boundaries?.features?.map((feature: any) => (
            <path
              key={feature.properties.name}
              className="people-province-outline"
              d={pathGenerator(feature) ?? undefined}
            />
          ))}
        </g>
      )}
      {fill !== "price" && !layers.people && (
        <g className="svg-province-labels" aria-hidden="true">
          {boundaries?.features
            ?.filter((feature: any) =>
              ["BC", "AB", "SK", "MB", "ON", "QC"].includes(provinceCodes[feature.properties.name]),
            )
            .map((feature: any) => {
              const [x, y] = pathGenerator.centroid(feature);
              const share =
                fill === "sitesActive" || fill === "sitesPlanned"
                  ? siteShare(feature.properties.name, fill)
                  : null;
              return (
                <text
                  key={feature.properties.name}
                  x={x}
                  y={y}
                  className={share !== null ? "share-label" : ""}
                  style={{ fontSize: (share !== null ? 15 : 9) / Math.sqrt(scale) }}
                >
                  {provinceCodes[feature.properties.name]}
                  {share !== null ? ` ${Math.round(share)}%` : ""}
                </text>
              );
            })}
        </g>
      )}
      {layers.water && (
        <g className="svg-drainage">
          {drainage?.features?.map((feature: any) => (
            <path key={feature.properties.name} d={pathGenerator(feature) ?? undefined}>
              <title>{feature.properties.name}</title>
            </path>
          ))}
          {drainage?.features?.map((feature: any) => {
            const [x, y] = pathGenerator.centroid(feature);
            return (
              <text key={feature.properties.name} x={x} y={y} style={{ fontSize: 8 / Math.sqrt(scale) }}>
                {feature.properties.name}
              </text>
            );
          })}
        </g>
      )}
      {layers.lines && (
        <g className="svg-power-lines">
          {(powerLines?.features ?? []).map((feature: any) => (
            <path
              key={feature.properties.canvec_id}
              d={pathGenerator(feature) ?? undefined}
              onClick={(event) => {
                event.stopPropagation();
                onSelectPowerLine(feature.properties as PowerLine);
              }}
            />
          ))}
        </g>
      )}
      {layers.clean && (
        <g className="svg-clean">
          {[...(cleanStations?.features ?? [])]
            .sort((a: any, b: any) => (b.properties.mw ?? 0) - (a.properties.mw ?? 0))
            .map((feature: any, index: number) => {
              const point = projection(feature.geometry.coordinates);
              if (!point) return null;
              const p = feature.properties;
              return (
                <circle
                  key={index}
                  cx={point[0]}
                  cy={point[1]}
                  r={r(1.4 + Math.sqrt(p.mw ?? 0) / 14)}
                  fill={cleanColors[p.type] ?? "#9a8f7a"}
                >
                  <title>
                    {`${p.name} · ${p.type} · ${p.mw ?? "?"} MW${p.owner ? ` · ${p.owner}` : ""}`}
                  </title>
                </circle>
              );
            })}
        </g>
      )}
      <g className={`svg-projects ${hideProjects ? "hidden" : ""}`}>
        {projects.map((project) => {
          const point = projection([Number(project.lon), Number(project.lat)]) ?? [0, 0];
          const radius = r(
            project.reported_mw ? 3.2 + Math.min(Number(project.reported_mw) / 230, 5.8) : 3.2,
          );
          const lowerConfidence = project.check_status === "From tracker, not yet opened by me";
          return (
            <g
              key={project.id}
              onClick={(event) => {
                event.stopPropagation();
                onSelectProject(project);
              }}
            >
              {highlightProject && project.name.startsWith(highlightProject) && (
                <circle cx={point[0]} cy={point[1]} r={radius + 7} className="pulse-ring" />
              )}
              {lowerConfidence && (
                <circle cx={point[0]} cy={point[1]} r={radius + r(2.5)} className="confidence-ring" />
              )}
              <circle
                cx={point[0]}
                cy={point[1]}
                r={radius}
                fill={statusColors[project.status]}
                style={{ stroke: statusStroke[project.status] }}
                className={selectedProject?.id === project.id ? "selected-point" : ""}
              />
            </g>
          );
        })}
      </g>
      {annotations && annotations.length > 0 && (
        <g className="svg-annotations" aria-hidden="true">
          <defs>
            <marker id="anno-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M1 1 L9 5 L1 9" fill="none" stroke="#172d49" strokeWidth="1.6" strokeLinecap="round" />
            </marker>
          </defs>
          {annotations.map((note) => {
            const point = projection([note.lon, note.lat]);
            if (!point) return null;
            const [px, py] = point;
            const lx = px + note.dx;
            const ly = py + note.dy;
            const anchor = note.anchor ?? (note.dx < 0 ? "end" : "start");
            // hand-drawn feel: an S-curve from the label to just short of the point
            const sx = lx + (anchor === "end" ? 6 : -6);
            const sy = ly + (note.dy < 0 ? 30 : -26);
            const ex = px - Math.sign(note.dx) * 10;
            const ey = py - Math.sign(note.dy) * 10;
            const mx = (sx + ex) / 2;
            const my = (sy + ey) / 2;
            const bend = 26;
            const d = `M${sx} ${sy} C ${sx + (note.dx < 0 ? bend : -bend)} ${my - bend}, ${mx - bend} ${my + bend}, ${mx} ${my} S ${ex + (note.dx < 0 ? -bend : bend) / 2} ${ey - (note.dy < 0 ? bend : -bend) / 2}, ${ex} ${ey}`;
            return (
              <g key={note.lines[0]}>
                <path d={d} className="anno-line" markerEnd="url(#anno-arrow)" />
                <text x={lx} y={ly} textAnchor={anchor} className="anno-head">{note.lines[0]}</text>
                <text x={lx} y={ly + 20} textAnchor={anchor} className="anno-sub">{note.lines[1]}</text>
              </g>
            );
          })}
        </g>
      )}
      {fill === "price" && (
        <g className="svg-prices">
          {(prices ?? []).map((row) => {
            const point = projection([Number(row.lon), Number(row.lat)]);
            if (!point) return null;
            const cents = Number(row.cents_per_kwh_50mw);
            const [dx, dy, anchor] = priceLabel[row.city] ?? [0, -13, "middle"];
            const s = 1 / Math.sqrt(scale);
            return (
              <g key={row.city}>
                <circle cx={point[0]} cy={point[1]} r={2.6 * s} />
                <text
                  x={point[0] + dx * s}
                  y={point[1] + dy * s}
                  textAnchor={anchor}
                  style={{ fontSize: 11 * s }}
                >
                  <tspan className="price-city">{row.city}</tspan>
                  <tspan className="price-value"> {cents.toFixed(2)}¢</tspan>
                </text>
                <title>{`${row.city} (${row.utility_per_hq_report}): ${cents.toFixed(2)}¢/kWh${row.note ? `. ${row.note}` : ""}`}</title>
              </g>
            );
          })}
        </g>
      )}
      </g>
      </g>
      {zoomable && (
        <foreignObject x="934" y="12" width="54" height="120">
          <div
            className="zoom-buttons"
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <button aria-label="Zoom in" onClick={() => zoomAt(1.5)}>+</button>
            <button aria-label="Zoom out" onClick={() => zoomAt(1 / 1.5)}>−</button>
            <button aria-label="Reset zoom" onClick={() => setView({ k: 1, x: 0, y: 0 })}>⟲</button>
          </div>
        </foreignObject>
      )}
    </svg>
  );
}

function MapLegend({ fill, layers, shown, total }: { fill: FillMode; layers: Layers; shown: number; total: number }) {
  return (
    <div className="map-legend">
      <div className="legend-block">
        <p>
          Data centre projects · {total} found in public sources
          {shown !== total ? ` (showing ${shown})` : ""}
        </p>
        <div className="project-legend">
          {Object.entries(statusColors).map(([label, color]) => (
            <span key={label}>
              <i
                style={{
                  background: color,
                  borderColor: statusStroke[label as keyof typeof statusStroke],
                }}
              />
              {label}
            </span>
          ))}
          <span className="confidence-key">
            <i />
            Outline: lower confidence
          </span>
        </div>
        <small>Dot size = reported MW. All pins are approximate.</small>
      </div>

      {fill === "capacity" && (
        <div className="legend-block">
          <p>Planned MW by province · York University estimate</p>
          <div className="capacity-scale">
            {[
              ["#e8e5df", "Not disclosed"],
              [capacityColors[0], "< 100"],
              [capacityColors[1], "100–499"],
              [capacityColors[2], "500–9,999"],
              [capacityColors[3], "10,000+"],
            ].map(([color, label]) => (
              <span key={label}>
                <i style={{ background: color }} />
                {label}
              </span>
            ))}
          </div>
        </div>
      )}
      {fill === "energy" && (
        <div className="legend-block">
          <p>Share of 2025 electricity from fossil fuels</p>
          <div className="capacity-scale">
            {fossilScale.map((color, index) => (
              <span key={color}>
                <i style={{ background: color }} />
                {fossilBands[index]}
              </span>
            ))}
          </div>
          <small>Teal = cleaner grid, pink = more fossil fuels. Statistics Canada.</small>
        </div>
      )}
      {layers.people && (
        <div className="legend-block">
          <p>People per km² · 2021 Census</p>
          <div className="capacity-scale">
            {peopleColors.slice(2).map((color, index) => (
              <span key={color}>
                <i style={{ background: color }} />
                {peopleBands[index + 2]}
              </span>
            ))}
          </div>
          <small>Statistics Canada, by census division. Areas under 10 people per km² are left clear. Hover an area for its number.</small>
        </div>
      )}
      {fill === "price" && (
        <div className="legend-block">
          <p>Electricity price for a 50 MW customer · ¢/kWh</p>
          <div className="capacity-scale">
            {priceColors.map((color, index) => (
              <span key={color}>
                <i style={{ background: color }} />
                {priceBands[index]}
              </span>
            ))}
            <span>
              <i style={{ background: "#dcd9d2" }} />
              No data
            </span>
          </div>
          <small>
            Hydro-Québec 2025 estimate (rates on April 1, 2025, before taxes), one city per
            province. Montréal and Winnipeg checked against the utilities&apos; own rates.
          </small>
        </div>
      )}
      {layers.lines && (
        <div className="legend-block">
          <p>Power lines</p>
          <div className="power-legend">
            <span>
              <i />
              Transmission lines (NRCan CanVec)
            </span>
          </div>
          <small>Being near a line does not mean a project connects to it.</small>
        </div>
      )}
      {layers.clean && (
        <div className="legend-block">
          <p>Clean power stations (NRCan) · size = MW</p>
          <div className="energy-legend">
            {Object.entries(cleanColors).map(([label, color]) => (
              <span key={label}>
                <i style={{ background: color, borderRadius: "50%" }} />
                {label}
              </span>
            ))}
          </div>
        </div>
      )}
      {layers.water && (
        <div className="legend-block">
          <p>Watersheds</p>
          <small>
            Major drainage areas, NRCan Atlas of Canada. Shows which river system an area drains
            into, not water use or stress.
          </small>
        </div>
      )}
    </div>
  );
}

function PowerLineDetail({ line }: { line: PowerLine }) {
  return (
    <>
      <p className="drawer-kicker">Power infrastructure</p>
      <h2>Transmission line</h2>
      <p className="operator">{line.province}</p>
      <dl>
        <div>
          <dt>Mapped length</dt>
          <dd>{Number(line.length_km).toLocaleString("en-CA")} km</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>Natural Resources Canada, CanVec 1:250K</dd>
        </div>
      </dl>
      <p className="detail-note">
        Being near a line does not mean a data centre connects to it, or that the line has room for
        more load.
      </p>
      <a
        className="primary-link"
        href="https://open.canada.ca/data/en/dataset/92dbea79-f644-4a62-b25e-8eb993ca0264"
        target="_blank"
        rel="noreferrer"
      >
        View NRCan CanVec source ↗
      </a>
    </>
  );
}

function ProjectDetail({ project, onProvince }: { project: Project; onProvince: () => void }) {
  return (
    <>
      <p className="drawer-kicker">
        <i
          style={{
            background: statusColors[project.status],
            border: `1.5px solid ${statusStroke[project.status]}`,
          }}
        />
        {project.status}
      </p>
      {project.check_status === "From tracker, not yet opened by me" && (
        <p className="confidence-note">
          Lower confidence · source page was not opened during collection
        </p>
      )}
      <h2>{project.name}</h2>
      <p className="operator">{project.operator}</p>
      <strong className="capacity-number">{formatMw(project.reported_mw)}</strong>
      <span className="capacity-label">Reported capacity</span>
      <dl>
        <div>
          <dt>Location</dt>
          <dd>
            {project.city}, {project.province}
          </dd>
        </div>
        {project.reported_mw && (
          <div>
            <dt>What the MW measures</dt>
            <dd>{project.what_the_mw_measures}</dd>
          </div>
        )}
        <div>
          <dt>Location precision</dt>
          <dd>{project.location_precision}</dd>
        </div>
      </dl>
      {project.notes && <p className="detail-note">{project.notes}</p>}
      <a className="primary-link" href={project.source} target="_blank" rel="noreferrer">
        View primary source ↗
      </a>
      <button className="province-context" onClick={onProvince}>
        Why {codeToProvince[project.province]}? <span>View province context →</span>
      </button>
    </>
  );
}

function ProvinceDetail({
  province,
  energy,
  mode,
  prices,
}: {
  province: Province;
  energy?: EnergyMix;
  mode: MapMode;
  prices: PriceRow[];
}) {
  const mixSources = ["Hydro", "Nuclear", "Fossil fuels", "Wind", "Solar", "Biomass"];
  return (
    <>
      <p className="drawer-kicker">{mode === "capacity" ? "Why here?" : "Electricity profile"}</p>
      <h2>{province.province}</h2>
      <strong className="capacity-number">{formatMw(province.planned_mw)}</strong>
      <span className="capacity-label">Provincial planned capacity</span>
      <dl>
        <div>
          <dt>Main power source</dt>
          <dd>{province.main_power_source}</dd>
        </div>
        <div>
          <dt>Grid rules</dt>
          <dd>{province.grid_rules}</dd>
        </div>
        <div>
          <dt>Clean energy / openness</dt>
          <dd>
            {province.clean_energy_level} / {province.openness}
          </dd>
        </div>
      </dl>
      {energy && (
        <div className="mix-chart">
          <p>2025 electricity mix</p>
          {mixSources.map((source) => {
            const value = Number(energy[`${source} %`] || 0);
            return (
              <div key={source}>
                <span>{source}</span>
                <i>
                  <b style={{ width: `${value}%`, background: energyColors[source] }} />
                </i>
                <em>{value.toFixed(1)}%</em>
              </div>
            );
          })}
        </div>
      )}
      {prices.length > 0 && (
        <div className="price-detail">
          <p>Large-customer electricity price, April 2025</p>
          {prices.map((row) => (
            <div key={row.city}>
              <span>{row.city}</span>
              <strong>{Number(row.cents_per_kwh_50mw).toFixed(2)}¢/kWh</strong>
            </div>
          ))}
          <a href={prices[0].source} target="_blank" rel="noreferrer">
            Hydro-Québec 2025 comparison, p.17 ↗
          </a>
        </div>
      )}
      <a
        className="primary-link"
        href={getUrl(province.planned_mw_source)}
        target="_blank"
        rel="noreferrer"
      >
        View provincial source ↗
      </a>
    </>
  );
}

export default App;
