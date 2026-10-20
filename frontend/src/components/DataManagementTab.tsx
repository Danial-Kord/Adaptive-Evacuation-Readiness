import React, { useCallback, useEffect, useState } from "react";
import {
  BigQueryTableMeta,
  BigQueryTableRowsResponse,
  BigQueryTablesOverviewResponse,
} from "../mocks/sampleBigQueryTables";
import {
  fetchBigQueryTableRows,
  fetchBigQueryTablesOverview,
} from "../services/agentApi";

const QUICK_FILTERS: Record<string, { id: string; label: string }[]> = {
  shelters: [
    { id: "", label: "All Shelters" },
    { id: "ada_unrecorded", label: "Wheelchair: UNRECORDED (NULL)" },
    { id: "ada_yes", label: "Wheelchair: YES (TRUE)" },
    { id: "ada_no", label: "Wheelchair: NO (FALSE)" },
    { id: "medical", label: "Medical-Needs (is_medical)" },
    { id: "surge", label: "In Surge Zone" },
  ],
  vulnerability_tracts: [
    { id: "", label: "All Tracts" },
    { id: "high_no_vehicle", label: "No-Vehicle >= 15%" },
    { id: "high_disability", label: "Disability >= 20%" },
  ],
  power_dependent_counties: [
    { id: "", label: "All Counties" },
    { id: "censored", label: "Privacy-Censored (= 11)" },
  ],
  hazard_tracts: [{ id: "", label: "All Hazard Tracts" }],
  care_facilities: [{ id: "", label: "All Nursing Homes" }],
};

const TABLE_GUARDRAIL_NOTES: Record<string, { title: string; body: string }> = {
  shelters: {
    title: "Data Guardrail — UNRECORDED != NO",
    body: "In Florida, 88% of FEMA shelter rows have `wheelchair_accessible IS NULL`. Blank/NULL means nobody recorded it — never treat it as FALSE. Also note `ada_compliant` (only 63 YES rows nationally) was dropped as a decoy column.",
  },
  vulnerability_tracts: {
    title: "Data Guardrail — Transport Proxies & Excluded SVI Theme 3",
    body: "CDC PLACES `pct_lacktrpt` is NULL across all of Florida and Texas; use ACS `households_no_vehicle` and SVI `pct_no_vehicle` (vehicle ownership). SVI `RPL_THEMES` and Theme 3 (race/ethnicity) are excluded as model inputs per Responsible AI policy.",
  },
  power_dependent_counties: {
    title: "Data Guardrail — County Grain & The Number 11",
    body: "HHS emPOWER is published strictly at the county level (never disaggregate to census tracts). Any county with 1–10 electricity-dependent beneficiaries is reported as `11` (`power_dependent_is_censored = TRUE`).",
  },
  hazard_tracts: {
    title: "Data Guardrail — Pure Exposure vs. Composite Risk",
    body: "Contains FEMA NRI Hurricane (`HRCN_*`) and Coastal Flooding (`CFLD_*`) expected annual loss and frequency. Composite `RISK_SCORE` columns are excluded so vulnerability is not double-counted.",
  },
  care_facilities: {
    title: "Data Guardrail — CMS Certified Nursing Homes",
    body: "Monthly CMS provider roster with coordinates and `number_of_certified_beds`. Assisted living facilities are state-licensed and do not exist in federal CMS files.",
  },
};

const UNRECORDED_FLAG_COLUMNS = new Set([
  "wheelchair_accessible",
  "generator_onsite",
  "self_sufficient_electricity",
  "in_surge_slosh_area",
  "in_100_yr_floodplain",
]);

export const DataManagementTab: React.FC = () => {
  const [overview, setOverview] = useState<BigQueryTablesOverviewResponse | null>(null);
  const [selectedTable, setSelectedTable] = useState<string>("shelters");
  const [rowsData, setRowsData] = useState<BigQueryTableRowsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [search, setSearch] = useState<string>("");
  const [quickFilter, setQuickFilter] = useState<string>("");
  const [limit, setLimit] = useState<number>(50);
  const [offset, setOffset] = useState<number>(0);
  const [subTab, setSubTab] = useState<"rows" | "schema" | "sql">("rows");
  const [copiedSql, setCopiedSql] = useState<boolean>(false);

  const loadOverview = useCallback(async () => {
    const data = await fetchBigQueryTablesOverview();
    setOverview(data);
  }, []);

  const loadRows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchBigQueryTableRows({
        tableName: selectedTable,
        limit,
        offset,
        search,
        quickFilter,
      });
      setRowsData(res);
    } finally {
      setLoading(false);
    }
  }, [selectedTable, limit, offset, search, quickFilter]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  const handleSelectTable = (tableName: string) => {
    setSelectedTable(tableName);
    setQuickFilter("");
    setSearch("");
    setOffset(0);
  };

  const selectedTableMeta: BigQueryTableMeta | undefined = overview?.tables.find(
    (t) => t.table_name === selectedTable
  );

  const loadedTablesCount =
    overview?.tables.filter((t) => t.status === "LOADED").length ?? 0;
  const totalDatasetRows =
    overview?.tables.reduce((sum, t) => sum + (t.row_count || 0), 0) ?? 0;

  const guardrail = TABLE_GUARDRAIL_NOTES[selectedTable];
  const filtersForTable = QUICK_FILTERS[selectedTable] || [];

  const formatBytes = (bytes: number) => {
    if (!bytes) return "0 KB";
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const renderCellValue = (colName: string, val: unknown, row: Record<string, unknown>) => {
    if (val === null || val === undefined) {
      if (UNRECORDED_FLAG_COLUMNS.has(colName)) {
        return <span className="cell-pill unrecorded">NULL (UNRECORDED)</span>;
      }
      if (colName === "pct_lacktrpt") {
        return <span className="cell-pill unrecorded">NULL (Not in FL/TX)</span>;
      }
      return <span className="cell-null">NULL</span>;
    }

    if (typeof val === "boolean") {
      return val ? (
        <span className="cell-pill bool-true">TRUE</span>
      ) : (
        <span className="cell-pill bool-false">FALSE</span>
      );
    }

    if (
      colName === "power_dependent_dme" &&
      Number(val) === 11 &&
      row.power_dependent_is_censored === true
    ) {
      return (
        <span>
          <strong>11</strong>{" "}
          <span className="cell-pill unrecorded">CENSORED (1–10)</span>
        </span>
      );
    }

    if (typeof val === "number") {
      if (Number.isInteger(val)) {
        return val.toLocaleString();
      }
      return val.toFixed(4).replace(/\.?0+$/, "");
    }

    return String(val);
  };

  const handleCopySql = () => {
    if (!rowsData?.executed_sql) return;
    navigator.clipboard.writeText(rowsData.executed_sql);
    setCopiedSql(true);
    setTimeout(() => setCopiedSql(false), 2000);
  };

  return (
    <div className="admin-dashboard">
      {/* Top Dataset Connection Status Bar */}
      <div className="card admin-header-card">
        <div className="admin-header-top">
          <div>
            <div className="admin-title-row">
              <h2>BigQuery Data Management & Table Explorer</h2>
              {overview?.connected ? (
                <span className="connection-badge live">
                  ● Live BigQuery Connected ({loadedTablesCount}/5 Tables Loaded •{" "}
                  {totalDatasetRows.toLocaleString()} Total Rows)
                </span>
              ) : (
                <span className="connection-badge preview">
                  ● Local Preview Mode (0/5 Live Tables • {totalDatasetRows} Sample Rows)
                </span>
              )}
            </div>
            <p className="admin-subtitle">
              Dataset:{" "}
              <code>
                {overview?.project || "your-gcp-project"}.{overview?.dataset || "evacuation_readiness"}
              </code>{" "}
              — Inspect schemas, verify <code>UNRECORDED</code> (<code>NULL</code>) rates, and run filtered table queries.
            </p>
          </div>

          <button
            className="refresh-btn"
            onClick={() => {
              loadOverview();
              loadRows();
            }}
          >
            ↻ Refresh Dataset
          </button>
        </div>

        {!overview?.connected && (
          <div className="admin-setup-banner">
            <strong>How to switch from Preview Mode to your live BigQuery tables:</strong>{" "}
            1) Load the dataset in Cloud Shell with <code>bash scripts/load.sh FL</code>{" "}
            2) Set <code>GOOGLE_CLOUD_PROJECT</code> in <code>.env</code>{" "}
            3) Start the backend API with <code>uvicorn server:app --reload --port 8080</code>.
          </div>
        )}

        {/* 5 Tables Selector Cards */}
        <div className="bq-tables-grid">
          {overview?.tables.map((tbl) => {
            const isSelected = tbl.table_name === selectedTable;
            return (
              <button
                key={tbl.table_name}
                type="button"
                className={`bq-table-card ${isSelected ? "selected" : ""}`}
                onClick={() => handleSelectTable(tbl.table_name)}
              >
                <div className="bq-table-card-top">
                  <span className={`role-tag ${tbl.role.toLowerCase()}`}>
                    {tbl.role}
                  </span>
                  <span className={`status-dot ${tbl.status.toLowerCase()}`}>
                    {tbl.status}
                  </span>
                </div>
                <div className="bq-table-name">{tbl.table_name}</div>
                <div className="bq-table-stats">
                  <span>
                    <strong>{tbl.row_count.toLocaleString()}</strong> rows
                  </span>
                  <span>•</span>
                  <span>{tbl.columns.length} cols</span>
                  <span>•</span>
                  <span>{formatBytes(tbl.num_bytes)}</span>
                </div>
                <div className="bq-table-source">{tbl.source}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected Table Explorer Card */}
      <div className="card">
        {guardrail && (
          <div className="guardrail-callout">
            <strong>⚠️ {guardrail.title}:</strong> {guardrail.body}
          </div>
        )}

        {/* Controls Bar */}
        <div className="admin-controls-bar">
          <div className="search-and-filters">
            <input
              type="text"
              className="admin-search-input"
              placeholder={`Search ${selectedTable} (name, geo_id, city, county)...`}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setOffset(0);
              }}
            />

            <div className="quick-filter-pills">
              {filtersForTable.map((f) => (
                <button
                  key={f.id || "all"}
                  type="button"
                  className={`filter-pill-btn ${quickFilter === f.id ? "active" : ""}`}
                  onClick={() => {
                    setQuickFilter(f.id);
                    setOffset(0);
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="subtab-Completed-bar">
            <button
              type="button"
              className={`subtab-btn ${subTab === "rows" ? "active" : ""}`}
              onClick={() => setSubTab("rows")}
            >
              📊 Data Rows ({rowsData?.total_matching_rows.toLocaleString() ?? 0})
            </button>
            <button
              type="button"
              className={`subtab-btn ${subTab === "schema" ? "active" : ""}`}
              onClick={() => setSubTab("schema")}
            >
              📐 Schema ({selectedTableMeta?.columns.length ?? 0} cols)
            </button>
            <button
              type="button"
              className={`subtab-btn ${subTab === "sql" ? "active" : ""}`}
              onClick={() => setSubTab("sql")}
            >
              💻 BigQuery SQL
            </button>
          </div>
        </div>

        {/* Sub-view 1: Data Rows Table */}
        {subTab === "rows" && (
          <>
            <div className="table-scroll-container">
              {loading ? (
                <div className="admin-empty-state">Querying BigQuery table `{selectedTable}`...</div>
              ) : !rowsData || rowsData.rows.length === 0 ? (
                <div className="admin-empty-state">
                  No rows match your current filter criteria.
                </div>
              ) : (
                <table className="data-table bq-explorer-table">
                  <thead>
                    <tr>
                      <th className="row-num-col">#</th>
                      {rowsData.columns.map((col) => (
                        <th key={col.name}>
                          <div className="th-col-name">{col.name}</div>
                          <div className="th-col-type">{col.type}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rowsData.rows.map((row, idx) => (
                      <tr key={idx}>
                        <td className="row-num-col">{offset + idx + 1}</td>
                        {rowsData.columns.map((col) => (
                          <td key={col.name}>
                            {renderCellValue(col.name, row[col.name], row)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Pagination Footer */}
            <div className="admin-pagination-bar">
              <div className="pagination-info">
                Showing{" "}
                <strong>
                  {rowsData && rowsData.rows.length > 0 ? offset + 1 : 0}–
                  {offset + (rowsData?.rows.length || 0)}
                </strong>{" "}
                of <strong>{rowsData?.total_matching_rows.toLocaleString() || 0}</strong> matching rows
              </div>

              <div className="pagination-actions">
                <label className="rows-per-page">
                  Rows per page:{" "}
                  <select
                    value={limit}
                    onChange={(e) => {
                      setLimit(Number(e.target.value));
                      setOffset(0);
                    }}
                  >
                    <option value={25}>25</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                  </select>
                </label>

                <button
                  type="button"
                  className="page-btn"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - limit))}
                >
                  ← Prev
                </button>
                <button
                  type="button"
                  className="page-btn"
                  disabled={
                    !rowsData || offset + limit >= rowsData.total_matching_rows
                  }
                  onClick={() => setOffset(offset + limit)}
                >
                  Next →
                </button>
              </div>
            </div>
          </>
        )}

        {/* Sub-view 2: Table Schema */}
        {subTab === "schema" && selectedTableMeta && (
          <div className="schema-view">
            <p className="subtext">{selectedTableMeta.description}</p>
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Column Name</th>
                  <th>BigQuery Data Type</th>
                  <th>Mode</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {selectedTableMeta.columns.map((col, idx) => (
                  <tr key={col.name}>
                    <td>{idx + 1}</td>
                    <td>
                      <code>{col.name}</code>
                    </td>
                    <td>
                      <span className="badge-subtle">{col.type}</span>
                    </td>
                    <td>{col.mode || "NULLABLE"}</td>
                    <td className="subtext">
                      {col.name === "wheelchair_accessible" &&
                        "TRUE = YES, FALSE = NO, NULL = UNRECORDED (88% in FL)"}
                      {col.name === "generator_onsite" &&
                        "TRUE = YES, FALSE = NO, NULL = UNRECORDED"}
                      {col.name === "pct_lacktrpt" &&
                        "Not published by CDC PLACES for FL or TX (always NULL in FL/TX)"}
                      {col.name === "power_dependent_dme" &&
                        "County-level count; 11 means 1–10 residents (privacy-masked)"}
                      {col.name === "power_dependent_is_censored" &&
                        "TRUE when power_dependent_dme == 11"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Sub-view 3: Executed BigQuery SQL */}
        {subTab === "sql" && (
          <div className="sql-view">
            <div className="sql-header">
              <span>Executed BigQuery Standard SQL Query:</span>
              <button type="button" className="copy-sql-btn" onClick={handleCopySql}>
                {copiedSql ? "✓ Copied!" : "📋 Copy SQL"}
              </button>
            </div>
            <pre className="sql-code-block">{rowsData?.executed_sql}</pre>
          </div>
        )}
      </div>
    </div>
  );
};
