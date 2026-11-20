require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const cors = require("cors");
const { Server } = require("socket.io");
const Database = require("better-sqlite3");
const { GPSProcessor, estimateETA, routeLengths } = require("./src/gps-engine");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || "*" } });
const PORT = Number(process.env.PORT || 3000);
const TICK_MS = 2500;
const GPS_API_KEY = process.env.GPS_API_KEY || "";
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "";

app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(path.join(__dirname, "smartshuttle.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
 CREATE TABLE IF NOT EXISTS gps_points(
  id INTEGER PRIMARY KEY AUTOINCREMENT, shuttle_id TEXT NOT NULL,
  lat REAL NOT NULL, lng REAL NOT NULL, speed REAL NOT NULL,
  recorded_at INTEGER NOT NULL, matched_lat REAL, matched_lng REAL,
  confidence REAL, off_route INTEGER DEFAULT 0, source TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_gps_shuttle_time ON gps_points(shuttle_id, recorded_at);
 CREATE TABLE IF NOT EXISTS alerts(
  id INTEGER PRIMARY KEY AUTOINCREMENT, shuttle_id TEXT, level TEXT NOT NULL,
  title TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL,
  read INTEGER DEFAULT 0
 );
 CREATE TABLE IF NOT EXISTS eta_history(
  id INTEGER PRIMARY KEY AUTOINCREMENT, shuttle_id TEXT NOT NULL,
  stop_name TEXT NOT NULL, eta_seconds REAL NOT NULL,
  confidence REAL NOT NULL, model TEXT, created_at INTEGER NOT NULL
 );
 CREATE TABLE IF NOT EXISTS eta_evaluations(
  id INTEGER PRIMARY KEY AUTOINCREMENT, shuttle_id TEXT NOT NULL,
  stop_name TEXT, predicted_seconds REAL NOT NULL,
  actual_seconds REAL NOT NULL, error_seconds REAL NOT NULL,
  created_at INTEGER NOT NULL
 );
`);
const insertGPS = db.prepare(`INSERT INTO gps_points
 (shuttle_id,lat,lng,speed,recorded_at,matched_lat,matched_lng,confidence,off_route,source)
 VALUES(?,?,?,?,?,?,?,?,?,?)`);
const insertAlert = db.prepare("INSERT INTO alerts(shuttle_id,level,title,message,created_at) VALUES(?,?,?,?,?)");
const insertETA = db.prepare("INSERT INTO eta_history(shuttle_id,stop_name,eta_seconds,confidence,model,created_at) VALUES(?,?,?,?,?,?)");

const routes = [
 { id:"RED", name:"Red Loop", color:"#c62036", stops:["Main Entrance","Academic Block","Uni Mall","Central Library","Hostel Gate"], coords:[[31.25510,75.70430],[31.25605,75.70610],[31.25715,75.70515],[31.25650,75.70295],[31.25480,75.70230]] },
 { id:"BLUE", name:"Blue Express", color:"#3478d4", stops:["Hostel Gate","Sports Complex","Auditorium","Academic Block"], coords:[[31.25480,75.70230],[31.25330,75.70410],[31.25455,75.70645],[31.25605,75.70610]] },
 { id:"GREEN", name:"Green Connector", color:"#159b79", stops:["North Parking","Uni Mall","Central Library","Medical Centre"], coords:[[31.25810,75.70400],[31.25715,75.70515],[31.25650,75.70295],[31.25395,75.70170]] }
];
const fleet = [
 { id:"LPU-01", route:"RED", progress:.12, speed:22, delay:0, source:"SIMULATED", lastGps:Date.now() },
 { id:"LPU-02", route:"BLUE", progress:.43, speed:19, delay:0, source:"SIMULATED", lastGps:Date.now() },
 { id:"LPU-03", route:"RED", progress:.69, speed:14, delay:360, source:"SIMULATED", lastGps:Date.now() },
 { id:"LPU-04", route:"GREEN", progress:.28, speed:25, delay:0, source:"SIMULATED", lastGps:Date.now() }
];
const processor = new GPSProcessor(routes);
const dropoutUntil = new Map();
const hardwareState = new Map();
const aiCache = new Map();
const alertCooldown = new Map();
let snapshot = null;
let lastPublished = 0;

function requireKey(expected, headerName, label) {
 return (req,res,next) => {
  if (expected && req.get(headerName) !== expected) return res.status(401).json({ error:`Invalid ${label} key` });
  next();
 };
}
const requireGPSKey = requireKey(GPS_API_KEY, "x-api-key", "GPS");
const requireAdminKey = requireKey(ADMIN_API_KEY, "x-admin-key", "admin");
function routeFor(id) { return routes.find(r => r.id === id); }
function busFor(id) { return fleet.find(b => b.id === id); }
function interpolate(route, progress) {
 const { lengths, total } = routeLengths(route);
 let target = Math.max(0,Math.min(.9999,progress))*total;
 for(let i=0;i<lengths.length;i++){
  if(target<=lengths[i]){
   const t=target/Math.max(lengths[i],.001),a=route.coords[i],b=route.coords[i+1];
   return {lat:a[0]+(b[0]-a[0])*t,lng:a[1]+(b[1]-a[1])*t};
  }
  target-=lengths[i];
 }
 const last=route.coords.at(-1); return {lat:last[0],lng:last[1]};
}
function nextStopFor(route, progress) {
 const idx=Math.min(route.stops.length-1,Math.max(1,Math.floor(progress*(route.stops.length-1))+1));
 return { index:idx, name:route.stops[idx] };
}
function addGPSRecord(bus, raw, result, speed, at, source) {
 insertGPS.run(bus.id,raw.lat,raw.lng,speed,at,result.position.lat,result.position.lng,result.confidence,result.offRoute?1:0,source);
}
function createAlert(bus, route, stopName) {
 const now=Date.now(), last=alertCooldown.get(bus.id)||0;
 if(bus.delay>120 && now-last>120000){
  insertAlert.run(bus.id,"warning",`${bus.id} is running late`,
   `${route.name}: estimated delay ${Math.round(bus.delay/60)} minutes. Next stop: ${stopName}.`,now);
  alertCooldown.set(bus.id,now);
 }
}
async function requestAI(bus, route, stopIndex, gpsAge) {
 const cached=aiCache.get(bus.id);
 if(cached && Date.now()-cached.at<15000) return cached.value;
 const distanceKm=Math.max(.025,routeLengths(route).total*(1-bus.progress)*Math.max(.1,(stopIndex/(route.stops.length-1)-bus.progress)/(1-bus.progress))/1000);
 try {
  const response=await fetch("http://127.0.0.1:8000/predict",{
   method:"POST",headers:{"Content-Type":"application/json"},
   body:JSON.stringify({distance_km:distanceKm,speed_kmh:bus.speed,dwell_seconds:stopIndex*18,
    delay_seconds:bus.delay,traffic_multiplier:1.08,gps_age_seconds:Math.min(120,gpsAge),slope_factor:.015}),
   signal:AbortSignal.timeout(1200)
  });
  if(!response.ok) return null;
  const data=await response.json();
  const value={seconds:Number(data.eta_seconds),confidence:.88,model:data.model||"Python ML"};
  if(Number.isFinite(value.seconds)){aiCache.set(bus.id,{at:Date.now(),value});return value;}
 } catch {}
 return null;
}
function buildSnapshot() {
 const now=Date.now();
 const shuttles=fleet.map(bus=>{
  const route=routeFor(bus.route);
  const hardware=hardwareState.get(bus.id);
  const hardwareAge=hardware?Math.max(0,(now-hardware.at)/1000):Infinity;
  let processed,raw,dropout=false;
  if(bus.source==="HARDWARE" && hardware){
   raw=hardware.raw;
   const forcedDropout=dropoutUntil.has(bus.id)&&dropoutUntil.get(bus.id)>now;
   if(hardwareAge<=15 && !forcedDropout){
    processed=hardware.result;
   } else if(hardwareAge<=120 || forcedDropout){
    dropout=true;
    processed=processor.process(bus.id,raw,bus.speed,now,true,bus.route);
   } else {
    dropout=true;
    processed={...hardware.result,confidence:.35,source:"SIGNAL_LOST"};
   }
  } else {
   const expected=interpolate(route,bus.progress);
   raw={lat:expected.lat+(Math.random()-.5)*.00012,lng:expected.lng+(Math.random()-.5)*.00012};
   if(!dropoutUntil.has(bus.id)&&Math.random()<.012)dropoutUntil.set(bus.id,now+45000);
   dropout=dropoutUntil.has(bus.id)&&dropoutUntil.get(bus.id)>now;
   if(!dropoutUntil.has(bus.id)||dropoutUntil.get(bus.id)<=now)dropoutUntil.delete(bus.id);
   processed=processor.process(bus.id,raw,bus.speed,now,dropout,bus.route);
  }
  if(bus.source==="HARDWARE" && processed.progress!==undefined) bus.progress=processed.progress;
  const {index:stopIndex,name:nextStop}=nextStopFor(route,bus.progress);
  const fallback=estimateETA({speed:bus.speed,delay:bus.delay,progress:bus.progress,route,stopIndex,confidence:processed.confidence});
  const ai=aiCache.get(bus.id);
  const eta=ai&&now-ai.at<15000?ai.value:fallback;
  requestAI(bus,route,stopIndex,dropout?hardwareAge:0);
  if(dropoutUntil.has(bus.id)&&dropoutUntil.get(bus.id)<=now)dropoutUntil.delete(bus.id);
  const gpsStatus=dropout?(hardwareAge>120?"Lost":"Recovering"):processed.confidence>.75?"Strong":"Fair";
  const state={
   id:bus.id,route:bus.route,routeName:route.name,position:processed.position,rawPosition:raw,
   progress:bus.progress,speed:bus.speed,status:bus.delay>0?"Delayed":"On time",
   delaySeconds:bus.delay,gpsStatus,gpsDropout:dropout,lastGpsAt:bus.lastGps,
   source:bus.source,nextStop,etaSeconds:eta.seconds,etaMinutes:Math.max(1,Math.round(eta.seconds/60)),
   confidence:eta.confidence,etaModel:eta.model||"Adaptive route ETA",
   upcoming:route.stops.slice(stopIndex).map((stop,i)=>({
    stop,etaMinutes:Math.max(1,Math.round((eta.seconds+i*145)/60)),
    confidence:Math.max(.5,eta.confidence-i*.035)
   }))
  };
  addGPSRecord(bus,raw,processed,bus.speed,now,bus.source);
  insertETA.run(bus.id,nextStop,eta.seconds,eta.confidence,eta.model||"Adaptive route ETA",now);
  createAlert(bus,route,nextStop);
  return state;
 });
 return {shuttles,routes,serverTime:now,mode:fleet.some(b=>b.source==="HARDWARE")?"MIXED / HARDWARE GPS":"DEMO GPS FEED",
  metrics:{active:shuttles.length,delayed:shuttles.filter(s=>s.status==="Delayed").length,
   gpsHealth:Math.round(shuttles.filter(s=>s.gpsStatus==="Strong"||s.gpsStatus==="Fair").length/Math.max(1,shuttles.length)*100),etaTarget:80}};
}
function publish() { snapshot=buildSnapshot();lastPublished=Date.now();io.emit("fleet:update",snapshot); }
function advanceSimulation() {
 for(const bus of fleet){
  if(bus.source==="SIMULATED" && !(dropoutUntil.has(bus.id)&&dropoutUntil.get(bus.id)>Date.now())){
   const route=routeFor(bus.route),lengthKm=routeLengths(route).total/1000;
   const stepKm=(bus.speed/3600)*(TICK_MS/1000);
   bus.progress=(bus.progress+stepKm/Math.max(.1,lengthKm))%0.98;
  }
  if(bus.delay>0)bus.delay=Math.max(0,bus.delay-1);
 }
 publish();
}
publish();
setInterval(advanceSimulation,TICK_MS).unref();

app.get("/api/health",async(req,res)=>{
 let ai="offline";
 try{const r=await fetch("http://127.0.0.1:8000/health",{signal:AbortSignal.timeout(700)});if(r.ok)ai="online";}catch{}
 res.json({ok:true,service:"SmartShuttle API",database:"SQLite",ai,time:Date.now(),uptime:Math.round(process.uptime())});
});
app.get("/api/state",(req,res)=>res.json(snapshot));
app.get("/api/routes",(req,res)=>res.json(routes));
app.get("/api/shuttles",(req,res)=>res.json(snapshot.shuttles));
app.get("/api/alerts",(req,res)=>res.json(db.prepare("SELECT * FROM alerts ORDER BY created_at DESC LIMIT 50").all()));
app.get("/api/analytics",(req,res)=>{
 const day=Date.now()-86400000;
 const gps=db.prepare("SELECT COUNT(*) points, COUNT(DISTINCT shuttle_id) shuttles FROM gps_points WHERE recorded_at>?").get(day);
 const eta=db.prepare("SELECT AVG(confidence) confidence,AVG(eta_seconds) avg_eta FROM eta_history WHERE created_at>?").get(day);
 const evals=db.prepare("SELECT COUNT(*) total,SUM(CASE WHEN ABS(error_seconds)<=120 THEN 1 ELSE 0 END) within_target,AVG(ABS(error_seconds)) mae FROM eta_evaluations").get();
 res.json({gpsPoints:gps.points||0,activeGpsShuttles:gps.shuttles||0,avgEtaSeconds:Math.round(eta.avg_eta||0),
  confidence:Math.round((eta.confidence||.8)*100),target:80,evaluatedPredictions:evals.total||0,
  withinTwoMinutesPercent:evals.total?Math.round((evals.within_target/evals.total)*100):null,
  meanAbsoluteErrorSeconds:evals.total?Math.round(evals.mae):null,
  disclaimer:"Use ground-truth arrival labels to evaluate actual prediction performance. Simulated feed is not field validation."});
});
app.get("/api/shuttles/:id/history",(req,res)=>{
 if(!busFor(req.params.id))return res.status(404).json({error:"Unknown shuttle"});
 const rows=db.prepare("SELECT lat,lng,matched_lat,matched_lng,speed,confidence,off_route,source,recorded_at FROM gps_points WHERE shuttle_id=? ORDER BY recorded_at DESC LIMIT 100").all(req.params.id);
 res.json(rows.reverse());
});
app.post("/api/gps",requireGPSKey,(req,res)=>{
 const {shuttleId,lat,lng,speed,source="HARDWARE",timestamp}=req.body||{};
 const bus=busFor(shuttleId);
 if(!bus)return res.status(404).json({error:"Unknown shuttleId"});
 if(!Number.isFinite(lat)||!Number.isFinite(lng)||lat < -90||lat>90||lng < -180||lng>180)
  return res.status(400).json({error:"lat/lng must be valid numeric coordinates"});
 const safeSpeed=Number(speed??bus.speed);
 if(!Number.isFinite(safeSpeed)||safeSpeed<0||safeSpeed>120)return res.status(400).json({error:"speed must be between 0 and 120 km/h"});
 const at=Number.isFinite(timestamp)?timestamp:Date.now();
 if(Math.abs(Date.now()-at)>300000)return res.status(400).json({error:"GPS timestamp must be within 5 minutes of server time"});
 const raw={lat,lng},result=processor.process(shuttleId,raw,safeSpeed,Date.now(),false,bus.route);
 bus.speed=safeSpeed;bus.source=String(source).slice(0,32);bus.lastGps=at;
 if(result.progress!==undefined)bus.progress=result.progress;
 hardwareState.set(shuttleId,{raw,result,at:Date.now()});
 addGPSRecord(bus,raw,result,safeSpeed,at,bus.source);
 publish();
 res.status(202).json({accepted:true,shuttleId,matchedPosition:result.position,confidence:result.confidence,
  offRoute:result.offRoute,route:result.routeId,progress:result.progress,source:result.source});
});
app.post("/api/simulate/dropout/:id",(req,res)=>{
 const id=req.params.id;if(!busFor(id))return res.status(404).json({error:"Unknown shuttle"});
 const seconds=Math.min(120,Math.max(10,Number(req.body?.seconds)||120));
 const bus=busFor(id);if(bus.source==="HARDWARE"&&!hardwareState.has(id))return res.status(409).json({error:"No trusted GPS point exists for this shuttle yet"});
 dropoutUntil.set(id,Date.now()+seconds*1000);publish();
 res.json({ok:true,shuttleId:id,dropoutSeconds:seconds,message:"GPS dropout simulation started; dead reckoning remains active."});
});
app.post("/api/simulate/delay/:id",(req,res)=>{
 const bus=busFor(req.params.id);if(!bus)return res.status(404).json({error:"Unknown shuttle"});
 const delay=Math.max(60,Math.min(3600,Number(req.body?.delaySeconds)||360));
 bus.delay=delay;alertCooldown.delete(bus.id);publish();
 res.json({ok:true,shuttleId:bus.id,delaySeconds:bus.delay});
});
app.post("/api/alerts/:id/read",(req,res)=>{
 const info=db.prepare("UPDATE alerts SET read=1 WHERE id=?").run(Number(req.params.id));
 if(!info.changes)return res.status(404).json({error:"Alert not found"});
 res.json({ok:true});
});
app.post("/api/evaluations",requireAdminKey,(req,res)=>{
 const {shuttleId,stopName="",predictedSeconds,actualSeconds}=req.body||{};
 if(typeof shuttleId!=="string"||!Number.isFinite(predictedSeconds)||!Number.isFinite(actualSeconds)||predictedSeconds<0||actualSeconds<0)
  return res.status(400).json({error:"shuttleId, predictedSeconds and actualSeconds are required"});
 const error=predictedSeconds-actualSeconds;
 const result=db.prepare("INSERT INTO eta_evaluations(shuttle_id,stop_name,predicted_seconds,actual_seconds,error_seconds,created_at) VALUES(?,?,?,?,?,?)")
  .run(shuttleId,String(stopName).slice(0,100),predictedSeconds,actualSeconds,error,Date.now());
 res.status(201).json({ok:true,id:result.lastInsertRowid,errorSeconds:error,withinTwoMinutes:Math.abs(error)<=120});
});
app.post("/api/admin/shuttles",requireAdminKey,(req,res)=>{
 const {id,route}=req.body||{};
 if(typeof id!=="string"||!/^[A-Z0-9-]{3,20}$/.test(id)||!routeFor(route)||busFor(id))
  return res.status(400).json({error:"Provide a unique shuttle ID (3–20 letters/numbers) and valid route"});
 fleet.push({id,route,progress:.05,speed:20,delay:0,source:"SIMULATED",lastGps:Date.now()});
 publish();res.status(201).json({ok:true,id});
});
app.delete("/api/admin/shuttles/:id",requireAdminKey,(req,res)=>{
 const i=fleet.findIndex(b=>b.id===req.params.id);
 if(i<0)return res.status(404).json({error:"Shuttle not found"});
 fleet.splice(i,1);hardwareState.delete(req.params.id);dropoutUntil.delete(req.params.id);aiCache.delete(req.params.id);
 publish();res.json({ok:true});
});
app.get("/api/admin/config",(req,res)=>res.json({routes:routes.map(r=>({id:r.id,name:r.name,stops:r.stops.length})),fleet:fleet.length,
 gpsKeyRequired:!!GPS_API_KEY,adminKeyRequired:!!ADMIN_API_KEY,aiUrl:"http://127.0.0.1:8000"}));

io.on("connection",socket=>{
 socket.emit("fleet:update",snapshot);
 socket.emit("system:connected",{ok:true,at:Date.now()});
});
app.use((err,req,res,next)=>{
 console.error(err);
 res.status(500).json({error:"Internal server error"});
});
server.listen(PORT,()=>console.log(`SmartShuttle API ready at http://localhost:${PORT}`));
function shutdown(){server.close(()=>{db.close();process.exit(0);});}
process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
