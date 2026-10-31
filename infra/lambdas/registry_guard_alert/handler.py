"""
Detect-and-alert response for the App Registry guardrails.

This Lambda is invoked by all three EventBridge rules in AppRegistryGuardStack
(blocked writes, unauthorized successful writes, guardrail tampering).

Rules invoke this Lambda directly so the
alert email can be built as plain, readable sentences in Python.
"""

import os
import json
import boto3

sns = boto3.client("sns")
ALERT_TOPIC_ARN = os.environ.get("ALERT_TOPIC_ARN")

APP_PK_PREFIX = "APP#"


def _attribute_value_to_plain(av):
    if isinstance(av, dict) and len(av) == 1:
        type_key, value = next(iter(av.items()))
        if type_key in ("S", "N"):
            return value
        if type_key == "BOOL":
            return bool(value)
        if type_key == "NULL":
            return None
        if type_key == "L":
            return [_attribute_value_to_plain(v) for v in (value or [])]
        if type_key == "M":
            return {k: _attribute_value_to_plain(v) for k, v in (value or {}).items()}
    return av


def _attribute_value_to_str(av):
    plain = _attribute_value_to_plain(av)
    return plain if isinstance(plain, str) else None


def _format_item_fields(item):
    if not item:
        return None
    lines = []
    for field in sorted(item.keys()):
        plain = _attribute_value_to_plain(item[field])
        text = json.dumps(plain) if not isinstance(plain, str) else plain
        if len(text) > 200:
            text = text[:200] + "... (truncated, see CloudTrail for the full value)"
        lines.append(f"  - {field}: {text}")
    return "\n".join(lines)


def _format_attempted_write(detail):
    """Describe what the caller actually tried to write, for the blocked-write
    alert. Covers PutItem, UpdateItem/DeleteItem, and BatchWriteItem.

    Important limitation: for a DENIED call, CloudTrail generally does not
    log the full item values - only the key and, for PutItem, the list of
    attribute NAMES involved ("items": [...]), not their values. This
    reflects that honestly instead of silently showing nothing.
    """
    req = detail.get("requestParameters", {}) or {}
    event_name = detail.get("eventName", "")

    if event_name == "PutItem":
        item = req.get("item")
        if item:
            fields = _format_item_fields(item)
            if fields:
                return f"They attempted to write an item with these fields:\n{fields}"
        key_fields = _format_item_fields(req.get("key"))
        attribute_names = req.get("items")
        if key_fields or attribute_names:
            parts = []
            if key_fields:
                parts.append(f"They targeted the item with this key:\n{key_fields}")
            if attribute_names:
                names = ", ".join(sorted(attribute_names))
                parts.append(
                    f"CloudTrail did not log the attempted values for a "
                    f"denied PutItem, only the attribute names involved: "
                    f"{names}."
                )
            return "\n\n".join(parts)

    if event_name in ("UpdateItem", "DeleteItem"):
        key_fields = _format_item_fields(req.get("key"))
        parts = []
        if key_fields:
            parts.append(f"They targeted the item with this key:\n{key_fields}")
        attribute_updates = req.get("attributeUpdates")
        update_expression = req.get("updateExpression")
        if event_name == "UpdateItem" and attribute_updates:
            change_lines = []
            for field in sorted(attribute_updates.keys()):
                change = attribute_updates[field] or {}
                action = change.get("Action", "PUT")
                new_value = _attribute_value_to_plain(change.get("Value", {}))
                text = json.dumps(new_value) if not isinstance(new_value, str) else new_value
                change_lines.append(f"  - {field}: {action} -> {text}")
            parts.append("Attempted attribute changes:\n" + "\n".join(change_lines))
        elif event_name == "UpdateItem" and update_expression:
            parts.append(f"Update expression: {update_expression}")
        if parts:
            return "\n\n".join(parts)

    if event_name == "BatchWriteItem":
        request_items = req.get("requestItems", {}) or {}
        entries = []
        for table_name, requests in request_items.items():
            for entry in requests or []:
                if "PutRequest" in entry:
                    fields = _format_item_fields(entry["PutRequest"].get("item"))
                    if fields:
                        entries.append(f"Put into {table_name}:\n{fields}")
                elif "DeleteRequest" in entry:
                    fields = _format_item_fields(entry["DeleteRequest"].get("key"))
                    if fields:
                        entries.append(f"Delete from {table_name} (key):\n{fields}")
        if entries:
            return "They attempted a batch write:\n\n" + "\n\n".join(entries)

    return None


def _app_id_from_pk(pk):
    if isinstance(pk, str) and pk.startswith(APP_PK_PREFIX):
        return pk[len(APP_PK_PREFIX):]
    return None


def _extract_app_ids(detail):
    """Return the list of distinct app ids affected by this CloudTrail event.

    Handles both single-item calls (PutItem / UpdateItem / DeleteItem), where
    requestParameters carries a flat "key" or "item" with a "PK" attribute,
    and BatchWriteItem, where requestParameters carries "requestItems" keyed
    by table name with a list of PutRequest/DeleteRequest entries, any of
    which may reference a different app.
    """
    req = detail.get("requestParameters", {}) or {}
    app_ids = []

    key = req.get("key", {}) or {}
    item = req.get("item", {}) or {}
    pk = _attribute_value_to_str(key.get("PK", {})) or _attribute_value_to_str(item.get("PK", {}))
    app_id = _app_id_from_pk(pk)
    if app_id:
        app_ids.append(app_id)

    request_items = req.get("requestItems", {}) or {}
    for _table_name, requests in request_items.items():
        for entry in requests or []:
            put_req = (entry or {}).get("PutRequest", {}) or {}
            del_req = (entry or {}).get("DeleteRequest", {}) or {}
            batch_item = put_req.get("item", {}) or {}
            batch_key = del_req.get("key", {}) or {}
            batch_pk = _attribute_value_to_str(batch_item.get("PK", {})) or _attribute_value_to_str(
                batch_key.get("PK", {})
            )
            batch_app_id = _app_id_from_pk(batch_pk)
            if batch_app_id:
                app_ids.append(batch_app_id)

    seen = set()
    deduped = []
    for aid in app_ids:
        if aid not in seen:
            seen.add(aid)
            deduped.append(aid)
    return deduped


def _format_blocked_write(detail):
    caller = detail.get("userIdentity", {}).get("arn", "an unknown principal")
    event_name = detail.get("eventName", "a write")
    table_name = detail.get("requestParameters", {}).get("tableName", "the registry table")
    event_time = detail.get("eventTime", "an unknown time")
    source_ip = detail.get("sourceIPAddress", "an unknown address")

    message = (
        f"The App Registry guardrails blocked a write attempt to the App Catalog registry DynamoDB table. "
        f"No data was changed; this is just an alert to inform you the deny "
        f"policy successfully worked.\n\n"
        f"On date :{event_time}, {caller} tried to run {event_name} on the "
        f"{table_name} table from IP address {source_ip}, and AWS denied it "
        f"because that principal is not the approved writer role."
    )

    attempted_write = _format_attempted_write(detail)
    if attempted_write:
        message += f"\n\n{attempted_write}"

    message += (
        f"\n\nYou do not need to do anything. If you do not recognize this "
        f"caller, it is worth finding out why they tried to write to the "
        f"registry directly."
    )
    return message


def _format_unauthorized_write(detail, app_ids):
    caller = detail.get("userIdentity", {}).get("arn", "an unknown principal")
    event_name = detail.get("eventName", "a write")
    table_name = detail.get("requestParameters", {}).get("tableName", "the registry table")
    event_time = detail.get("eventTime", "an unknown time")
    source_ip = detail.get("sourceIPAddress", "an unknown address")
    affected = ", ".join(app_ids) if app_ids else "an app that could not be identified from the event"

    return (
        f"A write to the App Registry table succeeded from a principal that "
        f"is not the approved writer role. This should not be possible while "
        f"the deny policy is in place.\n\n"
        f"On {event_time}, {caller} ran {event_name} on the {table_name} "
        f"table from IP address {source_ip}, and it went through. The "
        f"affected app(s): {affected}.\n\n"
        f"No automated rollback was attempted. Please review the affected app's version history "
        f"(PK = APP#<app_id> in the table) and decide whether a manual "
        f"correction is needed."
    )


def _format_tampering(detail):
    caller = detail.get("userIdentity", {}).get("arn", "an unknown principal")
    event_name = detail.get("eventName", "an action")
    event_source = detail.get("eventSource", "an AWS service")
    event_time = detail.get("eventTime", "an unknown time")
    source_ip = detail.get("sourceIPAddress", "an unknown address")

    return (
        f"Someone may have just tampered with the App Registry guardrails "
        f"themselves. Please review this immediately.\n\n"
        f"On {event_time}, {caller} ran {event_name} (a {event_source} "
        f"action) from IP address {source_ip}.\n\n"
        f"This kind of action can disable the CloudTrail audit log or weaken "
        f"the deny policy that protects the registry table, so it deserves a "
        f"closer look even if it turns out to be expected."
    )


def _publish(subject, message):
    if not ALERT_TOPIC_ARN:
        print("ALERT_TOPIC_ARN not set; skipping notification.")
        return
    try:
        sns.publish(TopicArn=ALERT_TOPIC_ARN, Subject=subject, Message=message)
    except Exception as exc:  # noqa: BLE001 - never let a notification failure hide the detection
        print(f"Failed to publish notification: {exc}")


def lambda_handler(event, context):
    print("Guardrail handler triggered:", json.dumps(event, default=str))
    detail = event.get("detail", {})
    kind = event.get("guardrailAlertKind", "unauthorized_write")

    if kind == "blocked_write":
        _publish(
            "App Registry: a blocked write attempt was detected",
            _format_blocked_write(detail),
        )
        return {"status": "notified", "kind": kind}

    if kind == "tampering":
        _publish(
            "App Registry: possible guardrail tampering detected",
            _format_tampering(detail),
        )
        return {"status": "notified", "kind": kind}

    app_ids = _extract_app_ids(detail)
    if not app_ids:
        print("Could not determine any affected appId from the event.")
    _publish(
        "App Registry: an unauthorized write succeeded",
        _format_unauthorized_write(detail, app_ids),
    )
    return {"status": "notified", "kind": kind, "appIds": app_ids}
