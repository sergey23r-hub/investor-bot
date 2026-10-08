export const MEMBERSHIP_URL='https://micbot.vercel.app/integrations/portfolius/membership';
export const COMMUNITY_IDS=[-1002230180865,-1002094215821];
export const COMMUNITY_CONSENT='rub-weekly-community-v2';
export const BASE_AMOUNT=29000,COMMUNITY_AMOUNT=14500;
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export async function membership(config,user,fetcher=fetch){
 if(!Number.isSafeInteger(user)||user<=0||!config?.gateway_signing_key)throw Error('membership_unavailable');
 const key=await crypto.subtle.importKey('jwk',JSON.parse(config.gateway_signing_key),{name:'Ed25519'},false,['sign']);
 const raw=new TextEncoder().encode(JSON.stringify({method:'CommunityMembership',params:{user_id:user},timestamp:Date.now(),request_id:crypto.randomUUID()}));
 const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',key,raw));
 let result;
 try{
  const response=await fetcher(MEMBERSHIP_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:b64(raw),signature:b64(signature)}),signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw Error();result=await response.json();
 }catch{throw Error('membership_unavailable');}
 const checks=result?.checks,age=Date.now()-Date.parse(result?.checked_at);
 if(result?.user_id!==user||!Array.isArray(checks)||checks.length!==2||new Set(checks.map(c=>c.chat_id)).size!==2
  ||checks.some(c=>!COMMUNITY_IDS.includes(c.chat_id)||!['member','not_member','unknown'].includes(c.state))
  ||!Number.isFinite(age)||age < -30000||age>90000)throw Error('membership_unavailable');
 const eligible=checks.some(c=>c.state==='member');
 if(!eligible&&checks.some(c=>c.state==='unknown')||result.eligible!==eligible)throw Error('membership_unavailable');
 return {amount_kopecks:eligible?COMMUNITY_AMOUNT:BASE_AMOUNT,eligible,checked_at:result.checked_at,chat_ids:checks.filter(c=>c.state==='member').map(c=>c.chat_id),checks};
}
