import { useEffect, useMemo, useState } from "react";
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
type MapMode = "capacity" | "power" | "energy" | "clean" | "water";
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
  "Under construction": "#172d49",
  Proposed: "#e0457b",
};

const statusStroke = {
  Operating: "#172d49",
  "Under construction": "#ffffff",
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
  const [mode, setMode] = useState<MapMode>("capacity");
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
    ]).then(([projectText, provinceText, energyText, boundaryData, powerLineData, cleanData, drainageData]) => {
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
      <header className="masthead">
        <span>Power / Place</span>
        <span>A data story · November 2026</span>
        <a href="#methods">Methods</a>
      </header>

      <section className="lede">
        <p className="eyebrow">Canada&apos;s AI buildout</p>
        <h1>
          Canada&apos;s AI boom is following the <em>power</em>.
        </h1>
        <p className="dek">
          Most of the data centre capacity planned in Canada sits in one province. Here&apos;s
          where it&apos;s going, and why.
        </p>
        <p className="byline">By Sabrina Bedjera</p>

        <div className="lede-body">
          <p>
            Researchers at York University counted <strong>213 planned data centre sites</strong>{" "}
            across Canada in 2026, adding up to about <strong>22.2 gigawatts</strong>.{" "}
            <mark>{albertaShare.toFixed(0)}% of that planned capacity is in Alberta.</mark>
          </p>
          <ProvinceBar provinces={provinces} />
          <p>
            Those totals include sites that aren&apos;t public. So I built my own list of{" "}
            <strong>{projects.length} named projects</strong> that I could trace to a public
            source, from government listings and grid operators to company releases and city
            planning files. Of the {plannedCount} that are planned or under construction,{" "}
            <strong>{albertaPlannedCount} are in Alberta</strong>.
          </p>
        </div>
      </section>

      <div className="map-intro">
        <p className="step">Explore the map</p>
        <h2>Every named project, and the grid around it</h2>
        <p>
          Click a dot for its source and what its number measures. Switch views to see power lines
          and each province&apos;s electricity mix.
        </p>
      </div>

      <section className="map-experience">
        <SvgMap
          boundaries={enrichedBoundaries}
          powerLines={powerLines}
          cleanStations={cleanStations}
          drainage={drainage}
          projects={filteredProjects}
          mode={mode}
          selectedProject={selectedProject}
          onSelectProject={selectProject}
          onSelectProvince={selectProvince}
          onSelectPowerLine={(line) => {
            setSelectedPowerLine(line);
            setSelectedProject(null);
            setPanelOpen(true);
          }}
        />

        <div className="map-controls">
          <div className="mode-switcher" aria-label="Map view">
            <span>View</span>
            <button
              className={mode === "capacity" ? "active" : ""}
              onClick={() => setMode("capacity")}
            >
              Data centres
            </button>
            <button className={mode === "power" ? "active" : ""} onClick={() => setMode("power")}>
              Power lines
            </button>
            <button className={mode === "energy" ? "active" : ""} onClick={() => setMode("energy")}>
              Energy source
            </button>
            <button className={mode === "clean" ? "active" : ""} onClick={() => setMode("clean")}>
              Clean power
            </button>
            <button className={mode === "water" ? "active" : ""} onClick={() => setMode("water")}>
              Watersheds
            </button>
          </div>
          <div className="filters">
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
            <b>{filteredProjects.length} projects</b>
          </div>
        </div>

        <MapLegend mode={mode} />

        {!panelOpen && (
          <button className="open-panel" onClick={() => setPanelOpen(true)}>
            View {selectedPowerLine ? "power line" : selectedProject ? "project" : "province"}{" "}
            details
          </button>
        )}

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
              <ProvinceDetail province={selectedProvinceData} energy={selectedEnergy} mode={mode} />
            ) : null}
          </aside>
        )}
      </section>

      <section className="findings">
        <article className="chapter">
          <span className="chapter-number">01</span>
          <div className="chapter-body">
            <h3>Alberta&apos;s rule: bring your own power</h3>
            <p>
              Alberta&apos;s grid operator capped new large loads at 1,200 MW in its first phase,
              and both slots are already taken (970 MW and 230 MW). A 2025 law, Bill 8, puts data
              centres that bring their own power first in line.
            </p>
            <p>
              So the biggest Alberta projects plan their own gas plants. Wonder Valley&apos;s first
              phase is a <mark>1.4 GW</mark> off-grid power system. Malachite One plans 1 GW of
              on-site gas, and Beacon&apos;s Heartland hub 920 MW.
            </p>
          </div>
          <aside className="sidenote">
            Sources:{" "}
            <a href="https://www.aeso.ca/grid/connecting-to-the-grid/large-load-projects" target="_blank" rel="noreferrer">AESO</a>
            ,{" "}
            <a href="https://www.bennettjones.com/Insights/Blogs/2026/01/Alberta-Advances-Regulatory-Changes-to-Facilitate-Data-Centre-Development" target="_blank" rel="noreferrer">Bennett Jones</a>
            ,{" "}
            <a href="https://majorprojects.alberta.ca/" target="_blank" rel="noreferrer">Gov of Alberta Major Projects</a>
            . Wonder Valley&apos;s company says the full build-out could reach 7.5 GW.
          </aside>
        </article>

        <article className="chapter">
          <span className="chapter-number">02</span>
          <div className="chapter-body">
            <h3>The cleanest grids are rationing power</h3>
            <p>
              Quebec, British Columbia and Manitoba run on hydro ({pct("Quebec", "Hydro %")}%,{" "}
              {pct("British Columbia", "Hydro %")}% and {pct("Manitoba", "Hydro %")}% of 2025
              generation). They are also the provinces putting limits on data centres.
            </p>
            <p>
              BC opened a competitive process for up to <mark>400 MW</mark> over two years, with a
              cap of 145 MW per project. In Quebec, powering a data centre now needs the
              minister&apos;s authorization. Manitoba has proposed its own rate class for data
              centres.
            </p>
          </div>
          <aside className="sidenote">
            Sources:{" "}
            <a href="https://www150.statcan.gc.ca/t1/tbl1/en/tv.action?pid=2510001501" target="_blank" rel="noreferrer">Statistics Canada</a>
            ,{" "}
            <a href="https://news.gov.bc.ca/releases/2026ECS0005-000095" target="_blank" rel="noreferrer">BC government</a>
            ,{" "}
            <a href="https://www.blg.com/en/insights/2026/07/data-centre-regulation-in-quebec-from-honeyed-promise-to-iron-control" target="_blank" rel="noreferrer">BLG</a>
            ,{" "}
            <a href="https://web2.gov.mb.ca/bills/43-3/pdf/b039.pdf" target="_blank" rel="noreferrer">Manitoba Bill 39</a>
            . Bill 39&apos;s status is unclear.
          </aside>
        </article>

        <article className="chapter">
          <span className="chapter-number">03</span>
          <div className="chapter-body">
            <h3>So the AI buildout leans on gas</h3>
            <p>
              In 2025, <mark>{pct("Alberta", "Fossil fuels %")}%</mark> of Alberta&apos;s
              electricity came from fossil fuels, compared with {pct("Quebec", "Fossil fuels %")}% in
              Quebec. Switch the map to <em>Energy source</em> to see how the planned projects line
              up with each province&apos;s grid.
            </p>
            <p>
              Outside Alberta, the projects to watch are on the east coast: a 420 MW campus at Point
              Tupper, Nova Scotia, and a 390 MW site in Saint John, New Brunswick.
            </p>
          </div>
          <aside className="sidenote">
            Source: Statistics Canada, Table 25-10-0015-01. Project sources are linked on each dot
            in the map.
          </aside>
        </article>
      </section>

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
            their totals don&apos;t match. All project pins are approximate. Six rows I couldn&apos;t
            open at the source are marked as lower confidence.
          </p>
          <p>
            The energy view shows each province&apos;s share of 2025 electricity generated from
            fossil fuels. It does not claim that a data centre uses that exact mix, especially when a
            project reports its own on-site power.
          </p>
          <p>
            Power-line shapes come from NRCan CanVec at 1:250,000 scale. Voltage was added from
            OpenStreetMap where a line matched. A &ldquo;confirmed&rdquo; voltage means an official
            source lists that voltage level in the province, not that every line was checked. A
            project near a line is not proof that it connects to it.
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
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap contributors, voltage data ↗
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

function SvgMap({
  boundaries,
  powerLines,
  cleanStations,
  drainage,
  projects,
  mode,
  selectedProject,
  onSelectProject,
  onSelectProvince,
  onSelectPowerLine,
}: {
  boundaries: any;
  powerLines: any;
  cleanStations: any;
  drainage: any;
  projects: Project[];
  mode: MapMode;
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
          [55, 72],
          [945, 548],
        ],
        boundaries,
      );
    return nextProjection;
  }, [boundaries]);
  const pathGenerator = useMemo(() => geoPath(projection), [projection]);

  const provinceFill = (properties: any) => {
    if (mode === "power" || mode === "clean" || mode === "water") return "#e8e5df";
    if (mode === "energy")
      return properties.fossil_share === null ? "#e8e5df" : fossilColor(properties.fossil_share);
    if (!properties.has_capacity) return "#e8e5df";
    const capacity = Number(properties.planned_mw);
    if (capacity >= 10000) return capacityColors[3];
    if (capacity >= 500) return capacityColors[2];
    if (capacity >= 100) return capacityColors[1];
    return capacityColors[0];
  };

  const voltageColor = (voltage: number | null) => {
    if (!voltage) return voltageColors.unknown;
    if (voltage >= 450) return voltageColors.highest;
    if (voltage >= 200) return voltageColors.high;
    return voltageColors.lower;
  };

  return (
    <svg
      className="map-canvas svg-map"
      viewBox="0 0 1000 600"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label="Interactive map of Canadian data centre projects"
    >
      <rect width="1000" height="600" fill="#e8ebe7" />
      <g className="svg-provinces">
        {boundaries?.features?.map((feature: any) => (
          <path
            key={feature.properties.name}
            d={pathGenerator(feature) ?? undefined}
            fill={provinceFill(feature.properties)}
            onClick={() => onSelectProvince(feature.properties.name)}
          />
        ))}
      </g>
      <g className="svg-province-labels" aria-hidden="true">
        {boundaries?.features
          ?.filter((feature: any) =>
            ["BC", "AB", "SK", "MB", "ON", "QC"].includes(provinceCodes[feature.properties.name]),
          )
          .map((feature: any) => {
            const [x, y] = pathGenerator.centroid(feature);
            return (
              <text key={feature.properties.name} x={x} y={y}>
                {provinceCodes[feature.properties.name]}
              </text>
            );
          })}
      </g>
      {mode === "water" && (
        <g className="svg-drainage">
          {drainage?.features?.map((feature: any, index: number) => (
            <path
              key={feature.properties.name}
              d={pathGenerator(feature) ?? undefined}
              fill={drainageColors[index % drainageColors.length]}
            >
              <title>{feature.properties.name}</title>
            </path>
          ))}
          {drainage?.features?.map((feature: any) => {
            const [x, y] = pathGenerator.centroid(feature);
            return (
              <text key={feature.properties.name} x={x} y={y}>
                {feature.properties.name}
              </text>
            );
          })}
        </g>
      )}
      {mode === "clean" && (
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
                  r={1.4 + Math.sqrt(p.mw ?? 0) / 14}
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
      {mode === "power" && (
        <g className="svg-power-lines">
          {powerLines?.features?.map((feature: any) => {
            const properties = feature.properties as PowerLine;
            const unverified =
              properties.voltage_status === "Voltage from OpenStreetMap, not verified";
            return (
              <path
                key={feature.properties.canvec_id}
                d={pathGenerator(feature) ?? undefined}
                stroke={voltageColor(properties.voltage_kv)}
                strokeDasharray={unverified ? "3 3" : undefined}
                onClick={(event) => {
                  event.stopPropagation();
                  onSelectPowerLine(properties);
                }}
              />
            );
          })}
        </g>
      )}
      <g className="svg-projects">
        {projects.map((project) => {
          const point = projection([Number(project.lon), Number(project.lat)]) ?? [0, 0];
          const radius = project.reported_mw
            ? 3.2 + Math.min(Number(project.reported_mw) / 230, 5.8)
            : 3.2;
          const lowerConfidence = project.check_status === "From tracker, not yet opened by me";
          return (
            <g
              key={project.id}
              onClick={(event) => {
                event.stopPropagation();
                onSelectProject(project);
              }}
            >
              {lowerConfidence && (
                <circle cx={point[0]} cy={point[1]} r={radius + 2.5} className="confidence-ring" />
              )}
              <circle
                cx={point[0]}
                cy={point[1]}
                r={radius}
                fill={mode === "energy" ? "#ffffff" : statusColors[project.status]}
                style={{ stroke: mode === "energy" ? "#172d49" : statusStroke[project.status] }}
                className={selectedProject?.id === project.id ? "selected-point" : ""}
              />
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function MapLegend({ mode }: { mode: MapMode }) {
  return (
    <div className="map-legend">
      {mode === "capacity" ? (
        <>
          <p>Provincial planned MW · York paper estimate</p>
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
          <p className="project-legend-title">Projects</p>
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
          <small>All project pins are approximate.</small>
        </>
      ) : mode === "clean" ? (
        <>
          <p>Clean power stations (NRCan) · dot size = MW</p>
          <div className="energy-legend">
            {Object.entries(cleanColors).map(([label, color]) => (
              <span key={label}>
                <i style={{ background: color, borderRadius: "50%" }} />
                {label}
              </span>
            ))}
          </div>
          <small>
            1,078 operating stations from NRCan&apos;s Clean Energy Resources and Projects map.
            Hover a dot for its name. Pink dots = data centre projects.
          </small>
        </>
      ) : mode === "water" ? (
        <>
          <p>Major drainage areas (watersheds)</p>
          <small>
            Natural Resources Canada, Atlas of Canada. Shows which river system each region drains
            into. A first step toward a water layer: it does not show water use or stress.
          </small>
        </>
      ) : mode === "energy" ? (
        <>
          <p>Share of 2025 electricity from fossil fuels</p>
          <div className="capacity-scale">
            {fossilScale.map((color, index) => (
              <span key={color}>
                <i style={{ background: color }} />
                {fossilBands[index]}
              </span>
            ))}
          </div>
          <small>Teal = cleaner grid, pink = more fossil fuels. White pins = data centre projects.</small>
        </>
      ) : (
        <>
          <p>Approximate voltage band</p>
          <div className="power-legend">
            {[
              [voltageColors.highest, "450 kV+"],
              [voltageColors.high, "200–449 kV"],
              [voltageColors.lower, "Under 200 kV"],
              [voltageColors.unknown, "Unknown"],
            ].map(([color, label]) => (
              <span key={label}>
                <i style={{ background: color }} />
                {label}
              </span>
            ))}
            <span className="dashed-key">
              <i />
              Dashed: not verified
            </span>
          </div>
          <small>
            Lines: NRCan CanVec. Voltage: © OpenStreetMap contributors. Proximity does not prove a
            grid connection.
          </small>
        </>
      )}
    </div>
  );
}

function PowerLineDetail({ line }: { line: PowerLine }) {
  const isConfirmed =
    line.voltage_status === "Voltage from OpenStreetMap, level confirmed by grid operator";
  const isUnverified = line.voltage_status === "Voltage from OpenStreetMap, not verified";
  return (
    <>
      <p className="drawer-kicker">Power infrastructure</p>
      <h2>{line.voltage_kv ? `${line.voltage_kv} kV line` : "Voltage unknown"}</h2>
      <p className="operator">{line.province}</p>
      <p
        className={`line-status ${isConfirmed ? "confirmed" : isUnverified ? "unverified" : "unknown"}`}
      >
        {isConfirmed
          ? "Voltage level confirmed in this province"
          : isUnverified
            ? "OpenStreetMap voltage · not verified"
            : "NRCan line · no voltage match"}
      </p>
      <dl>
        <div>
          <dt>Mapped length</dt>
          <dd>{Number(line.length_km).toLocaleString("en-CA")} km</dd>
        </div>
        <div>
          <dt>Line geometry</dt>
          <dd>Natural Resources Canada, CanVec 1:250K</dd>
        </div>
        {line.osm_operator && (
          <div>
            <dt>OSM operator</dt>
            <dd>{line.osm_operator}</dd>
          </div>
        )}
        {line.osm_line_name && (
          <div>
            <dt>OSM line name</dt>
            <dd>{line.osm_line_name}</dd>
          </div>
        )}
      </dl>
      <p className="detail-note">
        The voltage was spatially matched from OpenStreetMap. A confirmed status means that an
        official source lists this voltage level in the province; it does not verify this individual
        line.
      </p>
      {line.check_source && (
        <a className="primary-link" href={line.check_source} target="_blank" rel="noreferrer">
          View provincial voltage source ↗
        </a>
      )}
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
}: {
  province: Province;
  energy?: EnergyMix;
  mode: MapMode;
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
