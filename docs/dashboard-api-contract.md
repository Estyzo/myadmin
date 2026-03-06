# Dashboard API Contract

## Endpoint

`GET /api/dashboard-data`

This contract is intended for server-side dashboard rendering, exports, and future upstream API migration.

## Query Parameters

- `period`: `today` or `all`
- `q`: free-text search against sender, receiver, operator, operation, amount, creator, and formatted date
- `operator`: exact operator filter
- `operation`: exact operation filter
- `sort_by`: `date`, `amount`, or `operator`
- `sort_dir`: `asc` or `desc`
- `page`: 1-based page number
- `per_page`: `15`, `30`, or `50`
- `refresh`: `1|true|yes|on` to bypass transaction cache
- `include_filtered`: `1|true|yes|on` to include all filtered rows in `data.filtered_transactions`

## Success Response

```json
{
  "ok": true,
  "data": {
    "period": "today",
    "per_page": 15,
    "per_page_options": [15, 30, 50],
    "filters": {
      "q": "",
      "operator": "",
      "operation": ""
    },
    "sort": {
      "by": "date",
      "dir": "desc"
    },
    "pagination": {
      "page": 1,
      "per_page": 15,
      "total": 0,
      "total_pages": 0,
      "has_prev": false,
      "has_next": false,
      "prev_page": 1,
      "next_page": 1,
      "start_row": 0,
      "end_row": 0
    },
    "operator_options": ["VodaCom", "YAS"],
    "operation_options": ["Received", "Transfer"],
    "data_status": {
      "level": "info",
      "title": "No Transactions For Today",
      "message": "Live data loaded successfully, but the latest transaction is from 05 Mar 2026. There are no transactions dated 06 Mar 2026 yet.",
      "last_updated": "06 Mar 2026, 03:45:32 PM",
      "can_retry": true
    },
    "stats": {
      "total_label": "TOTAL VOLUME TODAY",
      "sent_label": "SENT TODAY",
      "received_label": "RECEIVED TODAY",
      "total_volume": "TZS 0.00",
      "total_transactions": 0,
      "sent_amount": "TZS 0.00",
      "received_amount": "TZS 0.00",
      "outgoing_transfers": 0,
      "incoming_transfers": 0,
      "total_trend": {
        "delta_direction": "flat",
        "delta_text": "No change vs yesterday",
        "sparkline_points": "..."
      },
      "sent_trend": {
        "delta_direction": "flat",
        "delta_text": "No change vs yesterday",
        "sparkline_points": "..."
      },
      "received_trend": {
        "delta_direction": "flat",
        "delta_text": "No change vs yesterday",
        "sparkline_points": "..."
      }
    },
    "transactions": [
      {
        "id": 803,
        "sender_number": "0753901881",
        "receiver_number": "255760020033 - DAVID ETKO MPONZI,",
        "operator": "VodaCom",
        "operation": "Transfer",
        "amount": "TZS 5,000.00",
        "status": "COMPLETED",
        "created_by": "client2",
        "created_at": "05 Mar 2026, 04:13 PM"
      }
    ]
  },
  "meta": {
    "contract_version": "2026-03-06",
    "generated_at": "2026-03-06T12:45:32Z",
    "source": "live",
    "used_stale": false,
    "last_updated": 1772801132.481,
    "last_updated_label": "06 Mar 2026, 03:45:32 PM",
    "error": ""
  }
}
```

## Notes

- `data.transactions` is always paginated.
- `data.filtered_transactions` is returned only when `include_filtered=1`.
- `meta.source` is one of `live`, `cache`, or `error`.
- `data_status` is already presentation-ready for HTML views.
