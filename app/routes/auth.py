from flask import current_app, jsonify, redirect, render_template, request, url_for

from app.services.auth import (
    accept_invitation,
    active_admin_count,
    authenticate_user,
    build_invite_url,
    create_invitation,
    current_user,
    get_invitation_by_id,
    get_invitation_by_token,
    get_user_by_id,
    has_permission,
    invitation_is_usable,
    list_audit_logs,
    list_invitations,
    list_users,
    login_user,
    log_audit_event,
    logout_user,
    mark_invitation_delivery,
    revoke_invitation,
    role_home_endpoint,
    set_user_status,
    update_user_access,
)
from app.services.email import EmailDeliveryError, send_invitation_email


def split_form_scope(value):
    return [item.strip() for item in str(value or "").split(",") if item.strip()]


def request_ip():
    forwarded_for = request.headers.get("X-Forwarded-For", "")
    if forwarded_for:
        return forwarded_for.split(",", 1)[0].strip()
    return request.remote_addr or ""


def request_user_agent():
    return request.headers.get("User-Agent", "")


def audit(action, target_type="", target_id="", target_label="", details=None, actor=None):
    log_audit_event(
        action=action,
        actor=actor if actor is not None else current_user(),
        target_type=target_type,
        target_id=target_id,
        target_label=target_label,
        details=details,
        ip_address=request_ip(),
        user_agent=request_user_agent(),
        config=current_app.config,
    )


def render_users_page(invite_link="", invite_error="", invite_notice="", status_error="", status_notice=""):
    return render_template(
        "users.html",
        users=list_users(current_app.config),
        invitations=list_invitations(current_app.config),
        audit_logs=list_audit_logs(30, current_app.config),
        invite_link=invite_link,
        invite_error=invite_error,
        invite_notice=invite_notice,
        status_error=status_error,
        status_notice=status_notice,
    )


def deliver_invitation(token):
    invite_link = build_invite_url(token)
    invitation = get_invitation_by_token(token, config=current_app.config)
    invited_by = (current_user() or {}).get("email", "")
    try:
        if invitation:
            send_invitation_email(invitation, invite_link, invited_by=invited_by, config=current_app.config)
        mark_invitation_delivery(token, sent=True, config=current_app.config)
        if invitation:
            audit(
                "invite_email_sent",
                target_type="invitation",
                target_id=invitation.get("id"),
                target_label=invitation.get("email"),
                details={"role": invitation.get("role"), "client_codes": invitation.get("client_codes")},
            )
        return invite_link, "", "Invitation email sent. The user can enroll from their inbox."
    except EmailDeliveryError as exc:
        mark_invitation_delivery(token, sent=False, error=str(exc), config=current_app.config)
        if invitation:
            audit(
                "invite_email_failed",
                target_type="invitation",
                target_id=invitation.get("id"),
                target_label=invitation.get("email"),
                details={"error": str(exc), "role": invitation.get("role"), "client_codes": invitation.get("client_codes")},
            )
        return invite_link, f"Invitation was created, but email delivery failed: {exc}", "Use the enrollment link below while mail settings are corrected."


def login():
    if current_user():
        return redirect(url_for(role_home_endpoint()))

    error = ""
    if request.method == "POST":
        email = request.form.get("email", "")
        password = request.form.get("password", "")
        user = authenticate_user(email, password, config=current_app.config)
        if user:
            login_user(user)
            audit("login_success", target_type="user", target_id=user.get("id"), target_label=user.get("email"), actor=user)
            return redirect(url_for(role_home_endpoint(user)))
        log_audit_event(
            action="login_failed",
            actor={},
            target_type="user",
            target_label=str(email or "").strip().lower(),
            details={"reason": "invalid_credentials"},
            ip_address=request_ip(),
            user_agent=request_user_agent(),
            config=current_app.config,
        )
        error = "Invalid email or password."

    return render_template("auth/login.html", error=error)


def logout():
    user = current_user()
    if user:
        audit("logout", target_type="user", target_id=user.get("id"), target_label=user.get("email"))
    logout_user()
    return redirect(url_for("login"))


def accept_invite(token):
    error = ""
    if request.method == "POST":
        name = request.form.get("name", "")
        password = request.form.get("password", "")
        confirm_password = request.form.get("confirm_password", "")
        if len(password) < 8:
            error = "Password must be at least 8 characters."
        elif password != confirm_password:
            error = "Passwords do not match."
        else:
            user, error = accept_invitation(token, name=name, password=password, config=current_app.config)
            if user:
                login_user(user)
                audit("invite_accepted", target_type="user", target_id=user.get("id"), target_label=user.get("email"), actor=user)
                return redirect(url_for(role_home_endpoint(user)))

    return render_template("auth/accept_invite.html", token=token, error=error)


def users_page():
    if not has_permission("manage_users"):
        return redirect(url_for(role_home_endpoint()))
    return render_users_page()


def create_user_invite():
    if not has_permission("manage_users"):
        return jsonify({"ok": False, "error": "You do not have permission to invite users."}), 403

    email = request.form.get("email", "")
    role = request.form.get("role", "operator")
    client_codes = request.form.get("client_codes", "")
    operator_scope = request.form.get("operator_scope", "")
    if not email or "@" not in email:
        return render_users_page(
            invite_error="Enter a valid email address.",
        ), 400

    token = create_invitation(
        email=email,
        role=role,
        client_codes=split_form_scope(client_codes),
        operator_scope=split_form_scope(operator_scope),
        invited_by=(current_user() or {}).get("id"),
        config=current_app.config,
    )
    invitation = get_invitation_by_token(token, config=current_app.config)
    if invitation:
        audit(
            "invite_created",
            target_type="invitation",
            target_id=invitation.get("id"),
            target_label=invitation.get("email"),
            details={
                "role": invitation.get("role"),
                "client_codes": invitation.get("client_codes"),
                "operator_scope": invitation.get("operator_scope"),
            },
        )
    invite_link, invite_error, invite_notice = deliver_invitation(token)
    return render_users_page(
        invite_link=invite_link,
        invite_error=invite_error,
        invite_notice=invite_notice,
    )


def update_user():
    if not has_permission("manage_users"):
        return jsonify({"ok": False, "error": "You do not have permission to manage users."}), 403

    user_id = request.form.get("user_id")
    target_user = get_user_by_id(user_id, config=current_app.config)
    if not target_user:
        return render_users_page(status_error="User was not found."), 404

    new_role = request.form.get("role", target_user.get("role"))
    if target_user.get("role") == "admin" and new_role != "admin" and active_admin_count(current_app.config) <= 1:
        return render_users_page(status_error="Keep at least one active admin before changing this user's role."), 400

    new_client_codes = split_form_scope(request.form.get("client_codes", ""))
    new_operator_scope = split_form_scope(request.form.get("operator_scope", ""))
    updated_user = update_user_access(
        user_id=target_user["id"],
        role=new_role,
        client_codes=new_client_codes,
        operator_scope=new_operator_scope,
        config=current_app.config,
    )
    audit(
        "user_access_updated",
        target_type="user",
        target_id=target_user.get("id"),
        target_label=target_user.get("email"),
        details={
            "before": {
                "role": target_user.get("role"),
                "client_codes": target_user.get("client_codes"),
                "operator_scope": target_user.get("operator_scope"),
            },
            "after": {
                "role": updated_user.get("role"),
                "client_codes": updated_user.get("client_codes"),
                "operator_scope": updated_user.get("operator_scope"),
            },
        },
    )
    return render_users_page(status_notice=f"Updated access for {target_user['email']}.")


def toggle_user_status():
    if not has_permission("manage_users"):
        return jsonify({"ok": False, "error": "You do not have permission to manage users."}), 403

    user_id = request.form.get("user_id")
    action = str(request.form.get("action") or "").strip().lower()
    target_user = get_user_by_id(user_id, config=current_app.config)
    if not target_user:
        return render_users_page(status_error="User was not found."), 404
    if target_user.get("id") == (current_user() or {}).get("id") and action != "activate":
        return render_users_page(status_error="You cannot suspend your own account while signed in."), 400
    if target_user.get("role") == "admin" and action != "activate" and active_admin_count(current_app.config) <= 1:
        return render_users_page(status_error="Keep at least one active admin before suspending this account."), 400

    new_status = "active" if action == "activate" else "suspended"
    set_user_status(target_user["id"], new_status, config=current_app.config)
    audit(
        "user_status_updated",
        target_type="user",
        target_id=target_user.get("id"),
        target_label=target_user.get("email"),
        details={"before": target_user.get("status"), "after": new_status},
    )
    return render_users_page(status_notice=f"{target_user['email']} is now {new_status}.")


def revoke_user_invite():
    if not has_permission("manage_users"):
        return jsonify({"ok": False, "error": "You do not have permission to manage invitations."}), 403
    invitation = get_invitation_by_id(request.form.get("invitation_id"), config=current_app.config)
    if not invitation:
        return render_users_page(status_error="Invitation was not found."), 404
    if not invitation_is_usable(invitation):
        return render_users_page(status_error="Only pending, unexpired invitations can be revoked."), 400
    revoke_invitation(invitation["id"], config=current_app.config)
    audit(
        "invite_revoked",
        target_type="invitation",
        target_id=invitation.get("id"),
        target_label=invitation.get("email"),
        details={"role": invitation.get("role"), "client_codes": invitation.get("client_codes")},
    )
    return render_users_page(status_notice=f"Revoked invitation for {invitation['email']}.")


def resend_user_invite():
    if not has_permission("manage_users"):
        return jsonify({"ok": False, "error": "You do not have permission to manage invitations."}), 403
    invitation = get_invitation_by_id(request.form.get("invitation_id"), config=current_app.config)
    if not invitation:
        return render_users_page(status_error="Invitation was not found."), 404
    if invitation.get("accepted_at"):
        return render_users_page(status_error="Accepted invitations cannot be resent."), 400

    if not invitation.get("revoked_at"):
        revoke_invitation(invitation["id"], config=current_app.config)
        audit(
            "invite_revoked_for_resend",
            target_type="invitation",
            target_id=invitation.get("id"),
            target_label=invitation.get("email"),
            details={"role": invitation.get("role"), "client_codes": invitation.get("client_codes")},
        )
    token = create_invitation(
        email=invitation["email"],
        role=invitation["role"],
        client_codes=invitation["client_codes"],
        operator_scope=invitation["operator_scope"],
        invited_by=(current_user() or {}).get("id"),
        config=current_app.config,
    )
    new_invitation = get_invitation_by_token(token, config=current_app.config)
    if new_invitation:
        audit(
            "invite_resent",
            target_type="invitation",
            target_id=new_invitation.get("id"),
            target_label=new_invitation.get("email"),
            details={
                "previous_invitation_id": invitation.get("id"),
                "role": new_invitation.get("role"),
                "client_codes": new_invitation.get("client_codes"),
            },
        )
    invite_link, invite_error, invite_notice = deliver_invitation(token)
    return render_users_page(invite_link=invite_link, invite_error=invite_error, invite_notice=invite_notice)


def register_auth_routes(app):
    app.add_url_rule("/login", view_func=login, endpoint="login", methods=["GET", "POST"])
    app.add_url_rule("/logout", view_func=logout, endpoint="logout")
    app.add_url_rule("/invite/<string:token>", view_func=accept_invite, endpoint="accept_invite", methods=["GET", "POST"])
    app.add_url_rule("/users", view_func=users_page, endpoint="users")
    app.add_url_rule("/users/invite", view_func=create_user_invite, endpoint="create_user_invite", methods=["POST"])
    app.add_url_rule("/users/update", view_func=update_user, endpoint="update_user", methods=["POST"])
    app.add_url_rule("/users/status", view_func=toggle_user_status, endpoint="toggle_user_status", methods=["POST"])
    app.add_url_rule("/users/invite/revoke", view_func=revoke_user_invite, endpoint="revoke_user_invite", methods=["POST"])
    app.add_url_rule("/users/invite/resend", view_func=resend_user_invite, endpoint="resend_user_invite", methods=["POST"])
