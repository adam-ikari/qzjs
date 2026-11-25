"use strict";
// AOT 产品负载的纯 JS 镜像；run.js 与 baseline_ci.mjs 共用，避免基线口径漂移。
const LOADS = [["computeWork", 200000], ["jsonWork", 30000], ["validationWork", 200000], ["hpackIntBatch", 200000], ["varintBatch", 200000], ["hashBatch", 200000], ["policyGate", 20000]];
const source = `
function computeWork(n){ let s=0; for(let i=0;i<n;i++){ const a=i%1000; const v=a*a; s=(s+v-((v/7)|0)+((i*3)%13))%1000003; } return s; }
function jsonWork(n){ const src='{"id":7,"name":"alice","tags":["a","b","c"],"vals":[1,2,3,4]}'; let t=0;
  for(let i=0;i<n;i++){ const o=JSON.parse(src); const m={id:o.id+i,name:o.name,total:o.vals[0]+o.vals[1]+o.vals[2]+o.vals[3]}; t=t+m.id+m.total+m.name.length; } return t; }
function validate(v){ if(v===null||typeof v!=="object") return -1; let e=0;
  if(typeof v.name!=="string") e=e+1; else if(v.name.length<2) e=e+1; else if(v.name.length>20) e=e+1;
  if(typeof v.age!=="number") e=e+1; else if(v.age<0) e=e+1; else if(v.age>150) e=e+1;
  if(typeof v.email!=="string") e=e+1; else if(v.email.indexOf("@")<0) e=e+1; return e; }
function validationWork(n){ const good={name:"Alice",age:30,email:"a@b.com"}; const bad={name:"",age:200,email:"nope"}; let t=0;
  for(let i=0;i<n;i++){ if((i%2)===0) t=t+validate(good); else t=t+validate(bad); } return t; }
function hpackIntBatch(n){ let t=0; for(let i=0;i<n;i++){ let v=(i*7919)>>>0; let len=1; while(v>0x7f){ v=v>>>7; len=len+1; } t=t+len; } return t; }
function varintBatch(n){ let t=0; for(let i=0;i<n;i++){ let v=(i*104729)>>>0; let len=1; while(v>0x7f){ v=v>>>7; len=len+1; } t=t+len; } return t; }
function hashBatch(n){ let h=2166136261%16777216; for(let i=0;i<n;i++){ h=(h^(i*7919))%16777216; h=(h*33)%16777216; } return h; }
function policyScore(c){ let s=0; if(c.retry<0)s=s+1; if(c.timeout>5000)s=s+1; if(c.name.length<3)s=s+1; return s; }
function policyGate(n){ const strict={retry:3,timeout:1000,name:"strict-mode"},loose={retry:-1,timeout:9000,name:"x"}; let t=0; for(let i=0;i<n;i++){ if((i%2)===0)t=t+policyScore(strict); else t=t+policyScore(loose); } return t; }
`;
module.exports = { LOADS, source };
