// index.js  (Node 10 compatible: NO ?.  and NO ??)
"use strict";

const express = require("express");
const mysql = require("mysql2");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

/* =========================
   CONFIG (EDIT HERE)
   ========================= */
const CONFIG = {
  PORT: 3000,

  DB: {
    host: "localhost",
    user: "soutjsdc_hassan",
    password: "hassan.1405",
    database: "soutjsdc_NewFin",
    charset: "utf8mb4",
  },

  JWT: {
    secret: "Ponjoro.2026",
    refreshSecret: "Ponjoro.2026",
    expiresIn: "7d",
    refreshExpiresIn: "30d",
  },

  CORS: {
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "X-Requested-With",
      "x-api-key",
    ],
    exposedHeaders: ["Content-Disposition"],
    credentials: false,
    optionsSuccessStatus: 204,
  },

  DASHBOARD: {
    contractVersion: "2026-03-06",
    cacheTtlMs: 20000,
  },
};

/* =========================
   HELPERS
   ========================= */
const INVALID_CREDENTIALS = "Invalid credentials";

function normalizeEmail(raw) {
  return String(raw || "").trim().toLowerCase();
}
function normalizeRole(raw) {
  const role = String(raw || "USER").trim().toUpperCase();
  return role === "ADMIN" ? "ADMIN" : "USER";
}
function toInt(value, fallback) {
  const n = parseInt(String(value), 10);
  return isFinite(n) ? n : fallback;
}
function toNumber(value, fallback) {
  const n = Number(value);
  return isFinite(n) ? n : fallback;
}
function pad2(value) {
  return value < 10 ? "0" + value : String(value);
}
function safeString(v) {
  return v === null || v === undefined ? "" : String(v);
}

/* =========================
   Phone/operator helpers (STRICT TZ)
   ========================= */
const OP_PREFIXES = {
  Vodacom: ["075", "074", "076"],
  Tigo: ["071", "067"],
  Airtel: ["068", "078"],
  Halotel: ["062"],
};

function normalizeTzPhoneStrict(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).trim().replace(/[^\d+]/g, "");

  if (s.indexOf("+255") === 0) s = "0" + s.slice(4);
  else if (s.indexOf("255") === 0) s = "0" + s.slice(3);

  s = s.replace(/\D/g, "");
  if (!/^0\d{9}$/.test(s)) return null;
  return s;
}

function detectOperator(normalized10) {
  if (!normalized10 || normalized10.length < 3) return "UNKNOWN";
  const prefix = normalized10.slice(0, 3);

  for (const op in OP_PREFIXES) {
    if (!Object.prototype.hasOwnProperty.call(OP_PREFIXES, op)) continue;
    if (OP_PREFIXES[op].indexOf(prefix) !== -1) return op;
  }
  return "UNKNOWN";
}

function logQueryError(err, query, data) {
  const msg = err && err.message ? err.message : String(err);
  console.error("Database Error:", msg);
  console.error("Query:", query);
  if (data !== undefined) console.error("Data:", JSON.stringify(data));
}

/* =========================
   DASHBOARD API HELPERS
   ========================= */
const DASHBOARD_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DASHBOARD_CACHE = {};

function clearDashboardCache() {
  const keys = Object.keys(DASHBOARD_CACHE);
  for (let i = 0; i < keys.length; i++) {
    delete DASHBOARD_CACHE[keys[i]];
  }
}

function dashboardNormalizePeriod(value) {
  const normalized = safeString(value || "today").trim().toLowerCase();
  return normalized === "all" ? "all" : "today";
}

function dashboardNormalizePerPage(value) {
  const parsed = toInt(value, 15);
  return parsed === 15 || parsed === 30 || parsed === 50 ? parsed : 15;
}

function dashboardNormalizeSort(sortBy, sortDir) {
  let by = safeString(sortBy || "date").trim().toLowerCase();
  if (["date", "amount", "operator"].indexOf(by) === -1) by = "date";

  let dir = safeString(sortDir || "").trim().toLowerCase();
  if (dir !== "asc" && dir !== "desc") {
    dir = by === "operator" ? "asc" : "desc";
  }

  return { by: by, dir: dir };
}

function dashboardIsTruthyFlag(value) {
  const normalized = safeString(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseDashboardRequestParams(query) {
  const page = Math.max(1, toInt(query && query.page ? query.page : "1", 1));

  return {
    period: dashboardNormalizePeriod(query && query.period ? query.period : "today"),
    searchQuery: query && query.q ? safeString(query.q) : "",
    operatorFilter: query && query.operator ? safeString(query.operator) : "",
    operationFilter: query && query.operation ? safeString(query.operation) : "",
    sortBy: query && query.sort_by ? safeString(query.sort_by) : "date",
    sortDir: query && query.sort_dir ? safeString(query.sort_dir) : "desc",
    page: page,
    perPage: dashboardNormalizePerPage(query && query.per_page ? query.per_page : "15"),
    forceRefresh: dashboardIsTruthyFlag(query && query.refresh ? query.refresh : "0"),
    includeFilteredTransactions: dashboardIsTruthyFlag(query && query.include_filtered ? query.include_filtered : "0"),
  };
}

function dashboardQuery(sql, params) {
  return new Promise(function (resolve, reject) {
    db.query(sql, params || [], function (err, rows) {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function formatDashboardCurrency(amount, currency) {
  const numeric = toNumber(amount, 0);
  return (currency || "TZS") + " " + numeric.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatDashboardDateKey(dateKey) {
  const text = safeString(dateKey).trim();
  if (!text || text.length !== 10) return text || "-";
  const parts = text.split("-");
  if (parts.length !== 3) return text;
  const year = parts[0];
  const month = toInt(parts[1], 1);
  const day = toInt(parts[2], 1);
  return pad2(day) + " " + DASHBOARD_MONTHS[Math.max(0, Math.min(11, month - 1))] + " " + year;
}

function buildDashboardSparklinePoints(values, width, height) {
  const chartWidth = typeof width === "number" ? width : 96;
  const chartHeight = typeof height === "number" ? height : 24;
  const numericValues = values.map(function (value) {
    return toNumber(value, 0);
  });

  if (numericValues.length === 0) {
    return "0," + (chartHeight / 2).toFixed(2) + " " + chartWidth.toFixed(2) + "," + (chartHeight / 2).toFixed(2);
  }

  if (numericValues.length === 1) {
    const ySingle = (chartHeight / 2).toFixed(2);
    return "0," + ySingle + " " + chartWidth.toFixed(2) + "," + ySingle;
  }

  const minValue = Math.min.apply(null, numericValues);
  const maxValue = Math.max.apply(null, numericValues);
  const valueSpan = maxValue - minValue;
  const stepX = chartWidth / (numericValues.length - 1);

  const points = [];
  for (let i = 0; i < numericValues.length; i++) {
    const xPos = stepX * i;
    let yPos;
    if (valueSpan <= 0) {
      yPos = chartHeight / 2;
    } else {
      const scaled = (numericValues[i] - minValue) / valueSpan;
      yPos = chartHeight - (scaled * chartHeight);
    }
    points.push(xPos.toFixed(2) + "," + yPos.toFixed(2));
  }
  return points.join(" ");
}

function buildDashboardDeltaContext(currentValue, previousValue, comparisonSuffix) {
  const current = toNumber(currentValue, 0);
  const previous = toNumber(previousValue, 0);
  let deltaPercent;

  if (previous <= 0) {
    deltaPercent = current > 0 ? 100 : 0;
  } else {
    deltaPercent = ((current - previous) / previous) * 100;
  }

  if (Math.abs(deltaPercent) < 0.05) {
    deltaPercent = 0;
  }

  let direction = "flat";
  if (deltaPercent > 0) direction = "up";
  else if (deltaPercent < 0) direction = "down";

  return {
    direction: direction,
    text: (deltaPercent >= 0 ? "+" : "") + deltaPercent.toFixed(1) + "% " + comparisonSuffix,
  };
}

function buildDashboardStatTrendPayload(currentValue, previousValue, sparklineValues, comparisonSuffix) {
  const delta = buildDashboardDeltaContext(currentValue, previousValue, comparisonSuffix);
  return {
    delta_direction: delta.direction,
    delta_text: delta.text,
    sparkline_points: buildDashboardSparklinePoints(sparklineValues),
  };
}

function buildDashboardSevenDayKeys(todayDateKey) {
  const parts = safeString(todayDateKey).split("-");
  if (parts.length !== 3) return [];
  const year = toInt(parts[0], 0);
  const month = toInt(parts[1], 1);
  const day = toInt(parts[2], 1);
  const baseDate = new Date(Date.UTC(year, month - 1, day));
  const keys = [];

  for (let offset = 6; offset >= 0; offset--) {
    const d = new Date(baseDate.getTime() - (offset * 24 * 60 * 60 * 1000));
    keys.push(d.getUTCFullYear() + "-" + (d.getUTCMonth() + 1 < 10 ? "0" : "") + (d.getUTCMonth() + 1) + "-" + (d.getUTCDate() < 10 ? "0" : "") + d.getUTCDate());
  }
  return keys;
}

function buildDashboardDailyMetricWindow(todayDateKey, rows) {
  const dayKeys = buildDashboardSevenDayKeys(todayDateKey);
  const buckets = {};

  for (let i = 0; i < dayKeys.length; i++) {
    buckets[dayKeys[i]] = { total: 0, sent: 0, received: 0 };
  }

  for (let j = 0; j < rows.length; j++) {
    const row = rows[j] || {};
    const key = safeString(row.day_key).trim();
    if (!Object.prototype.hasOwnProperty.call(buckets, key)) continue;
    buckets[key].total = toNumber(row.total_amount, 0);
    buckets[key].sent = toNumber(row.sent_amount, 0);
    buckets[key].received = toNumber(row.received_amount, 0);
  }

  const totalSeries = [];
  const sentSeries = [];
  const receivedSeries = [];
  for (let k = 0; k < dayKeys.length; k++) {
    const dayKey = dayKeys[k];
    totalSeries.push(buckets[dayKey].total);
    sentSeries.push(buckets[dayKey].sent);
    receivedSeries.push(buckets[dayKey].received);
  }

  return {
    series: {
      total: totalSeries,
      sent: sentSeries,
      received: receivedSeries,
    },
    today: {
      total: totalSeries.length ? totalSeries[totalSeries.length - 1] : 0,
      sent: sentSeries.length ? sentSeries[sentSeries.length - 1] : 0,
      received: receivedSeries.length ? receivedSeries[receivedSeries.length - 1] : 0,
    },
    yesterday: {
      total: totalSeries.length > 1 ? totalSeries[totalSeries.length - 2] : 0,
      sent: sentSeries.length > 1 ? sentSeries[sentSeries.length - 2] : 0,
      received: receivedSeries.length > 1 ? receivedSeries[receivedSeries.length - 2] : 0,
    },
  };
}

function buildDashboardPagination(total, page, perPage) {
  if (total <= 0) {
    return {
      page: 1,
      per_page: perPage,
      total: 0,
      total_pages: 0,
      has_prev: false,
      has_next: false,
      prev_page: 1,
      next_page: 1,
      start_row: 0,
      end_row: 0,
    };
  }

  const totalPages = Math.ceil(total / perPage);
  const currentPage = Math.max(1, Math.min(page, totalPages));
  const startIndex = (currentPage - 1) * perPage;
  const endRow = Math.min(total, startIndex + perPage);

  return {
    page: currentPage,
    per_page: perPage,
    total: total,
    total_pages: totalPages,
    has_prev: currentPage > 1,
    has_next: currentPage < totalPages,
    prev_page: currentPage > 1 ? currentPage - 1 : 1,
    next_page: currentPage < totalPages ? currentPage + 1 : totalPages,
    start_row: startIndex + 1,
    end_row: endRow,
  };
}

function escapeLike(value) {
  return safeString(value).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function buildDashboardPeriodSql(period) {
  if (period === "today") {
    return "createdat >= CURDATE() AND createdat < (CURDATE() + INTERVAL 1 DAY)";
  }
  return "1=1";
}

function buildDashboardOperationLabelSql() {
  return (
    "CASE " +
    "WHEN UPPER(TRIM(actin)) = 'TRANSFER' THEN 'Transfer' " +
    "WHEN UPPER(TRIM(actin)) IN ('RECEIVED', 'RECEIVE') THEN 'Received' " +
    "ELSE IFNULL(NULLIF(TRIM(actin), ''), '-') END"
  );
}

function buildDashboardFilterSql(params) {
  const conditions = [];
  const queryParams = [];
  const operationLabelSql = buildDashboardOperationLabelSql();

  if (params.searchQuery) {
    const like = "%" + escapeLike(params.searchQuery) + "%";
    conditions.push(
      "(" +
        "number LIKE ? ESCAPE '\\\\' OR " +
        "beneficiary LIKE ? ESCAPE '\\\\' OR " +
        "carrier LIKE ? ESCAPE '\\\\' OR " +
        "actin LIKE ? ESCAPE '\\\\' OR " +
        "CAST(amount AS CHAR) LIKE ? ESCAPE '\\\\' OR " +
        "CAST(clientId AS CHAR) LIKE ? ESCAPE '\\\\' OR " +
        "DATE_FORMAT(createdat, '%d %b %Y, %h:%i %p') LIKE ? ESCAPE '\\\\'" +
      ")"
    );
    queryParams.push(like, like, like, like, like, like, like);
  }

  if (params.operatorFilter) {
    conditions.push("carrier = ?");
    queryParams.push(params.operatorFilter);
  }

  if (params.operationFilter) {
    conditions.push(operationLabelSql + " = ?");
    queryParams.push(params.operationFilter);
  }

  return {
    clause: conditions.length ? conditions.join(" AND ") : "1=1",
    params: queryParams,
    operationLabelSql: operationLabelSql,
  };
}

function buildDashboardOrderSql(sortBy, sortDir) {
  const normalized = dashboardNormalizeSort(sortBy, sortDir);
  let column = "createdat";
  if (normalized.by === "amount") column = "amount";
  else if (normalized.by === "operator") column = "carrier";

  return {
    sort: normalized,
    sql: column + " " + normalized.dir.toUpperCase(),
  };
}

function mapDashboardTransactionRow(row) {
  const amountValue = toNumber(row.amount_value, 0);
  return {
    id: row.id,
    sender_number: safeString(row.sender_number || "-") || "-",
    receiver_number: safeString(row.receiver_number || "-") || "-",
    operator: safeString(row.operator || "-") || "-",
    operation: safeString(row.operation || "-") || "-",
    amount: formatDashboardCurrency(amountValue, row.currency || "TZS"),
    status: safeString(row.status || "COMPLETED") || "COMPLETED",
    created_by: safeString(row.created_by || "-") || "-",
    created_at: safeString(row.created_at || "-") || "-",
  };
}

function buildDashboardPayload(params) {
  const normalizedPeriod = dashboardNormalizePeriod(params.period);
  const perPage = dashboardNormalizePerPage(params.perPage);
  const currentPage = Math.max(1, toInt(params.page, 1));
  const periodSql = buildDashboardPeriodSql(normalizedPeriod);
  const filters = buildDashboardFilterSql({
    searchQuery: safeString(params.searchQuery).trim(),
    operatorFilter: safeString(params.operatorFilter).trim(),
    operationFilter: safeString(params.operationFilter).trim(),
  });
  const order = buildDashboardOrderSql(params.sortBy, params.sortDir);

  const metaSql =
    "SELECT " +
    "DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today_date, " +
    "DATE_FORMAT(MAX(createdat), '%Y-%m-%d') AS latest_transaction_date, " +
    "DATE_FORMAT(NOW(), '%d %b %Y, %h:%i:%s %p') AS last_updated_label " +
    "FROM transactions";

  const scopedStatsSql =
    "SELECT " +
    "COUNT(*) AS total_transactions, " +
    "COALESCE(SUM(amount), 0) AS total_volume, " +
    "SUM(CASE WHEN UPPER(TRIM(actin)) IN ('TRANSFER', 'SENT') THEN 1 ELSE 0 END) AS outgoing_transfers, " +
    "COALESCE(SUM(CASE WHEN UPPER(TRIM(actin)) IN ('TRANSFER', 'SENT') THEN amount ELSE 0 END), 0) AS sent_volume, " +
    "SUM(CASE WHEN UPPER(TRIM(actin)) IN ('RECEIVED', 'RECEIVE') THEN 1 ELSE 0 END) AS incoming_transfers, " +
    "COALESCE(SUM(CASE WHEN UPPER(TRIM(actin)) IN ('RECEIVED', 'RECEIVE') THEN amount ELSE 0 END), 0) AS received_volume " +
    "FROM transactions WHERE " + periodSql;

  const operatorOptionsSql =
    "SELECT DISTINCT carrier AS operator " +
    "FROM transactions WHERE " + periodSql + " AND carrier IS NOT NULL AND TRIM(carrier) <> '' " +
    "ORDER BY carrier ASC";

  const operationOptionsSql =
    "SELECT DISTINCT " + filters.operationLabelSql + " AS operation " +
    "FROM transactions WHERE " + periodSql + " AND actin IS NOT NULL AND TRIM(actin) <> '' " +
    "ORDER BY operation ASC";

  const trendSql =
    "SELECT " +
    "DATE_FORMAT(createdat, '%Y-%m-%d') AS day_key, " +
    "COALESCE(SUM(amount), 0) AS total_amount, " +
    "COALESCE(SUM(CASE WHEN UPPER(TRIM(actin)) IN ('TRANSFER', 'SENT') THEN amount ELSE 0 END), 0) AS sent_amount, " +
    "COALESCE(SUM(CASE WHEN UPPER(TRIM(actin)) IN ('RECEIVED', 'RECEIVE') THEN amount ELSE 0 END), 0) AS received_amount " +
    "FROM transactions " +
    "WHERE createdat >= CURDATE() - INTERVAL 6 DAY " +
    "GROUP BY DATE(createdat) " +
    "ORDER BY day_key ASC";

  const filteredWhereSql = "(" + periodSql + ") AND (" + filters.clause + ")";
  const countSql = "SELECT COUNT(*) AS total FROM transactions WHERE " + filteredWhereSql;
  const dataSql =
    "SELECT " +
    "id, " +
    "number AS sender_number, " +
    "beneficiary AS receiver_number, " +
    "IFNULL(NULLIF(TRIM(carrier), ''), '-') AS operator, " +
    filters.operationLabelSql + " AS operation, " +
    "amount AS amount_value, " +
    "'TZS' AS currency, " +
    "'COMPLETED' AS status, " +
    "CAST(clientId AS CHAR) AS created_by, " +
    "DATE_FORMAT(createdat, '%d %b %Y, %h:%i %p') AS created_at " +
    "FROM transactions " +
    "WHERE " + filteredWhereSql + " " +
    "ORDER BY " + order.sql + " LIMIT ? OFFSET ?";

  const filteredDataSql =
    "SELECT " +
    "id, " +
    "number AS sender_number, " +
    "beneficiary AS receiver_number, " +
    "IFNULL(NULLIF(TRIM(carrier), ''), '-') AS operator, " +
    filters.operationLabelSql + " AS operation, " +
    "amount AS amount_value, " +
    "'TZS' AS currency, " +
    "'COMPLETED' AS status, " +
    "CAST(clientId AS CHAR) AS created_by, " +
    "DATE_FORMAT(createdat, '%d %b %Y, %h:%i %p') AS created_at " +
    "FROM transactions " +
    "WHERE " + filteredWhereSql + " " +
    "ORDER BY " + order.sql;

  return Promise.all([
    dashboardQuery(metaSql, []),
    dashboardQuery(scopedStatsSql, []),
    dashboardQuery(operatorOptionsSql, []),
    dashboardQuery(operationOptionsSql, []),
    dashboardQuery(trendSql, []),
    dashboardQuery(countSql, filters.params),
  ]).then(function (initialResults) {
    const metaRows = initialResults[0];
    const scopedStatsRows = initialResults[1];
    const operatorRows = initialResults[2];
    const operationRows = initialResults[3];
    const trendRows = initialResults[4];
    const countRows = initialResults[5];

    const metaRow = metaRows && metaRows[0] ? metaRows[0] : {};
    const statsRow = scopedStatsRows && scopedStatsRows[0] ? scopedStatsRows[0] : {};
    const totalFiltered = countRows && countRows[0] ? toInt(countRows[0].total, 0) : 0;
    const pagination = buildDashboardPagination(totalFiltered, currentPage, perPage);
    const offset = (pagination.page - 1) * perPage;
    const dataParams = filters.params.slice();
    dataParams.push(perPage, offset);

    const rowPromises = [dashboardQuery(dataSql, dataParams)];
    if (params.includeFilteredTransactions) {
      rowPromises.push(dashboardQuery(filteredDataSql, filters.params.slice()));
    }

    return Promise.all(rowPromises).then(function (rowResults) {
      const dataRows = rowResults[0] || [];
      const filteredRows = rowResults.length > 1 ? rowResults[1] || [] : [];

      const todayDateKey = safeString(metaRow.today_date).trim();
      const latestTransactionDate = safeString(metaRow.latest_transaction_date).trim();
      const dailyMetrics = buildDashboardDailyMetricWindow(todayDateKey, trendRows || []);

      const totalVolume = toNumber(statsRow.total_volume, 0);
      const sentVolume = toNumber(statsRow.sent_volume, 0);
      const receivedVolume = toNumber(statsRow.received_volume, 0);
      const totalDeltaCurrent = normalizedPeriod === "today" ? totalVolume : dailyMetrics.today.total;
      const sentDeltaCurrent = normalizedPeriod === "today" ? sentVolume : dailyMetrics.today.sent;
      const receivedDeltaCurrent = normalizedPeriod === "today" ? receivedVolume : dailyMetrics.today.received;

      let statusLevel = "success";
      let statusTitle = "Data Synced";
      let statusMessage = "Live transaction data is up to date.";

      if (normalizedPeriod === "today" && toInt(statsRow.total_transactions, 0) === 0) {
        statusLevel = "info";
        statusTitle = "No Transactions For Today";
        if (latestTransactionDate && latestTransactionDate < todayDateKey) {
          statusMessage =
            "Live data loaded successfully, but the latest transaction is from " +
            formatDashboardDateKey(latestTransactionDate) +
            ". There are no transactions dated " +
            formatDashboardDateKey(todayDateKey) +
            " yet.";
        } else {
          statusMessage =
            "Live data loaded successfully, but there are no transactions dated " +
            formatDashboardDateKey(todayDateKey) +
            " yet.";
        }
      }

      const periodSuffix = normalizedPeriod === "all" ? "ALL TIME" : "TODAY";
      const payload = {
        ok: true,
        data: {
          period: normalizedPeriod,
          per_page: perPage,
          per_page_options: [15, 30, 50],
          filters: {
            q: safeString(params.searchQuery).trim(),
            operator: safeString(params.operatorFilter).trim(),
            operation: safeString(params.operationFilter).trim(),
          },
          operator_options: operatorRows.map(function (row) {
            return safeString(row.operator).trim();
          }).filter(function (value) {
            return !!value && value !== "-";
          }),
          operation_options: operationRows.map(function (row) {
            return safeString(row.operation).trim();
          }).filter(function (value) {
            return !!value && value !== "-";
          }),
          transactions: dataRows.map(mapDashboardTransactionRow),
          pagination: pagination,
          sort: { by: order.sort.by, dir: order.sort.dir },
          data_status: {
            level: statusLevel,
            title: statusTitle,
            message: statusMessage,
            last_updated: safeString(metaRow.last_updated_label || "-") || "-",
            can_retry: true,
          },
          stats: {
            total_label: "TOTAL VOLUME " + periodSuffix,
            sent_label: "SENT " + periodSuffix,
            received_label: "RECEIVED " + periodSuffix,
            total_volume: formatDashboardCurrency(totalVolume, "TZS"),
            total_transactions: toInt(statsRow.total_transactions, 0),
            sent_amount: formatDashboardCurrency(sentVolume, "TZS"),
            received_amount: formatDashboardCurrency(receivedVolume, "TZS"),
            outgoing_transfers: toInt(statsRow.outgoing_transfers, 0),
            incoming_transfers: toInt(statsRow.incoming_transfers, 0),
            total_trend: buildDashboardStatTrendPayload(totalDeltaCurrent, dailyMetrics.yesterday.total, dailyMetrics.series.total, "vs yesterday"),
            sent_trend: buildDashboardStatTrendPayload(sentDeltaCurrent, dailyMetrics.yesterday.sent, dailyMetrics.series.sent, "vs yesterday"),
            received_trend: buildDashboardStatTrendPayload(receivedDeltaCurrent, dailyMetrics.yesterday.received, dailyMetrics.series.received, "vs yesterday"),
          },
        },
        meta: {
          contract_version: CONFIG.DASHBOARD.contractVersion,
          generated_at: new Date().toISOString(),
          source: "live",
          used_stale: false,
          last_updated: Math.floor(Date.now() / 1000),
          last_updated_label: safeString(metaRow.last_updated_label || "-") || "-",
          error: "",
        },
      };

      if (params.includeFilteredTransactions) {
        payload.data.filtered_transactions = filteredRows.map(mapDashboardTransactionRow);
      }

      return payload;
    });
  });
}

/* =========================
   APP + MIDDLEWARE
   ========================= */
const app = express();

app.use(cors(CONFIG.CORS));
app.options(/.*/, cors(CONFIG.CORS));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

/* =========================
   DB CONNECTION
   ========================= */
const db = mysql.createConnection(CONFIG.DB);

db.connect(function (err) {
  if (err) {
    console.error("Error connecting to DB:", err.message);
    return;
  }
  console.log("Connected to MySQL.");
});

/* =========================
   HEALTH
   ========================= */
app.get("/health", function (req, res) {
  res.json({ ok: true });
});

/* =========================
   AUTH
   ========================= */
app.post("/api/auth/register", function (req, res) {
  const body = req.body || {};
  const email = normalizeEmail(body.email);
  const password = String(body.password || "");
  const role = normalizeRole(body.role);

  if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const checkQuery = "SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1";
  db.query(checkQuery, [email], function (checkErr, rows) {
    if (checkErr) return res.status(500).json({ error: "Database error" });
    if (rows && rows.length > 0) return res.status(400).json({ error: "Email already exists" });

    bcrypt.hash(password, 10, function (hashErr, hashedPassword) {
      if (hashErr) return res.status(500).json({ error: "Hashing failed" });

      const insertQuery = "INSERT INTO users (email, password, role) VALUES (?, ?, ?)";
      db.query(insertQuery, [email, hashedPassword, role], function (insertErr, result) {
        if (insertErr) return res.status(500).json({ error: "Failed to register" });
        return res.status(201).json({
          message: "User registered successfully",
          user: { id: result.insertId, email: email, role: role },
        });
      });
    });
  });
});

app.post("/api/auth/login", function (req, res) {
  const body = req.body || {};
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : String(body.password || "");

  if (!email || !password.trim()) return res.status(400).json({ error: "Email and password are required" });

  const query =
    "SELECT id, email, password, role " +
    "FROM users " +
    "WHERE LOWER(TRIM(email)) = ? " +
    "LIMIT 1";

  db.query(query, [email], function (err, results) {
    if (err) return res.status(500).json({ error: "Database error" });
    if (!results || results.length === 0) return res.status(401).json({ error: INVALID_CREDENTIALS });

    const user = results[0];
    const dbEmail = typeof user.email === "string" ? user.email.trim() : "";
    const dbHash = typeof user.password === "string" ? user.password.trim() : "";
    const role = typeof user.role === "string" && user.role.trim() ? user.role.trim() : "USER";

    if (!dbHash || dbHash.length < 20) return res.status(401).json({ error: INVALID_CREDENTIALS });

    bcrypt.compare(password.trim(), dbHash, function (compareErr, ok) {
      if (compareErr) return res.status(500).json({ error: "Auth error" });
      if (!ok) return res.status(401).json({ error: INVALID_CREDENTIALS });

      const token = jwt.sign(
        { id: user.id, email: dbEmail || email, role: role },
        CONFIG.JWT.secret,
        { expiresIn: CONFIG.JWT.expiresIn }
      );

      const refreshToken = jwt.sign(
        { id: user.id },
        CONFIG.JWT.refreshSecret,
        { expiresIn: CONFIG.JWT.refreshExpiresIn }
      );

      res.json({ token: token, refreshToken: refreshToken, user: { id: user.id, email: dbEmail || email, role: role } });
    });
  });
});

app.post("/auth/refresh", function (req, res) {
  const refreshToken =
    req.body && Object.prototype.hasOwnProperty.call(req.body, "refreshToken")
      ? req.body.refreshToken
      : undefined;

  if (!refreshToken) return res.status(400).json({ error: "Refresh token required" });

  try {
    const decoded = jwt.verify(refreshToken, CONFIG.JWT.refreshSecret);
    const newToken = jwt.sign({ id: decoded.id }, CONFIG.JWT.secret, { expiresIn: CONFIG.JWT.expiresIn });
    return res.json({ token: newToken });
  } catch (e) {
    return res.status(401).json({ error: "Invalid refresh token" });
  }
});

/* =========================
   APP LOGS (Android)
   ========================= */
app.post("/api/postLogs", function (req, res) {
  var body = req.body || {};
  var clientId = body.clientId ? String(body.clientId).trim() : "";
  var deviceId = body.deviceId ? String(body.deviceId).trim() : "";
  var logs = Array.isArray(body.logs) ? body.logs : [];

  if (!clientId || !deviceId) return res.status(400).json({ value: "clientId and deviceId are required" });
  if (logs.length === 0) return res.status(200).json({ value: "No logs received" });

  var rows = [];
  for (var i = 0; i < logs.length; i++) {
    var item = logs[i] || {};
    var ts = Number(item.time);
    var category = item.category === null || item.category === undefined ? "" : String(item.category).trim();
    var message = item.message === null || item.message === undefined ? "" : String(item.message).trim();

    if (!isFinite(ts) || !category || !message) continue;
    rows.push([clientId, deviceId, Math.trunc(ts), category, message]);
  }

  if (rows.length === 0) return res.status(200).json({ value: "No valid logs in payload" });

  var insertSql = "INSERT IGNORE INTO app_logs (client_id, device_id, ts, category, message) VALUES ?";

  db.query(insertSql, [rows], function (err, result) {
    if (err) {
      logQueryError(err, insertSql, { rowsCount: rows.length });
      return res.status(500).json({ value: "Failed to store logs" });
    }
    var inserted = result && typeof result.affectedRows === "number" ? result.affectedRows : 0;
    return res.status(200).json({ value: "Logs received", received: rows.length, inserted: inserted });
  });
});

app.get("/api/logs", function (req, res) {
  const limit = Math.min(1000, Math.max(1, toInt(req.query.limit || "200", 200)));
  const q =
    "SELECT id, client_id, device_id, ts, category, message, received_at " +
    "FROM app_logs ORDER BY id DESC LIMIT ?";

  db.query(q, [limit], function (err, rows) {
    if (err) return res.status(500).json({ error: "Failed to fetch logs" });
    res.json(rows);
  });
});

/* =========================
   TRANSACTIONS (web app)
   ========================= */
app.post("/api/transactions", function (req, res) {
  const body = req.body || {};
  const receiverPhone = body.receiverPhone;
  const amount = body.amount;
  const note = body.note;

  if (!receiverPhone || amount === null || amount === undefined) {
    return res.status(400).json({ error: "receiverPhone and amount are required" });
  }

  const normalized = normalizeTzPhoneStrict(receiverPhone);
  if (!normalized) {
    return res.status(400).json({ error: "Invalid phone. Must be strict 10 digits starting with 0 (e.g., 0754123456)." });
  }

  const parsedAmount = toNumber(amount, NaN);
  if (!isFinite(parsedAmount) || parsedAmount <= 0) {
    return res.status(400).json({ error: "Invalid amount" });
  }

  const operator = detectOperator(normalized);

  const query =
    "INSERT INTO transactions (number, amount, beneficiary, carrier, message, actin, provider, time, clientId) " +
    "VALUES (?, ?, ?, ?, ?, 'TRANSFER', 'MOBILE_MONEY', NOW(), ?)";

  db.query(query, [normalized, parsedAmount, receiverPhone, operator, note || "", 1], function (err, result) {
    if (err) return res.status(500).json({ error: "Failed to create transaction" });

    clearDashboardCache();

    res.status(201).json({
      id: result.insertId,
      receiverPhone: receiverPhone,
      normalizedPhone: normalized,
      operator: operator,
      amount: parsedAmount,
      currency: "TZS",
      status: "COMPLETED",
      note: note || "",
      created_date: new Date().toISOString(),
      created_by: "system",
    });
  });
});

app.get("/api/transactions", function (req, res) {
  const page = Math.max(1, toInt(req.query.page || "1", 1));
  const pageSize = Math.min(100, Math.max(1, toInt(req.query.pageSize || "10", 10)));
  const offset = (page - 1) * pageSize;

  const operator = req.query.operator;
  const search = req.query.search;

  const where = [];
  const params = [];

  if (search) {
    where.push("(number LIKE ? OR beneficiary LIKE ?)");
    params.push("%" + search + "%", "%" + search + "%");
  }
  if (operator && operator !== "UNKNOWN") {
    where.push("carrier = ?");
    params.push(operator);
  }

  const whereClause = where.length ? "WHERE " + where.join(" AND ") : "";

  const countQuery = "SELECT COUNT(*) AS total FROM transactions " + whereClause;
  const dataQuery =
    "SELECT id, number AS normalizedPhone, beneficiary AS receiverPhone, carrier AS operator, amount, " +
    "'TZS' AS currency, 'COMPLETED' AS status, message AS note, createdat AS created_date, clientId AS created_by, actin AS operation " +
    "FROM transactions " +
    whereClause +
    " ORDER BY createdat DESC LIMIT ? OFFSET ?";

  db.query(countQuery, params, function (err, countRows) {
    if (err) return res.status(500).json({ error: "Failed to count transactions" });

    const total = countRows && countRows[0] ? Number(countRows[0].total || 0) : 0;

    const dataParams = params.slice();
    dataParams.push(pageSize, offset);

    db.query(dataQuery, dataParams, function (err2, rows) {
      if (err2) return res.status(500).json({ error: "Failed to fetch transactions" });

      res.json({
        data: rows,
        total: total,
        page: page,
        pageSize: pageSize,
        totalPages: Math.ceil(total / pageSize),
      });
    });
  });
});

app.get("/api/transactions/:id", function (req, res) {
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ error: "Missing id" });

  const query =
    "SELECT id, number AS normalizedPhone, beneficiary AS receiverPhone, carrier AS operator, amount, " +
    "'TZS' AS currency, 'COMPLETED' AS status, message AS note, createdat AS created_date, clientId AS created_by, actin AS operation " +
    "FROM transactions WHERE id = ? LIMIT 1";

  db.query(query, [id], function (err, rows) {
    if (err) return res.status(500).json({ error: "Failed to fetch transaction" });
    if (!rows || rows.length === 0) return res.status(404).json({ error: "Transaction not found" });
    res.json(rows[0]);
  });
});

/* =========================
   DASHBOARD API
   ========================= */
app.get("/health/dashboard", function (req, res) {
  res.json({
    ok: true,
    service: "dashboard-api-mysql",
    contract_version: CONFIG.DASHBOARD.contractVersion,
  });
});

app.get("/api/dashboard-data", function (req, res) {
  const params = parseDashboardRequestParams(req.query || {});
  const cacheKey = JSON.stringify({
    period: params.period,
    q: safeString(params.searchQuery).trim(),
    operator: safeString(params.operatorFilter).trim(),
    operation: safeString(params.operationFilter).trim(),
    sortBy: params.sortBy,
    sortDir: params.sortDir,
    page: params.page,
    perPage: params.perPage,
    includeFilteredTransactions: params.includeFilteredTransactions,
  });

  const cached = DASHBOARD_CACHE[cacheKey];
  if (!params.forceRefresh && cached && (Date.now() - cached.createdAt) < CONFIG.DASHBOARD.cacheTtlMs) {
    return res.json(cached.payload);
  }

  buildDashboardPayload(params)
    .then(function (payload) {
      DASHBOARD_CACHE[cacheKey] = {
        createdAt: Date.now(),
        payload: payload,
      };
      res.json(payload);
    })
    .catch(function (err) {
      console.error("Dashboard API error:", err && err.message ? err.message : err);
      res.status(500).json({
        ok: false,
        error: "Failed to build dashboard data.",
      });
    });
});

/* =========================
   OPERATORS
   ========================= */
app.get("/api/operators/prefixes", function (req, res) {
  res.json({
    operators: [
      { name: "Vodacom", prefixes: ["075", "074", "076"] },
      { name: "Tigo", prefixes: ["071", "067"] },
      { name: "Airtel", prefixes: ["068", "078"] },
      { name: "Halotel", prefixes: ["062"] },
    ],
  });
});

/* =========================
   SENDER CONFIGURATIONS
   ========================= */
app.get("/api/sender-configurations", function (req, res) {
  const clientCode = safeString(req.query && req.query.client_code).trim();
  const isActiveRaw = safeString(req.query && req.query.is_active).trim();

  let isActive = null;
  if (isActiveRaw !== "") {
    const n = Number(isActiveRaw);
    if (!isNaN(n)) isActive = n;
  }

  let sql =
    "SELECT sender_number, client_code, til_number, til_name, path, is_active " +
    "FROM sender_configurations WHERE 1=1";
  const params = [];

  if (clientCode) {
    sql += " AND client_code = ?";
    params.push(clientCode);
  }
  if (isActive !== null) {
    sql += " AND is_active = ?";
    params.push(isActive);
  }

  sql += " ORDER BY client_code, sender_number";

  db.query(sql, params, function (err, rows) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});

app.put("/api/sender-configurations/:sender_number", function (req, res) {
  const senderNumber = String(req.params.sender_number || "").trim();
  if (!senderNumber) return res.status(400).json({ success: false, message: "sender_number is required" });

  const body = req.body || {};
  const client_code = body.client_code;
  const til_number = body.til_number;
  const til_name = body.til_name;
  const path = body.path;
  const is_active = body.is_active;

  const fields = [];
  const params = [];

  if (client_code !== undefined) { fields.push("client_code = ?"); params.push(client_code); }
  if (til_number !== undefined)  { fields.push("til_number = ?");  params.push(til_number); }
  if (til_name !== undefined)    { fields.push("til_name = ?");    params.push(til_name); }
  if (path !== undefined)        { fields.push("path = ?");        params.push(path); }
  if (is_active !== undefined)   { fields.push("is_active = ?");   params.push(is_active); }

  if (fields.length === 0) return res.status(400).json({ success: false, message: "No fields to update" });

  params.push(senderNumber);

  const updateSql = "UPDATE sender_configurations SET " + fields.join(", ") + " WHERE sender_number = ?";

  db.query(updateSql, params, function (err, result) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!result || result.affectedRows === 0) return res.status(404).json({ success: false, message: "Not found" });

    db.query(
      "SELECT sender_number, client_code, til_number, til_name, path, is_active FROM sender_configurations WHERE sender_number = ?",
      [senderNumber],
      function (err2, rows) {
        if (err2) return res.status(500).json({ success: false, message: err2.message });
        res.json({ success: true, data: rows[0] });
      }
    );
  });
});

/* =========================
   REPORTS
   ========================= */
app.post("/api/reports/run", function (req, res) {
  const body = req.body || {};
  const dateFrom = body.dateFrom;
  const dateTo = body.dateTo;
  const operators = body.operators;
  const amountMin = body.amountMin;
  const amountMax = body.amountMax;
  const groupBy = body.groupBy;

  const whereConditions = ["1=1"];
  const queryParams = [];

  if (dateFrom) { whereConditions.push("createdat >= ?"); queryParams.push(dateFrom); }
  if (dateTo) { whereConditions.push("createdat <= ?"); queryParams.push(dateTo); }

  if (operators && Array.isArray(operators) && operators.length > 0) {
    whereConditions.push("carrier IN (" + operators.map(function () { return "?"; }).join(",") + ")");
    for (let i = 0; i < operators.length; i++) queryParams.push(operators[i]);
  }

  if (amountMin !== null && amountMin !== undefined && amountMin !== "") {
    whereConditions.push("amount >= ?");
    queryParams.push(toNumber(amountMin, 0));
  }
  if (amountMax !== null && amountMax !== undefined && amountMax !== "") {
    whereConditions.push("amount <= ?");
    queryParams.push(toNumber(amountMax, 0));
  }

  const whereClause = whereConditions.join(" AND ");

  let groupExpr = "DATE(createdat)";
  if (groupBy === "operator") groupExpr = "carrier";
  else if (groupBy === "month") groupExpr = "DATE_FORMAT(createdat, '%Y-%m-01')";
  else if (groupBy === "week") groupExpr = "YEARWEEK(createdat, 1)";

  const query =
    "SELECT " + groupExpr + " AS group_key, COUNT(*) as count, SUM(amount) as sum, AVG(amount) as avg " +
    "FROM transactions WHERE " + whereClause + " GROUP BY group_key ORDER BY group_key ASC";

  db.query(query, queryParams, function (err, results) {
    if (err) return res.status(500).json({ error: "Failed to generate report" });
    res.json({ results: results });
  });
});

app.post("/api/reports/export", function (req, res) {
  const format = String(req.query.format || "csv").toLowerCase();
  if (format !== "csv") return res.status(400).json({ error: "Only CSV export is implemented here (format=csv)." });

  const query = "SELECT * FROM transactions ORDER BY createdat DESC LIMIT 1000";
  db.query(query, function (err, results) {
    if (err) return res.status(500).json({ error: "Export failed" });

    const headers = Object.keys(results[0] || {});
    const lines = [headers.join(",")];

    for (let i = 0; i < results.length; i++) {
      const row = results[i];
      const cells = [];
      for (let j = 0; j < headers.length; j++) {
        const h = headers[j];
        const v = row[h] === null || row[h] === undefined ? "" : String(row[h]);
        const escaped = v.replace(/"/g, '""');
        cells.push(/[",\n]/.test(escaped) ? '"' + escaped + '"' : escaped);
      }
      lines.push(cells.join(","));
    }

    const csv = lines.join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=report.csv");
    res.send(csv);
  });
});

/* =========================
   LEGACY /api/* endpoints (RESTORED)
   ========================= */

// Insert SMS data
app.post("/api/sms", function (req, res) {
  const body = req.body || {};
  const sender = body.sender;
  const reference = body.reference;
  const amount = body.amount;
  const timestamp = body.timestamp;
  const fullmessage = body.fullmessage;
  const operation = body.operation;

  if (!sender || !reference || !amount || !timestamp || !fullmessage || !operation) {
    return res.status(400).json({ error: "All fields are required." });
  }

  const query =
    "INSERT INTO sms (sender, reference, amount, timestamp, fullmessage, operation) VALUES (?, ?, ?, ?, ?, ?)";

  db.query(query, [sender, reference, amount, timestamp, fullmessage, operation], function (err, result) {
    if (err) {
      logQueryError(err, query, body);
      return res.status(500).json({ error: "Failed to store SMS data." });
    }
    res.status(201).json({ message: "SMS data stored successfully.", id: result.insertId });
  });
});

// Insert balance request
app.post("/api/balance", function (req, res) {
  const body = req.body || {};
  const mobileCarrier = body.mobileCarrier;
  const phoneNumber = body.phoneNumber;
  const request = body.request;

  if (!mobileCarrier || !phoneNumber || !request) {
    return res.status(400).json({ error: "All fields are required." });
  }

  const query = "INSERT INTO request (mobileCarrier, phoneNumber, request) VALUES (?, ?, ?)";
  db.query(query, [mobileCarrier, phoneNumber, request], function (err, result) {
    if (err) {
      logQueryError(err, query, body);
      return res.status(500).json({ error: "Failed to insert balance request." });
    }
    res.status(201).json({ message: "Balance request inserted successfully.", id: result.insertId });
  });
});

// Get list of SMS received
app.get("/api/getmessages", function (req, res) {
  const query = "SELECT * FROM messages";
  db.query(query, function (err, results) {
    if (err) {
      logQueryError(err, query);
      return res.status(500).json({ error: "Failed to get SMS." });
    }
    res.json(results);
  });
});

// Insert request from admin to the client
app.post("/api/insertRequest", function (req, res) {
  const body = req.body || {};
  const mobileCarrier = body.mobileCarrier;
  const phoneNumber = body.phoneNumber;
  const amount = body.amount;
  const receiverNumber = body.receiverNumber;
  const mrequest = body.mrequest;
  const client = body.client;
  const action = body.action;

  if (!mobileCarrier || !phoneNumber || !amount || !receiverNumber || !mrequest || !client || !action) {
    return res.status(400).json({ error: "All fields are required." });
  }

  const checkDuplicateQuery =
    "SELECT COUNT(*) AS count " +
    "FROM request " +
    "WHERE phoneNumber = ? " +
    "  AND receiverNumber = ? " +
    "  AND amount = ? " +
    "  AND mobileCarrier = ? " +
    "  AND createdAt >= (NOW() - INTERVAL 5 MINUTE)";

  db.query(
    checkDuplicateQuery,
    [phoneNumber, receiverNumber, amount, mobileCarrier],
    function (err, results) {
      if (err) {
        logQueryError(err, checkDuplicateQuery, { phoneNumber, receiverNumber, amount, mobileCarrier });
        return res.status(500).json({ error: "Failed to check for duplicate transfers." });
      }

      const duplicateCount = results && results[0] ? Number(results[0].count || 0) : 0;
      if (duplicateCount > 0) {
        return res.status(409).json({
          error:
            "A similar transfer has been initiated recently. Please wait a few minutes before trying again or confirm it's not a duplicate.",
        });
      }

      const insertQuery =
        "INSERT INTO request (mobileCarrier, phoneNumber, amount, receiverNumber, request, client, action) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)";

      db.query(
        insertQuery,
        [mobileCarrier, phoneNumber, amount, receiverNumber, mrequest, client, action],
        function (err2, result) {
          if (err2) {
            logQueryError(err2, insertQuery, body);
            return res.status(500).json({ error: "Failed to insert admin request." });
          }
          res.status(200).json({ message: "Admin request inserted successfully.", id: result.insertId });
        }
      );
    }
  );
});

// Get all requests
app.get("/api/getrequest", function (req, res) {
  const client = req.query && req.query.client ? req.query.client : null;
  if (!client) return res.status(400).json({ success: false, error: "client is required" });

  const query = "SELECT * FROM request WHERE client = ? AND status IS NULL ORDER BY id DESC LIMIT 100";
  db.query(query, [client], function (err, rows) {
    if (err) {
      logQueryError(err, query, { client: client });
      return res.status(500).json({ error: "Failed to fetch requests." });
    }
    res.json({ success: true, count: rows.length, data: rows });
  });
});

// Post message
app.post("/api/postmessage", function (req, res) {
  const body = req.body || {};
  const message = body.message;
  const phoneId = body.phoneId;
  const phoneName = body.phoneName;
  const sender = body.sender;
  const sim = body.sim;
  const smsId = body.smsId;
  const time = body.time;

  const missingFields = [];
  if (!message) missingFields.push("message");
  if (!phoneId) missingFields.push("phoneId");
  if (!phoneName) missingFields.push("phoneName");
  if (!sender) missingFields.push("sender");
  if (!sim) missingFields.push("sim");
  if (!smsId) missingFields.push("smsId");
  if (!time) missingFields.push("time");

  if (missingFields.length > 0) return res.status(400).json({ error: "Missing fields: " + missingFields.join(", ") });

  const sql =
    "INSERT INTO messages (message, phoneId, phoneName, sender, sim, smsId, time) VALUES (?, ?, ?, ?, ?, ?, ?)";

  db.query(sql, [message, phoneId, phoneName, sender, sim, smsId, time], function (err, result) {
    if (err) return res.status(500).json({ error: "Failed to insert data" });
    res.status(200).json({ message: "Data inserted successfully", data: result });
  });
});

// Post balance
app.post("/api/postbalance", function (req, res) {
  const body = req.body || {};
  const clientId = body.clientId;
  const carrier = body.carrier;
  const provider = body.provider;
  const value = body.value;
  const time = body.time;

  if (!carrier || !clientId || !provider || !time || !value) {
    return res.status(400).json({ error: "All fields are required except id and createdAt" });
  }

  const sql = "INSERT INTO balance (carrier, clientId, provider, time, value) VALUES (?, ?, ?, ?, ?)";

  db.query(sql, [carrier, clientId, provider, time, value], function (err, result) {
    if (err) return res.status(500).json({ error: "Failed to insert data" });
    res.status(200).json({ message: "Balance saved successfully", insertId: result.insertId });
  });
});

// Post transaction (legacy)
app.post("/api/postTransaction", function (req, res) {
  const body = req.body || {};
  const actin = body.actin;
  const amount = body.amount;
  const balance = body.balance;
  const beneficiary = body.beneficiary;
  const carrier = body.carrier;
  const clientId = body.clientId;
  const message = body.message;
  const number = body.number;
  const provider = body.provider;
  const time = body.time;

  const sql =
    "INSERT INTO transactions (actin, amount, balance, beneficiary, carrier, clientId, message, number, provider, time) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

  db.query(sql, [actin, amount, balance, beneficiary, carrier, clientId, message, number, provider, time], function (err, result) {
    if (err) return res.status(500).json({ message: "Database error", error: err });
    clearDashboardCache();
    res.status(200).json({ message: "Transaction saved successfully", transactionId: result.insertId });
  });
});

// Get balances
app.get("/api/getbalance", function (req, res) {
  const query = "SELECT * FROM balance";
  db.query(query, function (err, results) {
    if (err) return res.status(500).json({ error: "Failed to fetch balance." });
    res.json(results);
  });
});

// Get transactions (legacy list)
app.get("/api/getTransactions", function (req, res) {
  const query = "SELECT * FROM transactions ORDER BY id DESC LIMIT 10";
  db.query(query, function (err, results) {
    if (err) return res.status(500).json({ error: "Failed to fetch transactions." });
    res.json(results);
  });
});

// Live chart
app.get("/api/getLivechart", function (req, res) {
  const query =
    "SELECT DATE(createdat) AS date, COUNT(amount) AS total_amount " +
    "FROM transactions " +
    "WHERE createdat >= CURDATE() - INTERVAL 6 DAY " +
    "GROUP BY DATE(createdat) " +
    "ORDER BY date ASC";

  db.query(query, function (err, results) {
    if (err) return res.status(500).json({ error: "Database error" });

    const labels = [];
    const values = [];

    const today = new Date();
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(today.getDate() - i);
      labels.push(d.toISOString().split("T")[0]);
      values.push(0);
    }

    for (let i = 0; i < results.length; i++) {
      const row = results[i];
      const rowDate = row.date instanceof Date ? row.date.toISOString().split("T")[0] : String(row.date);
      const idx = labels.indexOf(rowDate);
      if (idx !== -1) values[idx] = toNumber(row.total_amount, 0);
    }

    res.json({ labels: labels, values: values });
  });
});

// Update request feedback
app.put("/api/postRequestFeedback/:id", function (req, res) {
  const id = req.params.id;
  const sql = "UPDATE request SET status = '100' WHERE id = ?";

  db.query(sql, [id], function (err, result) {
    if (err) return res.status(500).json({ error: "Failed to update request" });
    if (!result || result.affectedRows === 0) return res.status(404).json({ message: "Request not found" });
    res.status(200).json({ message: "Request updated successfully" });
  });
});

/* =========================
   Global error handler
   ========================= */
app.use(function (err, req, res, next) {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

/* =========================
   START SERVER
   ========================= */
app.listen(CONFIG.PORT, function () {
  console.log("API running on port " + CONFIG.PORT);
});
