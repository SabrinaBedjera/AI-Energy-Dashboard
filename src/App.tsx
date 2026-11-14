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
  ai_use?: string;
  ai_use_quote?: string;
  ai_use_link?: string;
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
  power_source_source?: string;
  grid_rules_sources?: string;
  levels_source?: string;
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

// Sequential blue: share of provincial electricity generated from fossil fuels in 2025.
const fossilScale = ["#eff3ff", "#bdd7e7", "#6baed6", "#3182bd", "#08519c"];
const fossilBands = ["0–<20%", "20–<40%", "40–<60%", "60–<80%", "80–100%"];
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

// Share of York's data center sites (Appendix Table A2), used in the story only
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

const fossilColor = (share: number) => fossilScale[Math.min(4, Math.max(0, Math.floor(share / 20)))];

const energyColors: Record<string, string> = {
  Hydro: "#0b5f57",
  Nuclear: "#6c5b8f",
  "Fossil fuels": "#08519c",
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
const mapSources = {
  generation: "https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=2510001501",
  population: "https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=9810000701",
  lines: "https://open.canada.ca/data/en/dataset/92dbea79-f644-4a62-b25e-8eb993ca0264",
  clean: "https://geoappext.nrcan.gc.ca/arcgis/rest/services/Energy/CERP_EN/MapServer",
  water: "https://geoappext.nrcan.gc.ca/arcgis/rest/services/NRCAN/AtlasWatershedsEN/MapServer",
  prices: "https://www.hydroquebec.com/data/documents-donnees/pdf/comparaison-prix-2025-en.pdf",
};
function Citation({ href, children }: { href: string; children: React.ReactNode }) {
  return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
}


const getUrl = (source: string) => source.match(/https?:\/\/[^\s]+/)?.[0] ?? "#";

function dominantEnergy(mix?: EnergyMix) {
  if (!mix) return "Other";
  return ["Hydro", "Nuclear", "Fossil fuels", "Wind", "Solar", "Biomass", "Other"].reduce(
    (largest, source) =>
      Number(mix[`${source} %`] || 0) > Number(mix[`${largest} %`] || 0) ? source : largest,
    "Other",
  );
}

// Keep phone layouts in normal document flow; desktop retains the sticky story.
function usePhoneLayout() {
  const [phone, setPhone] = useState(() => window.matchMedia("(max-width: 800px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 800px)");
    const update = () => setPhone(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return phone;
}

function App() {
  const phone = usePhoneLayout();
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false);
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
  const [minMw, setMinMw] = useState(0);
  const [useFilter, setUseFilter] = useState<"" | "ai" | "other" | "unknown">("");
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedPowerLine, setSelectedPowerLine] = useState<PowerLine | null>(null);
  const [selectedProvince, setSelectedProvince] = useState("Alberta");
  const [panelOpen, setPanelOpen] = useState(false);

  // A link like #methods should open at that section once the page has its data.
  useEffect(() => {
    if (!projects.length || !window.location.hash) return;
    const target = document.getElementById(window.location.hash.slice(1));
    if (target) setTimeout(() => target.scrollIntoView(), 300);
  }, [projects.length]);

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
          (statusFilter === "All" || project.status === statusFilter) &&
          (minMw === 0 || inSizeBand(project.reported_mw, minMw)) &&
          (useFilter === "" ||
            (useFilter === "ai"
              ? project.ai_use === "AI" || project.ai_use === "Mixed"
              : useFilter === "other"
                ? project.ai_use === "General cloud" || project.ai_use === "Not AI"
                : !project.ai_use || project.ai_use === "Not stated")),
      ),
    [projects, provinceFilter, statusFilter, minMw, useFilter],
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
        <h2>Try out the map</h2>
        <p>
          Explore the data center projects and clean power. Click a province for its
          rules, energy mix and power prices. Use the buttons to filter the dots or add layers.
        </p>
      </div>

      <section className="map-experience explorer side-layout">
        <button className="mobile-filter-toggle" aria-expanded={mobileFiltersOpen} aria-controls="map-filters" onClick={() => setMobileFiltersOpen(!mobileFiltersOpen)}>
          <span>{mobileFiltersOpen ? "Hide filters and layers" : "Filters and layers"}</span>
          <span>{filteredProjects.length} shown {mobileFiltersOpen ? "−" : "+"}</span>
        </button>
        <div id="map-filters" className={`map-controls explorer-controls ${mobileFiltersOpen ? "is-open" : ""}`}>
          <h3>Data centers</h3>
          <div className="control-group" aria-label="Status">
            <span>Status</span>
            <div className="chips">
              {(
                [
                  ["All", "All", ""],
                  ["Operating", "Operational", statusColors.Operating],
                  ["Under construction", "Under construction", statusColors["Under construction"]],
                  ["Proposed", "Planned projects", statusColors.Proposed],
                ] as [string, string, string][]
              ).map(([value, label, color]) => (
                <button
                  key={value}
                  className={statusFilter === value ? "active" : ""}
                  aria-pressed={statusFilter === value}
                  onClick={() => setStatusFilter(value)}
                >
                  {color && <i className="status-dot" style={{ background: color }} aria-hidden="true" />}
                  {label}
                </button>
              ))}
            </div>
            <small className="chip-note">Size of dot increases with MW.</small>
          </div>
          <div className="control-group" aria-label="Size">
            <span>Size</span>
            <div className="chips">
              {sizeBands.map(([value, label]) => (
                <button
                  key={value}
                  className={minMw === value ? "active" : ""}
                  aria-pressed={minMw === value}
                  onClick={() => setMinMw(minMw === value ? 0 : value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="control-group" aria-label="Data center focus">
            <span>Data center focus</span>
            <div className="chips">
              {(
                [
                  ["ai", "AI"],
                  ["other", "Other uses"],
                  ["unknown", "Not stated"],
                ] as ["ai" | "other" | "unknown", string][]
              ).map(([value, label]) => (
                <button
                  key={value}
                  className={useFilter === value ? "active" : ""}
                  aria-pressed={useFilter === value}
                  onClick={() => setUseFilter(useFilter === value ? "" : value)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="control-group" aria-label="Province">
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
          <div className="control-group layer-list" aria-label="Map layers">
            <span>Map layers</span>
            {(
              [
                ["lines", "Power lines"],
                ["clean", "Clean power generation"],
                ["people", "Population spread"],
                ["water", "Watersheds"],
              ] as [keyof Layers, string][]
            ).map(([key, label]) => (
              <label key={key} className="check">
                <input
                  type="checkbox"
                  checked={layers[key]}
                  onChange={() => setLayers((current) => ({ ...current, [key]: !current[key] }))}
                />
                {label}
              </label>
            ))}
            <button
              className="link-button"
              onClick={() => {
                const allOn = layers.lines && layers.clean && layers.people && layers.water;
                setLayers((current) => ({ ...current, lines: !allOn, clean: !allOn, people: !allOn, water: !allOn }));
              }}
            >
              {layers.lines && layers.clean && layers.people && layers.water ? "Hide all layers" : "Show all layers"}
            </button>
          </div>
          <div className="control-group" aria-label="Colour provinces by">
            <span>Colour provinces by</span>
            <div className="chips">
              {/* Claude / future maintainers: energy-source colouring is intentionally hidden.
                  Preserved on branch archive/energy-source-colouring (commit d043c85).
                  Restore only if requested. First verify the source-to-CSV mapping:
                  Statistics Canada 25-10-0015-01, footnote 8, combines fossil fuels
                  AND biomass under combustible fuels; it does not separate them.
                  The existing "Fossil fuels %" and "Biomass %" fields need review. */}
              <button
                className={fill === "capacity" ? "active" : ""}
                aria-pressed={fill === "capacity"}
                onClick={() => setFill(fill === "capacity" ? "none" : "capacity")}
              >
                Planned MW
              </button>
            </div>
          </div>
          <p className="shown-count">
            Showing {filteredProjects.length} of {projects.length} data centers
          </p>
          <button className="mobile-apply-filters" onClick={() => setMobileFiltersOpen(false)}>Show map</button>
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
              fitStoryMap={phone && provinceFilter === "All"}
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
              <p className="map-hint">{phone ? "Tap a dot or province for details." : "Click a dot or a province for details."}</p>
            )}
            <MapLegend fill={fill} layers={layers} />
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

      {/* Claude / future maintainers: the bottom Charts section is intentionally hidden.
          Full version preserved on archive/charts-before-removal (commit 2c09cb3).
          Restore ChartsSection and its jump link only if requested. */}

      <section id="methods" className="about">
        <h2>About my methods</h2>
        <div className="about-copy">
          <p>
            AI is everywhere. It&apos;s in almost every news source I read, and people have so many
            questions. How is AI being used? How do we regulate it? Why are data centers being built
            everywhere, and where do they get their power? I&apos;m a scientist and engineer who loves
            data and making complex topics accessible, and I had my own questions. What does the data
            center ecosystem look like in Canada? Where do these data centers get their energy? How do
            trends differ across provinces and territories?
          </p>
          <p>
            I found a lot of resources that looked at these questions, but I couldn&apos;t find an
            interactive map that pulled it all together, so I decided to build one! I stuck to
            public information that isn&apos;t behind a paywall, so anyone can explore my data and
            fact-check my sources.
          </p>
          <p>
            In my analysis, I pull together publicly accessible data from research papers, news
            articles, government sources, utility websites, company websites and more! An interesting
            finding is that a decent amount of data center information is behind paywalls, either
            through a private data firm or a news article. Of the 125 sites I found (includes distinct sites and grouped projects), 84 are already
            running, mostly small buildings listed on the operators&apos; own websites. Key information gaps were water use and
            power sources. For example, only 12 of the 125 sites I found share anything about cooling
            or water. For 98 of the 125 mapped sites, a power source was not identified in the public
            sources reviewed.
          </p>
          <p>
            A few notes on the data. Each map layer has its own notes and sources under its legend.
            Sizes (MW) are what each source reports, and they don&apos;t always measure the same thing.
            Some count only the computers, some the whole site, some the power plant next door, and
            some only the first phase. These reported capacities are not measurements of actual
            electricity use. Provincial generation mixes do not establish the power supply of an
            individual facility. Planned projects may change or never be built. All pins are approximate.
          </p>
          <p>
            Each project includes links to its sources. This dataset may not capture every data center
            in Canada. The map uses my 125-site project list; the headline statistics and selected charts
            use <Citation href={yorkUrl}>York University&apos;s separate dataset</Citation> of 194 operating and 213 planned sites.
          </p>
          <p>
            <a href="https://github.com/SabrinaBedjera/AI-Energy-Dashboard" target="_blank" rel="noreferrer">Explore the code</a>
            {/* Project CSV download link intentionally hidden for now.
                Previous link is preserved on archive/charts-before-removal. */}
          </p>
        </div>
        <div className="sources">
          <div className="sources-col">
            <p className="sources-group">Reports and research</p>
            <a href="https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6464099" target="_blank" rel="noreferrer">Carlo &amp; Rolheiser, York University (2026), data centers in Canada</a>
            <a href="https://www.iea.org/reports/energy-and-ai" target="_blank" rel="noreferrer">IEA, Energy and AI (2025)</a>
            <a href="https://www.iea.org/data-and-statistics/charts/sources-of-global-electricity-generation-for-data-centres-base-case-2020-2035" target="_blank" rel="noreferrer">IEA, Sources of global electricity generation for data centres (chart, CC BY 4.0)</a>
            <a href="https://www.iea.org/data-and-statistics/charts/global-data-centre-electricity-consumption-by-equipment-base-case-2020-2030" target="_blank" rel="noreferrer">IEA, Global data centre electricity consumption, by equipment (chart, CC BY 4.0)</a>
            <a href="https://www.iea.org/news/ai-is-set-to-drive-surging-electricity-demand-from-data-centres-while-offering-the-potential-to-transform-how-the-energy-sector-works" target="_blank" rel="noreferrer">IEA news release on Energy and AI (2025)</a>
            <a href="https://angusreid.org/wp-content/uploads/2026/06/2026.06.01_AI_Policy_data_centres.pdf" target="_blank" rel="noreferrer">Angus Reid Institute, AI policy and data centres (2026)</a>
          </div>
          <div className="sources-col">
            <p className="sources-group">Government strategies and rules</p>
            <a href="https://ised-isde.canada.ca/site/ised/en/data-centres-powering-canadas-digital-future-responsibly/canadas-responsible-data-centre-development-principles" target="_blank" rel="noreferrer">Government of Canada, Responsible Data Centre Development Principles (signed by 45 companies)</a>
            <a href="https://www.alberta.ca/artificial-intelligence-data-centres-strategy" target="_blank" rel="noreferrer">Government of Alberta, AI Data Centres Strategy</a>
            <a href="https://majorprojects.alberta.ca/" target="_blank" rel="noreferrer">Government of Alberta, Major Projects</a>
            <a href="https://news.gov.bc.ca/releases/2026ECS0005-000095" target="_blank" rel="noreferrer">Government of BC, power for AI and data centers</a>
            <a href="https://www.blg.com/en/insights/2026/07/data-centre-regulation-in-quebec-from-honeyed-promise-to-iron-control" target="_blank" rel="noreferrer">Quebec, Bill 69 (BLG summary)</a>
            <a href="https://www.torys.com/en/our-latest-thinking/publications/2025/12/key-takeaways-and-next-steps-on-new-energy-law" target="_blank" rel="noreferrer">Ontario, Bill 40 (Torys summary)</a>
            <a href="https://web2.gov.mb.ca/bills/43-3/pdf/b039.pdf" target="_blank" rel="noreferrer">Manitoba, Bill 39</a>
          </div>
          <div className="sources-col">
            <p className="sources-group">Utilities and companies</p>
            <a href="https://www.aeso.ca/grid/connecting-to-the-grid/large-load-projects" target="_blank" rel="noreferrer">AESO, large load projects</a>
            <a href="https://www.hydroquebec.com/data/documents-donnees/pdf/comparaison-prix-2025-en.pdf" target="_blank" rel="noreferrer">Hydro-Québec, Comparison of Electricity Prices 2025</a>
            <a href="https://www.telus.com/en/about/news-and-events/media-releases/TELUS-and-Government-of-Canada-advance-work-to-scale-Canadas-sovereign-AI-infrastructure" target="_blank" rel="noreferrer">TELUS, sovereign AI infrastructure</a>
            <a href="https://cfjctoday.com/2025/05/28/bell-announces-plans-to-open-six-ai-data-centres-in-b-c-as-part-of-bell-ai-fabric/" target="_blank" rel="noreferrer">CFJC Today, Bell AI Fabric in BC</a>
            <a href="https://www.cp24.com/news/canada/2026/10/16/everwind-says-10b-ai-data-centre-proposal-largest-private-investment-in-ns-history/" target="_blank" rel="noreferrer">CP24, EverWind data center proposal</a>
          </div>
          <div className="sources-col">
            <p className="sources-group">Maps and data</p>
            <a href="https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=2510001501" target="_blank" rel="noreferrer">Statistics Canada, electricity generation, Table 25-10-0015-01</a>
            <a href="https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=9810000701" target="_blank" rel="noreferrer">Statistics Canada, 2021 Census population, Table 98-10-0007-01</a>
            <a href="https://open.canada.ca/data/en/dataset/92dbea79-f644-4a62-b25e-8eb993ca0264" target="_blank" rel="noreferrer">NRCan CanVec, power lines</a>
            <a href="https://geoappext.nrcan.gc.ca/arcgis/rest/services/Energy/CERP_EN/MapServer" target="_blank" rel="noreferrer">NRCan, Clean Energy Resources and Projects</a>
            <a href="https://geoappext.nrcan.gc.ca/arcgis/rest/services/NRCAN/AtlasWatershedsEN/MapServer" target="_blank" rel="noreferrer">NRCan Atlas of Canada, drainage areas</a>
          </div>
          <span>Each data center&apos;s own source is linked on the map.</span>
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
  backdrop?: React.ReactNode;
  title?: string;
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
  const [active, setActive] = useState(0);
  const stepRefs = useRef<(HTMLDivElement | null)[]>([]);

  const steps: ScrollStep[] = [
    {
      mode: "projects",
      hero: true,
      annotations: [
        { lon: -114, lat: 56, dx: 40, dy: -200, anchor: "start", lines: ["Majority of planned data centers", "Alberta: 78% of planned sites"] },
        { lon: -79.6, lat: 43.9, dx: -170, dy: 20, lines: ["Largest share of operating data centers", "Ontario: 41% of operating sites"] },
        { lon: -73.6, lat: 45.6, dx: 60, dy: -170, anchor: "start", lines: ["Large portion of operating data centers", "Quebec: 30% of operating sites"] },
      ],
      body: (
        <>
          <h1 className="fun-title" data-text="Canada's AI Boom">Canada&apos;s AI Boom</h1>
          <p className="hero-sub">An exploration of where Canada&apos;s AI will get its power</p>
          <ul className="hero-findings">
            <li>
              <span className="finding-num">78%</span> of Canada&apos;s planned data centers are in
              Alberta.
            </li>
            <li>
              <span className="finding-num">14×</span>
              <span>the reported power capacity in planned projects versus operating sites
              (22.2 GW vs 1.6 GW).</span>
            </li>
          </ul>
          <p className="hero-source">
            Source: {" "}
            <a href={yorkUrl} target="_blank" rel="noreferrer">
              York University (2026)
            </a>{" "}
            · <a href="#methods">Methods</a>
          </p>
          <p className="hero-byline">By Sabrina Bedjera · November 2026</p>
          <nav className="hero-nav" aria-label="Jump to">
            <span>Jump to:</span> <a href="#story">The story</a> · <a href="#explore">Interactive map</a> ·{" "}
            <a href="#methods">Data and methods</a>
          </nav>

        </>
      ),
    },
    {
      mode: "projects",
      title: "Canada’s data center shift",
      body: (
        <>
          <p>
            Canada is experiencing a data center shift. Operating data centers are concentrated in
            Ontario and Quebec, are located close to cities, and have smaller reported power
            capacities. Planned data center projects have larger reported power capacities and are
            more concentrated in Alberta.
          </p>
          <p>
            However, planned projects are not built projects. Whether they proceed depends on access
            to power, land, funding, water, regulatory approvals, and other factors. In areas with
            limited grid connection capacity, some developers are looking to build their own power
            generation. For example, Wonder Valley proposes on-site natural gas and geothermal power.
          </p>
          <p>
            My analysis brings together project announcements, provincial electricity generation,
            infrastructure, and policy to explore that shift.
          </p>
          <p className="hero-source">
            Sources: <a href={yorkUrl} target="_blank" rel="noreferrer">York University (2026)</a>,{" "}
            <a href="https://www.aeso.ca/grid/connecting-to-the-grid/large-load-projects" target="_blank" rel="noreferrer">AESO</a>,{" "}
            <a href="https://majorprojects.alberta.ca/details/Wonder-Valley-AI-Data-Centre-Park-Phase-1/11477" target="_blank" rel="noreferrer">Wonder Valley project listing</a>.
          </p>
        </>
      ),
    },
    {
      mode: "projects",
      title: "What is a data center?",
      body: (
        <>
          <p>
            AI is rapidly growing and being used in many aspects of everyday life, from writing
            emails and searching for jobs to vibe coding websites or doing research. AI has
            experienced a boom over the last few years due to improvements in computing power (e.g.
            computer chips), and AI models.
          </p>
          <p>
            A data center is a building full of computer servers that companies use to run their
            systems. For instance, if you&apos;ve ever done a Google search, your computer would have
            connected to a server in a data center. Companies use AI data centers to train and run
            their AI models.
          </p>
        </>
      ),
    },
    {
      mode: "power",
      title: "How much power do data centers use?",
      hideProjects: true,
      fadeAll: true,
      backdrop: <IeaChart />,
      body: (
        <>
          <p>
            Data centers need electricity to run, which increases with the amount of servers that
            they hold. The International Energy Agency found that data centers used{" "}
            1.5% of the world&apos;s electricity in 2024 (
            <a href={ieaUrl} target="_blank" rel="noreferrer">
              IEA, 2025
            </a>
            ). It expects that to roughly double to about 3% by 2030, slightly more than{" "}
            the whole country of Japan uses today.
          </p>
          <p>
            In order to meet this demand, companies are exploring a range of energy sources such as
            renewable energy (e.g. wind, solar, hydro), nuclear, natural gas, and coal. The IEA
            expects renewable energy and natural gas will lead until 2035 due to their availability
            and lower costs (
            <a href="https://www.iea.org/news/ai-is-set-to-drive-surging-electricity-demand-from-data-centres-while-offering-the-potential-to-transform-how-the-energy-sector-works" target="_blank" rel="noreferrer">
              IEA, 2025
            </a>
            ).
          </p>
        </>
      ),
    },
    {
      mode: "power",
      title: "What the power is used for",
      hideProjects: true,
      fadeAll: true,
      backdrop: <IeaEquipmentChart />,
      body: (
        <>
          <p>
            So what is all that electricity used for? Most of it runs the servers, the computers
            themselves. The IEA says servers use around 60% of the electricity in a modern data
            center, and the rest goes to storage, network equipment, cooling and the building (
            <a href="https://www.iea.org/reports/energy-and-ai/energy-demand-from-ai" target="_blank" rel="noreferrer">
              IEA, 2025
            </a>
            ).
          </p>
          <p>
            The fastest-growing part is accelerated servers, the AI chips. The IEA expects their
            electricity use to grow about 30% a year to 2030, compared with about 9% for regular
            servers (
            <a href="https://www.iea.org/reports/energy-and-ai/energy-demand-from-ai" target="_blank" rel="noreferrer">
              IEA, 2025
            </a>
            ).
          </p>
        </>
      ),
    },
    {
      mode: "grid",
      title: "Where data centers get their power",
      hideProjects: true,
      body: (
        <>
          <p>
            Companies have different approaches for sourcing their data center energy. Some will
            choose to plug into the electricity grid if it&apos;s nearby and has power available.
            Others might build their data centers in more remote locations and may have to build
            their own power systems. For example:
          </p>
          <ul className="step-list">
            <li>
              <strong>British Columbia:</strong> TELUS&apos; data centers have secured 85 MW of renewable power from
              BC Hydro (
              <a href="https://www.telus.com/en/about/news-and-events/media-releases/TELUS-and-Government-of-Canada-advance-work-to-scale-Canadas-sovereign-AI-infrastructure" target="_blank" rel="noreferrer">TELUS</a>
              ).
            </li>
            <li>
              <strong>Nova Scotia:</strong> EverWind is investing $2B in new wind projects to supply
              energy to their data centers (
              <a href="https://www.cp24.com/news/canada/2026/10/16/everwind-says-10b-ai-data-centre-proposal-largest-private-investment-in-ns-history/" target="_blank" rel="noreferrer">CP24</a>
              ).
            </li>
          </ul>
        </>
      ),
    },
    {
      mode: "capacity",
      title: "Why Alberta?",
      focus: "Alberta",
      highlight: "Wonder Valley",
      body: (
        <>
          <p>
            Overall, data centers are shifting to being built in Alberta. This is due to the
            different regulations, incentives, and tools that the provinces and territories use.
            Alberta is aiming to become the North American destination for AI data centers (
            <a href="https://www.alberta.ca/artificial-intelligence-data-centres-strategy" target="_blank" rel="noreferrer">
              Government of Alberta, AI Data Centres Strategy, 2024
            </a>
            ) by pointing to its power supply and cold climate, low corporate taxes, a data centre
            concierge program, and regulatory changes to make it easier to build data centers.
          </p>
          <p>
            Alberta&apos;s grid only had room for 1,200 MW of big new loads, and
            that&apos;s taken (
            <a href="https://www.aeso.ca/grid/connecting-to-the-grid/large-load-projects" target="_blank" rel="noreferrer">
              AESO
            </a>
            ), so projects like Wonder Valley plan to build their
            own power plants. Other provinces are more careful with their power: BC caps how much
            goes to data centers, and Quebec needs a minister to sign off. The full rules by
            province are at the bottom of the page.
          </p>
        </>
      ),
    },
    {
      mode: "sitesPlanned",
      title: "Today vs planned",
      hideProjects: true,
      wide: true,
      body: (
        <>
          <TodayVsPlanned />
          <p>
            Today&apos;s data centers are close to cities, where people live and the grid is
            strong. The planned ones show a shift: they&apos;re mostly in Alberta, farther from
            cities where there is likely more room to build, but where getting power can be harder
            and they might have to build their own. They&apos;re also much bigger.
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

  const phone = usePhoneLayout();
  const renderStoryMap = (item: ScrollStep) => (
        <SvgMap
          boundaries={props.boundaries}
          powerLines={props.powerLines}
          cleanStations={props.cleanStations}
          drainage={props.drainage}
          population={props.population}
          prices={props.prices}
          projects={props.projects}
          fill={viewFor(item.mode).fill}
          layers={viewFor(item.mode).layers}
          selectedProject={null}
          onSelectProject={() => {}}
          onSelectProvince={() => {}}
          onSelectPowerLine={() => {}}
          focusProvince={item.focus}
          hideProjects={item.hideProjects}
          highlightProject={item.highlight}
          fadeAll={item.fadeAll}
          annotations={phone ? undefined : item.annotations}
          fitStoryMap={!item.focus && (phone || !item.hero)}
        />
  );
  const renderStoryLegend = (item: ScrollStep) => (
    <>

        {item.hero && (
          <div className="cover-legend cover-map-key" role="group" aria-label="Cover map legend">
            <div className="project-legend">
              {([
                ["Operating", "Operational"],
                ["Under construction", "Under construction"],
                ["Proposed", "Planned projects"],
              ] as const).map(([status, label]) => (
                <span key={status}>
                  <i style={{ background: statusColors[status], borderColor: statusStroke[status] }} aria-hidden="true" />
                  {label}
                </span>
              ))}
              <span className="confidence-key"><i aria-hidden="true" />Outer ring: lower confidence</span>
            </div>
            <small>Dot size = reported MW · Smallest dots include unknown capacity</small>
          </div>
        )}
              {item.mode === "grid" && (
                <div className="story-map-key cover-legend story-under-map-key" role="group" aria-label="Power infrastructure map legend">
                  <p><span className="transmission-swatch" aria-hidden="true" />Power transmission lines</p>
                  <p>Clean power generation</p>
                  <div className="project-legend">
                    {Object.entries(cleanColors).map(([label, color]) => (
                      <span key={label}><i style={{ background: color, borderColor: color }} aria-hidden="true" />{label}</span>
                    ))}
                  </div>
                  <small>Larger dots indicate higher generating capacity (MW). Stations: <Citation href={mapSources.clean}>NRCan</Citation>, a list compiled in 2017. Some stations have since closed and newer ones may be missing. Lines: <Citation href={mapSources.lines}>NRCan CanVec</Citation>. Proximity does not establish a data center’s power supply.</small>
                </div>
              )}
        {(item.mode === "sitesPlanned" || item.mode === "sitesActive") && (
          <div className="cover-legend story-under-map-key" role="group" aria-label="Provincial site share map legend">
            <p>Share of Canada&apos;s {item.mode === "sitesPlanned" ? "planned" : "operating"} data center sites</p>
            <div className="project-legend share-scale">
              {siteShareColors.map((color, index) => (
                <span key={color}><i style={{ background: color, borderColor: color }} aria-hidden="true" />{["0%", ">0–<5%", "5–<15%", "15–<35%", "35–100%"][index]}</span>
              ))}
            </div>
            <small>Darker pink = a larger share of sites, not MW. Source: <Citation href={yorkUrl}>York University (2026), Appendix Table A2</Citation>.</small>
          </div>
        )}

    </>
  );
  const step = steps[active];
  return (
    <section className="scrolly">
      {!phone && <div className={`scrolly-graphic ${step.wide ? "shift" : ""} ${step.backdrop ? "has-backdrop" : ""} ${step.hero ? "is-cover" : ""} ${step.mode === "grid" || step.mode === "sitesPlanned" || step.mode === "sitesActive" ? "has-map-key" : ""}`}>
        {renderStoryMap(step)}
        {renderStoryLegend(step)}
        {step.backdrop && <div className="scrolly-backdrop">{step.backdrop}</div>}
      </div>}
      <div className="scrolly-steps">
        {steps.map((item, index) => (
          <div
            key={index}
            ref={(element) => {
              stepRefs.current[index] = element;
            }}
            data-step={index}
            className={`scrolly-step ${item.hero ? "hero" : ""} ${item.wide ? "wide" : ""} ${item.backdrop ? "has-backdrop" : ""} ${index === active ? "is-active" : ""}`}
          >
            <div className="step-card" id={index === 1 ? "story" : undefined}>
              {item.title && <h2 className="step-title">{item.title}</h2>}
              {item.body}
              {phone && item.backdrop && <div className="inline-story-chart">{item.backdrop}</div>}
            </div>
            {phone && !item.backdrop && (
              <div className="mobile-story-figure">
                {renderStoryMap(item)}
                {renderStoryLegend(item)}
              </div>
            )}
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
      <figcaption>Planned data center capacity by province (MW), York University estimate</figcaption>
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
const sizeBands: [number, string][] = [
  [1, "Under 100 MW"],
  [3, "100 MW+"],
];

// Size bands don't overlap. Sites with no published MW are left out of every band.
function inSizeBand(raw: string | undefined, band: number) {
  if (!raw || !String(raw).trim()) return false;
  const mw = Number(raw);
  if (Number.isNaN(mw)) return false;
  if (band === 1) return mw < 100;
  return mw >= 100;
}

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
        <figcaption>Average size of one data center (MW)</figcaption>
        <svg viewBox="0 0 440 128" role="img" aria-label="Average data center size, operating versus announced, Canada and US">
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

// York University paper, Appendix Table A2 (page 42): number of data centers by province and stage.
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

function IeaChart() {
  return (
    <figure className="iea-figure">
      <figcaption>
        <strong>Sources of global electricity generation for data centres, Base Case, 2020-2035</strong>{" "}
        (TWh)
      </figcaption>
      <img
        src={`${import.meta.env.BASE_URL}images/iea-data-centre-electricity-sources-2020-2035.png`}
        alt="Stacked area chart of electricity generation for data centres worldwide, 2020 to 2035, by source, rising from about 300 TWh to about 1,330 TWh."
      />
      <ul className="iea-legend">
        <li><span style={{ background: "#76ddfe" }} />Coal</li>
        <li><span style={{ background: "#6b9bdc" }} />Natural gas</li>
        <li><span style={{ background: "#8ff5a8" }} />Nuclear</li>
        <li><span style={{ background: "#3fbfb6" }} />Solar PV</li>
        <li><span style={{ background: "#fff584" }} />Wind</li>
        <li><span style={{ background: "#ffc773" }} />Other renewables</li>
        <li><span style={{ background: "#f4733f" }} />Other</li>
      </ul>
      <p className="york-source">
        Source:{" "}
        <a href="https://www.iea.org/data-and-statistics/charts/sources-of-global-electricity-generation-for-data-centres-base-case-2020-2035" target="_blank" rel="noreferrer">
          IEA (2025), Sources of global electricity generation for data centres, Base Case,
          2020-2035, IEA, Paris
        </a>
        . Licence:{" "}
        <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
          CC BY 4.0
        </a>
        .
      </p>
    </figure>
  );
}

function IeaEquipmentChart() {
  return (
    <figure className="iea-figure">
      <figcaption>
        <strong>Global data centre electricity consumption, by equipment, Base Case, 2020-2030</strong>{" "}
        (TWh)
      </figcaption>
      <img
        src={`${import.meta.env.BASE_URL}images/iea-data-centre-electricity-by-equipment-2020-2030.png`}
        alt="Stacked area chart of global data center electricity use by equipment, 2020 to 2030, rising from about 270 TWh to about 945 TWh, with accelerated servers growing fastest."
      />
      <ul className="iea-legend">
        <li><span style={{ background: "#77deff" }} />Accelerated servers</li>
        <li><span style={{ background: "#6e9bde" }} />Conventional servers</li>
        <li><span style={{ background: "#8ef6af" }} />Other IT equipment</li>
        <li><span style={{ background: "#40c2b9" }} />Cooling</li>
        <li><span style={{ background: "#fff783" }} />Other infrastructure</li>
      </ul>
      <p className="york-source">
        Source:{" "}
        <a href="https://www.iea.org/data-and-statistics/charts/global-data-centre-electricity-consumption-by-equipment-base-case-2020-2030" target="_blank" rel="noreferrer">
          IEA (2025), Global data centre electricity consumption, by equipment, Base Case,
          2020-2030, IEA, Paris
        </a>
        . Licence:{" "}
        <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">
          CC BY 4.0
        </a>
        .
      </p>
    </figure>
  );
}

function TodayVsPlanned() {
  const rows: [string, string, string][] = [
    ["Data centers", "194", "213"],
    ["Power", "1.6 GW", "22.2 GW (14×)"],
    ["Where", "Ontario 41%, Quebec 30%, BC 14%", "Alberta 78%"],
    ["Distance to a downtown (half of sites)", "Within about 4 km", "More than 48 km"],
    ["Over 100 MW", "None", "116"],
  ];
  return (
    <table className="today-planned">
      <thead>
        <tr>
          <th />
          <th>Running today</th>
          <th className="planned">Planned</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, today, planned]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{today}</td>
            <td className="planned">{planned}</td>
          </tr>
        ))}
      </tbody>
      <caption>
        Source:{" "}
        <a href={yorkUrl} target="_blank" rel="noreferrer">
          Carlo &amp; Rolheiser, York University (2026)
        </a>
        , Tables A1 and A2, Figure 3b, so these are different from my own list. Planned = announced
        or under construction. Over 100 MW is what the <Citation href={ieaUrl}>IEA</Citation> calls hyperscale.
      </caption>
    </table>
  );
}

function ChartsSection({ prices }: { prices: PriceRow[] }) {
  return (
    <section className="charts-section" id="charts">
      <p className="eyebrow">From the story</p>
      <h2>Charts</h2>
      <div className="charts-grid">
        <div className="chart-card">
          <h3>Where data centers are, and where they&apos;re planned</h3>
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
          <p>
            York counts 1,989 data centers running in the US (46.8 GW), against 194 in Canada. But
            Canada&apos;s planned projects are bigger on average: 122 MW vs 95 MW.
          </p>
          <YorkComparison />
          <p>
            Worldwide, the US used 45% of all data center electricity in 2024, China 25% and Europe
            15% (
            <a href={ieaUrl} target="_blank" rel="noreferrer">
              IEA, 2025
            </a>
            ).
          </p>
        </div>
        <div className="chart-card">
          <h3>How Canadians feel</h3>
          <p>
            In a May 2026 Angus Reid survey, 68% said they would oppose a large AI data center within
            a few blocks of their home, and 15% would support one. 67% said these sites would be bad
            for energy and environmental sustainability (
            <a href="https://angusreid.org/wp-content/uploads/2026/06/2026.06.01_AI_Policy_data_centres.pdf" target="_blank" rel="noreferrer">
              Angus Reid Institute
            </a>
            , online survey, May 7 to 11, 2026, 1,803 adults).
          </p>
          <p>
            45 companies, including Amazon, Google, Microsoft, Meta, OpenAI and Anthropic, have
            signed Canada&apos;s Responsible Data Centre Development Principles: leave lasting local
            benefits, don&apos;t shift electricity costs to Canadians, limit and report water use, be
            open about local impacts, and bring value to Canada. The principles don&apos;t say they are
            binding (
            <a href="https://ised-isde.canada.ca/site/ised/en/data-centres-powering-canadas-digital-future-responsibly/canadas-responsible-data-centre-development-principles" target="_blank" rel="noreferrer">
              ISED
            </a>
            ).
          </p>
        </div>
      </div>
    </section>
  );
}

const rulesRows: [string, string, string][] = [
  ["Alberta", "Grid capped at 1,200 MW for big new loads (all allocated). Bill 8 fast-tracks data centers that bring their own power.", "https://www.aeso.ca/grid/connecting-to-the-grid/large-load-projects"],
  ["British Columbia", "Competitive process: up to 300 MW for AI and 100 MW for other data centers over two years, 145 MW max per project.", "https://news.gov.bc.ca/releases/2026ECS0005-000095"],
  ["Quebec", "A minister must authorize power for any data center of 5 MW or more (Bill 69).", "https://www.blg.com/en/insights/2026/07/data-centre-regulation-in-quebec-from-honeyed-promise-to-iron-control"],
  ["Ontario", "The government decides which large loads can connect, and weighs economic benefit (Bill 40).", "https://www.torys.com/en/our-latest-thinking/publications/2025/12/key-takeaways-and-next-steps-on-new-energy-law"],
  ["Manitoba", "Proposed a separate rate class for data centers (Bill 39). Not yet clear if it's in force.", "https://web2.gov.mb.ca/bills/43-3/pdf/b039.pdf"],
  ["Saskatchewan", "New data center projects must supply their own power (Data Centre Framework, Aug 2026).", "https://www.saskatchewan.ca/government/news-and-media/2026/august/27/waiting-on-news-release"],
  ["Nova Scotia, New Brunswick", "Standard grid connection, no data center rules yet.", "https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6464099"],
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
        Rules as of November 2026. Summary based on <Citation href={yorkUrl}>York University (2026), Table 2</Citation>, and each
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
        <figcaption>Share of data center sites by province</figcaption>
        <svg viewBox="0 0 440 300" role="img" aria-label="Share of operating and planned data center sites by province">
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
  fitStoryMap = false,
}: {
  annotations?: Annotation[];
  fitStoryMap?: boolean;
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
  const phone = usePhoneLayout();
  const projection = useMemo(() => {
    const nextProjection = geoConicEqualArea().parallels([50, 70]).rotate([96, 0]).center([0, 62]);
    if (boundaries)
      nextProjection.fitExtent(
        [
          [4, 4],
          [996, 596],
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
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const showTip = (event: React.MouseEvent<SVGElement>, text: string) => {
    const box = (event.currentTarget as SVGElement).ownerSVGElement?.parentElement?.getBoundingClientRect();
    if (!box) return;
    setTip({ text, x: event.clientX - box.left + 14, y: event.clientY - box.top + 14 });
  };
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
    <>
    <svg
      ref={svgRef}
      className={`map-canvas svg-map ${zoomable ? "zoomable" : ""}`}
      viewBox={fitStoryMap ? "120 0 760 600" : "0 0 1000 600"}
      preserveAspectRatio="xMidYMid meet"
      style={phone && zoomable ? { touchAction: view.k > 1 ? "none" : "pan-y" } : undefined}
      role="img"
      aria-label="Interactive map of Canadian data center projects"
      onDoubleClick={(event) => {
        if (!zoomable) return;
        const { x, y } = toSvg(event.clientX, event.clientY);
        zoomAt(1.6, x, y);
      }}
      onPointerDown={(event) => {
        if (!zoomable || (phone && event.pointerType === "touch" && view.k === 1)) return;
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
      onPointerCancel={() => (drag.current = null)}
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
          {population?.features?.map((feature: any) => {
            const p = feature.properties;
            const tip = `${p.name}: ${p.density_per_km2.toLocaleString("en-CA")} people per km², ${p.population_2021.toLocaleString("en-CA")} people (2021 Census)`;
            return (
              <path
                key={p.cd_uid}
                d={pathGenerator(feature) ?? undefined}
                fill={peopleColor(p.density_per_km2)}
                onMouseMove={(event) => showTip(event, tip)}
                onMouseLeave={() => setTip(null)}
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
                  style={{
                    fontSize: (share !== null ? 15 : 9) / Math.sqrt(scale),
                    fill: fill === "energy" && feature.properties.fossil_share >= 60 ? "#ffffff" : undefined,
                  }}
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
          {annotations.map((note) => {
            const point = projection([note.lon, note.lat]);
            if (!point) return null;
            const [px, py] = point;
            const lx = px + note.dx;
            const ly = py + note.dy;
            const anchor = note.anchor ?? (note.dx < 0 ? "end" : "start");
            const headingLines = note.lines[0].length > 35
              ? [note.lines[0].replace(/ data centers$/, ""), "data centers"]
              : [note.lines[0]];
            // hand-drawn feel: one loose arc that swings out to the side, with a quick pen-stroke head
            const sx = lx + (anchor === "end" ? -4 : 4);
            const sy = ly + (note.dy < 0 ? 32 + (headingLines.length - 1) * 22 : -24);
            const ex = px - Math.sign(note.dx) * 9;
            const ey = py - Math.sign(note.dy) * 9;
            const vx = ex - sx;
            const vy = ey - sy;
            const len = Math.hypot(vx, vy) || 1;
            const swing = Math.min(70, len * 0.35) * (note.dx < 0 ? -1 : 1);
            const cx = sx + vx * 0.5 - (vy / len) * swing;
            const cy = sy + vy * 0.5 + (vx / len) * swing;
            const d = `M${sx} ${sy} Q ${cx} ${cy} ${ex} ${ey}`;
            // arrowhead follows the curve's last direction, two strokes of different length
            const tx = ex - cx;
            const ty = ey - cy;
            const tl = Math.hypot(tx, ty) || 1;
            const ux = tx / tl;
            const uy = ty / tl;
            const head = (size: number, turn: number) => {
              const c = Math.cos(turn);
              const sn = Math.sin(turn);
              return `${ex - size * (ux * c - uy * sn)} ${ey - size * (uy * c + ux * sn)}`;
            };
            const h = `M${head(11, 0.5)} L${ex} ${ey} L${head(8, -0.6)}`;
            return (
              <g key={note.lines[0]}>
                <path d={d} className="anno-line" />
                <path d={h} className="anno-line anno-head-stroke" />
                <text x={lx} y={ly} textAnchor={anchor} className="anno-head">
                  {headingLines.map((line, index) => (
                    <tspan key={line} x={lx} dy={index === 0 ? 0 : 22}>{line}</tspan>
                  ))}
                </text>
                <text x={lx} y={ly + 20 + (headingLines.length - 1) * 22} textAnchor={anchor} className="anno-sub">{note.lines[1]}</text>
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
      {zoomable && !phone && (
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
    {zoomable && phone && (
      <div className="mobile-map-zoom zoom-buttons" onPointerDown={(event) => event.stopPropagation()}>
        <button aria-label="Zoom in" onClick={() => zoomAt(1.5)}>+</button>
        <button aria-label="Zoom out" onClick={() => zoomAt(1 / 1.5)}>−</button>
        <button aria-label="Reset zoom" onClick={() => setView({ k: 1, x: 0, y: 0 })}>⟲</button>
      </div>
    )}
    {tip && (
      <div className="map-tip" style={{ left: tip.x, top: tip.y }}>
        {tip.text}
      </div>
    )}
    </>
  );
}

function MapLegend({ fill, layers }: { fill: FillMode; layers: Layers }) {
  return (
    <div className="map-legend">

      {fill === "capacity" && (
        <div className="legend-block">
          <p>Planned MW by province (<Citation href={yorkUrl}>York University</Citation> estimate, separate from my list of dots)</p>
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
          <small>Darker blue = a higher fossil-fuel share of electricity generated in 2025. Bands are display choices, not source categories. Source: <Citation href={mapSources.generation}>Statistics Canada, Table 25-10-0015-01</Citation>. Provincial generation does not establish a data center&apos;s electricity supply.</small>
        </div>
      )}
      {layers.people && (
        <div className="legend-block">
          <p>Population spread: people per km², 2021 Census</p>
          <div className="capacity-scale">
            {peopleColors.map((color, index) => (
              <span key={color}>
                <i style={{ background: color }} />
                {peopleBands[index]}
              </span>
            ))}
          </div>
          <small>All 293 census divisions, <Citation href={mapSources.population}>Statistics Canada 2021 Census</Citation>. Hover an area for its number.</small>
        </div>
      )}
      {fill === "price" && (
        <div className="legend-block">
          <p>Electricity price for a 50 MW customer (¢/kWh)</p>
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
            <Citation href={mapSources.prices}>Hydro-Québec 2025 estimate</Citation> (rates on April 1, 2025, before taxes), one city per
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
              Transmission lines (<Citation href={mapSources.lines}>NRCan CanVec</Citation>)
            </span>
          </div>
          <small><Citation href={mapSources.lines}>NRCan CanVec</Citation>. Being near a line does not mean a data center connects to it.</small>
        </div>
      )}
      {layers.clean && (
        <div className="legend-block">
          <p>Clean power generation (<Citation href={mapSources.clean}>NRCan</Citation>): hydro, wind, solar, nuclear, biomass and tidal generating stations. Size = MW</p>
          <div className="energy-legend">
            {Object.entries(cleanColors).map(([label, color]) => (
              <span key={label}>
                <i style={{ background: color, borderRadius: "50%" }} />
                {label}
              </span>
            ))}
          </div>
          <small><Citation href={mapSources.clean}>NRCan</Citation>, a list compiled in 2017. Some stations have since closed and newer ones may be missing.</small>
        </div>
      )}
      {layers.water && (
        <div className="legend-block">
          <p>Watersheds</p>
          <small>
            Major drainage areas, <Citation href={mapSources.water}>NRCan Atlas of Canada</Citation>. Shows which river system an area drains
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
          <dd><Citation href={mapSources.lines}>Natural Resources Canada, CanVec 1:250K</Citation></dd>
        </div>
      </dl>
      <p className="detail-note">
        Being near a line does not mean a data center connects to it, or that the line has room for
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
        {project.ai_use && (
          <div>
            <dt>What it is for</dt>
            <dd>
              {project.ai_use === "Not stated" ? "Not stated publicly" : project.ai_use}
              {project.ai_use_link && (
                <>
                  {" "}
                  <a href={project.ai_use_link} target="_blank" rel="noreferrer">
                    source ↗
                  </a>
                </>
              )}
            </dd>
          </div>
        )}
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
  // Statistics Canada 25-10-0015-01 reports fossil fuels and biomass together as combustible fuels.
  const mixSources = ["Hydro", "Nuclear", "Combustible fuels", "Wind", "Solar"];
  return (
    <>
      <h2>{province.province}</h2>
      <div className="panel-block">
        <h3>Planned data center power</h3>
        <p className="capacity-number">{formatMw(province.planned_mw)}</p>
        <SourceLine raw={province.planned_mw_source} label="York University (2026)" />
      </div>
      <div className="panel-block">
        <h3>Grid rules</h3>
        <p>{province.grid_rules.replace(/centres/g, "centers").replace(/centre\b/g, "center")}</p>
        <SourceLine raw={province.grid_rules_sources} />
      </div>
      {energy && (
        <div className="panel-block mix-chart">
          <h3>Power Generation Sources</h3>
          {mixSources.map((source) => {
            const value =
              source === "Combustible fuels"
                ? Number(energy["Fossil fuels %"] || 0) + Number(energy["Biomass %"] || 0)
                : Number(energy[`${source} %`] || 0);
            return (
              <div key={source}>
                <span>{source === "Combustible fuels" ? "Fossil fuels and biomass" : source}</span>
                <i>
                  <b style={{ width: `${value}%`, background: energyColors[source] ?? energyColors["Fossil fuels"] }} />
                </i>
                <em>{value.toFixed(1)}%</em>
              </div>
            );
          })}
          <SourceLine raw="https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=2510001501" label="Statistics Canada, Table 25-10-0015-01" />
        </div>
      )}
      {prices.length > 0 && (
        <div className="panel-block price-detail">
          <h3>What a large customer pays for power, April 2025</h3>
          {prices.map((row) => (
            <div key={row.city}>
              <span>{row.city}</span>
              <strong>{Number(row.cents_per_kwh_50mw).toFixed(2)}¢/kWh</strong>
            </div>
          ))}
          <SourceLine raw={prices[0].source} label="Hydro-Québec, Comparison of Electricity Prices 2025, p.17" />
        </div>
      )}
    </>
  );
}

const sourceNames: Record<string, string> = {
  "papers.ssrn.com": "York University (2026)",
  "aeso.ca": "AESO",
  "bennettjones.com": "Bennett Jones",
  "torys.com": "Torys",
  "mccarthy.ca": "McCarthy Tétrault",
  "news.gov.bc.ca": "BC government",
  "blg.com": "BLG",
  "web2.gov.mb.ca": "Manitoba Bill 39",
  "alberta.ca": "Government of Alberta",
  "saskatchewan.ca": "Government of Saskatchewan",
};

// Turns a source cell like "https://a.ca (Fig 3b) https://b.ca" into links.
function SourceLine({ raw, label }: { raw?: string; label?: string }) {
  if (!raw) return null;
  const urls = raw.match(/https?:\/\/[^\s,;)]+/g) ?? [];
  if (!urls.length) return <p className="panel-source">Source: {raw}</p>;
  const note = raw.match(/\(([^)]+)\)/)?.[1];
  return (
    <p className="panel-source">
      Source{urls.length > 1 ? "s" : ""}:{" "}
      {urls.map((url, index) => {
        const domain = url.replace(/^https?:\/\/(www\d*\.)?/, "").split("/")[0];
        let host = sourceNames[domain] ?? domain;
        if (label && urls.length === 1) host = label;
        return (
          <span key={url}>
            {index > 0 && ", "}
            <a href={url} target="_blank" rel="noreferrer">
              {host}
            </a>
          </span>
        );
      })}
      {note ? ` (${note})` : ""}
    </p>
  );
}

export default App;
