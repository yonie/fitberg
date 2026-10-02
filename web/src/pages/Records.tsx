import { useState } from 'react';
import { useGet } from '../lib/hooks';
import { Card, Loading, ErrorNotice, Empty } from '../components/common';
import { EffortCurve, SplitsTable } from '../charts/Bars';
import { shortDateLabel } from '../lib/format';

interface Effort {
  bucket: number; value: number; activityId: number; activityName: string | null;
  startTime: number; sport?: string; measuredM?: number;
}

interface RecordsData {
  sport: string | null;
  powerCurve: Effort[];
  hrCurve: Effort[];
  fastestDistances: Effort[];
  fastestByFamily: Record<string, Effort[]>;
}

const FAMILY_LABELS: Record<string, string> = {
  run: 'Running', ride: 'Cycling', swim: 'Swimming', walk: 'Walking',
  row: 'Rowing', strength: 'Strength', other: 'Other',
};

// Running first, then cycling, then the rest — rather than whatever order the database
// happened to return the rows in.
const FAMILY_ORDER = ['run', 'ride', 'swim', 'walk', 'row', 'other'];
const familyRank = (family: string) => {
  const i = FAMILY_ORDER.indexOf(family);
  return i === -1 ? FAMILY_ORDER.length : i;
};

export function Records() {
  const [sport, setSport] = useState('');
  // A forgotten stop puts the drive home in the file, which shows up as a 45 km/h
  // running split. Hidden by default, but it is a switch, not a decision made for you.
  const [showImpossible, setShowImpossible] = useState(false);
  // GPS measures most races a little short. Counted by default; strict is a tick away.
  const [strict, setStrict] = useState(false);
  const sports = useGet<{ sports: { sport: string; label: string; count: number }[] }>('/api/activities/sports');
  const query = [sport && `sport=${sport}`, showImpossible && 'impossible=1', strict && 'strict=1']
    .filter(Boolean).join('&');
  const records = useGet<RecordsData>(`/api/stats/records${query ? `?${query}` : ''}`, [sport, showImpossible, strict]);

  const hasAnything = Boolean(
    records.data && (
      records.data.powerCurve.length || records.data.hrCurve.length || records.data.fastestDistances.length
    ),
  );

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Records</h1>
          <p>Your best efforts, found by searching every recorded second</p>
        </div>
        <select
          value={sport}
          onChange={(e) => setSport(e.target.value)}
          aria-label="Filter by sport"
          style={{
            padding: '0.4375rem 0.5625rem', borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-strong)', background: 'var(--surface-1)',
          }}
        >
          <option value="">All sports</option>
          {sports.data?.sports.map((s) => (
            <option key={s.sport} value={s.sport}>{s.label}</option>
          ))}
        </select>
      </div>

      <label style={{
        display: 'flex', gap: '0.5rem', alignItems: 'baseline',
        fontSize: '0.875rem', marginBottom: '1rem',
      }}>
        <input
          type="checkbox" checked={showImpossible}
          onChange={(e) => setShowImpossible(e.target.checked)}
        />
        <span>
          Show impossible times
          <span className="card-sub" style={{ display: 'block' }}>
            Forget to stop your watch and the drive home lands in the file, which reads as a
            45 km/h running split. Those are hidden unless you tick this. Trim the activity to
            fix it properly.
          </span>
        </span>
      </label>

      <label style={{
        display: 'flex', gap: '0.5rem', alignItems: 'baseline',
        fontSize: '0.875rem', marginBottom: '1rem',
      }}>
        <input
          type="checkbox" checked={strict}
          onChange={(e) => setStrict(e.target.checked)}
        />
        <span>
          Strict distances
          <span className="card-sub" style={{ display: 'block' }}>
            GPS measures most races a little short, so a half marathon can come out at 20.9 km.
            An activity up to 1% short of a 5 km, 10 km, half or full marathon counts as that
            race at its finishing time, unless you tick this.
          </span>
        </span>
      </label>

      {records.error && <ErrorNotice error={records.error} onRetry={records.reload} />}
      {records.loading && <Loading />}

      {!records.loading && !hasAnything && (
        <Empty title="No records yet">
          Records come from the detailed sample data inside your activity files. Import some FIT,
          FIT files and they will appear here automatically.
        </Empty>
      )}

      {/* One table per sport family: a bike split and a run split over the same
          distance are different achievements and must not compete for one row. */}
      {records.data && Object.entries(records.data.fastestByFamily || {})
        .filter(([, efforts]) => efforts.length > 0)
        .sort(([a], [b]) => familyRank(a) - familyRank(b))
        .map(([family, efforts]) => (
          <Card
            key={family}
            title={`Fastest distances — ${FAMILY_LABELS[family] || family}`}
            sub="The quickest you have ever covered each distance, including splits inside longer sessions"
            style={{ marginBottom: '1rem' }}
          >
            <SplitsTable splits={efforts} family={family} />
          </Card>
        ))}

      {records.data && records.data.powerCurve.length > 2 && (
        <Card
          title="Power curve"
          sub="Best average power for every duration. The x-axis is logarithmic so short efforts stay readable."
          style={{ marginBottom: '1rem' }}
        >
          <EffortCurve points={records.data.powerCurve} unit="W" color="var(--series-4)" />
          <PowerTable rows={records.data.powerCurve} unit="W" />
        </Card>
      )}

      {records.data && records.data.hrCurve.length > 2 && (
        <Card
          title="Heart-rate curve"
          sub="Highest sustained heart rate per duration — useful for finding your true threshold and max"
        >
          <EffortCurve points={records.data.hrCurve} unit="bpm" color="var(--series-8)" />
          <p className="card-sub" style={{ marginTop: '0.75rem' }}>
            Your best 60-minute average is a good practical estimate of threshold heart rate, and the
            peak of the short end is close to your true maximum. Fitberg uses both when you have not
            set them yourself.
          </p>
        </Card>
      )}
    </>
  );
}

function PowerTable({ rows, unit }: {
  rows: { bucket: number; value: number; activityId: number; activityName: string | null; startTime: number }[];
  unit: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      style={{ marginTop: '0.875rem' }}>
      <summary style={{ cursor: 'pointer', fontSize: '0.875rem', color: 'var(--text-2)' }}>
        Show as a table
      </summary>
      <div className="table-wrap" style={{ marginTop: '0.625rem' }}>
        <table>
          <thead>
            <tr>
              <th>Duration</th>
              <th className="num">Best</th>
              <th>Activity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.bucket}>
                <td>{r.bucket < 60 ? `${r.bucket}s` : `${Math.round(r.bucket / 60)} min`}</td>
                <td className="num">{Math.round(r.value)} {unit}</td>
                <td>
                  <a href={`/activities/${r.activityId}`}>
                    {r.activityName || shortDateLabel(r.startTime)}
                  </a>
                  {r.activityName && (
                    <span className="card-sub" style={{ display: 'block' }}>
                      {shortDateLabel(r.startTime)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
