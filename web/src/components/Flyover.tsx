import { useEffect, useRef, useState, useCallback } from 'react';
import * as maplibregl from 'maplibre-gl';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { distance as fmtDistance, duration as fmtDuration, pace, number } from '../lib/format';
import type { AppConfig } from '../lib/api';

// 3D flyover.
//
// Strava's version renders a video server-side, behind a subscription, and makes
// you wait for a push notification. This does it live in the browser: MapLibre
// draws real terrain from a DEM tile source and the camera flies the route while a
// HUD reads out the data at the current position.
//
// The upshot is that it is interactive rather than a video — you can pause, scrub,
// grab the map and look around mid-flight — and it costs nothing to generate.
//
// Elevation comes from free terrarium-encoded DEM tiles by default (configurable,
// so a self-hoster can serve their own Mapterhorn PMTiles and depend on no one).

const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

// Route colours, chosen against the basemap rather than against a blank page.
//
// A chart sits on one flat surface; a route sits on OSM's entire palette — pastel
// greens, greys, buildings, water, and their pink/orange road classes. Grey was the
// original choice and it was indefensible: measured against OSM's road grey it scored
// ΔE 0.0, i.e. the same colour, and its chroma of 0.005 is below the floor where a hue
// stops reading as a hue at all. A grey line on a road map looks like a road.
//
// Magenta is the gap in OSM's cartography. Validated (OKLab ΔE ×100): ≥ 25 against
// every OSM colour including their motorway pink, 29.2 against the blue used for the
// travelled portion, 16.0 under deuteranopia — all above the thresholds. The white
// casing underneath carries it over dark features like railways and water.
const ROUTE_COLOR = '#c2007a';
const TRAVELLED_COLOR = '#2a78d6';

export interface FlyoverProps {
  coordinates: [number, number][];   // [lng, lat]
  elevations?: (number | null)[];
  times?: (number | null)[];         // seconds from start
  distances?: (number | null)[];     // cumulative metres
  heartRates?: (number | null)[];
  powers?: (number | null)[];
  speeds?: (number | null)[];
  config: AppConfig;
  sport: string;
  height?: number;
  externalIndex?: number | null;     // hover index from the linked charts
  /**
   * Where the trim handles currently sit, as sample indices. Drawn on the route so you
   * can see what you are about to cut rather than guessing from two clock readings.
   */
  trim?: { from: number; to: number } | null;
  /** Fires as the flight advances, so the charts below can follow along. */
  onIndex?: (index: number) => void;
}

/**
 * A key-less raster basemap.
 *
 * Deliberately not a vector style behind an API key: this has to work on a home
 * server with no account anywhere. A self-hoster who wants vector tiles sets
 * MAP_STYLE_URL and this is bypassed entirely.
 */
function buildStyle(config: AppConfig): StyleSpecification {
  return {
    version: 8,
    // Terrain needs a glyph source present even when no labels are drawn.
    glyphs: 'https://fonts.openmaptiles.org/{fontstack}/{range}.pbf',
    sources: {
      osm: {
        type: 'raster',
        tiles: [
          'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
          'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
        ],
        tileSize: 256,
        maxzoom: 19,
        attribution: OSM_ATTRIBUTION,
      },
      terrain: {
        type: 'raster-dem',
        tiles: [config.map.terrainTileUrl],
        // Terrarium tiles are 256px; the encoding must match the tile source or
        // the terrain comes out as noise.
        encoding: (config.map.terrainEncoding as 'terrarium' | 'mapbox') || 'terrarium',
        tileSize: 256,
        maxzoom: config.map.terrainMaxZoom || 13,
        attribution: '<a href="https://registry.opendata.aws/terrain-tiles/">Terrain tiles</a>',
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#e8e5dd' } },
      { id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-opacity': 1 } },
      // Shaded relief from the same elevation tiles the 3D view uses. Costs no extra
      // tile source and turns a flat street map into something that reads as hills.
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'terrain',
        paint: {
          'hillshade-exaggeration': 0.45,
          'hillshade-shadow-color': '#5a5348',
          'hillshade-highlight-color': '#ffffff',
          'hillshade-accent-color': '#8a8272',
        },
      },
    ],
  };
}

/**
 * Which parts of the route a trim would discard, and where the two cuts land.
 *
 * Exported because it is the half of the trim preview that can be wrong — off-by-one at
 * the ends, a piece with a single point, a trim covering everything — and the half that
 * does not need a GPU to check.
 */
export function trimPreview(
  coordinates: [number, number][],
  trim: { from: number; to: number } | null | undefined,
): { discarded: [number, number][][]; cuts: [number, number][] } {
  const n = coordinates.length;
  const none = { discarded: [], cuts: [] };
  if (!trim || n < 2) return none;

  const clamp = (v: number) => Math.max(0, Math.min(n - 1, Math.round(v)));
  const from = clamp(trim.from);
  const to = clamp(trim.to);

  // Nothing trimmed, or the handles crossed: nothing to strike through.
  if (to <= from) return none;
  if (from <= 0 && to >= n - 1) return none;

  const discarded = [coordinates.slice(0, from + 1), coordinates.slice(to)]
    // A one-point line is not drawable and not a piece of route.
    .filter((piece) => piece.length >= 2);

  return { discarded, cuts: [coordinates[from], coordinates[to]] };
}

export function Flyover(props: FlyoverProps) {
  const { coordinates, config, height = 480 } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const animationRef = useRef<number | null>(null);
  const progressRef = useRef(0);
  // The camera bearing is eased rather than set. It used to be computed from integer
  // sample indices, so at 0.1x the index held still for many frames and then jumped —
  // the position glided but the view snapped, which read as stepping.
  const bearingRef = useRef<number | null>(null);
  // The tilt the current mode wants, and where the camera actually is on the way there.
  // Both are refs because the animation loop reads them every frame: an easeTo() started
  // by the mode switch is cancelled by the very next jumpTo(), so the loop has to carry
  // the tilt itself rather than leaving it to a transition.
  const pitchTargetRef = useRef(0);
  const pitchRef = useRef(0);

  const [ready, setReady] = useState(false);

  // ─── the only state this view has ─────────────────────────────────────────
  //
  //   overview   flat map, whole route fitted, solid line, nothing moving
  //   flying     tilted over terrain, camera following, route as circles
  //   paused     same view as flying, but stopped where you left it
  //
  //   overview --Play--> flying --Pause--> paused --Play--> flying
  //                      anything --Overview--> overview
  //
  // Scrubbing the slider or hovering a chart moves the position; it never changes the
  // mode. The point of having one variable rather than two booleans is that the camera
  // then has exactly one writer per state: `fitBounds` on entering overview, and the
  // render function while flying or paused. Nothing else touches it. Four different
  // things writing to the camera is what made the tilt cancel itself.
  const [mode, setModeState] = useState<'overview' | 'flying' | 'paused'>('overview');
  // Mirrors `mode` synchronously, so an animation frame already in flight can see that
  // it has been superseded before it writes to the map.
  const modeRef = useRef<'overview' | 'flying' | 'paused'>('overview');
  // Starts at half speed. 1× crosses the whole route in forty seconds, which on an
  // 80 km ride is far too fast to see anything.
  const [speed, setSpeed] = useState(0.5);
  // Why 3D draws the route as circles: MapLibre drapes line layers onto the terrain mesh
  // and the route line does not survive the trip — the basemap and marker draw, the route
  // does not. Circles are placed in 3D space instead. Flat keeps the solid line, which
  // reads better. (MapLibre 6.0.0 draws no GeoJSON line layers at all, which is why
  // package.json pins ^5.)
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const pointCount = coordinates.length;

  // ─── set up the map once ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current || pointCount < 2) return;

    let map: MapLibreMap;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: config.map.styleUrl || buildStyle(config),
        center: coordinates[0],
        zoom: 13,
        pitch: 0,
        bearing: 0,
        attributionControl: { compact: true },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not initialise the map');
      return;
    }

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');

    map.on('error', (event) => {
      // Tile 404s are normal at the edges of DEM coverage and must not kill the view.
      const message = (event as any)?.error?.message || '';
      if (/tile|404|Failed to fetch/i.test(message)) return;
      if (message) setError(message);
    });

    // `style.load` rather than `load`: the latter waits for every source in view to have
    // rendered, and adding hillshade means that now includes elevation tiles. Gating on it
    // left the route and the controls hidden until the DEM arrived. Sources and layers can
    // be added as soon as the style is parsed, which is what this fires on.
    map.on('style.load', () => {
      try {
        // Sky makes the horizon read as a horizon rather than a grey void.
        (map as any).setSky?.({
          'sky-color': '#7aa7d8',
          'sky-horizon-blend': 0.5,
          'horizon-color': '#dfe9f2',
          'horizon-fog-blend': 0.5,
          'fog-color': '#e8eef5',
          'fog-ground-blend': 0.6,
        });
      } catch { /* older MapLibre: no sky */ }

      // Everything from here on is the route itself. Wrapped, because a throw halfway
      // through used to abandon the remaining addLayer calls silently: the basemap and
      // terrain still rendered (they come from the style), so the flyover looked fine
      // while showing no route at all. A visible error beats a mystery.
      try {
      // The whole route: the "where you went" context line.
      map.addSource('route', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } },
      });
      // Progress line, redrawn each frame as the camera advances.
      map.addSource('travelled', {
        type: 'geojson',
        // Two copies of the start, not one: a single-position LineString is not valid
        // GeoJSON and renders as nothing.
        data: {
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: [coordinates[0], coordinates[0]] },
        },
      });
      // The same route again, as points.
      //
      // This exists because MapLibre drapes line layers onto the terrain mesh and the
      // route does not survive that: in 3D the basemap draws and the line does not.
      // Circle layers are NOT draped — they are placed in 3D space and follow terrain
      // elevation — so a dense run of small circles gives a route that is actually
      // visible in 3D. Lines stay for the flat view, where they look better.
      map.addSource('route-points', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates } },
      });
      // The trim preview: the part that would be dropped, plus a marker at each cut.
      map.addSource('trim-cut', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addSource('trim-ends', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addSource('position', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: coordinates[0] } },
      });

      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.6 },
      });
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ROUTE_COLOR, 'line-width': 3, 'line-opacity': 0.95 },
      });
      map.addLayer({
        id: 'travelled-line',
        type: 'line',
        source: 'travelled',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': TRAVELLED_COLOR, 'line-width': 4.5 },
      });
      // Drawn above the route so the discarded section reads as struck through.
      map.addLayer({
        id: 'trim-cut-line',
        type: 'line',
        source: 'trim-cut',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#8a8a86',
          'line-width': 5,
          'line-opacity': 0.85,
          'line-dasharray': [1, 1.4],
        },
      });
      map.addLayer({
        id: 'trim-end-dots',
        type: 'circle',
        source: 'trim-ends',
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffffff',
          'circle-stroke-width': 3,
          'circle-stroke-color': ROUTE_COLOR,
        },
      });
      map.addLayer({
        id: 'route-dots',
        type: 'circle',
        source: 'route-points',
        // Hidden until terrain is switched on; the line is better when it works.
        layout: { visibility: 'none' },
        paint: {
          // Same colour as the flat-view line, so switching modes does not look like
          // switching to a different map.
          //
          // The radius grows with zoom so the circles overlap into something that reads
          // as a line rather than a row of beads. They cannot BE a line: MapLibre drapes
          // line layers onto the terrain mesh and the route does not survive it, while
          // circles are placed in 3D space and do.
          //
          // Kept deliberately thin. A first attempt scaled them up much harder, which
          // did join the dots but made the route look heavy and untidy against the
          // terrain — a thin trace reads better than a thick one.
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 1.1, 12, 1.9, 14, 2.8, 16, 4],
          'circle-color': ROUTE_COLOR,
          'circle-stroke-width': 0,
          // Slight transparency so the overlaps do not build up into a darker cord.
          'circle-opacity': 0.9,
        },
      });
      map.addLayer({
        id: 'position-halo',
        type: 'circle',
        source: 'position',
        paint: { 'circle-radius': 11, 'circle-color': TRAVELLED_COLOR, 'circle-opacity': 0.28 },
      });
      map.addLayer({
        id: 'position-dot',
        type: 'circle',
        source: 'position',
        paint: {
          'circle-radius': 6, 'circle-color': TRAVELLED_COLOR,
          'circle-stroke-width': 2.5, 'circle-stroke-color': '#ffffff',
        },
      });

        if (!map.getLayer('route-line')) throw new Error('the route layer was not created');
      } catch (err) {
        setError(`Could not draw the route: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      fitToRoute(map, coordinates);
      setReady(true);
    });

    return () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      map.remove();
      mapRef.current = null;
    };
    // Rebuilding the map on prop changes would tear down the GPU context; the
    // route is fixed for the lifetime of this component instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── drive the marker & camera ────────────────────────────────────────────
  const renderAt = useCallback((position: number) => {
    const map = mapRef.current;
    if (!map || !map.getSource('travelled')) return;

    // Whether the camera follows is a property of the mode, not of the caller. Passing it
    // in meant every call site had to agree, and they did not.
    const follow = modeRef.current !== 'overview';

    const clamped = Math.max(0, Math.min(pointCount - 1, position));
    const i = Math.floor(clamped);
    const next = Math.min(pointCount - 1, i + 1);
    const t = clamped - i;

    // Interpolate between samples so motion is smooth even at 1 Hz data.
    const lng = coordinates[i][0] + (coordinates[next][0] - coordinates[i][0]) * t;
    const lat = coordinates[i][1] + (coordinates[next][1] - coordinates[i][1]) * t;

    (map.getSource('travelled') as maplibregl.GeoJSONSource).setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [...coordinates.slice(0, i + 1), [lng, lat]] },
    });
    (map.getSource('position') as maplibregl.GeoJSONSource).setData({
      type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lng, lat] },
    });

    if (follow) {
      // Look ahead along the track so the camera leads the athlete rather than
      // chasing them, which is what makes it feel like a flight. The look-ahead point is
      // interpolated too, so the target bearing changes continuously.
      const span = Math.max(3, Math.round(pointCount / 200));
      const aheadPos = Math.min(pointCount - 1, clamped + span);
      const ai = Math.floor(aheadPos);
      const an = Math.min(pointCount - 1, ai + 1);
      const at = aheadPos - ai;
      const aheadLng = coordinates[ai][0] + (coordinates[an][0] - coordinates[ai][0]) * at;
      const aheadLat = coordinates[ai][1] + (coordinates[an][1] - coordinates[ai][1]) * at;

      const target = bearingBetween([lng, lat], [aheadLng, aheadLat]);

      // Ease toward the target the short way round the compass, so a route heading north
      // does not spin 359 degrees when it crosses due north.
      const current = bearingRef.current;
      let bearing = target;
      if (current !== null) {
        let delta = ((target - current + 540) % 360) - 180;
        bearing = current + delta * 0.12;
      }
      bearingRef.current = bearing;

      // Ease the tilt toward whatever the mode asked for, so pressing Play tilts in
      // over about half a second instead of cutting.
      pitchRef.current += (pitchTargetRef.current - pitchRef.current) * 0.12;

      map.jumpTo({ center: [lng, lat], bearing, zoom: 15, pitch: pitchRef.current });
    }

    setIndex(i);
    props.onIndex?.(i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinates, pointCount]);

  /**
   * The only transition. Every button goes through here.
   *
   * Each mode owns a complete camera and layer configuration, and entering a mode applies
   * all of it in one go. `overview` gets a single `fitBounds` that also sets the pitch, so
   * there is one camera command rather than a `fitBounds` racing an `easeTo`; the 3D modes
   * hand the camera to the render function, which is then the only thing writing to it.
   */
  const goTo = useCallback((next: 'overview' | 'flying' | 'paused') => {
    const map = mapRef.current;
    if (!map) return;

    // Set the ref first: an animation frame already queued checks this before writing, so
    // it cannot clobber the camera we are about to set.
    modeRef.current = next;
    setModeState(next);

    const to3D = next !== 'overview';
    try {
      const show = (id: string, visible: boolean) => {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
      };
      for (const id of ['route-casing', 'route-line', 'travelled-line']) show(id, !to3D);
      show('route-dots', to3D);
      map.setTerrain(to3D ? { source: 'terrain', exaggeration: 1.4 } : null);
    } catch { /* no terrain source: the flat route still works */ }

    pitchTargetRef.current = to3D ? 60 : 0;

    if (next === 'overview') {
      // Rewind, and lay the camera back down over the whole route. One command, with the
      // pitch included, so nothing is left half-tilted.
      progressRef.current = 0;
      bearingRef.current = null;
      pitchRef.current = 0;
      renderAt(0);
      fitToRoute(map, coordinates, true);
      return;
    }

    if (next === 'flying') {
      // Leave the tilt where it is and let the loop ease it in; that is what makes Play
      // tilt smoothly rather than cut.
      if (progressRef.current >= pointCount - 1) progressRef.current = 0;
      return;
    }

    // Paused: stay exactly where the flight stopped.
  }, [coordinates, pointCount, renderAt]);

  useEffect(() => {
    if (mode !== 'flying') {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
      animationRef.current = null;
      return undefined;
    }

    let lastFrame = performance.now();
    const step = (now: number) => {
      // A frame can still be queued when the mode changes. Without this check it would
      // write to the camera after Overview had already reset it.
      if (modeRef.current !== 'flying') return;

      const deltaMs = now - lastFrame;
      lastFrame = now;

      // Aim for a ~40-second flight at 1x regardless of activity length, so a
      // marathon and a 5 k both stay watchable.
      const pointsPerSecond = (pointCount / 40) * speed;
      progressRef.current += (deltaMs / 1000) * pointsPerSecond;

      if (progressRef.current >= pointCount - 1) {
        progressRef.current = pointCount - 1;
        renderAt(progressRef.current);
        // Reaching the end stops the flight but stays in the 3D view, so you are looking
        // at where you finished rather than being thrown back to the map. Through goTo
        // like every other transition, so there is exactly one place modes change.
        goTo('paused');
        return;
      }

      renderAt(progressRef.current);
      animationRef.current = requestAnimationFrame(step);
    };

    animationRef.current = requestAnimationFrame(step);
    return () => {
      if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    };
  }, [mode, speed, pointCount, renderAt, goTo]);

  // Chart hover moves the marker when the flight is not running.
  useEffect(() => {
    if (mode === 'flying' || props.externalIndex === null || props.externalIndex === undefined) return;
    progressRef.current = props.externalIndex;
    renderAt(props.externalIndex);
  }, [props.externalIndex, mode, renderAt]);

  // ─── the route changed under us ───────────────────────────────────────────
  //
  // Applying a trim replaces the route while this component stays mounted, and the
  // sources above are built once, inside the effect that creates the map. So the map
  // went on drawing the whole recording after a crop — the numbers, the charts and the
  // list preview all updated, and the flyover alone still showed the part you had just
  // cut off. It looked right often enough to be baffling: React tears the component down
  // and rebuilds it whenever the track briefly disappears mid-refetch, and that hid the
  // staleness on exactly the paths one tends to try first.
  //
  // Rebuilding the map here is still the wrong answer — that is what would cost the GPU
  // context. Only the data needs replacing, and then the camera needs to be told.
  const routeKey = coordinates.length
    ? `${pointCount}:${coordinates[0]}:${coordinates[coordinates.length - 1]}`
    : '';
  const firstRouteRef = useRef(routeKey);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || pointCount < 2) return;
    // The mount already drew this one; only later changes need doing again.
    if (firstRouteRef.current === routeKey) return;
    firstRouteRef.current = routeKey;

    const route = map.getSource('route') as maplibregl.GeoJSONSource | undefined;
    const points = map.getSource('route-points') as maplibregl.GeoJSONSource | undefined;
    if (!route || !points) return;

    route.setData({
      type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates },
    } as any);
    points.setData({
      type: 'Feature', properties: {}, geometry: { type: 'MultiPoint', coordinates },
    } as any);

    // Rewind: the old position is an index into a route that no longer exists.
    progressRef.current = 0;
    bearingRef.current = null;
    renderAt(0);
    if (modeRef.current === 'overview') fitToRoute(map, coordinates, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeKey, ready]);

  // ─── trim preview ─────────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const cutSource = map.getSource('trim-cut') as maplibregl.GeoJSONSource | undefined;
    const endSource = map.getSource('trim-ends') as maplibregl.GeoJSONSource | undefined;
    if (!cutSource || !endSource) return;

    const { discarded, cuts } = trimPreview(coordinates, props.trim);

    cutSource.setData({
      type: 'FeatureCollection',
      features: discarded.map((piece) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: piece },
      })),
    } as any);
    endSource.setData({
      type: 'FeatureCollection',
      features: cuts.map((coord) => ({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: coord },
      })),
    } as any);
    // routeKey, because the preview is drawn from `coordinates` — after a trim it must be
    // recomputed against the new route, not the one captured on the last render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.trim?.from, props.trim?.to, ready, pointCount, routeKey]);


  if (pointCount < 2) {
    return (
      <div className="notice">
        <span className="notice-icon" aria-hidden="true">i</span>
        <div>This activity has no GPS track, so there is nothing to fly over.</div>
      </div>
    );
  }

  const hudDistance = props.distances?.[index];
  const hudElevation = props.elevations?.[index];
  const hudTime = props.times?.[index];
  const hudHr = props.heartRates?.[index];
  const hudPower = props.powers?.[index];
  const hudSpeed = props.speeds?.[index];
  const isPaceSport = /run|walk|hike/.test(props.sport);

  return (
    <div>
      <div className="map" style={{ position: 'relative', height }}>
        <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

        {ready && (
          <>
            <div className="flyover-controls">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => goTo(mode === 'flying' ? 'paused' : 'flying')}
              >
                {mode === 'flying' ? '❙❙ Pause' : '▶ Play'}
              </button>
              <div className="seg">
                {[0.1, 0.5, 1, 2].map((s) => (
                  <button key={s} type="button" aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                    {s}×
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-sm"
                aria-pressed={mode === 'overview'}
                onClick={() => goTo('overview')}
              >
                Overview
              </button>
            </div>

            <div className="flyover-hud">
              {Number.isFinite(hudDistance as number) && (
                <div className="stat">
                  <span className="stat-label">Distance</span>
                  {/* At the start of the route this is legitimately 0, which the
                      general distance formatter renders as "—" (it treats 0 as
                      "no distance recorded"). Here 0 means the start line. */}
                  <span className="stat-value">
                    {(hudDistance as number) < 10
                      ? <>0<small>m</small></>
                      : fmtDistance(hudDistance as number)}
                  </span>
                </div>
              )}
              {Number.isFinite(hudElevation as number) && (
                <div className="stat">
                  <span className="stat-label">Elevation</span>
                  <span className="stat-value">{Math.round(hudElevation as number)}<small>m</small></span>
                </div>
              )}
              {Number.isFinite(hudTime as number) && (
                <div className="stat">
                  <span className="stat-label">Time</span>
                  <span className="stat-value">{fmtDuration(hudTime as number, 'clock')}</span>
                </div>
              )}
              {Number.isFinite(hudSpeed as number) && (
                <div className="stat">
                  <span className="stat-label">{isPaceSport ? 'Pace' : 'Speed'}</span>
                  <span className="stat-value">
                    {isPaceSport ? pace(hudSpeed as number) : number((hudSpeed as number) * 3.6, 1)}
                    <small>{isPaceSport ? '/km' : 'km/h'}</small>
                  </span>
                </div>
              )}
              {Number.isFinite(hudHr as number) && (
                <div className="stat">
                  <span className="stat-label">Heart rate</span>
                  <span className="stat-value">{Math.round(hudHr as number)}<small>bpm</small></span>
                </div>
              )}
              {Number.isFinite(hudPower as number) && (
                <div className="stat">
                  <span className="stat-label">Power</span>
                  <span className="stat-value">{Math.round(hudPower as number)}<small>W</small></span>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Scrub bar: the flight is interactive, unlike a rendered video. */}
      {ready && (
        <input
          type="range"
          min={0}
          max={pointCount - 1}
          value={index}
          aria-label="Position along the route"
          onChange={(event) => {
            // Scrubbing stops the flight but keeps the view you are in: dragging the
            // timeline in 3D should not throw you back to the flat map.
            if (mode === 'flying') goTo('paused');
            const value = Number(event.target.value);
            progressRef.current = value;
            renderAt(value);
          }}
          style={{ width: '100%', marginTop: '0.625rem', accentColor: 'var(--series-1)' }}
        />
      )}

      {error && (
        <div className="notice warn" style={{ marginTop: '0.75rem' }}>
          <span className="notice-icon" aria-hidden="true">!</span>
          <div>
            <strong>Map issue:</strong> {error}
            <br />
            The route data is fine — this is a tile or rendering problem. Terrain tiles come
            from an external source by default; you can point <code>TERRAIN_TILE_URL</code> at
            your own server.
          </div>
        </div>
      )}
    </div>
  );
}

/** Frame the whole route with a little padding. */
/**
 * Fit the whole route, flat and north-up.
 *
 * Pitch and bearing are part of this call on purpose. Overview is entered from a tilted
 * camera, and a separate easeTo for the tilt would be cancelled by this fitBounds — that
 * race is what left the view stuck in perspective after pressing Overview.
 */
function fitToRoute(map: MapLibreMap, coordinates: [number, number][], animate = false) {
  const bounds = coordinates.reduce(
    (acc, coord) => acc.extend(coord),
    new maplibregl.LngLatBounds(coordinates[0], coordinates[0]),
  );
  map.fitBounds(bounds, {
    padding: 48,
    maxZoom: 16,
    pitch: 0,
    bearing: 0,
    // Instant on first load: there is nothing to animate away from.
    duration: animate ? 600 : 0,
  });
}

/** Initial bearing from one point to another, for pointing the camera. */
function bearingBetween(from: [number, number], to: [number, number]): number {
  const toRad = Math.PI / 180;
  const lat1 = from[1] * toRad;
  const lat2 = to[1] * toRad;
  const dLng = (to[0] - from[0]) * toRad;

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** A small static route preview for lists and cards. */
export function RoutePreview({ polyline, width = 120, height = 48, color = 'var(--series-1)' }: {
  polyline: string | null; width?: number; height?: number; color?: string;
}) {
  if (!polyline) return null;
  const points = decodePolyline(polyline);
  if (points.length < 2) return null;

  let minLat = Infinity; let maxLat = -Infinity;
  let minLng = Infinity; let maxLng = -Infinity;
  for (const [lat, lng] of points) {
    minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
    minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
  }

  const pad = 3;
  // Correct for latitude so a route's shape is not stretched east-west.
  const latSpan = (maxLat - minLat) || 1e-6;
  const lngSpan = ((maxLng - minLng) || 1e-6) * Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const scale = Math.min((width - pad * 2) / lngSpan, (height - pad * 2) / latSpan);

  const offsetX = (width - lngSpan * scale) / 2;
  const offsetY = (height - latSpan * scale) / 2;

  const path = points.map(([lat, lng], i) => {
    const x = offsetX + (lng - minLng) * Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180)) * scale;
    const y = height - (offsetY + (lat - minLat) * scale);
    return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join('');

  return (
    <svg width={width} height={height} aria-hidden="true" style={{ display: 'block', flex: '0 0 auto' }}>
      <path d={path} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function decodePolyline(str: string): [number, number][] {
  const points: [number, number][] = [];
  let i = 0; let lat = 0; let lng = 0;

  while (i < str.length) {
    let shift = 0; let result = 0; let b: number;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0; result = 0;
    do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}
