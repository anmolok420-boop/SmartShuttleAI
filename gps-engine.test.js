const test = require("node:test");
const assert = require("node:assert/strict");
const { GPSProcessor, estimateETA } = require("../src/gps-engine");

const routes=[{
 id:"R",name:"Test route",stops:["A","B","C"],
 coords:[[31.0000,75.0000],[31.0010,75.0000],[31.0020,75.0000]]
}];

test("GPS readings are snapped to the configured route",()=>{
 const gps=new GPSProcessor(routes);
 const result=gps.process("BUS-1",{lat:31.0005,lng:75.00008},20,1000,false,"R");
 assert.equal(result.routeId,"R");
 assert.ok(Math.abs(result.position.lng-75)<0.00001);
 assert.ok(result.progress>0&&result.progress<1);
});

test("GPS dropout returns a dead-reckoned position for a short interruption",()=>{
 const gps=new GPSProcessor(routes);
 const first=gps.process("BUS-1",{lat:31.0005,lng:75.0000},20,1000,false,"R");
 const recovered=gps.process("BUS-1",{lat:31.0005,lng:75.0000},20,6000,true,"R");
 assert.equal(recovered.source,"DEAD_RECKONING");
 assert.ok(recovered.position.lat>first.position.lat);
 assert.ok(recovered.confidence>=0.55);
});

test("ETA is positive and includes dwell and delay",()=>{
 const fast=estimateETA({speed:25,delay:0,progress:.1,route:routes[0],stopIndex:1});
 const delayed=estimateETA({speed:25,delay:180,progress:.1,route:routes[0],stopIndex:1});
 assert.ok(fast.seconds>0);
 assert.ok(delayed.seconds>=fast.seconds+179);
});
