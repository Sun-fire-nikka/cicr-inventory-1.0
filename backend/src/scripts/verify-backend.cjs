const dotenv = require('dotenv');
const path = require('path');
const http = require('http');

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

async function verifyBackend() {
  console.log('🩺 ==========================================');
  console.log('🩺 CICR BACKEND COMPREHENSIVE HEALTH CHECK');
  console.log('🩺 ==========================================\n');

  let passes = 0;
  let failures = 0;

  function report(name, success, info = '') {
    if (success) {
      console.log(`✅ [PASS] ${name}${info ? ` — ${info}` : ''}`);
      passes++;
    } else {
      console.error(`❌ [FAIL] ${name}${info ? ` — ${info}` : ''}`);
      failures++;
    }
  }

  // 1. Check Dist Build & Express App Import
  let appModule;
  try {
    appModule = require('../../dist/app.js');
    report('Express App Module Load', Boolean(appModule && appModule.default), 'dist/app.js loaded cleanly');
  } catch (err) {
    report('Express App Module Load', false, err.message);
    process.exit(1);
  }

  const app = appModule.default;

  // 2. Check Database & Supabase connection
  try {
    const { getSupabasePublic, checkSupabaseHealth } = require('../../dist/config/supabasePool.js');
    const isHealthy = await checkSupabaseHealth();
    report('Supabase Health Check', isHealthy, isHealthy ? 'Supabase responded healthy' : 'Supabase returned warning');
  } catch (err) {
    report('Supabase Health Check', false, err.message);
  }

  // 3. Check Hardware Request Service
  try {
    const { getAllHardwareRequests } = require('../../dist/modules/borrow/hardwareRequestService.js');
    const list = getAllHardwareRequests();
    report('Hardware Request Service State', true, `${list.length} hardware requests loaded in memory`);
  } catch (err) {
    report('Hardware Request Service State', false, err.message);
  }

  // 4. Test In-Process HTTP Server & Endpoints
  const server = http.createServer(app);
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      report('Ephemeral Server Spin-up', true, `Listening on port ${port}`);
      resolve();
    });
  });

  const base = `http://127.0.0.1:${server.address().port}`;

  // Test /api/health
  try {
    const res = await fetch(`${base}/api/health`);
    const json = await res.json();
    report('GET /api/health', res.status === 200, `status: ${res.status}, response: ${JSON.stringify(json)}`);
  } catch (err) {
    report('GET /api/health', false, err.message);
  }

  // Test /api/items/categories
  try {
    const res = await fetch(`${base}/api/items/categories`);
    const json = await res.json();
    const isSuccess = res.status === 200 && Array.isArray(json.data);
    report('GET /api/items/categories', isSuccess, `status: ${res.status}, categories count: ${json.data ? json.data.length : 0}`);
  } catch (err) {
    report('GET /api/items/categories', false, err.message);
  }

  // Test /api/stats (Public Dashboard Stats)
  try {
    const res = await fetch(`${base}/api/stats`);
    const json = await res.json();
    const isSuccess = res.status === 200 && json.status === 'success';
    report('GET /api/stats', isSuccess, `status: ${res.status}, total items: ${json.data ? json.data.total_items : 'N/A'}`);
  } catch (err) {
    report('GET /api/stats', false, err.message);
  }

  // Close server
  await new Promise((resolve) => server.close(resolve));
  report('Server Teardown', true, 'Cleanly closed socket and listeners');

  console.log('\n==========================================');
  console.log(`Summary: ${passes} Passed, ${failures} Failed`);
  console.log('==========================================');

  process.exit(failures > 0 ? 1 : 0);
}

verifyBackend().catch((err) => {
  console.error('Fatal backend check error:', err);
  process.exit(1);
});
