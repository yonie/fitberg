import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

/**
 * Fetch-on-mount with loading, error and refetch. Deliberately small — the app has
 * no shared server cache to invalidate, so a hook per view is enough.
 */
export function useAsync<T>(
  fn: () => Promise<T>,
  deps: unknown[] = [],
): { data: T | null; error: string | null; loading: boolean; reload: () => void; setData: (v: T) => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // Guard against a resolved response from a superseded request overwriting a
  // newer one, and against setting state after unmount.
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    let cancelled = false;
    setLoading(true);
    setError(null);

    fn()
      .then((value) => {
        if (cancelled || current !== generation.current) return;
        setData(value);
      })
      .catch((err: unknown) => {
        if (cancelled || current !== generation.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled && current === generation.current) setLoading(false);
      });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload, setData };
}

export function useGet<T>(path: string | null, deps: unknown[] = []) {
  return useAsync<T>(
    () => (path ? api.get<T>(path) : Promise.resolve(null as unknown as T)),
    [path, ...deps],
  );
}

/** Is the viewer signed in? Also reports whether the instance needs setting up. */
export function useSession() {
  const [state, setState] = useState<{
    loading: boolean;
    userId: number | null;
    email: string | null;
    initialised: boolean;
    openAccess: boolean;
  }>({ loading: true, userId: null, email: null, initialised: false, openAccess: false });

  const refresh = useCallback(async () => {
    try {
      const authState = await api.get<{ initialised: boolean; openAccess: boolean }>('/api/auth/state');
      try {
        const me = await api.get<{ id: number; email: string }>('/api/auth/me');
        setState({
          loading: false, userId: me.id, email: me.email,
          initialised: authState.initialised, openAccess: authState.openAccess,
        });
      } catch (err) {
        // 401 here is the normal "not signed in" case, not a failure.
        if (err instanceof ApiError && err.status === 401) {
          setState({
            loading: false, userId: null, email: null,
            initialised: authState.initialised, openAccess: authState.openAccess,
          });
        } else throw err;
      }
    } catch {
      setState((s) => ({ ...s, loading: false }));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  return { ...state, refresh };
}

/** Measure an element so SVG charts can be sized in real pixels. */
export function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      // Round to whole pixels: sub-pixel churn would re-render on every scroll.
      setSize((prev) => {
        const next = { width: Math.round(width), height: Math.round(height) };
        return prev.width === next.width && prev.height === next.height ? prev : next;
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, size] as const;
}

export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch { return initial; }
  });

  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  }, [key, value]);

  return [value, setValue] as const;
}
