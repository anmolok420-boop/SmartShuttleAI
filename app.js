const $=s=>document.querySelector(s), $$=s=>[...document.querySelectorAll(s)];
let state=null,routes=[],map=null,markers={},routeLines=[],stopMarkers=[],selected="LPU-01",socket=null,chart=null;
const toast=m=>{const t=$("#toast");t.textContent=m;t.classList.add("show");clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>t.classList.remove("show"),3000)};
async function api(url,options={}){const r=await fetch(url,{headers:{"Content-Type":"application/json"},...options});if(!r.ok)throw new Error((await r.json()).error||"Request failed");return r.json()}
function nav(page){$$(".page").forEach(x=>x.classList.toggle("show",x.id===page));$$(".nav").forEach(x=>x.classList.toggle("active",x.dataset.page===page));$("#crumb").textContent=({dashboard:"Overview",tracking:"Live shuttle tracking",routes:"Routes & bus stops",alerts:"Alerts & notices",analytics:"AI performance",admin:"Transport control"})[page];$("#sidebar").classList.remove("open");if(page==="tracking"&&map)setTimeout(()=>map.invalidateSize(),150);if(page==="analytics")loadAnalytics();window.scrollTo({top:0,behavior:"smooth"})}
$$("[data-page]").forEach(b=>b.addEventListener("click",()=>nav(b.dataset.page)));
$("#menu").onclick=()=>$("#sidebar").classList.toggle("open");
$("#theme").onclick=()=>{document.body.classList.toggle("dark");toast("Display theme updated")};
$("#help").onclick=()=>toast("GPS → clean & map-match → ETA prediction → student alert");
function fmtEta(n){return n<=1?"< 1 min":`${n} min`}
function render(s){state=s;routes=s.routes;const buses=s.shuttles;
 $("#activeMetric").innerHTML=`${String(buses.length).padStart(2,"0")} <small>/ 06</small>`;$("#delayMetric").textContent=String(buses.filter(x=>x.status==="Delayed").length).padStart(2,"0");$("#gpsHealth").textContent=s.metrics.gpsHealth+"%";$("#gpsBar").style.width=s.metrics.gpsHealth+"%";$("#syncTime").textContent="just now";$("#fleetCount").textContent=`${buses.length} ACTIVE`;
 $("#arrivals").innerHTML=buses.slice(0,4).map(b=>`<div class="arrival"><div class="bus-icon">▰</div><div><b>${b.id} · ${b.routeName}</b><small>${b.nextStop} · ${b.gpsStatus==="Recovering"?"GPS recovery active":"Live route matched"}</small></div><div class="eta"><strong>${fmtEta(b.etaMinutes)}</strong><small>next stop</small><span class="pill ${b.status==="Delayed"?"late":""}">${b.status}</span></div></div>`).join("");
 $("#routeCards").innerHTML=routes.map(r=>`<div class="route-mini" data-route="${r.id}"><b><i class="route-color" style="background:${r.color}"></i>${r.name}</b><small>${r.stops.length} stops</small><strong>${r.stops.length*3+2} min</strong></div>`).join("");$$(".route-mini").forEach(x=>x.onclick=()=>{nav("routes");$("#routeFilter").value=x.dataset.route;renderRoutes()});
 $("#noticePreview").innerHTML=`<div class="notice"><span class="notice-icon">!</span><div><b>${buses.find(b=>b.status==="Delayed")?.id||"Fleet"} service update</b><p>${buses.some(b=>b.status==="Delayed")?"A shuttle is delayed. Check live predictions before leaving.":"All campus shuttle services are on schedule."}</p></div></div>`;
 renderFleet();renderRoutes();renderAdmin();renderMap(s);if(!selected||!buses.some(b=>b.id===selected))selected=buses[0]?.id;selectShuttle(selected);$("#alertBadge").textContent=document.querySelectorAll(".notification.unread").length||"";
}
function renderFleet(){const buses=state?.shuttles||[];$("#fleet").innerHTML=buses.map(b=>`<div class="fleet-item" data-id="${b.id}"><div class="fleet-icon">▰</div><div class="fleet-name"><b>${b.id} · ${b.route}</b><small>${b.nextStop} · ${b.gpsStatus}</small></div><div class="fleet-eta"><b>${fmtEta(b.etaMinutes)}</b><small>${b.status}</small></div></div>`).join("");$$(".fleet-item").forEach(x=>x.onclick=()=>selectShuttle(x.dataset.id))}
function selectShuttle(id){selected=id;const b=state?.shuttles.find(x=>x.id===id);if(!b)return;$("#shuttleDetail").innerHTML=`<div class="detail-grid"><div><b>${b.id} · ${b.routeName}</b><small>${b.status} · ${b.source} feed</small></div><div><b>${fmtEta(b.etaMinutes)}</b><small>Next stop · ${b.nextStop}</small></div><div><b>${Math.round(b.confidence*100)}%</b><small>Prediction confidence</small></div><div><b>${b.gpsStatus}</b><small>${b.gpsDropout?"Position is estimated":"GPS signal status"}</small></div><div><b>${b.etaModel||"Adaptive fallback"}</b><small>ETA prediction engine</small></div></div><div style="margin-top:15px"><b style="font-size:9px">Predicted arrivals</b><div class="eta-stops">${b.upcoming.slice(0,4).map(x=>`<span style="display:inline-block;margin:9px 16px 0 0;font-size:8px;color:#7d8998">${x.stop} <b style="color:#b51e35">${x.etaMinutes}m</b></span>`).join("")}</div></div>`;if(map&&markers[id]){map.setView(routePixelPoint(b.route,b.progress),.25);markers[id].openPopup()}}
function renderRoutes(){const f=$("#routeFilter").value;$("#routeDirectory").innerHTML=routes.filter(r=>f==="all"||r.id===f).map(r=>`<article class="route-detail"><div class="route-detail-head"><div class="route-name"><div class="route-symbol" style="background:${r.color}18;color:${r.color}">↗</div><div><b>${r.name}</b><small>Campus shuttle service · ${r.id}</small></div></div><span>● ACTIVE</span></div><div class="route-meta"><span>STOPS<b>${r.stops.length}</b></span><span>FREQUENCY<b>Every 10–15 min</b></span><span>SERVICE<b>Campus loop</b></span></div>${r.stops.map((s,i)=>`<div class="stop"><i style="border-color:${r.color}"></i><span>${s}</span><small>${i===0?"First stop":i===r.stops.length-1?"Last stop":`Stop 0${i+1}`}</small></div>`).join("")}</article>`).join("")}
$("#routeFilter").onchange=renderRoutes;
// Pixel-coordinate overlays are aligned to the campus map image supplied by the user.
// Coordinates are approximate visual route traces, not surveyed GPS geometry.
const CAMPUS_ROUTES={
 RED:{color:"#c62036",path:[[570,800],[535,750],[490,690],[475,630],[515,585],[555,540],[530,495],[480,445],[430,395],[470,350],[535,310],[560,270],[510,230],[455,195],[395,180],[335,205],[275,240],[205,260],[145,230],[85,195]],stops:["Main Entrance","Academic Block","Uni Mall","Central Library","Hostel Gate"]},
 BLUE:{color:"#3478d4",path:[[570,800],[650,755],[730,710],[810,665],[900,625],[980,590],[910,550],[820,510],[735,465],[650,425],[575,385],[520,350],[470,315]],stops:["Hostel Gate","Sports Complex","Auditorium","Academic Block"]},
 GREEN:{color:"#159b79",path:[[145,230],[230,190],[315,155],[405,180],[485,225],[555,275],[620,325],[580,375],[520,420],[465,390],[410,340]],stops:["North Parking","Uni Mall","Central Library","Medical Centre"]}
};
function routePixelPoint(routeId,progress){
 const pts=CAMPUS_ROUTES[routeId]?.path||CAMPUS_ROUTES.RED.path;
 const lengths=[];let total=0;
 for(let i=0;i<pts.length-1;i++){const d=Math.hypot(pts[i+1][0]-pts[i][0],pts[i+1][1]-pts[i][1]);lengths.push(d);total+=d;}
 let target=Math.max(0,Math.min(.999,progress))*total;
 for(let i=0;i<lengths.length;i++){if(target<=lengths[i]){const t=target/lengths[i];return [pts[i][1]+(pts[i+1][1]-pts[i][1])*t,pts[i][0]+(pts[i+1][0]-pts[i][0])*t];}target-=lengths[i];}
 return [pts.at(-1)[1],pts.at(-1)[0]];
}
function renderMap(s){
 if(!map||!window.L)return;
 for(const b of s.shuttles){
  const pos=routePixelPoint(b.route,b.progress);
  if(!markers[b.id])markers[b.id]=L.marker(pos,{icon:busIcon(b)}).addTo(map).on("click",()=>selectShuttle(b.id));
  else {markers[b.id].setLatLng(pos);markers[b.id].setIcon(busIcon(b));}
  markers[b.id].bindPopup(`<b>${b.id} · ${b.routeName}</b><br>${b.etaMinutes} min to ${b.nextStop}<br>${b.gpsStatus}<br><small>${b.source} feed</small>`);
 }
}
function busIcon(b){return L.divIcon({className:"",html:`<div class="bus-marker ${b.status==="Delayed"?"delayed":b.gpsDropout?"recover":""}">▰</div>`,iconSize:[25,25],iconAnchor:[12,12]})}
function initMap(){
 if(!window.L)return;
 const bounds=[[0,0],[1062,1086]];
 map=L.map("map",{crs:L.CRS.Simple,minZoom:-1.5,maxZoom:1.5,zoomSnap:.25,zoomDelta:.25,attributionControl:false}).fitBounds(bounds);
 L.imageOverlay("/lpu-campus-map.jpg",bounds).addTo(map);
 L.control.attribution({prefix:false}).addAttribution("Campus map image supplied by project owner").addTo(map);
 Object.entries(CAMPUS_ROUTES).forEach(([id,r])=>{
  const latlngs=r.path.map(([x,y])=>[y,x]);
  const line=L.polyline(latlngs,{color:r.color,weight:5,opacity:.88,lineCap:"round",lineJoin:"round"}).addTo(map);
  routeLines.push(line);
  const step=Math.max(1,Math.floor((r.path.length-1)/r.stops.length));
  r.stops.forEach((name,i)=>{
   const pt=r.path[Math.min(r.path.length-1,i*step)];
   const marker=L.marker([pt[1],pt[0]],{icon:L.divIcon({className:"",html:'<div class="stop-marker"></div>',iconSize:[10,10],iconAnchor:[5,5]})}).addTo(map).bindPopup(`<b>${name}</b><br>${id} route stop`);
   stopMarkers.push(marker);
  });
 });
 map.setMaxBounds(bounds);map.fitBounds(bounds);
 if(state)renderMap(state);
}
$("#fit").onclick=()=>{if(map)map.fitBounds([[0,0],[1062,1086]])};
$("#layers").onclick=()=>{routeLines.forEach(l=>map.hasLayer(l)?map.removeLayer(l):l.addTo(map));toast("Route overlays toggled")};
async function simulateDropout(){const id=selected||state?.shuttles[0]?.id;if(!id)return;await api(`/api/simulate/dropout/${id}`,{method:"POST",body:JSON.stringify({seconds:120})});toast(`${id}: 120-second GPS dropout started. Recovery is active.`)}
$("#dropout").onclick=simulateDropout;$("#adminDropout").onclick=simulateDropout;
$("#adminDelay").onclick=async()=>{const b=state?.shuttles.find(x=>x.id==="LPU-03")||state?.shuttles[0];if(!b)return;await api(`/api/simulate/delay/${b.id}`,{method:"POST",body:JSON.stringify({delaySeconds:360})});toast(`Six-minute delay applied to ${b.id}; backend alert generated.`)};
async function loadAlerts(){try{const a=await api("/api/alerts");$("#alertsList").innerHTML=a.length?a.map(x=>`<div class="notification ${x.read? "":"unread"}"><div class="notification-icon">${x.level==="warning"?"!":"↗"}</div><div><b>${x.title}</b><p>${x.message}</p><small>${new Date(x.created_at).toLocaleString()}</small></div></div>`).join(""):'<p class="muted">No alerts yet. Delay events appear here automatically.</p>';}catch(e){toast(e.message)}}
$("#readAll").onclick=async()=>{const a=await api("/api/alerts");await Promise.all(a.filter(x=>!x.read).map(x=>api(`/api/alerts/${x.id}/read`,{method:"POST"})));loadAlerts();toast("Notifications marked as read")};
async function loadAnalytics(){try{const a=await api("/api/analytics");$("#pointsMetric").textContent=a.gpsPoints;$("#confidenceMetric").textContent=a.confidence+"%";if(chart)chart.destroy();if(window.Chart)chart=new Chart($("#gpsChart"),{type:"bar",data:{labels:["Current fleet"],datasets:[{data:[state?.metrics.gpsHealth||98],backgroundColor:["#b51e35"],borderRadius:5,barThickness:42}]},options:{plugins:{legend:{display:false}},scales:{y:{min:0,max:100,ticks:{callback:v=>v+"%"}},x:{grid:{display:false}}}}});}catch(e){console.warn(e)}}
async function renderAdmin(){if(!state)return;$("#adminTable").innerHTML=state.shuttles.map(b=>`<tr><td><b>${b.id}</b></td><td>${b.route}</td><td><span class="table-status ${b.status==="Delayed"?"late":""}">${b.status}</span></td><td>${b.source}</td><td><button class="table-action" data-remove="${b.id}">Remove</button></td></tr>`).join("");$$("[data-remove]").forEach(x=>x.onclick=async()=>{try{await api(`/api/admin/shuttles/${x.dataset.remove}`,{method:"DELETE"});toast("Shuttle removed")}catch(e){toast(e.message)}})}
$("#addBus").onclick=()=>$("#modal").classList.add("open");$("#modalClose").onclick=()=>$("#modal").classList.remove("open");$("#saveBus").onclick=async()=>{try{await api("/api/admin/shuttles",{method:"POST",body:JSON.stringify({id:$("#newId").value.trim().toUpperCase(),route:$("#newRoute").value})});$("#modal").classList.remove("open");$("#newId").value="";toast("New shuttle registered in backend")}catch(e){toast(e.message)}};
$("#reset").onclick=()=>toast("Demo fleet state is managed by the running server. Restart npm start to reset initial values.");
async function checkHealth(){try{const h=await api("/api/health");$("#apiHealth").textContent="ONLINE";$("#apiStatus").textContent="● Online";$("#socketStatus").textContent=socket?.connected?"● Connected":"Connecting…";$("#dbStatus").textContent=h.database+" connected";}catch(e){$("#apiHealth").textContent="OFFLINE";$("#apiStatus").textContent="Unavailable";$("#dbStatus").textContent="Unavailable";toast("Backend is not reachable")}}
$("#checkHealth").onclick=checkHealth;
function connect(){socket=io();socket.on("connect",()=>{$("#socketStatus").textContent="● Connected";});socket.on("disconnect",()=>{$("#socketStatus").textContent="Disconnected";});socket.on("fleet:update",s=>{render(s);});}
async function boot(){try{const [s,rs]=await Promise.all([api("/api/state"),api("/api/routes")]);routes=rs;render(s);initMap();connect();checkHealth();loadAlerts();setInterval(()=>{$("#clock").textContent=new Date().toLocaleTimeString("en-IN",{hour12:false})},1000);setInterval(loadAlerts,15000);}catch(e){$("#apiHealth").textContent="OFFLINE";toast("Start backend with npm install && npm start. "+e.message);}}
boot();
