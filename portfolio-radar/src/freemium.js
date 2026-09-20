import {newsIdentity} from './daily.js';
export function portfolioAssets(accounts){
 return [...new Map(accounts.flatMap(a=>a.positions).filter(p=>p.verified&&p.provider!=='cash').map(p=>[newsIdentity(p),{...p,key:newsIdentity(p)}])).values()];
}
// Apply entitlement BEFORE cache lookup, provider requests, events and rendering.
// Freeze the first release's selection so edits while a digest is running cannot
// cause a free customer to query more than three assets in that daily job.
export function entitledPortfolio(accounts,access,snapshot=null){
 const all=portfolioAssets(accounts),byId=new Map(all.map(p=>[p.key,p]));
 const limit=access.asset_limit??500;
 const order=snapshot||all.map(p=>p.key);
 const keys=[...new Set(order)].filter(k=>byId.has(k)).slice(0,limit);
 const allowed=new Set(keys),limited=access.tier==='free'||keys.length<all.length;
 const visible=accounts.map(a=>({...a,positions:a.positions.filter(p=>limited?p.verified&&p.provider!=='cash'&&allowed.has(newsIdentity(p)):true).map(p=>p.verified&&p.provider!=='cash'?{...p,key:newsIdentity(p)}:p)})).filter(a=>a.positions.length);
 return {accounts:visible,assets:keys.map(k=>byId.get(k)),keys,total:all.length,hidden:all.length-keys.length};
}
export function trialDeadline(access){return access.trial_until?new Date(access.trial_until).toLocaleString('ru-RU',{timeZone:'Europe/Moscow',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})+' МСК':null;}
export function upgradeOffer(access,{hidden=null}={}){
 if(!access.freemium||access.tier==='paid'||access.tier==='test')return {text:'',keyboard:null};
 const state=access.tier==='trial'?`🎁 <b>Полный доступ до ${trialDeadline(access)}</b>\nПосле бесплатных 72 часов сводка продолжится по трём активам.`:
  access.tier==='pending'?'🎁 <b>Первые 3 дня — бесплатно</b>\n72 часа полного доступа начнутся после первого сохранения портфеля.':
  `🔓 <b>Бесплатно — три актива</b>${hidden>0?'\nЕщё '+hidden+' активов доступны в полном обзоре.':''}\nВ сводке — первые три актива портфеля.`;
 return {text:state+'\n🔭 Прогнозы и ориентиры: бесплатно — крупнейший актив, в подписке — весь портфель.'+'\n💎 Весь портфель — 290 ₽ в неделю.',keyboard:[[{text:'💎 Открыть весь портфель',callback_data:'billing:upgrade'}]]};
}

