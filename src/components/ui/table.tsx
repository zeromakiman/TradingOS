import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx";

type Align = "start" | "center" | "end";

export type TableProps = ComponentProps<"table"> & {
  /** Table name; visually hidden unless `captionVisible`. */
  caption?: ReactNode;
  captionVisible?: boolean;
  /**
   * Below 768px each row becomes a labelled card: cells show their `label` before the value
   * (CSS generated text, which screen readers also read).
   */
  cards?: boolean;
  wrapperClassName?: string;
};

export function Table({ caption, captionVisible = false, cards = false, className, wrapperClassName, children, ...props }: TableProps) {
  return (
    <div className={cx("ui-table-wrap", cards && "ui-table-cards", wrapperClassName)}>
      <table className={cx("ui-table", className)} {...props}>
        {caption && <caption className={cx("ui-table-caption", !captionVisible && "sr-only")}>{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function TableHead({ className, ...props }: ComponentProps<"thead">) {
  return <thead className={cx("ui-table-head", className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<"tbody">) {
  return <tbody className={cx("ui-table-body", className)} {...props} />;
}

export function TableRow({ className, interactive = false, ...props }: ComponentProps<"tr"> & { interactive?: boolean }) {
  return <tr className={cx("ui-table-row", className)} data-interactive={interactive || undefined} {...props} />;
}

export function TableHeaderCell({ className, align = "start", scope = "col", ...props }: Omit<ComponentProps<"th">, "align"> & { align?: Align }) {
  return <th className={cx("ui-table-th", className)} scope={scope} data-align={align} {...props} />;
}

export function TableCell({ className, align = "start", label, primary = false, ...props }: Omit<ComponentProps<"td">, "align"> & { align?: Align; label?: string; primary?: boolean }) {
  return <td className={cx("ui-table-td", className)} data-align={align} data-label={label} data-primary={primary || undefined} {...props} />;
}

export function TableLink({ className, ...props }: ComponentProps<typeof Link>) {
  return <Link className={cx("ui-table-link", className)} {...props} />;
}

export type DataTableColumn<Row> = {
  key: string;
  header: ReactNode;
  /** Plain-text column name used as the card label on small screens. */
  label?: string;
  align?: Align;
  cell: (row: Row) => ReactNode;
};

export type DataTableProps<Row> = {
  caption: ReactNode;
  captionVisible?: boolean;
  columns: DataTableColumn<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  cards?: boolean;
  /** Rendered instead of the table when there are no rows. */
  empty?: ReactNode;
  className?: string;
};

/** Column-configured table; the first column is the row's primary cell. */
export function DataTable<Row>({ caption, captionVisible, columns, rows, rowKey, cards = false, empty, className }: DataTableProps<Row>) {
  if (rows.length === 0 && empty) return empty;
  return (
    <Table caption={caption} captionVisible={captionVisible} cards={cards} wrapperClassName={className}>
      <TableHead>
        <TableRow>
          {columns.map((column) => (
            <TableHeaderCell key={column.key} align={column.align}>
              {column.header}
            </TableHeaderCell>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={rowKey(row)}>
            {columns.map((column, position) => (
              <TableCell key={column.key} align={column.align} label={cards && position > 0 ? (column.label ?? (typeof column.header === "string" ? column.header : undefined)) : undefined} primary={cards && position === 0}>
                {column.cell(row)}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
