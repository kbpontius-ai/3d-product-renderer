import http from 'k6/http';
import { check, group } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

/**
 * API saturation (docs/20-testing-ci.md: "API + queue saturation, 100 concurrent renders").
 *
 * The companion to `packages/render-jobs/src/saturation.integration.test.ts`. That one saturates the
 * queue directly and proves the properties a queue lives or dies by; this one goes through HTTP,
 * where the interesting behaviour is different: whether the app sheds load deliberately — a 429 or
 * a quota refusal — or collapses into timeouts and 500s.
 *
 * Shedding is a success here, which is why the thresholds below count refusals separately from
 * failures. An API that answers "no" in twenty milliseconds under a burst is behaving correctly; one
 * that answers "yes" to everything and falls over is not, even though its error rate looks better
 * until the moment it does.
 *
 *   BASE_URL=http://127.0.0.1:3100 EMAIL=you@example.com PASSWORD=… k6 run load/api-saturation.js
 *
 * Needs an account that already has a design with artwork placed on it — the load is about the
 * render path, and a design that cannot be rendered would measure the validation instead.
 */

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:3100';
const EMAIL = __ENV.EMAIL;
const PASSWORD = __ENV.PASSWORD;
const DESIGN_ID = __ENV.DESIGN_ID;

/** Refusals the app makes on purpose. Counted, and explicitly not failures. */
const shed = new Counter('deliberate_refusals');
const accepted = new Counter('renders_accepted');
const serverErrors = new Rate('server_errors');
const submitLatency = new Trend('render_submit_ms', true);

export const options = {
  scenarios: {
    // A hundred at once, which is the number docs/20-testing-ci.md names.
    burst: {
      executor: 'per-vu-iterations',
      vus: 100,
      iterations: 1,
      exec: 'submitRender',
      startTime: '0s',
    },
    // And a steady background of ordinary reads, so the burst is measured against an app doing its
    // normal work rather than an idle one.
    browsing: {
      executor: 'constant-vus',
      vus: 10,
      duration: '60s',
      exec: 'browse',
      startTime: '0s',
    },
  },
  thresholds: {
    // Nothing may 5xx. A refusal is a 4xx and is fine; a 500 means something was not handled.
    server_errors: ['rate==0'],
    // Reads stay usable while the queue is being hammered.
    'http_req_duration{scenario:browsing}': ['p(95)<1500'],
    // Submissions may be refused but must be answered promptly either way.
    render_submit_ms: ['p(95)<3000'],
  },
};

export function setup() {
  if (!EMAIL || !PASSWORD || !DESIGN_ID) {
    throw new Error('set EMAIL, PASSWORD and DESIGN_ID: this drives a real account and design');
  }

  const login = http.post(
    `${BASE}/api/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { 'content-type': 'application/json', origin: BASE } },
  );
  check(login, { 'signed in': (r) => r.status === 200 });

  // The session cookie every virtual user will carry.
  return { cookies: login.cookies };
}

const withSession = (data) => ({
  headers: { 'content-type': 'application/json', origin: BASE },
  cookies: Object.fromEntries(
    Object.entries(data.cookies).map(([name, values]) => [name, values[0].value]),
  ),
});

export function submitRender(data) {
  const response = http.post(
    `${BASE}/api/designs/${DESIGN_ID}/renders`,
    JSON.stringify({ preset: 'draft', size: '1k', format: 'png8' }),
    withSession(data),
  );

  submitLatency.add(response.timings.duration);
  serverErrors.add(response.status >= 500);

  if (response.status === 202 || response.status === 200) accepted.add(1);
  // 429 is the rate limiter, 422 is the quota. Both are the app saying no on purpose.
  else if (response.status === 429 || response.status === 422) shed.add(1);

  check(response, {
    'answered without a server error': (r) => r.status < 500,
    'answered with something meaningful': (r) => [200, 202, 422, 429].includes(r.status),
  });
}

export function browse(data) {
  const session = withSession(data);

  group('reads', () => {
    for (const path of ['/api/catalog/products', '/api/designs', '/api/renders']) {
      const response = http.get(`${BASE}${path}`, session);
      serverErrors.add(response.status >= 500);
      check(response, { [`${path} ok`]: (r) => r.status === 200 });
    }
  });
}
