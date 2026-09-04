import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import type { ActivityDetail as Detail, AppConfig } from '../lib/api';
import { useGet } from '../lib/hooks';
import { Card, Loading, ErrorNotice, Metric } from '../components/common';
import { Markdown } from '../components/Markdown';
import { Flyover } from '../components/Flyover';
import { StreamCharts, LapsTable } from '../charts/StreamChart';
import type { StreamData } from '../charts/StreamChart';
import { EffortCurve } from '../charts/Bars';
import {
  distance, duration, dateLabel, timeLabel, paceOrSpeed, number, sportIcon, bytes, signed,
} from '../lib/format';

/**
 * Non-destructive trimming.
 *
 * Two handles over the recording, and the numbers update as you drag: distance and
 * duration are recomputed in the browser straight from the sample streams, so the
 * result is visible before anything is committed. Apply then re-derives properly on the
 * server. Typing start and end times, which is what this was, is useless — you cannot
 * know that the car journey started at 24:07.
 *
 * The file is never modified, so this is reversible at any time.
 */
function CropCard({ activity, streams, onRange, onCropped }: {
  activity: Detail;
  /** The whole recording's streams — see `fullStreams` on the page. */
  streams: StreamData | null;
  onRange: (range: [number, number] | null) => void;
  onCropped: () => void;
}) {
  // The WHOLE recording, not what is left of it. A crop rewrites elapsedS to the cropped
  // length, so bounding the handles by that meant a trim could only ever be tightened —
  // there was no way to hand any of the recording back short of starting over.
  const total = Math.max(1, Math.round(activity.recordingElapsedS ?? activity.elapsedS ?? 0));
  const [range, setRangeState] = useState<[number, number]>(() => [
    activity.cropStartS ?? 0,
    activity.cropEndS ?? total,
  ]);

  // Tell the page every time a handle moves, so the map redraws with it.
  const setRange = (next: [number, number]) => {
    setRangeState(next);
    onRange(next[0] === 0 && next[1] === total ? null : next);
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cropped = activity.cropStartS != null || activity.cropEndS != null;
  const [from, to] = range;
  const touched = from !== (activity.cropStartS ?? 0) || to !== (activity.cropEndS ?? total);

  // Preview from the streams we already have on the page: no round trip, so the numbers
  // move with the handles.
  const t = streams?.channels.t as number[] | undefined;
  const dist = streams?.channels.dist as number[] | undefined;
  const preview = (() => {
    if (!t?.length || !dist?.length) return null;
    let a = 0;
    let b = t.length - 1;
    for (let i = 0; i < t.length; i++) {
      if (t[i] <= from) a = i;
      if (t[i] <= to) b = i;
    }
    const metres = (dist[b] ?? 0) - (dist[a] ?? 0);
    return { metres: Math.max(0, metres), seconds: Math.max(0, to - from) };
  })();

  const apply = async (clear: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await api.put(`/api/activities/${activity.id}/crop`, clear
        ? { startS: null, endS: null }
        : { startS: from > 0 ? from : null, endS: to < total ? to : null });
      onCropped();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not trim');
    } finally {
      setBusy(false);
    }
  };

  const pct = (v: number) => `${(v / total) * 100}%`;

  return (
    <Card
      title="Trim"
      sub={cropped ? 'Trimmed — your file is untouched' : 'Drag the handles to cut off a warm-up, or the drive home'}
      style={{ marginBottom: '1rem' }}
    >
      <div className="trim">
        {/* The kept portion, so the selection is visible rather than implied. */}
        <div className="trim-track">
          <div className="trim-kept" style={{ left: pct(from), right: pct(total - to) }} />
        </div>
        <input
          type="range" min={0} max={total} value={from} aria-label="Start"
          onChange={(e) => setRange([Math.min(Number(e.target.value), to - 1), to])}
        />
        <input
          type="range" min={0} max={total} value={to} aria-label="End"
          onChange={(e) => setRange([from, Math.max(Number(e.target.value), from + 1)])}
        />
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8125rem', color: 'var(--text-2)' }}>
        <span>{secondsToClock(from)}</span>
        <span>{secondsToClock(to)} of {secondsToClock(total)}</span>
      </div>

      {preview && (
        <div className="grid grid-3" style={{ gap: '1rem', margin: '1rem 0 0.25rem' }}>
          <Metric label="Distance kept" value={distance(preview.metres)} />
          <Metric label="Time kept" value={duration(preview.seconds, 'clock')} />
          <Metric
            label="Cut"
            value={secondsToClock(total - preview.seconds)}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.875rem' }}>
        <button type="button" className="btn btn-primary" disabled={busy || !touched} onClick={() => apply(false)}>
          {busy ? <span className="spinner" /> : 'Apply'}
        </button>
        {(cropped || touched) && (
          <button type="button" className="btn" disabled={busy} onClick={() => { setRange([0, total]); apply(true); }}>
            Use the whole recording
          </button>
        )}
      </div>

      {error && <div style={{ marginTop: '0.75rem' }}><ErrorNotice error={error} /></div>}
    </Card>
  );
}

/** Seconds to h:mm:ss, dropping the hours when there are none. */
function secondsToClock(total: number): string {
  const s = Math.max(0, Math.round(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}


export function ActivityDetail({ config }: { config: AppConfig }) {
  const { id } = useParams<{ id: string }>();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  // Lifted out of the trim card so the flyover can draw where the cuts land.
  const [trimRange, setTrimRange] = useState<[number, number] | null>(null);
  // Where the flyover is. Separate from hoverIndex so the two do not feed each other in
  // a loop: the charts drive the map on hover, the map drives the charts while flying.
  const [flyIndex, setFlyIndex] = useState<number | null>(null);
  const [aiText, setAiText] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const detail = useGet<Detail>(`/api/activities/${id}`, [id]);
  // Cap the resolution: a 6-hour ride is 20 000+ samples per channel and a chart
  // cannot show more than a couple of thousand anyway.
  const streams = useGet<StreamData>(`/api/activities/${id}/streams?resolution=1500`, [id]);
  // The charts and the map show the activity as trimmed; the trim editor has to show the
  // whole recording, or the handles would drag over samples that are no longer on the
  // page. Same request when nothing is cropped, so this costs nothing in that case.
  const fullStreams = useGet<StreamData>(
    `/api/activities/${id}/streams?resolution=1500&full=1`, [id],
  );

  if (detail.loading) return <Loading />;
  if (detail.error) return <ErrorNotice error={detail.error} onRetry={detail.reload} />;
  if (!detail.data) return null;

  const a = detail.data;
  const speed = paceOrSpeed(a.avgSpeedMs, a.sport);
  const hasTrack = Boolean(streams.data?.channels.lat && streams.data.channels.lng);

  const coordinates: [number, number][] = hasTrack
    ? (streams.data!.channels.lng as number[])
      .map((lng, i) => [lng, (streams.data!.channels.lat as number[])[i]] as [number, number])
      .filter(([lng, lat]) => Number.isFinite(lng) && Number.isFinite(lat))
    : [];

  // The slider speaks seconds; the route is an array of samples. Translate through the
  // time stream so a handle lands on the right point even with irregular sampling.
  const trimIndices = (() => {
    if (!trimRange || !streams.data) return null;
    const t = streams.data.channels.t as number[] | undefined;
    if (!t?.length) return null;
    const indexAt = (seconds: number) => {
      let best = 0;
      for (let i = 0; i < t.length; i++) if (t[i] <= seconds) best = i;
      return best;
    };
    // The slider speaks whole-recording seconds; the map is drawing the CROPPED track,
    // whose clock was re-based to zero at the existing cut. Without this offset the
    // overlay on an already-trimmed activity marks the wrong place entirely.
    const base = a.cropStartS ?? 0;
    return { from: indexAt(trimRange[0] - base), to: indexAt(trimRange[1] - base) };
  })();

  const powerCurve = a.bestEfforts.filter((e) => e.kind === 'peak_power');

  const askAi = async () => {
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await api.post<{ content: string }>(`/api/ai/activity/${a.id}`);
      setAiText(result.content);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : 'AI request failed');
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/activities" className="card-sub">← Activities</Link>
          <h1 style={{ marginTop: '0.375rem' }}>
            <span aria-hidden="true" style={{ marginRight: '0.5rem' }}>{sportIcon(a.sport)}</span>
            {a.displayName || a.sportLabel}
          </h1>
          <p>
            {dateLabel(a.startTime, a.utcOffsetS)} at {timeLabel(a.startTime, a.utcOffsetS)}
            {' · '}{a.sportLabel}
            {a.trainer && ' · indoor'}
            {a.manual && ' · manual entry'}
            {' · '}<span title={`Imported from ${a.source}`}>from {a.source}</span>
          </p>
        </div>
        {a.original && (
          <a className="btn btn-sm" href={a.original.downloadUrl} download>
            Download original ({bytes(a.original.bytes)})
          </a>
        )}
      </div>

      {/* Headline numbers first. */}
      <Card style={{ marginBottom: '1rem' }}>
        <div className="grid grid-4" style={{ gap: '1rem' }}>
          {a.distanceM ? <Metric label="Distance" value={distance(a.distanceM)} /> : null}
          <Metric label="Moving time" value={duration(a.movingS, 'clock')} />
          {a.elapsedS && a.elapsedS !== a.movingS ? (
            <Metric label="Elapsed" value={duration(a.elapsedS, 'clock')} />
          ) : null}
          {a.distanceM ? <Metric label={speed.unit === '/km' ? 'Pace' : 'Speed'} value={speed.value} unit={speed.unit} /> : null}
          {a.elevGainM ? <Metric label="Climb" value={number(a.elevGainM, 0)} unit="m" /> : null}
          {a.avgHr ? <Metric label="Avg HR" value={number(a.avgHr, 0)} unit="bpm" /> : null}
          {a.maxHr ? <Metric label="Max HR" value={number(a.maxHr, 0)} unit="bpm" /> : null}
          {a.avgPower ? <Metric label="Avg power" value={number(a.avgPower, 0)} unit="W" /> : null}
          {a.normalizedPower ? (
            <Metric label="Normalized power" value={number(a.normalizedPower, 0)} unit="W"
              hint="A 30-second rolling average raised to the fourth power — surging costs more than steady riding." />
          ) : null}
          {a.avgCadence ? (
            <Metric label="Cadence" value={number(a.avgCadence, 0)}
              unit={/run|walk|hike/.test(a.sport) ? 'spm' : 'rpm'} />
          ) : null}
          {a.calories ? <Metric label="Calories" value={number(a.calories, 0)} /> : null}
          {a.load ? (
            <Metric label="Training load" value={number(a.load, 0)}
              hint={`Computed from ${a.loadMethod}. One hour at threshold = 100.`} />
          ) : null}
          {a.intensityFactor ? (
            <Metric label="Intensity" value={number(a.intensityFactor, 2)}
              hint="Relative to your threshold. 1.00 is an hour-long all-out effort." />
          ) : null}
        </div>
      </Card>

      <CropCard
        activity={a}
        streams={fullStreams.data ?? streams.data ?? null}
        onRange={setTrimRange}
        onCropped={() => {
          setTrimRange(null);
          detail.reload();
          streams.reload();
          fullStreams.reload();
        }}
      />

      {/* The flyover. */}
      {hasTrack && (
        <Card
          title="Flyover"
          sub="Play flies the route in 3D. Overview goes back to the flat map."
          style={{ marginBottom: '1rem' }}
        >
          <Flyover
            coordinates={coordinates}
            elevations={streams.data?.channels.alt}
            times={streams.data?.channels.t}
            distances={streams.data?.channels.dist}
            heartRates={streams.data?.channels.hr}
            powers={streams.data?.channels.power}
            speeds={streams.data?.channels.speed}
            config={config}
            sport={a.sport}
            externalIndex={hoverIndex}
            trim={trimIndices}
            onIndex={setFlyIndex}
          />
        </Card>
      )}

      {streams.data && streams.data.n > 0 && (
        <Card
          title="Session data"
          sub="Hover to read every channel at once. During a flyover it follows the flight."
          style={{ marginBottom: '1rem' }}
        >
          <StreamCharts
            streams={streams.data}
            sport={a.sport}
            onHoverIndex={setHoverIndex}
            followIndex={flyIndex}
          />
        </Card>
      )}

      <div className="grid grid-2" style={{ marginBottom: '1rem' }}>
        {(a.decouplingPct !== null || a.efficiencyFactor !== null || a.vo2maxEstimate !== null
          || a.aerobicPct !== null || a.variabilityIndex !== null) && (
          <Card title="Analysis">
            <div className="grid grid-3" style={{ gap: '0.875rem' }}>
              {a.decouplingPct !== null && (
                <Metric
                  label="Decoupling" value={signed(a.decouplingPct, 1)} unit="%"
                  hint="How much your output per heartbeat drifted from the first half to the second. Under 5% is good aerobic durability."
                />
              )}
              {a.efficiencyFactor !== null && (
                <Metric label="Efficiency" value={number(a.efficiencyFactor, 3)}
                  hint="Normalized output divided by average heart rate. Rises as fitness improves." />
              )}
              {a.variabilityIndex !== null && (
                <Metric label="Variability" value={number(a.variabilityIndex, 2)}
                  hint="Normalized power over average power. Near 1.0 means a steady effort." />
              )}
              {a.aerobicPct !== null && (
                <Metric label="Below threshold" value={number(a.aerobicPct, 0)} unit="%"
                  hint="Share of the session spent under your threshold heart rate." />
              )}
              {a.vo2maxEstimate !== null && (
                <Metric label="VO₂max from this" value={number(a.vo2maxEstimate, 1)} unit="ml/kg/min" />
              )}
              {a.workKj !== null && <Metric label="Work" value={number(a.workKj, 0)} unit="kJ" />}
            </div>

            {a.decouplingPct !== null && Math.abs(a.decouplingPct) > 5 && (
              <p className="card-sub" style={{ marginTop: '0.875rem' }}>
                {a.decouplingPct > 5
                  ? 'Output per heartbeat fell noticeably over this session — a sign the intensity was above what you can hold aerobically, or that heat or fuelling were limiting.'
                  : 'Output per heartbeat rose through the session, which usually means it started conservatively.'}
              </p>
            )}
          </Card>
        )}

        {config.ai.available && (
          <Card
            title="Coach"
            sub={`Local analysis by ${config.ai.model}`}
            action={
              <button type="button" className="btn btn-sm" onClick={askAi} disabled={aiBusy}>
                {aiBusy ? <span className="spinner" /> : aiText ? 'Regenerate' : 'Analyse'}
              </button>
            }
          >
            {aiError && <ErrorNotice error={aiError} />}
            {aiText ? (
              <Markdown text={aiText} />
            ) : !aiBusy && !aiError ? (
              <p className="card-sub">
                Ask the model what it makes of this session. It compares against your own
                previous 90 days of the same sport.
              </p>
            ) : null}
          </Card>
        )}
      </div>

      {powerCurve.length > 2 && (
        <Card title="Peak power in this session" sub="The best average you held for each duration"
          style={{ marginBottom: '1rem' }}>
          <EffortCurve points={powerCurve} unit="W" color="var(--series-4)" />
        </Card>
      )}

      {a.laps.length > 1 && (
        <Card title={`Laps (${a.laps.length})`} style={{ marginBottom: '1rem' }}>
          <LapsTable laps={a.laps} sport={a.sport} />
        </Card>
      )}

      {a.notes && (
        <Card title="Notes" style={{ marginBottom: '1rem' }}>
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{a.notes}</p>
        </Card>
      )}

      <Card title="Provenance" sub="Where this activity came from and what it was built from">
        <div className="grid grid-3" style={{ gap: '0.875rem' }}>
          <Metric label="Source" value={a.source} />
          {a.device && <Metric label="Recorded on" value={a.device} />}
          {a.original && <Metric label="Original file" value={a.original.name || a.original.kind} />}
          {a.original && <Metric label="Size" value={bytes(a.original.bytes)} />}
          <Metric label="Channels stored" value={a.streamChannels.length} />
        </div>
        {a.original && (
          <p className="card-sub" style={{ marginTop: '0.875rem' }}>
            Your original file, unmodified.
            {' '}<span style={{ fontFamily: 'var(--mono)', fontSize: '0.75rem' }}>
              sha256:{a.original.hash.slice(0, 16)}…
            </span>
          </p>
        )}
      </Card>
    </>
  );
}
