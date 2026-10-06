"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// MapLibre's own stylesheet. Without it the zoom controls and popups render unstyled.
import "maplibre-gl/dist/maplibre-gl.css";

import { applyMapTheme, themeStyle, type StyleDocument } from "../src/lib/map/theme.ts";

/**
 * The interface.
 *
 * It renders verdicts and sentences. It never sees a score, a probability or a confidence, because
 * `/api/plan` does not send any — the classification happened once, in `plan.ts`, and a component
 * re-deriving it from a raw number would be a second copy of every threshold.
 *
 * ── The hierarchy, which is the point of the layout ─────────────────────────────────────────
 *
 * An earlier version opened with two panels explaining how the answer was produced, then listed
 * eight equally-weighted cards. That is the shape of an explanation, not of an answer, and a reader
 * had to assemble the recommendation themselves.
 *
 * So: **the answer, then the context, then the alternatives, then the method.** One hero card for the
 * stop that cleared every gate, a single line of context above it, the rest compressed to one row
 * each, and the code-versus-model split moved to a collapsed panel at the bottom where someone
 * curious can find it. The map matches — one large pin, everything else small and quiet.
 *
 * ── Two endpoints, deliberately ─────────────────────────────────────────────────────────────
 *
 * `/api/plan` asks the model. `/api/route` only draws. Clicking a charger re-draws the line and costs
 * nothing, because the judgement has not changed — only what the reader wants to look at.
 */

type Verdict = "recommended" | "acceptable" | "unknown" | "warned" | "ruled_out";

interface Stop {
  readonly id: number;
  readonly name: string;
  readonly town: string | null;
  readonly operator: string | null;
  readonly position: { lat: number; lon: number };
  readonly verdict: Verdict;
  readonly reason: string;
  readonly evidence: string | null;
  readonly costBand: string | null;
  readonly detourKm: number;
  readonly maxPowerKw: number | null;
  readonly minutesToReach: number | null;
  readonly membershipRequired: boolean;
  readonly freshness: string;
  readonly freshnessLabel: string;
  readonly driverReports: number;
  readonly hero: boolean;
}

/**
 * Is this old enough that a reader should be told plainly?
 *
 * The verification age was previously buried in the grey provenance line next to the operator name —
 * which is where you put things nobody needs to read. "Nobody has confirmed this charger exists in
 * five years" is not that. It is the most useful caveat there is on a recommendation, so it gets its
 * own line in the palette's warning colour.
 */
function isStale(freshness: string): boolean {
  return freshness === "stale" || freshness === "abandoned" || freshness === "unknown";
}

interface PlanResponse {
  readonly stops: readonly Stop[];
  readonly priority: string | null;
  readonly arriving?: string;
  readonly arriveAt?: string;
  readonly origin: { lat: number; lon: number };
  readonly destination: { lat: number; lon: number };
  readonly originName: string;
  readonly destinationName: string;
  readonly rangeKm: number;
  readonly considered: number;
  readonly eliminated: number;
  readonly live: boolean;
  readonly fallbackReason: string | null;
  readonly attribution: string;
  readonly questionsAsked?: number;
  readonly inputTokens?: number;
  readonly latencyMs?: number;
  readonly billedUsd?: number | null;
  readonly note?: string;
  readonly error?: string;
}

interface RouteResult {
  readonly coordinates: readonly (readonly [number, number])[];
  readonly drivingKm: number;
  readonly drivingMinutes: number;
  readonly real: boolean;
}

interface PlaceOption {
  readonly id: string;
  readonly name: string;
  readonly state: string;
}

const VERDICT_LABEL: Record<Verdict, string> = {
  recommended: "best match",
  acceptable: "looks fine",
  unknown: "no info",
  warned: "check first",
  ruled_out: "not this one",
};

const PIN: Record<Verdict, string> = {
  recommended: "#00dd82",
  acceptable: "#40979d",
  unknown: "#74869b",
  warned: "#f1918b",
  ruled_out: "#ee5f53",
};

/**
 * What each priority is, in three registers: a banner label, a plain-English phrase, and an icon.
 *
 * The bare enum value — `amenities`, `reliability` — is the code's word for it and reads as jargon in
 * a sentence about what a driver wants. The banner label exists because a reader looking at a result
 * should be able to tell what question produced it without reading a paragraph first.
 */
interface PriorityMeta {
  readonly label: string;
  readonly phrase: string;
  readonly icon: string;
}

const PRIORITY_META: Record<string, PriorityMeta> = {
  safety: { label: "Safety request", phrase: "somewhere that feels safe", icon: "🛡️" },
  cost: { label: "Cost request", phrase: "the cheapest option", icon: "💰" },
  speed: { label: "Speed request", phrase: "the fastest charge", icon: "⚡" },
  amenities: { label: "Amenities request", phrase: "somewhere to wait", icon: "☕" },
  reliability: { label: "Reliability request", phrase: "one that will definitely work", icon: "🔧" },
};

const NO_PRIORITY: PriorityMeta = {
  label: "No stated preference",
  phrase: "nothing in particular",
  icon: "❓",
};

/** One size for every pin: start, end and the answer are equally part of the journey. */
const PIN_SIZE = 42;

const STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

const EXAMPLE =
  "I'm at 12% and I need to get to Geelong, but I've got my kid in the car and I'd rather not stop somewhere sketchy.";

const BUSY_LINES = ["Reading the small print…", "Asking around…", "Checking who's actually open…"];

/**
 * A Google-Maps-style teardrop, as an inline SVG.
 *
 * ── Why this is two nested elements ─────────────────────────────────────────────────────────
 *
 * MapLibre positions an HTML marker by writing `transform: translate(...)` onto **the element you
 * hand it**, and rewrites that on every animation frame while the map moves. So the outer element
 * must carry no `transform` and, above all, no `transition` on one — a `transition: transform` there
 * animates each repositioning and the entire set of pins visibly drags behind the map as you pan.
 *
 * Anything of ours that wants to animate goes on the inner element, which MapLibre never touches.
 */
function teardrop(fill: string, glyph: string, size: number, dim: boolean): HTMLElement {
  // Outer: MapLibre's. No transform, no transition, ever.
  const el = document.createElement("div");
  el.className = dim ? "pin pin-dim" : "pin";
  el.style.cssText = `width:${size}px;height:${size * 1.3}px;cursor:pointer`;

  // Inner: ours to animate.
  const art = document.createElement("div");
  art.className = "pin-art";
  art.innerHTML = `
    <svg viewBox="0 0 24 32" width="${size}" height="${size * 1.3}" aria-hidden="true">
      <path d="M12 0C5.4 0 0 5.4 0 12c0 8.4 12 20 12 20s12-11.6 12-20C24 5.4 18.6 0 12 0z"
            fill="${fill}" stroke="rgba(23,51,83,.5)" stroke-width="1.2"/>
      <circle cx="12" cy="12" r="6.6" fill="#fffdfa"/>
      <text x="12" y="16" text-anchor="middle" font-size="${glyph.length > 1 ? 7 : 9}" font-family="system-ui">${glyph}</text>
    </svg>`;
  el.appendChild(art);
  return el;
}

/** A small dot, for the chargers that are not the answer. Deliberately not a pin. */
function dot(fill: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "pin pin-dim";
  el.style.cssText = "width:13px;height:13px;cursor:pointer";
  const art = document.createElement("div");
  art.className = "pin-art";
  art.innerHTML = `<div style="width:13px;height:13px;border-radius:50%;background:${fill};border:2px solid #fffdfa;box-shadow:0 1px 3px rgba(23,51,83,.4)"></div>`;
  el.appendChild(art);
  return el;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

export default function Page() {
  const [said, setSaid] = useState(EXAMPLE);
  const [battery, setBattery] = useState(12);
  const [arriveAt, setArriveAt] = useState("21:00");
  const [places, setPlaces] = useState<readonly PlaceOption[]>([]);
  const [originId, setOriginId] = useState("melbourne");
  const [destinationId, setDestinationId] = useState("geelong");
  const [busy, setBusy] = useState(false);
  const [busyLine, setBusyLine] = useState(BUSY_LINES[0]);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [viaId, setViaId] = useState<number | null>(null);

  const mapNode = useRef<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MapLibre's types are import-only.
  const mapRef = useRef<any>(null);
  const ready = useRef(false);
  const markers = useRef<{ remove: () => void }[]>([]);

  useEffect(() => {
    void fetch("/api/plan")
      .then((r) => r.json() as Promise<{ places: PlaceOption[] }>)
      .then((body) => setPlaces(body.places))
      .catch(() => setPlaces([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const maplibre = await import("maplibre-gl");
      if (cancelled || mapNode.current === null || mapRef.current !== null) return;

      // Fetch the style and recolour it BEFORE handing it over, so the first frame MapLibre paints is
      // already the palette. Constructing from the URL and repainting on load left the published
      // grey-blue on screen for a frame or two, which read as a flicker on every refresh.
      let style: StyleDocument | string = STYLE_URL;
      try {
        const response = await fetch(STYLE_URL);
        if (response.ok) style = themeStyle((await response.json()) as StyleDocument).style;
      } catch {
        // Falls back to the URL, and `applyMapTheme` on load still themes it — with the flicker.
      }
      if (cancelled) return;

      const map = new maplibre.Map({
        container: mapNode.current,
        style: style as never,
        center: [144.75, -37.95],
        zoom: 8.2,
      });
      map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");
      map.on("load", () => {
        // Only needed when the style fetch above failed and MapLibre was given the URL. Harmless
        // otherwise: it writes the same colours the document already carries.
        if (typeof style === "string") applyMapTheme(map);
        map.addSource("route", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "route-casing",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#173353", "line-width": 10, "line-opacity": 0.16 },
        });
        map.addLayer({
          id: "route-line",
          type: "line",
          source: "route",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#ee5f53", "line-width": 4 },
        });
        ready.current = true;
      });
      mapRef.current = map;
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const drawRoute = useCallback(
    async (via: { lat: number; lon: number } | null) => {
      try {
        const response = await fetch("/api/route", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ originId, destinationId, via }),
        });
        if (!response.ok) return;
        setRoute((await response.json()) as RouteResult);
      } catch {
        // A missing line is cosmetic. Nothing else depends on it.
      }
    },
    [originId, destinationId],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (map === null || !ready.current) return;
    const source = map.getSource("route");
    if (source === undefined) return;
    source.setData({
      type: "FeatureCollection",
      features:
        route === null
          ? []
          : [
              {
                type: "Feature",
                properties: {},
                geometry: { type: "LineString", coordinates: route.coordinates },
              },
            ],
    });
  }, [route]);

  useEffect(() => {
    const map = mapRef.current;
    if (map === null || plan === null) return;

    void (async () => {
      const maplibre = await import("maplibre-gl");
      for (const marker of markers.current) marker.remove();
      markers.current = [];

      const add = (
        point: { lat: number; lon: number },
        el: HTMLElement,
        html: string,
        anchor: "bottom" | "center",
      ): void => {
        markers.current.push(
          new maplibre.Marker({ element: el, anchor })
            .setLngLat([point.lon, point.lat])
            // A teardrop is anchored at its tip and stands size * 1.3 tall, so its popup has to clear the
            // whole pin; anything less and the popup sits on the very pin it belongs to.
            .setPopup(new maplibre.Popup({ offset: anchor === "bottom" ? Math.round(PIN_SIZE * 1.3) + 4 : 12, closeButton: false }).setHTML(html))
            .addTo(map),
        );
      };

      // Everything that is not the answer: a small quiet dot. The hero is the only pin, because a map
      // with eight equal pins makes the reader do the ranking the app just did for them.
      for (const stop of plan.stops) {
        // The single pin marks what is SELECTED, not what is recommended. Those start out the same
        // thing, and once the reader picks another charger the pin has to move with them — otherwise
        // the map keeps shouting about a charger that is no longer on the drawn route.
        const selected = stop.id === viaId;
        // One size for every pin, deliberately. The hero was 52px against the A/B pins' 40px, which
        // made the answer shout over the journey it belongs to. It already stands out by colour and by
        // being the only charger drawn as a pin at all — the rest are dots — so the extra size was
        // doing nothing but unbalancing the map.
        const el = selected
          ? teardrop(PIN[stop.verdict], stop.hero ? "⚡" : "★", PIN_SIZE, false)
          : dot(PIN[stop.verdict]);
        el.title = `${stop.name} — ${VERDICT_LABEL[stop.verdict]}`;
        el.addEventListener("click", () => {
          setViaId(stop.id);
          void drawRoute(stop.position);
        });
        add(
          stop.position,
          el,
          `<strong>${escapeHtml(stop.name)}</strong><br/>${escapeHtml(VERDICT_LABEL[stop.verdict])}` +
            `<br/><small>${escapeHtml(stop.reason)}</small>` +
            `<br/><small style="color:#40979d;font-weight:700">${selected ? "Routing via here" : "Click to route via here"}</small>`,
          selected ? "bottom" : "center",
        );
      }

      add(plan.origin, teardrop("#173353", "A", PIN_SIZE, false), `<strong>Start</strong><br/>${escapeHtml(plan.originName)}`, "bottom");
      add(plan.destination, teardrop("#ee5f53", "B", PIN_SIZE, false), `<strong>End</strong><br/>${escapeHtml(plan.destinationName)}`, "bottom");

    })();
  }, [plan, viaId, drawRoute]);

  /**
   * Frame the journey — on a new plan only, never on a selection change.
   *
   * This used to live in the marker effect, which depends on `viaId`, so every click re-ran
   * `fitBounds` and the map jumped and re-zoomed under the reader's cursor. Framing is a response to
   * a new set of places, not to changing your mind about one of them.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || plan === null) return;
    const lons = [plan.origin.lon, plan.destination.lon, ...plan.stops.map((s) => s.position.lon)];
    const lats = [plan.origin.lat, plan.destination.lat, ...plan.stops.map((s) => s.position.lat)];
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: { top: 90, bottom: 60, left: 60, right: 60 }, maxZoom: 12, duration: 700 },
    );
  }, [plan]);

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setBusy(true);
      setBusyLine(BUSY_LINES[Math.floor(Math.random() * BUSY_LINES.length)]);
      setError(null);
      setViaId(null);
      try {
        const response = await fetch("/api/plan", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ said, batteryPercent: battery, arriveAt, originId, destinationId }),
        });
        const body = (await response.json()) as PlanResponse;
        if (!response.ok) {
          setError(body.error ?? `Request failed (${response.status}).`);
          setPlan(null);
        } else {
          setPlan(body);
          // Select the answer straight away and route through it. The recommendation is the point of
          // the search, so making the reader click it before the route appears is a step for nothing.
          const answer = body.stops.find((stop) => stop.hero) ?? null;
          setViaId(answer?.id ?? null);
          void drawRoute(answer === null ? null : answer.position);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Something went wrong.");
      } finally {
        setBusy(false);
      }
    },
    [said, battery, arriveAt, originId, destinationId, drawRoute],
  );

  /**
   * Select one charger, replacing whatever was selected before.
   *
   * Deliberately NOT a toggle. Clicking an already-selected stop used to clear it, which meant the
   * route silently reverted to the direct line and the reader was left wondering what they had
   * undone. There is always exactly one selection, and the only way to have none is a fresh search
   * that found nothing to recommend. The ✕ on the route bar is the explicit way back.
   */
  const selectStop = useCallback(
    (stop: Stop) => {
      setViaId(stop.id);
      void drawRoute(stop.position);
    },
    [drawRoute],
  );

  const viaStop = plan?.stops.find((s) => s.id === viaId) ?? null;
  const meta =
    plan?.priority === null || plan?.priority === undefined
      ? NO_PRIORITY
      : PRIORITY_META[plan.priority] ?? NO_PRIORITY;
  const hero = plan?.stops.find((s) => s.hero) ?? null;
  const rest = plan?.stops.filter((s) => !s.hero) ?? [];

  return (
    <div className="wrap">
      <div className="side">
        <div className="brand">
          <div className="brand-mark">&#128268;</div>
          <h1>Find me a stop</h1>
        </div>

        <form onSubmit={submit}>
          <div>
            <label htmlFor="said">What do you need?</label>
            <textarea id="said" rows={3} value={said} maxLength={500} onChange={(e) => setSaid(e.target.value)} />
          </div>

          <div className="row2">
            <div>
              <label htmlFor="from">From</label>
              <select id="from" value={originId} onChange={(e) => setOriginId(e.target.value)}>
                {places.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="arrow" aria-hidden="true">
              &rarr;
            </div>
            <div>
              <label htmlFor="to">To</label>
              <select id="to" value={destinationId} onChange={(e) => setDestinationId(e.target.value)}>
                {places.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="row">
            <div>
              <label htmlFor="battery">Battery %</label>
              <input id="battery" type="number" min={1} max={100} value={battery} onChange={(e) => setBattery(Number(e.target.value))} />
            </div>
            <div>
              <label htmlFor="arriveAt">Arriving at</label>
              <input
                id="arriveAt"
                type="time"
                value={arriveAt}
                onChange={(e) => setArriveAt(e.target.value)}
              />
            </div>
            <button type="submit" disabled={busy}>
              {busy ? "…" : "Find a stop"}
            </button>
          </div>
        </form>

        {busy && <p className="empty">{busyLine}</p>}
        {error !== null && <p className="err">{error}</p>}

        {plan !== null && !busy && (
          <>
            {/* One line of context, above the answer. Everything a reader needs to trust the result
                and nothing about how it was produced. */}
            <div className={`request r-${plan.priority ?? "none"}`}>
              <p className="rlabel">
                <span aria-hidden="true">{meta.icon}</span> {meta.label}
              </p>
              <p className="rbody">
                Read from your sentence as wanting <b>{meta.phrase}</b>. Looked at{" "}
                <b>{plan.considered}</b> chargers and kept the <b>{plan.stops.length}</b> you can reach
                on <b>{plan.rangeKm}km</b>.
              </p>
            </div>

            {plan.note !== undefined && <p className="empty">{plan.note}</p>}

            {hero !== null && (
              <article
                className={`hero ${hero.verdict}${hero.id === viaId ? " active" : ""}`}
                onClick={() => selectStop(hero)}
              >
                <div className="herohead">
                  <span className="badge">
                    {hero.verdict === "recommended" ? `best for ${plan.priority ?? "you"}` : "best available"}
                  </span>
                  {/* Always Jev. Code filters and phrases; it never chooses. */}
                  <span className="chose model">picked by Jev</span>
                </div>
                <h2>{hero.name}</h2>
                <p className="why">{hero.reason}</p>
                {hero.evidence !== null && <p className="quote">&ldquo;{hero.evidence}&rdquo;</p>}
                <p className="facts">
                  <span className="chip kw">{hero.maxPowerKw === null ? "? kW" : `${hero.maxPowerKw} kW`}</span>
                  <span className="chip">{hero.detourKm} km off route</span>
                  {hero.minutesToReach !== null && <span className="chip">~{hero.minutesToReach} min charging</span>}
                  {hero.costBand !== null && hero.costBand !== "not_stated" && (
                    <span className={`chip${hero.costBand === "free" ? " free" : ""}`}>{hero.costBand}</span>
                  )}
                </p>
                {isStale(hero.freshness) && (
                  <p className="caveat">
                    &#9888; {hero.freshnessLabel.charAt(0).toUpperCase() + hero.freshnessLabel.slice(1)}
                    {hero.driverReports === 0
                      ? ", and no driver has reported back on it."
                      : `, though ${hero.driverReports} driver${hero.driverReports === 1 ? " has" : "s have"} reported back.`}
                  </p>
                )}
                <p className="who">
                  {hero.operator ?? "operator unknown"}
                  {hero.membershipRequired && " · needs the network's app"}
                  {!isStale(hero.freshness) && ` · ${hero.freshnessLabel}`}
                </p>
                <p className="tap">
                  {hero.id === viaId ? "✓ the route goes via here" : "→ tap to route via here"}
                </p>
              </article>
            )}

            {hero === null && (
              <p className="empty">
                Nothing here is a confident answer. Everything in reach was either ruled out or has
                nothing written about it.
              </p>
            )}

            {rest.length > 0 && (
              <>
                <h3 className="section">Also in reach</h3>
                <ul className="rest">
                  {rest.map((stop) => (
                    <li
                      key={stop.id}
                      className={`${stop.verdict}${stop.id === viaId ? " active" : ""}`}
                      onClick={() => selectStop(stop)}
                    >
                      <span className="tick" />
                      <div>
                        <p className="name">
                          {stop.name}
                          <span className="tag">{VERDICT_LABEL[stop.verdict]}</span>
                        </p>
                        <p className="mini">
                          {stop.reason}
                          {isStale(stop.freshness) && (
                            <span className="stalebit"> &#9888; not checked in years</span>
                          )}
                        </p>
                      </div>
                      <span className="kwx">{stop.maxPowerKw === null ? "?" : stop.maxPowerKw}kW</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {/* The method, for whoever wants it. Collapsed, because it is the answer to a different
                question from the one the page is for. */}
            <details className="how">
              <summary>How this worked</summary>
              <div className="howgrid">
                <div className="half code">
                  <h4>Code did</h4>
                  <p>
                    Filtered <b>{plan.considered}</b> chargers to <b>{plan.stops.length}</b> on
                    distance, power and charging time. Every number you see. No model involved.
                  </p>
                </div>
                <div className="half jev">
                  <h4>Jev did</h4>
                  <p>
                    Answered <b>{plan.questionsAsked ?? 0}</b> questions in one request, reading only
                    what people wrote about each place. It never saw a distance or a kilowatt figure.
                  </p>
                </div>
              </div>
              <p className="meta">
                {plan.latencyMs !== undefined && (
                  <>
                    <b>{plan.latencyMs}ms</b> &middot; {plan.inputTokens} input tokens &middot;{" "}
                    <b>${(plan.billedUsd ?? 0).toFixed(6)}</b> per search
                    <br />
                  </>
                )}
                Arriving at <b>{plan.arriveAt ?? "—"}</b>, which is {plan.arriving ?? "—"}.
                Distances above are <b>straight-line</b>; the
                drawn route is real roads, and the gap is the size of the approximation.
              </p>
              <p className="attrib">
                {plan.attribution}
                <br />
                Map &copy; OpenFreeMap, OpenMapTiles, data from OpenStreetMap. Routing by OSRM.
                {!plan.live && (
                  <>
                    <br />
                    <b>Using recorded data.</b> {plan.fallbackReason}
                  </>
                )}
              </p>
            </details>
          </>
        )}
      </div>

      <div className="mapwrap">
        {plan !== null && (
          <div className="routebar">
            <span className="dot" />
            <span>
              {plan.originName} &rarr; {viaStop !== null ? `${viaStop.name} → ` : ""}
              {plan.destinationName}
              {route !== null && route.real && ` · ${route.drivingKm} km · ${route.drivingMinutes} min`}
            </span>
            {viaStop !== null && (
              <button
                className="clear"
                onClick={() => {
                  setViaId(null);
                  void drawRoute(null);
                }}
                aria-label="Clear the waypoint"
              >
                &#10005;
              </button>
            )}
          </div>
        )}
        <div id="map" ref={mapNode} />
      </div>
    </div>
  );
}
