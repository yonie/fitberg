import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Load .env by hand — one less dependency, and the format we need is trivial.
function loadDotenv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const projectRoot = path.resolve(import.meta.dirname, '..', '..');
loadDotenv(path.join(projectRoot, '.env'));

const num = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v, fallback = false) => {
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v));
};

const dataDir = path.resolve(projectRoot, process.env.DATA_DIR || './data');

export const config = {
  projectRoot,
  port: num(process.env.PORT, 8710),
  host: process.env.HOST || '0.0.0.0',
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${num(process.env.PORT, 8710)}`).replace(/\/$/, ''),

  dataDir,
  dbPath: path.join(dataDir, 'fitberg.db'),
  originalsDir: path.join(dataDir, 'originals'),
  tmpDir: path.join(dataDir, 'tmp'),
  webDist: path.join(projectRoot, 'web', 'dist'),

  sessionSecret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  sessionSecretIsEphemeral: !process.env.SESSION_SECRET,
  openAccess: bool(process.env.FITBERG_OPEN_ACCESS, false),


  ollama: {
    enabled: bool(process.env.OLLAMA_ENABLED, true),
    url: (process.env.OLLAMA_URL || 'http://host.docker.internal:11434').replace(/\/$/, ''),
    model: process.env.OLLAMA_MODEL || 'qwen3.5',
  },

  coros: {
    // The official COROS MCP server. Overridable for tests and for the regional
    // standalone URLs (mcpeu/mcpus/mcpcn.coros.com) if the redirecting main URL
    // ever misbehaves.
    mcpUrl: process.env.COROS_MCP_URL || 'https://mcp.coros.com/mcp',
    // On by default, but it only does anything once an account is connected —
    // and connecting is the user's explicit choice. Set COROS_AUTO_SYNC=0 to
    // keep the connection and sync only when asked.
    autoSync: bool(process.env.COROS_AUTO_SYNC, true),
  },

  map: {
    styleUrl: process.env.MAP_STYLE_URL || '',
    terrainTileUrl:
      process.env.TERRAIN_TILE_URL ||
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    terrainEncoding: process.env.TERRAIN_ENCODING || 'terrarium',
    terrainMaxZoom: num(process.env.TERRAIN_MAXZOOM, 13),
  },

};

export function ensureDirs() {
  for (const dir of [
    config.dataDir,
    config.originalsDir,
    config.tmpDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
