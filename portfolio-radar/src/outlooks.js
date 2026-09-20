import {OutlookProvider} from './outlook-provider.js';
import {outlookAssets,largestHolding,outlookBody} from './outlook-format.js';
import {cachedMarket} from './first-look.js';
import {newsDay} from './daily.js';

export class Outlooks{
 constructor(radar){this.radar=radar;this.db=radar.db;}
 async records(assets){
  if(!assets.length)return {};
  const results=await this.db.rpc('pr_outlook_latest',{p_keys:assets.map(a=>a.key)});
  return Object.fromEntries((results||[]).map(r=>[r.asset_key,r.data]));
 }
 async body(user,page=0,access=null){
  access ||= await this.radar.billing.access(user);
  const accounts=await this.radar.insights.accounts(user),assets=outlookAssets(accounts),now=new Date();
  const [records,market]=await Promise.all([this.records(assets),cachedMarket(this.db,assets,now)]);
  for(const a of assets)if(!market.quotes[a.key]&&records[a.key]?.quote)market.quotes[a.key]=records[a.key].quote;
  market.fx ||= Object.values(records).map(r=>r.fx).filter(f=>f?.status==='ok').sort((a,b)=>String(b.as_of).localeCompare(String(a.as_of)))[0];
  return outlookBody(user,assets,records,largestHolding(accounts,market,now),access,page,now);
 }
 async open(job,user,page=0){
  const body=await this.body(user,page);
  await this.radar.insights.event(user,'outlook_open',job.id);
  // Re-render on actual delivery: a paid page queued before expiry must not leak
  // other assets after expiry, edits or account deletion.
  await this.db.post('pr_outbox',{dedup_key:job.id+':outlook:'+page,user_id:user,body:{...body,_portfolius:{outlook:true,page}}},{on_conflict:'dedup_key'},'resolution=ignore-duplicates,return=minimal');
 }
 async work(){
  const token=crypto.randomUUID();if(!await this.db.rpc('pr_lock',{p_token:token,p_lane:3}))return {busy:true};
  const started=Date.now();let processed=0;
  try{
   await this.db.rpc('pr_outlook_schedule');
   while(processed<3&&Date.now()-started<65000){
    const job=(await this.db.rpc('pr_outlook_claim'))?.[0];if(!job)break;
    try{
     const previous=(await this.records([job.asset]))[job.asset_key];
     const provider=new OutlookProvider(this.db),data=await provider.collect(job.asset,previous);
     await this.db.post('pr_outlook_snapshots',{asset_key:job.asset_key,service_day:job.service_day,data},{on_conflict:'asset_key,service_day'},'resolution=ignore-duplicates,return=minimal');
     await this.db.patch('pr_outlook_jobs',{state:'done',finished_at:new Date().toISOString()},{asset_key:'eq.'+job.asset_key,service_day:'eq.'+job.service_day,state:'eq.running'});
    }catch{
     console.error('outlook_collection_failed');
     await this.db.patch('pr_outlook_jobs',{state:'failed',finished_at:new Date().toISOString()},{asset_key:'eq.'+job.asset_key,service_day:'eq.'+job.service_day,state:'eq.running'});
    }
    processed++;
   }return {processed,service_day:newsDay()};
  }finally{await this.db.rpc('pr_unlock',{p_token:token,p_lane:3});}
 }
}
