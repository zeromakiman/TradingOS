import { DataTable, TableLink } from "../ui/table";
import type { ChartDatum } from "./types";

/** Table view for category charts: category (linked when it drills down), value, details. */
export function CategoryTable({ caption, categoryLabel, valueName, data }: { caption: string; categoryLabel: string; valueName: string; data: ChartDatum[] }) {
  const hasDetail = data.some((datum) => datum.detail);
  return (
    <DataTable
      caption={caption}
      rows={data}
      rowKey={(datum) => datum.key}
      columns={[
        { key: "category", header: categoryLabel, cell: (datum) => (datum.href ? <TableLink href={datum.href}>{datum.label}</TableLink> : datum.label) },
        { key: "value", header: valueName, align: "end", cell: (datum) => datum.valueLabel },
        ...(hasDetail ? [{ key: "detail", header: "Details", cell: (datum: ChartDatum) => datum.detail ?? "" }] : []),
      ]}
    />
  );
}
