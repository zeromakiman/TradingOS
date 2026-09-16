import { Shell } from "@/components/shell";
import { TradeWorkspace } from "@/components/trade-workspace";
import { previewContext, previewInstrument } from "@/domain/fixtures";
export default function PreviewPage() { return <Shell active="Analyze" preview><TradeWorkspace preview context={previewContext} instruments={[previewInstrument]}/></Shell>; }
