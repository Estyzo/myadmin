import smtplib
from html import escape
from email.message import EmailMessage
from email.utils import formataddr


class EmailDeliveryError(RuntimeError):
    pass


def smtp_is_configured(config):
    return bool(str(config.get("MAIL_SERVER") or "").strip() and str(config.get("MAIL_DEFAULT_SENDER") or "").strip())


def sender_address(config):
    sender = str(config.get("MAIL_DEFAULT_SENDER") or "").strip()
    from_name = str(config.get("MAIL_FROM_NAME") or "").strip()
    return formataddr((from_name, sender)) if from_name else sender


def send_email(to_email, subject, text_body, html_body="", config=None):
    if not config or not smtp_is_configured(config):
        raise EmailDeliveryError("Email is not configured. Set MAIL_SERVER and MAIL_DEFAULT_SENDER.")

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = sender_address(config)
    message["To"] = str(to_email or "").strip()
    message.set_content(text_body)
    if html_body:
        message.add_alternative(html_body, subtype="html")

    server = str(config.get("MAIL_SERVER") or "").strip()
    port = int(config.get("MAIL_PORT") or 587)
    username = str(config.get("MAIL_USERNAME") or "").strip()
    password = str(config.get("MAIL_PASSWORD") or "")
    use_ssl = bool(config.get("MAIL_USE_SSL"))
    use_tls = bool(config.get("MAIL_USE_TLS")) and not use_ssl

    try:
        smtp_class = smtplib.SMTP_SSL if use_ssl else smtplib.SMTP
        with smtp_class(server, port, timeout=15) as smtp:
            if use_tls:
                smtp.starttls()
            if username:
                smtp.login(username, password)
            smtp.send_message(message)
    except Exception as exc:
        raise EmailDeliveryError(str(exc)) from exc


def send_invitation_email(invitation, invite_link, invited_by="", config=None):
    role = invitation.get("role", "operator")
    client_codes = ", ".join(invitation.get("client_codes") or []) or "assigned clients"
    safe_role = escape(role)
    safe_client_codes = escape(client_codes)
    safe_invite_link = escape(invite_link, quote=True)
    subject = "Your TransferFlow invitation"
    text_body = "\n".join(
        [
            "You have been invited to TransferFlow.",
            "",
            f"Role: {role}",
            f"Client scope: {client_codes}",
            f"Invited by: {invited_by or 'TransferFlow administrator'}",
            "",
            "Open this secure link to create your password:",
            invite_link,
            "",
            "This invitation expires automatically. If you did not expect this email, ignore it.",
        ]
    )
    html_body = f"""
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#172033">
      <h2 style="margin:0 0 12px">TransferFlow invitation</h2>
      <p>You have been invited to TransferFlow.</p>
      <p><strong>Role:</strong> {safe_role}<br><strong>Client scope:</strong> {safe_client_codes}</p>
      <p>
        <a href="{safe_invite_link}" style="display:inline-block;background:#0f766e;color:#fff;padding:12px 16px;border-radius:8px;text-decoration:none;font-weight:700">
          Create your password
        </a>
      </p>
      <p style="color:#64748b">This invitation expires automatically. If you did not expect this email, ignore it.</p>
    </div>
    """
    send_email(invitation["email"], subject, text_body, html_body=html_body, config=config)
