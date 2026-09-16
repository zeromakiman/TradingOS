import { loadJournalAnalytics } from "@/lib/analytics-data";
import { filterTrades,tradeCsv,validateFilters } from "@/domain/analytics";
import { routeError,routeUser } from "@/lib/route-security";
export async function GET(request:Request){
 try{await routeUser(request);const params=Object.fromEntries(new URL(request.url).searchParams),error=validateFilters(params);if(error)return Response.json({error},{status:400});
 const {trades}=await loadJournalAnalytics(params.account);
 return new Response(tradeCsv(filterTrades(trades,params).filter(t=>t.status==="CLOSED")),{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":"attachment; filename=trading-os-closed-trades.csv","Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
 }catch(e){return routeError(e);}
}
