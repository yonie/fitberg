// Thin API client. Same-origin, cookie-authenticated, no state library — the app
// is small enough that a fetch wrapper plus a `useAsync` hook is the whole thing.

export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, message: string, body?: any) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { 'content-type': 'application/json' }
        : {}),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let body: any = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }

  if (!response.ok) {
    const message = (body && typeof body === 'object' && body.error) || `Request failed (${response.status})`;
    throw new ApiError(response.status, message, body);
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),

  /** Uploads report progress, because a multi-gigabyte export takes real time. */
  upload: (path: string, files: File[], onProgress?: (fraction: number) => void) =>
    new Promise<any>((resolve, reject) => {
      const form = new FormData();
      for (const file of files) form.append('file', file, file.name);

      // XHR rather than fetch: fetch still has no upload progress event.
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      xhr.withCredentials = true;

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
      };
      xhr.onload = () => {
        let body: any = null;
        try { body = JSON.parse(xhr.responseText); } catch { body = xhr.responseText; }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(new ApiError(xhr.status, body?.error || `Upload failed (${xhr.status})`, body));
      };
      xhr.onerror = () => reject(new ApiError(0, 'Upload failed: the connection dropped'));
      xhr.ontimeout = () => reject(new ApiError(0, 'Upload timed out'));
      xhr.send(form);
    }),
};

// ─── types ────────────────────────────────────────────────────────────────────

export interface Activity {
  id: number;
  name: string | null;
  /** `name`, or a derived "Morning Ride"-style fallback when the file had none. */
  displayName: string;
  sport: string;
  sportLabel: string;
  startTime: number;
  utcOffsetS: number;
  elapsedS: number | null;
  movingS: number | null;
  distanceM: number | null;
  elevGainM: number | null;
  avgHr: number | null;
  maxHr: number | null;
  avgPower: number | null;
  normalizedPower: number | null;
  avgSpeedMs: number | null;
  calories: number | null;
  load: number | null;
  loadMethod: string | null;
  intensityFactor: number | null;
  trainer: boolean;
  commute: boolean;
  manual: boolean;
  polyline: string | null;
  startLat: number | null;
  startLng: number | null;
  source: string;
  perceivedExertion: number | null;
}

export interface ActivityDetail extends Activity {
  subSport: string | null;
  device: string | null;
  elevLossM: number | null;
  elevMinM: number | null;
  elevMaxM: number | null;
  avgCadence: number | null;
  maxCadence: number | null;
  maxPower: number | null;
  workKj: number | null;
  avgTempC: number | null;
  decouplingPct: number | null;
  efficiencyFactor: number | null;
  variabilityIndex: number | null;
  vo2maxEstimate: number | null;
  aerobicPct: number | null;
  notes: string | null;
  feeling: number | null;
  cropStartS: number | null;
  cropEndS: number | null;
  /** Length of the whole recording, crop or no crop — the range the trim editor spans. */
  recordingElapsedS: number | null;
  bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number } | null;
  laps: any[];
  streamChannels: { channel: string; n: number }[];
  bestEfforts: { kind: string; bucket: number; value: number }[];
  original: { hash: string; bytes: number; kind: string; name: string; downloadUrl: string } | null;
}

export interface Fitness {
  day: string;
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  rampRate: number | null;
  monotony: number | null;
  strain: number | null;
  vo2max: number | null;
  form: { label: string; tone: string; note?: string };
}

export interface Profile {
  sex: 'm' | 'f' | null;
  birthYear: number | null;
  heightCm: number | null;
  weightKg: number | null;
  maxHr: number | null;
  restingHr: number | null;
  lthr: number | null;
  ftp: number | null;
  thresholdPaceMs: number | null;
  sleepNeedS: number;
  units: string;
}

export interface Dashboard {
  profile: Profile;
  profileEstimated: Record<string, string>;
  fitness: Fitness | null;
  totals: {
    activities: number; distanceM: number; seconds: number; elevationM: number;
    firstActivity: number | null; lastActivity: number | null;
  };
  last7: PeriodTotals;
  prev7: PeriodTotals;
  last30: PeriodTotals;
  last365: PeriodTotals;
  recent: Activity[];
}

export interface PeriodTotals {
  activities: number;
  distance: number | null;
  seconds: number | null;
  load: number | null;
  elevation: number | null;
}

export interface FitnessDay {
  day: string;
  load: number;
  ctl: number | null;
  atl: number | null;
  tsb: number | null;
  rampRate: number | null;
  activities: number;
  durationS: number;
  distanceM: number;
  monotony: number | null;
  vo2max: number | null;
}

export interface AppConfig {
  version: string;
  map: {
    styleUrl: string | null;
    terrainTileUrl: string;
    terrainEncoding: string;
    terrainMaxZoom: number;
  };
  ai: { available: boolean; model: string | null; reason: string | null };
  openAccess: boolean;
  publicUrl: string;
}

export interface GuideEntry {
  id: string;
  label: string;
  kind: 'export' | 'connect' | 'files';
  waitTime?: string;
  recommended: boolean;
  summary: string;
  why: string;
  steps: string[];
  link?: string;
  linkLabel?: string;
  contains: string[];
  notes?: string;
  alternative?: { label: string; detail: string };
}

export interface OnboardingState {
  version: number;
  completed: boolean;
  dismissed: boolean;
  currentStep: string;
  steps: Record<string, { done?: boolean }>;
  platforms: Record<string, { status: string; requestedAt?: number; updatedAt?: number }>;
}

export interface OnboardingResponse {
  state: OnboardingState;
  guide: GuideEntry[];
  progress: {
    totalActivities: number;
    bySource: Record<string, { n: number; first: number; last: number }>;
    profileComplete: boolean;
    profileEstimated: string[];
    hasGps: number;
    dateRange: { first: number; last: number } | null;
  };
  profile: Profile;
}
