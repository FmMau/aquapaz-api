const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, ['--test', 'tests/gestion-reportes.test.js'], {
  cwd: require('node:path').resolve(__dirname, '..'),
  env: { ...process.env, RUN_GESTION_DB_TESTS: '1' }, stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
