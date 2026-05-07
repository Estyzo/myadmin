from flask import current_app, flash, jsonify, redirect, render_template, request, url_for

from app.services.auth import (
    accept_invitation,
    authenticate_user,
    build_invite_url,
    create_invitation,
    current_user,
    has_permission,
    list_invitations,
    list_users,
    login_user,
    logout_user,
    role_home_endpoint,
)


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
    # Email delivery can be added later; for now the generated link is shown for secure manual sharing.
    flash("Invitation created. Share the generated enrollment link with the user.")
    return render_template(
        "users.html",
        users=list_users(current_app.config),
        invitations=list_invitations(current_app.config),
        invite_link=invite_link,
        invite_error="",
    )


def register_auth_routes(app):
    app.add_url_rule("/login", view_func=login, endpoint="login", methods=["GET", "POST"])
    app.add_url_rule("/logout", view_func=logout, endpoint="logout")
    app.add_url_rule("/invite/<string:token>", view_func=accept_invite, endpoint="accept_invite", methods=["GET", "POST"])
    app.add_url_rule("/users", view_func=users_page, endpoint="users")
    app.add_url_rule("/users/invite", view_func=create_user_invite, endpoint="create_user_invite", methods=["POST"])
