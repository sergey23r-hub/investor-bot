// One shared news result for each verified instrument per Moscow calendar day.
// ISIN unifies different boards / display tickers; crypto uses the provider's ID.
export function newsIdentity(asset){
 if(asset.key==='market')return 'market';
 if(asset.isin&&/^[A-Z]{2}[A-Z0-9]{10}$/i.test(asset.isin))return 'isin:'+asset.isin.toUpperCase();
 if(asset.provider==='coingecko'&&asset.provider_id)return 'cg:'+asset.provider_id.toLowerCase();
 return asset.key;
}
export function newsDay(now=new Date()){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now).map(x=>[x.type,x.value]));
 return `${p.year}-${p.month}-${p.day}`;
}
export function dailyResearchKey(asset,now=new Date()){return 'research:daily:v1:'+newsDay(now)+':'+newsIdentity(asset);}
export function quoteCacheKey(asset,now=new Date()){return 'quote:v1:'+asset.key+':'+Math.floor(+now/(15*60000));}
