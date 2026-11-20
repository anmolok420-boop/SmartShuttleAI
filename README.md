# SmartShuttle AI — LPU-inspired campus shuttle platform

A full-stack campus shuttle demo with:
- Express REST API and Socket.IO live fleet updates
- SQLite storage for GPS telemetry, ETA history, alerts and ETA evaluations
- Route-constrained GPS map matching, noisy-point smoothing and jump rejection
- Dead-reckoning recovery for temporary GPS interruptions (up to 120 seconds)
- Adaptive ETA calculation with optional Python Random Forest prediction service
- Student dashboard, campus map, route directory, alerts and admin preview

> This is an independent student project, not an official Lovely Professional University service. Campus map route overlays are approximate visual traces. Backend latitude/longitude route geometry is illustrative and must be surveyed before real fleet use. The default fleet is simulated.

## Requirements

- Node.js 18+
- Python 3.10+ (optional, for the ML microservice)
- Internet access for external map libraries/fonts used by the browser UI

## Start the backend

```bash
npm install
npm start
```

Open `http://localhost:3000`. The Express app serves the frontend and API. SQLite database `smartshuttle.db` is created automatically.

Run tests:

```bash
npm test
```

## Start the optional Python ETA service

In another terminal:

```bash
cd ai
python -m venv .venv
```

Activate it:

```bash
# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate
```

Install and run:

```bash
pip install -r requirements.txt
uvicorn ai_service:app --host 127.0.0.1 --port 8000
```

The Python service trains a RandomForestRegressor on synthetic telemetry when no saved model exists. The Node backend checks this service and uses its cached predictions when available. If unavailable, Node uses the built-in adaptive route ETA estimator.

Synthetic model evaluation is not evidence of real-world accuracy. The ±2-minute / 80% target must be measured using actual shuttle arrival labels.

## Configuration

Copy `.env.example` to `.env` and set values as needed. The backend loads `.env` automatically using dotenv.

| Variable | Purpose |
|---|---|
| `PORT` | HTTP port (default `3000`) |
| `GPS_API_KEY` | Optional API key required in `x-api-key` for `/api/gps` |
| `ADMIN_API_KEY` | Optional API key required in `x-admin-key` for admin mutations and ETA evaluation |
| `CORS_ORIGIN` | Optional allowed browser origin |

Local demo mode leaves both keys blank. Before exposing the API publicly, configure keys, add user authentication/authorization, restrict CORS, and use HTTPS.

## REST API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/health` | Node, SQLite and optional AI service status |
| GET | `/api/state` | Current fleet snapshot |
| GET | `/api/routes` | Campus route definitions |
| GET | `/api/shuttles` | Current shuttle states |
| GET | `/api/shuttles/:id/history` | Last 100 GPS readings |
| GET | `/api/alerts` | Recent delay/system alerts |
| GET | `/api/analytics` | GPS counts, ETA confidence and labelled accuracy evaluation |
| POST | `/api/gps` | Ingest a GPS reading |
| POST | `/api/simulate/dropout/:id` | Simulate a GPS dropout up to 120 seconds |
| POST | `/api/simulate/delay/:id` | Simulate a shuttle delay |
| POST | `/api/alerts/:id/read` | Mark an alert as read |
| POST | `/api/evaluations` | Store predicted vs actual arrival time for accuracy evaluation |
| POST | `/api/admin/shuttles` | Add a shuttle |
| DELETE | `/api/admin/shuttles/:id` | Remove a shuttle |

### Send a hardware GPS point

```bash
curl -X POST http://localhost:3000/api/gps \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_GPS_API_KEY" \
  -d '{
    "shuttleId": "LPU-01",
    "lat": 31.2551,
    "lng": 75.7043,
    "speed": 22,
    "source": "GPS_DEVICE"
  }'
```

If `GPS_API_KEY` is blank, omit the `x-api-key` header. The API validates coordinates and speed, snaps the reading to that shuttle's configured route, rejects implausible jumps from the matched position, records telemetry and broadcasts an updated fleet snapshot.

### Trigger demo scenarios

```bash
curl -X POST http://localhost:3000/api/simulate/dropout/LPU-01 \
  -H "Content-Type: application/json" -d '{"seconds":120}'

curl -X POST http://localhost:3000/api/simulate/delay/LPU-03 \
  -H "Content-Type: application/json" -d '{"delaySeconds":360}'
```

### Evaluate ETA against a real arrival

Record the prediction made for a stop and the actual observed time-to-arrival, both in seconds:

```bash
curl -X POST http://localhost:3000/api/evaluations \
  -H "Content-Type: application/json" \
  -H "x-admin-key: YOUR_ADMIN_API_KEY" \
  -d '{
    "shuttleId": "LPU-01",
    "stopName": "Central Library",
    "predictedSeconds": 420,
    "actualSeconds": 500
  }'
```

`GET /api/analytics` reports the percentage of labelled predictions whose absolute error is no more than 120 seconds. Do not report the 80% target as achieved until enough real observations have been collected.

## Real-time events

Socket.IO event:
- `fleet:update` — complete fleet snapshot, emitted every 2.5 seconds and after important API mutations.
- `system:connected` — sent when a client connects.

## GPS processing details

1. Readings are matched to the shuttle's assigned route, not indiscriminately to every route.
2. The processor projects GPS points to route segments and computes a route progress fraction.
3. Noisy readings are smoothed. Large implausible jumps are not allowed to move the matched marker.
4. If updates stop, the backend dead-reckons from the last trusted point using the last speed and route segment, with confidence reduced over time and a 120-second limit.
5. After the recovery window, the GPS state is labelled `Lost`; the last position is retained rather than presented as a fresh live fix.

The backend route coordinates in `server.js` are currently illustrative coordinates, not verified campus survey data. Replace them with surveyed route GPS points and calibrate the map image overlays before connecting real vehicles.

## Project structure

```text
public/                 Student/admin web interface and supplied campus map
src/gps-engine.js       GPS filtering, map matching, dropout recovery, ETA estimator
ai/ai_service.py        Optional Python Random Forest ETA service
test/gps-engine.test.js GPS engine unit tests
server.js               Express API, Socket.IO, SQLite and demo fleet
```

## Deployment

GitHub Pages cannot run the Node/Python backend. Deploy the Node service to a Node-capable host and the Python AI service separately if required. Use persistent storage for SQLite or migrate to PostgreSQL. Set API keys, HTTPS, authentication, CORS restrictions and operational monitoring before a public launch.
