# App Change Log and API Usage

This document tracks important implementation details for the Flask admin app, especially transfer creation, sender configuration, approval polling, and browser/PWA behavior.

## App Overview

- App framework: Flask with Jinja templates.
- Main local URL: `http://127.0.0.1:5000`
- Shared shell: `templates/base_app.html`
- Transfer page: `templates/partials/send_money_content.html`
- Transfer frontend logic: `static/ux-enhancements.js`
- Transfer backend logic: `app/services/transfers.py`
- API client wrapper: `app/clients/api_client.py`
- Runtime configuration: `app/config.py` and `.env`

## Current Base API

Configured in `.env`:

```env
API_BASE_URL=https://wakala.southerntechnologies.tech/api
```

Derived URLs:

- Sender config: `https://wakala.southerntechnologies.tech/api/sender-configurations`
- Transfer create: `https://wakala.southerntechnologies.tech/api/insertRequest`
- Approval focus polling: `https://wakala.southerntechnologies.tech/api/requestFocus/:id`
- Approval decision: `https://wakala.southerntechnologies.tech/api/requestApprovalDecision/:id`

## Transfer Flow

1. User selects an active sender configuration.
2. Sender details are read from sender config:
   - `sender_number`
   - `client_code`
   - `mobile_operator`
   - `path`
3. Receiver number is normalized to local 10-digit format starting with `0`.
4. Sender number is also normalized to local 10-digit format for the upstream `phoneNumber` field.
5. Receiver operator is inferred from phone prefix.
6. Cross-operator transfer is blocked before submission.
7. Amount must be greater than or equal to `1000`.
8. Sender config `path` is resolved into `mrequest`.
9. App posts to `insertRequest`.
10. App immediately starts polling using the returned request id and owner token.
11. When server/device returns an approval prompt, popup enables Approve/Reject.
12. Decision is submitted back to server.

## Transfer Create Payload

Endpoint:

```http
POST /api/insertRequest
```

Payload shape sent upstream:

```json
{
  "mobileCarrier": "Yas",
  "phoneNumber": "0712345678",
  "amount": 1000,
  "receiverNumber": "0712345678",
  "mrequest": "*150*0712345678*1000#",
  "client": "CLIENT-1",
  "action": "TRANSFER",
  "initiatedBy": "transferflow-admin",
  "clientRequestId": "transferflow-..."
}
```

Important notes:

- `mrequest` must be built from the selected sender configuration `path`.
- If the path contains `receivernumber`, replace it with the normalized receiver number.
- If the path contains `amount`, replace it with the entered amount.
- `phoneNumber` is the normalized sender number in local format.
- `receiverNumber` is the normalized receiver number in local format.

Example:

```text
Path: *150*receivernumber*amount#
Receiver: 0712345678
Amount: 1000
Resolved mrequest: *150*0712345678*1000#
```

## Approval Polling

After transfer creation, upstream returns:

```json
{
  "success": true,
  "id": 123,
  "ownerToken": "...",
  "clientRequestId": "transferflow-..."
}
```

The app stores:

- `request_id`
- `owner_token`
- `initiated_by`
- `client_request_id`

Polling endpoint through Flask:

```http
POST /api/send-money/approval-status
```

Flask calls upstream:

```http
POST /api/requestFocus/:id
```

Payload:

```json
{
  "ownerToken": "...",
  "initiatedBy": "transferflow-admin",
  "clientRequestId": "transferflow-..."
}
```

Expected focus data may include:

- `approvalStatus`
- `approvalPromptText`
- `deviceStatus`
- `approvalNote`

The popup starts in waiting state immediately after request creation. Approve/Reject are disabled until an approval prompt is received.

## Approval Decision

Flask endpoint:

```http
POST /api/send-money/approval-decision
```

Flask calls upstream:

```http
POST /api/requestApprovalDecision/:id
```

Payload:

```json
{
  "decision": "APPROVED",
  "note": "",
  "ownerToken": "...",
  "initiatedBy": "transferflow-admin",
  "clientRequestId": "transferflow-..."
}
```

Valid decisions:

- `APPROVED`
- `REJECTED`

## Sender Configuration Rules

Sender configs are loaded from:

```http
GET /api/sender-configurations
```

The app normalizes:

- `sender_number`
- `client_code`
- `mobile_operator`
- `path`
- `is_active`

Settings page includes an active/inactive toggle. Inactive senders are excluded from the transfer form.

## Phone Normalization

Receiver examples:

```text
255712345678      -> 0712345678
+255 712 345 678 -> 0712345678
0712 345 678      -> 0712345678
712345678         -> 0712345678
```

Sender is matched internally against config as `+255...`, but sent upstream as local `0...` in `phoneNumber`.

## Operator Matching

Cross-operator transfer is blocked.

Prefix mapping:

- `61`, `62`: Halotel
- `68`, `69`, `78`: Airtel
- `65`, `67`, `71`, `77`: Yas
- `74`, `75`, `76`: Vodacom

## PWA Notes

The app includes:

- `static/manifest.webmanifest`
- `static/service-worker.js`
- app icons in `static/icons/`

When JS/CSS changes should be refreshed for installed/browser clients, bump `CACHE_NAME` in `static/service-worker.js`.

## Recent Changes

- Added PWA install support.
- Added sender active/inactive toggle.
- Added sender client code and mobile operator display.
- Added receiver and sender normalization.
- Added cross-operator transfer blocking.
- Changed amount rule to `>= 1000`.
- Changed transfer create endpoint to `insertRequest`.
- Added approval polling and approval/reject popup.
- Resolved sender config path placeholders into `mrequest`.
