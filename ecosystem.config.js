const fs = require('fs')
const path = require('path')

const APP_DIR = process.env.BAGSINDEX_DIR || '/home/bagsindex/app'

// Load variables from the project's root .env so every PM2 app sees them
const rootEnv = {}
try {
  const envFile = fs.readFileSync(path.join(APP_DIR, '.env'), 'utf8')
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    let v = m[2]
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1)
    }
    rootEnv[m[1]] = v
  }
} catch (err) {
  console.error('[ecosystem] Failed to read .env:', err.message)
}

const baseEnv = { NODE_ENV: 'production', ...rootEnv }

module.exports = {
  apps: [
    {
      name: 'bagsindex-web',
      cwd: `${APP_DIR}/apps/web`,
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3300',
      interpreter: 'node',
      env: { ...baseEnv, PORT: '3300' },
    },
    {
      name: 'bagsindex-api',
      cwd: APP_DIR,
      script: 'apps/api/dist/server.js',
      interpreter: 'node',
      node_args: '--experimental-specifier-resolution=node',
      env: { ...baseEnv, PORT: '3301' },
    },
    {
      name: 'bagsindex-worker',
      cwd: APP_DIR,
      script: 'apps/worker/dist/index.js',
      interpreter: 'node',
      node_args: '--experimental-specifier-resolution=node',
      env: { ...baseEnv },
    },
  ],
}
