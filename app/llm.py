"""Tiny LLM provider abstraction — the first "intelligence" brick, reused by the
generation queue (app/generate.py) and future phases.

Two layers on purpose:
  • PROTOCOLS — *how* we talk. Exactly two cover the whole market:
      - "openai_compatible"  → POST {base}/chat/completions   (OpenAI, Gemini's
        OpenAI endpoint, Mistral, Groq, OpenRouter, Ollama, LM Studio, vLLM…)
      - "anthropic"          → POST {base}/v1/messages         (Claude)
  • PRESETS — *who* we talk to. A preset just pre-fills protocol + base_url + a
    suggested model; base_url/model stay fully editable afterwards.

No SDK, no heavy dep: stdlib urllib only (requests is only transitively present
via apprise; httpx isn't guaranteed). Everything fits in one file.
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any

from . import store


class LLMError(Exception):
    """A provider/transport error with a human-readable, French message."""


# --- Presets (verified July 2026; editable defaults, NOT locks) ------------
# Model IDs and base URLs evolve — these are *suggestions* the user can change.
# Kept in ONE table so updating a default is a one-line edit.
PRESETS: dict[str, dict[str, Any]] = {
    "none": {
        "label": "Aucun (désactivé)", "protocol": "openai_compatible",
        "base_url": "", "model": "", "needs_key": False,
    },
    "anthropic": {
        "label": "Anthropic (Claude)", "protocol": "anthropic",
        "base_url": "https://api.anthropic.com", "model": "claude-haiku-4-5",
        "needs_key": True, "key_url": "https://console.anthropic.com/settings/keys",
        "cost_hint": "~0,1–0,5 centime par vidéo résumée (Haiku, léger et rapide).",
    },
    "openai": {
        "label": "OpenAI", "protocol": "openai_compatible",
        "base_url": "https://api.openai.com/v1", "model": "gpt-4o-mini",
        "needs_key": True, "key_url": "https://platform.openai.com/api-keys",
        "cost_hint": "~0,1–0,5 centime par vidéo résumée avec un modèle léger.",
    },
    "google_gemini": {
        "label": "Google Gemini", "protocol": "openai_compatible",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
        "model": "gemini-2.5-flash-lite", "needs_key": True,
        "key_url": "https://aistudio.google.com/apikey",
        "cost_hint": "Flash-Lite est l'un des modèles les moins chers du marché.",
    },
    "mistral": {
        "label": "Mistral", "protocol": "openai_compatible",
        "base_url": "https://api.mistral.ai/v1", "model": "mistral-small-latest",
        "needs_key": True, "key_url": "https://console.mistral.ai/api-keys",
        "cost_hint": "Mistral Small : bon rapport qualité/prix pour du résumé.",
    },
    "groq": {
        "label": "Groq", "protocol": "openai_compatible",
        "base_url": "https://api.groq.com/openai/v1", "model": "openai/gpt-oss-120b",
        "needs_key": True, "key_url": "https://console.groq.com/keys",
        "cost_hint": "Inférence très rapide, tarifs au token faibles.",
    },
    "openrouter": {
        "label": "OpenRouter", "protocol": "openai_compatible",
        "base_url": "https://openrouter.ai/api/v1", "model": "openai/gpt-4o-mini",
        "needs_key": True, "key_url": "https://openrouter.ai/keys",
        "cost_hint": "Un seul compte, des centaines de modèles ; prix variable selon le modèle.",
    },
    "ollama": {
        "label": "Ollama (local)", "protocol": "openai_compatible",
        "base_url": "http://localhost:11434/v1", "model": "llama3.2",
        "needs_key": False, "install_hint": "Installez le modèle : ollama pull llama3.2",
        "cost_hint": "100 % local, aucun coût, aucune donnée ne quitte votre machine.",
    },
    "lmstudio": {
        "label": "LM Studio (local)", "protocol": "openai_compatible",
        "base_url": "http://localhost:1234/v1", "model": "",
        "needs_key": False,
        "install_hint": "Chargez un modèle dans LM Studio puis renseignez son nom ici.",
        "cost_hint": "100 % local, aucun coût, aucune donnée ne quitte votre machine.",
    },
    "custom": {
        "label": "Personnalisé", "protocol": "openai_compatible",
        "base_url": "", "model": "", "needs_key": False,
        "cost_hint": "Tout est éditable : protocole, URL et modèle.",
    },
}

# Cloud presets carry the transcript to a third party — the UI warns for these.
LOCAL_PRESETS = {"ollama", "lmstudio"}


def presets_public() -> list[dict[str, Any]]:
    """Preset catalogue for the settings UI (no secrets — there are none here)."""
    out = []
    for pid, p in PRESETS.items():
        out.append({
            "id": pid, "label": p["label"], "protocol": p["protocol"],
            "base_url": p["base_url"], "model": p["model"],
            "needs_key": p.get("needs_key", False),
            "key_url": p.get("key_url", ""), "cost_hint": p.get("cost_hint", ""),
            "install_hint": p.get("install_hint", ""),
            "local": pid in LOCAL_PRESETS,
        })
    return out


# --- Config ----------------------------------------------------------------
def _cfg() -> dict[str, Any]:
    return store.get_intelligence()


def configured() -> bool:
    """Whether a usable provider is set (preset ≠ none, URL + model present, and a
    key when the protocol needs one)."""
    c = _cfg()
    if c.get("preset") in (None, "", "none"):
        return False
    if not c.get("base_url") or not c.get("model"):
        return False
    if c.get("protocol") == "anthropic" and not c.get("api_key"):
        return False
    return True


# --- HTTP (stdlib) ---------------------------------------------------------
def _post(url: str, headers: dict[str, str], body: dict[str, Any], timeout: float) -> Any:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json", **headers},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300] if hasattr(exc, "read") else ""
        raise LLMError(_http_message(exc.code, detail)) from exc
    except urllib.error.URLError as exc:
        raise LLMError(f"URL injoignable : {getattr(exc, 'reason', exc)}") from exc
    except TimeoutError as exc:
        raise LLMError("Délai dépassé (timeout) en contactant le fournisseur") from exc
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise LLMError("Réponse illisible du fournisseur (JSON invalide)") from exc


def _http_message(code: int, detail: str) -> str:
    if code == 401:
        return "Clé API invalide ou manquante (401)"
    if code == 403:
        return "Accès refusé (403) — vérifiez la clé et ses droits"
    if code == 404:
        return "Introuvable (404) — vérifiez l'URL de base et le nom du modèle"
    if code == 429:
        return "Quota/limite de débit atteint (429)"
    hint = f" — {detail}" if detail else ""
    return f"Erreur du fournisseur (HTTP {code}){hint}"


# --- Protocol calls --------------------------------------------------------
def _call_openai(
    c: dict[str, Any], system: str, prompt: str, max_tokens: int, timeout: float, json_mode: bool = False
) -> str:
    url = c["base_url"].rstrip("/") + "/chat/completions"
    headers = {}
    if c.get("api_key"):
        headers["Authorization"] = f"Bearer {c['api_key']}"
    body: dict[str, Any] = {
        "model": c["model"],
        "max_tokens": max_tokens,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt},
        ],
    }
    # Native JSON mode is far more reliable than prompting alone (OpenAI, Groq,
    # Mistral, Gemini's OpenAI endpoint, OpenRouter, LM Studio, Ollama…). Some
    # providers/models reject the field — degrade gracefully to prompt-only JSON.
    if json_mode:
        body["response_format"] = {"type": "json_object"}
        try:
            data = _post(url, headers, body, timeout)
        except LLMError as exc:
            if "response_format" in str(exc).lower():
                body.pop("response_format", None)
                data = _post(url, headers, body, timeout)
            else:
                raise
    else:
        data = _post(url, headers, body, timeout)
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError) as exc:
        raise LLMError("Réponse inattendue (format chat/completions)") from exc


def _call_anthropic(
    c: dict[str, Any], system: str, prompt: str, max_tokens: int, timeout: float, json_mode: bool = False
) -> str:
    url = c["base_url"].rstrip("/") + "/v1/messages"
    headers = {"x-api-key": c.get("api_key", ""), "anthropic-version": "2023-06-01"}
    body = {
        "model": c["model"],
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": prompt}],
    }  # Claude follows JSON instructions well; no response_format needed.
    data = _post(url, headers, body, timeout)
    try:
        parts = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
        return "".join(parts)
    except (AttributeError, TypeError) as exc:
        raise LLMError("Réponse inattendue (format Anthropic messages)") from exc


def _call(
    c: dict[str, Any], system: str, prompt: str, max_tokens: int, timeout: float, json_mode: bool = False
) -> str:
    if c.get("protocol") == "anthropic":
        return _call_anthropic(c, system, prompt, max_tokens, timeout, json_mode)
    return _call_openai(c, system, prompt, max_tokens, timeout, json_mode)


# --- JSON coaxing ----------------------------------------------------------
def _strip_fences(text: str) -> str:
    """Drop ```json … ``` fences and grab the outermost {...} if there's prose."""
    t = text.strip()
    t = re.sub(r"^```[a-zA-Z]*\s*", "", t)
    t = re.sub(r"\s*```$", "", t).strip()
    if not t.startswith("{"):
        i, j = t.find("{"), t.rfind("}")
        if i >= 0 and j > i:
            t = t[i : j + 1]
    return t


def _parse_json(text: str) -> Any | None:
    try:
        return json.loads(_strip_fences(text))
    except (json.JSONDecodeError, ValueError):
        return None


def _json_instructions() -> str:
    return (
        "Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant/après, "
        "sans commentaire et sans balises de code (```). "
    )


# --- Public API ------------------------------------------------------------
def generate(
    system: str,
    prompt: str,
    json_schema: dict[str, Any] | None = None,
    max_tokens: int = 1024,
    timeout: float = 60.0,
) -> Any:
    """Call the configured provider. Returns the raw text, or — when json_schema
    is given — the parsed JSON object. On invalid JSON, ONE automatic retry with
    the parse error in context, then a clean failure. Never loops."""
    if not configured():
        raise LLMError("Aucun fournisseur IA configuré")
    c = _cfg()
    json_mode = json_schema is not None
    sys_prompt = f"{system}\n\n{_json_instructions()}" if json_mode else system

    text = _call(c, sys_prompt, prompt, max_tokens, timeout, json_mode)
    if not json_mode:
        return text

    parsed = _parse_json(text)
    if parsed is not None:
        return parsed
    # Single retry, telling the model exactly what went wrong.
    retry_prompt = (
        f"{prompt}\n\n---\nTa réponse précédente n'était pas un JSON valide "
        f"(reçu : {text[:200]!r}). Renvoie STRICTEMENT l'objet JSON demandé, "
        f"rien d'autre."
    )
    text2 = _call(c, sys_prompt, retry_prompt, max_tokens, timeout, json_mode)
    parsed = _parse_json(text2)
    if parsed is not None:
        return parsed
    # Surface what the model actually returned — empty text usually means the
    # token budget was spent on reasoning (raise max_tokens or use a lighter model).
    sample = (text2 or text or "").strip()
    hint = "réponse vide (budget de tokens épuisé ? essayez un modèle plus léger)" if not sample else repr(sample[:150])
    raise LLMError(f"Le modèle n'a pas renvoyé de JSON valide (après une relance) — {hint}")


def test_connection() -> dict[str, Any]:
    """Cheap round-trip for the settings 'Tester la connexion' button.
    Returns {ok, message, model}."""
    if not configured():
        return {"ok": False, "message": "Configuration incomplète (URL, modèle, ou clé manquants)."}
    c = _cfg()
    try:
        out = _call(c, "Réponds par le seul mot: OK.", "Dis OK.", max_tokens=8, timeout=20.0)
        return {"ok": True, "message": f"Connecté à {c['model']}.", "model": c["model"], "sample": (out or "").strip()[:40]}
    except LLMError as exc:
        return {"ok": False, "message": str(exc)}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": f"Erreur inattendue : {exc}"}
