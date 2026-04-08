const APP_DIR = process.env.BAGSINDEX_DIR || '/home/bagsindex/app'

module.exports = {
  apps: [
    {
      name: 'bagsindex-web',
      cwd: `${APP_DIR}/apps/web`,
      script: 'node_modules/.bin/next',
      args: 'start -p 3300',
      interpreter: 'none',
      user: 'bagsindex',
      env: {
        NODE_ENV: 'production',
        PORT: '3300',
      },
    },
    {
      name: 'bagsindex-api',
      cwd: APP_DIR,
      script: 'apps/api/dist/server.js',
      interpreter: 'node',
      node_args: '--experimental-specifier-resolution=node',
      user: 'bagsindex',
      env: {
        NODE_ENV: 'production',
        PORT: '3301',
      },
    },
    {
      name: 'bagsindex-worker',
      cwd: APP_DIR,
      script: 'apps/worker/dist/index.js',
      interpreter: 'node',
      node_args: '--experimental-specifier-resolution=node',
      user: 'bagsindex',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
}
