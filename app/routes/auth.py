from flask import current_app, jsonify, redirect, render_template, request, url_for

from app.services.auth import (
    accept_invitation,
    authenticate_user,
    build_invite_url,
    create_invitation,
    current_user,
    get_invitation_by_token,
    has_permission,
    list_invitations,
    list_users,
    login_user,
    logout_user,
    mark_invitation_delivery,
    role_home_endpoint,
)
from app.services.email import EmailDeliveryError, send_invitation_email


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
            return redirect(url_for(role_home_endpoint(user)))
        error = "Invalid email or password."

    return render_template("auth/login.html", error=error)


def logout():
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
                return redirect(url_for(role_home_endpoint(user)))

    return render_template("auth/accept_invite.html", token=token, error=error)


def users_page():
    if not has_permission("manage_users"):
        return redirect(url_for(role_home_endpoint()))
    return render_template(
        "users.html",
        users=list_users(current_app.config),
        invitations=list_invitations(current_app.config),
        invite_link="",
        invite_error="",
        invite_notice="",
    )


def create_user_invite():
    if not has_permission("manage_users"):
        return jsonify({"ok": False, "error": "You do not have permission to invite users."}), 403

    email = request.form.get("email", "")
    role = request.form.get("role", "operator")
    client_codes = request.form.get("client_codes", "")
    operator_scope = request.form.get("operator_scope", "")
    if not email or "@" not in email:
        return render_template(
            "users.html",
            users=list_users(current_app.config),
            invitations=list_invitations(current_app.config),
            invite_link="",
            invite_error="Enter a valid email address.",
            invite_notice="",
        ), 400

    token = create_invitation(
        email=email,
        role=role,
        client_codes=client_codes.split(","),
        operator_scope=operator_scope.split(","),
        invited_by=(current_user() or {}).get("id"),
        config=current_app.config,
    )
    invite_link = build_invite_url(token)
    invitation = get_invitation_by_token(token, config=current_app.config)
    invited_by = (current_user() or {}).get("email", "")
    invite_notice = ""
    invite_error = ""
    try:
        if invitation:
            send_invitation_email(invitation, invite_link, invited_by=invited_by, config=current_app.config)
        mark_invitation_delivery(token, sent=True, config=current_app.config)
        invite_notice = "Invitation email sent. The user can enroll from their inbox."
    except EmailDeliveryError as exc:
        mark_invitation_delivery(token, sent=False, error=str(exc), config=current_app.config)
        invite_error = f"Invitation was created, but email delivery failed: {exc}"
        invite_notice = "Use the enrollment link below while mail settings are corrected."
    return render_template(
        "users.html",
        users=list_users(current_app.config),
        invitations=list_invitations(current_app.config),
        invite_link=invite_link,
        invite_error=invite_error,
        invite_notice=invite_notice,
    )


def register_auth_routes(app):
    app.add_url_rule("/login", view_func=login, endpoint="login", methods=["GET", "POST"])
    app.add_url_rule("/logout", view_func=logout, endpoint="logout")
    app.add_url_rule("/invite/<string:token>", view_func=accept_invite, endpoint="accept_invite", methods=["GET", "POST"])
    app.add_url_rule("/users", view_func=users_page, endpoint="users")
    app.add_url_rule("/users/invite", view_func=create_user_invite, endpoint="create_user_invite", methods=["POST"])
