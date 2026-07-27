"""
Клиенты OAuth 2.0 для входа через Google и VK ID. Оба провайдера следуют
одному и тому же паттерну (authorization code + PKCE): получить код на
редиректе, обменять на access_token, получить у провайдера email/имя/id
пользователя. Обменом на локальную JWT-пару и созданием/поиском
пользователя занимается accounts/views.py — этот модуль отвечает только
за разговор с самим провайдером.

PKCE (RFC 7636) используется для обоих провайдеров, хотя строго обязателен
только у VK ID — так проще держать один и тот же код для обоих без
специального случая.
"""

import base64
import hashlib
import secrets
from urllib.parse import urlencode

import requests
from django.conf import settings

REQUEST_TIMEOUT = 10


def generate_pkce_pair():
    """code_verifier — случайная строка; code_challenge — её SHA256 в
    base64url без паддинга (метод S256, обязательный для VK ID)."""
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(64)).rstrip(b"=").decode("ascii")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


class OAuthError(Exception):
    """Не удалось завершить обмен кода на токен или получить данные пользователя."""


class GoogleOAuth:
    name = "google"
    authorize_url = "https://accounts.google.com/o/oauth2/v2/auth"
    token_url = "https://oauth2.googleapis.com/token"
    userinfo_url = "https://www.googleapis.com/oauth2/v3/userinfo"
    scope = "openid email profile"

    def __init__(self):
        self.client_id = settings.GOOGLE_OAUTH_CLIENT_ID
        self.client_secret = settings.GOOGLE_OAUTH_CLIENT_SECRET
        self.redirect_uri = settings.GOOGLE_OAUTH_REDIRECT_URI

    @property
    def is_configured(self):
        return bool(self.client_id and self.client_secret)

    def build_authorize_url(self, state, code_challenge):
        params = {
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            "scope": self.scope,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
            "access_type": "online",
            "prompt": "select_account",
        }
        return f"{self.authorize_url}?{urlencode(params)}"

    def exchange_code(self, code, code_verifier, callback_params=None):
        data = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "code": code,
            "redirect_uri": self.redirect_uri,
            "grant_type": "authorization_code",
            "code_verifier": code_verifier,
        }
        try:
            resp = requests.post(self.token_url, data=data, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
        except requests.RequestException as exc:
            raise OAuthError(f"Google token exchange failed: {exc}") from exc
        return resp.json()

    def fetch_user_info(self, access_token):
        try:
            resp = requests.get(
                self.userinfo_url,
                headers={"Authorization": f"Bearer {access_token}"},
                timeout=REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
        except requests.RequestException as exc:
            raise OAuthError(f"Google userinfo request failed: {exc}") from exc
        data = resp.json()
        if not data.get("sub"):
            raise OAuthError("Google userinfo response missing 'sub'")
        return {
            "provider_user_id": data["sub"],
            "email": data.get("email", ""),
            "name": data.get("name") or (data.get("email", "").split("@")[0]),
        }


class VKOAuth:
    """VK ID (OAuth 2.1) — в отличие от Google, обязателен PKCE, а обмен
    кода на токен требует ещё и device_id, который VK возвращает вместе
    с code на редиректе (не часть стандартного OAuth2, особенность VK ID)."""

    name = "vk"
    authorize_url = "https://id.vk.com/authorize"
    token_url = "https://id.vk.com/oauth2/auth"
    userinfo_url = "https://id.vk.com/oauth2/user_info"
    scope = "email"

    def __init__(self):
        self.client_id = settings.VK_OAUTH_CLIENT_ID
        self.redirect_uri = settings.VK_OAUTH_REDIRECT_URI

    @property
    def is_configured(self):
        return bool(self.client_id)

    def build_authorize_url(self, state, code_challenge):
        params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "scope": self.scope,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        return f"{self.authorize_url}?{urlencode(params)}"

    def exchange_code(self, code, code_verifier, callback_params=None):
        device_id = (callback_params or {}).get("device_id", "")
        state = (callback_params or {}).get("state", "")
        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.redirect_uri,
            "client_id": self.client_id,
            "device_id": device_id,
            "code_verifier": code_verifier,
            "state": state,
        }
        try:
            resp = requests.post(
                self.token_url,
                data=data,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
        except requests.RequestException as exc:
            raise OAuthError(f"VK token exchange failed: {exc}") from exc
        return resp.json()

    def fetch_user_info(self, access_token):
        try:
            resp = requests.post(
                self.userinfo_url,
                data={"access_token": access_token, "client_id": self.client_id},
                headers={"Content-Type": "application/x-www-form-urlencoded"},
                timeout=REQUEST_TIMEOUT,
            )
            resp.raise_for_status()
        except requests.RequestException as exc:
            raise OAuthError(f"VK userinfo request failed: {exc}") from exc
        payload = resp.json().get("user") or {}
        user_id = payload.get("user_id")
        if not user_id:
            raise OAuthError("VK user_info response missing 'user_id'")
        full_name = " ".join(filter(None, [payload.get("first_name"), payload.get("last_name")]))
        return {
            "provider_user_id": str(user_id),
            "email": payload.get("email", ""),
            "name": full_name or "Пользователь VK",
        }


PROVIDERS = {"google": GoogleOAuth, "vk": VKOAuth}
