// GPS cleaning + route map matching + short-gap dead reckoning.
const haversine=(a,b)=>{const R=6371000,toRad=x=>x*Math.PI/180,dLat=toRad(b.lat-a.lat),dLng=toRad(b.lng-a.lng),q=Math.sin(dLat/2)**2+Math.cos(toRad(a.lat))*Math.cos(toRad(b.lat))*Math.sin(dLng/2)**2;return 2*R*Math.asin(Math.sqrt(q));};
function project(point,a,b){const meanLat=(a[0]+b[0])/2*Math.PI/180, sx=111320*Math.cos(meanLat),sy=110540, ax=a[1]*sx,ay=a[0]*sy,bx=b[1]*sx,by=b[0]*sy,px=point.lng*sx,py=point.lat*sy,dx=bx-ax,dy=by-ay,t=Math.max(0,Math.min(1,((px-ax)*dx+(py-ay)*dy)/(dx*dx+dy*dy||1)));const x=ax+t*dx,y=ay+t*dy;return {lat:y/sy,lng:x/sx,distance:Math.hypot(px-x,py-y),t};}
class GPSProcessor{
 constructor(routes){this.routes=routes;this.memory=new Map();}
 nearest(point){let best=null;for(const route of this.routes){for(let i=0;i<route.coords.length-1;i++){const p=project(point,route.coords[i],route.coords[i+1]);if(!best||p.distance<best.distance)best={...p,routeId:route.id,segment:i};}}return best;}
 process(id,raw,speed,now,dropout){
  const prev=this.memory.get(id);
  if(dropout&&prev){
   const dt=Math.min(120,(now-prev.time)/1000),meters=(speed||18)/3.6*dt;
   const route=this.routes.find(r=>r.id===prev.routeId),seg=Math.min(prev.segment||0,route.coords.length-2);
   const a=route.coords[seg],b=route.coords[seg+1],latScale=111320,lngScale=111320*Math.cos(prev.position.lat*Math.PI/180);
   const dx=(b[1]-a[1])*lngScale,dy=(b[0]-a[0])*latScale,len=Math.max(1,Math.hypot(dx,dy)),fraction=meters/len;
   const pos={lat:prev.position.lat+(dy/len*fraction)/latScale,lng:prev.position.lng+(dx/len*fraction)/lngScale};
   this.memory.set(id,{...prev,position:pos,time:now});
   return {position:pos,confidence:Math.max(.55,.91-Math.min(120,dt)*.0028),offRoute:false,source:"DEAD_RECKONING",estimatedMeters:meters};
  }
  const match=this.nearest(raw);const jump=prev?haversine(prev.raw,raw):0;const plausible=(speed||20)/3.6*Math.max(.5,(now-(prev?.time||now))/1000)+35;
  const outlier=prev&&jump>Math.max(120,plausible*2.5);let pos=outlier?prev.position:{lat:match.lat,lng:match.lng};
  if(prev&&!outlier){pos={lat:prev.position.lat*.35+pos.lat*.65,lng:prev.position.lng*.35+pos.lng*.65};}
  const confidence=Math.max(.35,Math.min(.99,1-match.distance/100-(outlier?.35:0)));
  this.memory.set(id,{position:pos,raw,time:now,routeId:match.routeId,segment:match.segment});
  return {position:pos,confidence,offRoute:match.distance>55||outlier,source:"MAP_MATCHED"};
 }
}
function estimateETA({speed,delay,progress,route,stopIndex,confidence}){
 const routeMeters=route.coords.slice(0,-1).reduce((sum,p,i)=>sum+haversine({lat:p[0],lng:p[1]},{lat:route.coords[i+1][0],lng:route.coords[i+1][1]}),0);
 const remaining=routeMeters*(1-progress)*Math.max(.18,stopIndex/(route.stops.length-1));
 const kmh=Math.max(7,Math.min(38,speed||18));
 const travel=remaining/(kmh/3.6);
 const dwell=Math.max(0,stopIndex)*18;
 const historical=travel*.12; // segment-history prior; replaced by learned values when available
 const seconds=Math.max(35,travel*.78+historical+dwell+(delay||0));
 return {seconds,confidence:Math.max(.52,Math.min(.97,(confidence||.8)*.94))};
}
module.exports={GPSProcessor,estimateETA,haversine};
